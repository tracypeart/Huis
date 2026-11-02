import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";
import type { FirmSession } from "../db/tenant";
import { NotFoundError, PermissionDeniedError, UserFacingError } from "../errors";
import { INTERNAL_ROLES } from "../security/permissions";
import { storageKeys, type EvidenceVault } from "../storage/store";
import { recordAudit } from "./audit";
import { getMatter } from "./matters";

export const CHUNK_SIZE = 8 * 1024 * 1024;
/** Per-file ceiling; large matters are many files. Raise as storage scales. */
export const MAX_FILE_BYTES = Number(process.env.HUIS_MAX_FILE_BYTES ?? 100 * 1024 ** 3);

export const SOURCES = [
  "upload", "folder_upload", "external_drive", "client_portal", "email", "cloud_drive", "court", "discovery_production",
] as const;
export type EvidenceSource = (typeof SOURCES)[number];

export const StartUploadInput = z.object({
  matterId: z.uuid(),
  folderId: z.uuid().optional(),
  filename: z.string().trim().min(1).max(1024).refine((n) => !/[\0/\\]/.test(n), "Invalid file name"),
  relativePath: z.string().max(4096).optional(),
  declaredType: z.string().max(200).optional(),
  totalSize: z.number().int().min(0).max(MAX_FILE_BYTES),
  source: z.enum(SOURCES).default("upload"),
  receivedFrom: z.string().trim().max(300).optional(),
  dateReceived: z.iso.date().optional(),
});
export type StartUploadInput = z.input<typeof StartUploadInput>;

export interface UploadSession {
  id: string;
  firmId: string;
  matterId: string;
  folderId: string;
  filename: string;
  relativePath: string | null;
  declaredType: string | null;
  totalSize: number;
  chunkSize: number;
  chunkCount: number;
  receivedChunks: number[];
  source: EvidenceSource;
  receivedFrom: string | null;
  dateReceived: string | null;
  completedAt: Date | null;
  evidenceId: string | null;
}

const toSession = (r: Record<string, any>): UploadSession => ({
  id: r.id, firmId: r.firm_id, matterId: r.matter_id, folderId: r.folder_id, filename: r.filename,
  relativePath: r.relative_path, declaredType: r.declared_type, totalSize: Number(r.total_size),
  chunkSize: r.chunk_size, chunkCount: r.chunk_count, receivedChunks: r.received_chunks ?? [],
  source: r.source, receivedFrom: r.received_from,
  dateReceived: r.date_received ? new Date(r.date_received).toISOString().slice(0, 10) : null,
  completedAt: r.completed_at, evidenceId: r.evidence_id,
});

/** Default destination: Evidence for firm staff, Client Uploads for clients. */
async function defaultFolder(s: FirmSession, matterId: string): Promise<string> {
  const name = INTERNAL_ROLES.has(s.actor.role) ? "Evidence" : "Client Uploads";
  const { rows } = await s.client.query<{ id: string }>(
    "SELECT id FROM huis.matter_folders WHERE matter_id = $1 AND name = $2 AND NOT is_privileged_area LIMIT 1",
    [matterId, name],
  );
  if (!rows[0]) throw new NotFoundError("Folder");
  return rows[0].id;
}

/** Step 1: register an upload. Works for a single file up to MAX_FILE_BYTES. */
export async function startUpload(s: FirmSession, input: StartUploadInput): Promise<UploadSession> {
  const v = StartUploadInput.parse(input);
  if (s.actor.role === "read_only") throw new PermissionDeniedError("upload files");
  await getMatter(s, v.matterId);
  const folderId = v.folderId ?? (await defaultFolder(s, v.matterId));
  const folder = (await s.client.query<{ classification: string; is_privileged_area: boolean }>(
    "SELECT classification, is_privileged_area FROM huis.matter_folders WHERE id = $1 AND matter_id = $2", [folderId, v.matterId],
  )).rows[0];
  if (!folder) throw new NotFoundError("Folder");
  const isClient = s.actor.role === "client";
  if (!INTERNAL_ROLES.has(s.actor.role) && !isClient) throw new PermissionDeniedError("upload files");
  // Clients may only send files into folders shared with clients (Client Uploads).
  if (isClient && (folder.classification !== "client_accessible" || folder.is_privileged_area)) {
    throw new PermissionDeniedError("upload to this folder");
  }

  const chunkCount = Math.max(1, Math.ceil(v.totalSize / CHUNK_SIZE));
  const { rows } = await s.client.query(
    `INSERT INTO huis.upload_sessions (firm_id, matter_id, folder_id, user_id, filename, relative_path, declared_type,
       total_size, chunk_size, chunk_count, source, received_from, date_received)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [s.actor.firmId, v.matterId, folderId, s.actor.userId, v.filename, v.relativePath ?? null, v.declaredType ?? null,
     v.totalSize, CHUNK_SIZE, chunkCount, isClient ? "client_portal" : v.source, v.receivedFrom ?? null, v.dateReceived ?? null],
  );
  return toSession(rows[0]!);
}

export async function getUploadSession(s: FirmSession, sessionId: string): Promise<UploadSession> {
  z.uuid().parse(sessionId);
  const { rows } = await s.client.query(
    "SELECT * FROM huis.upload_sessions WHERE id = $1 AND expires_at > now()", [sessionId],
  );
  if (!rows[0]) throw new NotFoundError("Upload");
  return toSession(rows[0]);
}

export function expectedChunkLength(session: UploadSession, index: number): number {
  if (session.totalSize === 0) return 0;
  const start = index * session.chunkSize;
  return Math.min(session.chunkSize, session.totalSize - start);
}

/**
 * Step 2: store one chunk (encrypted). Chunks can arrive in any order and be
 * retried, so an interrupted upload of a large drive resumes where it stopped.
 * The database work is done by the caller around this.
 */
export async function storeChunk(vault: EvidenceVault, session: UploadSession, index: number, body: Buffer): Promise<void> {
  if (session.completedAt) throw new UserFacingError("This upload is already complete.", 409);
  if (!Number.isInteger(index) || index < 0 || index >= session.chunkCount) throw new UserFacingError("Invalid chunk number.");
  if (body.length !== expectedChunkLength(session, index)) throw new UserFacingError("Chunk size does not match.");
  await vault.put(session.firmId, storageKeys.stagingChunk(session.firmId, session.id, index), Readable.from([body]));
}

export async function markChunkReceived(s: FirmSession, sessionId: string, index: number): Promise<number[]> {
  const { rows } = await s.client.query<{ received_chunks: number[] }>(
    `UPDATE huis.upload_sessions
        SET received_chunks = CASE WHEN $2 = ANY(received_chunks) THEN received_chunks ELSE array_append(received_chunks, $2) END
      WHERE id = $1 AND completed_at IS NULL RETURNING received_chunks`,
    [sessionId, index],
  );
  if (!rows[0]) throw new NotFoundError("Upload");
  return rows[0].received_chunks;
}

/**
 * Step 3a: join the chunks into the permanent encrypted original, computing
 * its SHA-256 fingerprint as it streams. Runs outside any database transaction
 * because large files take time.
 */
export async function assembleOriginal(vault: EvidenceVault, session: UploadSession, evidenceId: string): Promise<{ size: number; sha256: string; storageKey: string }> {
  const missing = Array.from({ length: session.chunkCount }, (_, i) => i).filter((i) => !session.receivedChunks.includes(i));
  if (missing.length) throw new UserFacingError(`Upload incomplete: ${missing.length} part(s) missing.`, 409);
  const storageKey = storageKeys.original(session.firmId, session.matterId, evidenceId);
  const firmId = session.firmId;
  async function* chunks() {
    for (let i = 0; i < session.chunkCount; i++) {
      const stream = await vault.get(firmId, storageKeys.stagingChunk(firmId, session.id, i));
      for await (const part of stream) yield part as Buffer;
    }
  }
  const { size, sha256 } = await vault.put(firmId, storageKey, Readable.from(chunks()));
  if (size !== session.totalSize) {
    await vault.delete(storageKey);
    throw new UserFacingError("Upload size does not match what was announced.");
  }
  return { size, sha256, storageKey };
}

/** Step 3b: record the evidence, its chain-of-custody start, and queue scanning. */
export async function recordEvidence(
  s: FirmSession, session: UploadSession, evidenceId: string, file: { size: number; sha256: string; storageKey: string },
): Promise<EvidenceItem> {
  const locked = (await s.client.query(
    "SELECT completed_at FROM huis.upload_sessions WHERE id = $1 FOR UPDATE", [session.id],
  )).rows[0];
  if (!locked || locked.completed_at) throw new UserFacingError("This upload is already complete.", 409);

  await s.client.query(
    `INSERT INTO huis.evidence_items (id, firm_id, matter_id, folder_id, original_filename, relative_path,
       declared_content_type, size_bytes, sha256, storage_key, source, received_from, date_received, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [evidenceId, s.actor.firmId, session.matterId, session.folderId, session.filename, session.relativePath,
     session.declaredType, file.size, file.sha256, file.storageKey, session.source, session.receivedFrom,
     session.dateReceived, s.actor.userId],
  );
  // The database itself writes the "received" custody event and queues
  // scanning (trigger huis.evidence_after_insert), so neither can be forged.
  await s.client.query(
    "UPDATE huis.upload_sessions SET completed_at = now(), evidence_id = $2 WHERE id = $1", [session.id, evidenceId],
  );
  await recordAudit(s, "evidence.uploaded", {
    targetType: "evidence", targetId: evidenceId, matterId: session.matterId,
    metadata: { size_bytes: file.size, source: session.source },
  });
  return getEvidence(s, evidenceId);
}

export async function cleanupStaging(vault: EvidenceVault, session: UploadSession): Promise<void> {
  for (let i = 0; i < session.chunkCount; i++) {
    await vault.delete(storageKeys.stagingChunk(session.firmId, session.id, i)).catch(() => undefined);
  }
}

/** Convenience for tests and server-side imports: full upload of an in-memory buffer. */
export function newEvidenceId(): string {
  return randomUUID();
}

// ---- Reading -----------------------------------------------------------

export interface EvidenceItem {
  id: string;
  matterId: string;
  folderId: string;
  folderName: string;
  folderIsPrivileged: boolean;
  originalFilename: string;
  relativePath: string | null;
  declaredContentType: string | null;
  detectedContentType: string | null;
  sizeBytes: number;
  sha256: string;
  status: "pending_scan" | "clean" | "infected" | "scan_failed";
  scanDetail: string | null;
  source: EvidenceSource;
  receivedFrom: string | null;
  dateReceived: string | null;
  duplicateOf: string | null;
  uploadedBy: string;
  uploadedByName: string | null;
  uploadedAt: Date;
  /** Set when this item was found inside another (email attachment, archive entry). */
  parentId: string | null;
  containerPath: string | null;
  childCount: number;
  extractionStatus: "pending" | "done" | "partial" | "no_text" | "unsupported" | "needs_provider" | "failed" | null;
  extractionDetail: string | null;
  pageCount: number | null;
}

const EVIDENCE_SELECT = `
  SELECT e.*, f.name AS folder_name, f.is_privileged_area, u.full_name AS uploader_name,
         (SELECT count(*)::int FROM huis.evidence_items c WHERE c.parent_id = e.id) AS child_count
    FROM huis.evidence_items e
    JOIN huis.matter_folders f ON f.id = e.folder_id
    LEFT JOIN huis.users u ON u.id = e.uploaded_by`;

const toEvidence = (r: Record<string, any>): EvidenceItem => ({
  id: r.id, matterId: r.matter_id, folderId: r.folder_id, folderName: r.folder_name,
  folderIsPrivileged: r.is_privileged_area, originalFilename: r.original_filename, relativePath: r.relative_path,
  declaredContentType: r.declared_content_type, detectedContentType: r.detected_content_type,
  sizeBytes: Number(r.size_bytes), sha256: String(r.sha256), status: r.status, scanDetail: r.scan_detail,
  source: r.source, receivedFrom: r.received_from,
  dateReceived: r.date_received ? new Date(r.date_received).toISOString().slice(0, 10) : null,
  duplicateOf: r.duplicate_of, uploadedBy: r.uploaded_by, uploadedByName: r.uploader_name ?? null,
  uploadedAt: r.uploaded_at, parentId: r.parent_id ?? null, containerPath: r.container_path ?? null,
  childCount: r.child_count ?? 0, extractionStatus: r.extraction_status ?? null,
  extractionDetail: r.extraction_detail ?? null, pageCount: r.page_count ?? null,
});

/** Items found inside this one (email attachments, archive contents) that the user may see. */
export async function listContainedItems(s: FirmSession, evidenceId: string): Promise<EvidenceItem[]> {
  await getEvidence(s, evidenceId);
  const { rows } = await s.client.query(`${EVIDENCE_SELECT} WHERE e.parent_id = $1 ORDER BY e.container_path, e.original_filename`, [evidenceId]);
  return rows.map(toEvidence);
}

export interface EvidenceText {
  content: string;
  method: string;
  charCount: number;
  truncated: boolean;
}

/**
 * Extracted text for an item the user may see. Reading a document on screen
 * is the same as opening it, so it is recorded in the chain of custody and
 * the audit log, exactly like a download.
 */
export async function getEvidenceText(s: FirmSession, evidenceId: string): Promise<EvidenceText | null> {
  const item = await getEvidence(s, evidenceId);
  const { rows } = await s.client.query(
    "SELECT content, method, char_count, truncated FROM huis.evidence_text WHERE evidence_id = $1", [evidenceId],
  );
  const r = rows[0];
  if (!r) return null;
  await s.client.query("SELECT huis.record_evidence_view($1)", [evidenceId]);
  await recordAudit(s, "evidence.viewed", { targetType: "evidence", targetId: evidenceId, matterId: item.matterId });
  return { content: r.content, method: r.method, charCount: r.char_count, truncated: r.truncated };
}

export interface EmailHeaders {
  from: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string | null;
  sentAt: Date | null;
  attachmentCount: number;
}

export async function getEmailHeaders(s: FirmSession, evidenceId: string): Promise<EmailHeaders | null> {
  const { rows } = await s.client.query(
    "SELECT from_addr, to_addrs, cc_addrs, bcc_addrs, subject, sent_at, attachment_count FROM huis.evidence_email WHERE evidence_id = $1",
    [evidenceId],
  );
  const r = rows[0];
  return r ? {
    from: r.from_addr, to: r.to_addrs, cc: r.cc_addrs, bcc: r.bcc_addrs, subject: r.subject,
    sentAt: r.sent_at, attachmentCount: r.attachment_count,
  } : null;
}

export async function listEvidence(s: FirmSession, matterId: string): Promise<EvidenceItem[]> {
  await getMatter(s, matterId);
  const { rows } = await s.client.query(`${EVIDENCE_SELECT} WHERE e.matter_id = $1 ORDER BY e.uploaded_at DESC`, [matterId]);
  return rows.map(toEvidence);
}

export async function getEvidence(s: FirmSession, evidenceId: string): Promise<EvidenceItem> {
  if (!z.uuid().safeParse(evidenceId).success) throw new NotFoundError("Evidence");
  const { rows } = await s.client.query(`${EVIDENCE_SELECT} WHERE e.id = $1`, [evidenceId]);
  if (!rows[0]) throw new NotFoundError("Evidence");
  return toEvidence(rows[0]);
}

export interface CustodyEvent {
  id: string;
  event: string;
  actorName: string | null;
  details: Record<string, unknown>;
  occurredAt: Date;
}

export async function custodyLog(s: FirmSession, evidenceId: string): Promise<{ events: CustodyEvent[]; brokenAt: string | null }> {
  await getEvidence(s, evidenceId);
  const { rows } = await s.client.query(
    `SELECT c.id, c.event, c.details, c.occurred_at, u.full_name
       FROM huis.evidence_custody_events c LEFT JOIN huis.users u ON u.id = c.actor_user_id
      WHERE c.evidence_id = $1 ORDER BY c.id`,
    [evidenceId],
  );
  const broken = (await s.client.query<{ b: string | null }>("SELECT huis.verify_custody_chain($1) AS b", [evidenceId])).rows[0]?.b ?? null;
  return {
    events: rows.map((r) => ({ id: String(r.id), event: r.event, actorName: r.full_name ?? null, details: r.details, occurredAt: r.occurred_at })),
    brokenAt: broken === null ? null : String(broken),
  };
}

/**
 * Authorizes opening an original and records it in the chain of custody.
 * Files that are not confirmed clean by the malware scanner cannot be opened.
 */
export async function authorizeDownload(s: FirmSession, evidenceId: string): Promise<EvidenceItem> {
  const item = await getEvidence(s, evidenceId);
  if (item.status !== "clean") {
    throw new PermissionDeniedError(
      item.status === "pending_scan" ? "open this file until its security scan is complete" : "open this file — it failed its security scan",
    );
  }
  const ok = (await s.client.query<{ ok: boolean }>("SELECT huis.record_evidence_download($1) AS ok", [evidenceId])).rows[0]?.ok;
  if (!ok) throw new PermissionDeniedError("open this file");
  await recordAudit(s, "evidence.downloaded", { targetType: "evidence", targetId: evidenceId, matterId: item.matterId });
  return item;
}

export class SharingAcknowledgementRequired extends UserFacingError {
  constructor() {
    super(
      "This folder can be seen by people outside the firm (such as the client). Moving material there may waive privilege. " +
      "Confirm you have reviewed it before moving.",
    );
    this.name = "SharingAcknowledgementRequired";
  }
}

/**
 * Moves an item to another folder in the same matter (for example into the red
 * privileged area). Moving into a folder people outside the firm can see
 * requires an explicit privilege-waiver acknowledgement, recorded in custody.
 */
export async function moveEvidence(
  s: FirmSession, evidenceId: string, folderId: string, opts: { acknowledgePrivilegeWaiverRisk?: boolean } = {},
): Promise<void> {
  const item = await getEvidence(s, evidenceId);
  if (!INTERNAL_ROLES.has(s.actor.role) || s.actor.role === "read_only") throw new PermissionDeniedError("move evidence");
  if (!z.uuid().safeParse(folderId).success) throw new NotFoundError("Folder");
  const result = (await s.client.query<{ r: string }>(
    "SELECT huis.move_evidence($1, $2, $3) AS r", [evidenceId, folderId, Boolean(opts.acknowledgePrivilegeWaiverRisk)],
  )).rows[0]?.r;
  if (result === "folder_not_found") throw new NotFoundError("Folder");
  if (result === "acknowledgement_required") throw new SharingAcknowledgementRequired();
  if (result === "moved") {
    await recordAudit(s, "evidence.moved", {
      targetType: "evidence", targetId: evidenceId, matterId: item.matterId, metadata: { to_folder: folderId },
    });
  }
}

export interface SimilarItem {
  id: string;
  originalFilename: string;
  kind: "near_duplicate" | "version";
  score: number;
  folderName: string;
  folderIsPrivileged: boolean;
  uploadedAt: Date;
  dateReceived: string | null;
}

/**
 * Near-duplicates and other versions of an item. The database only returns
 * a link when this person can see both items, so nothing here reveals that
 * a privileged or walled document exists.
 */
export async function listSimilar(s: FirmSession, evidenceId: string): Promise<SimilarItem[]> {
  await getEvidence(s, evidenceId);
  const { rows } = await s.client.query(
    `SELECT o.id, o.original_filename, x.kind, x.score, f.name AS folder_name, f.is_privileged_area,
            o.uploaded_at, o.date_received
       FROM huis.evidence_similarity x
       JOIN huis.evidence_items o ON o.id = CASE WHEN x.item_a = $1 THEN x.item_b ELSE x.item_a END
       JOIN huis.matter_folders f ON f.id = o.folder_id
      WHERE x.item_a = $1 OR x.item_b = $1
      ORDER BY x.kind DESC, x.score DESC, o.uploaded_at
      LIMIT 200`,
    [evidenceId],
  );
  return rows.map((r) => ({
    id: r.id, originalFilename: r.original_filename, kind: r.kind, score: Number(r.score),
    folderName: r.folder_name, folderIsPrivileged: r.is_privileged_area, uploadedAt: r.uploaded_at,
    dateReceived: r.date_received ? String(r.date_received).slice(0, 10) : null,
  }));
}

/**
 * Side-by-side comparison of two items' text. Both must be visible and in
 * the same matter; reading both is recorded like any other view.
 */
export async function compareEvidence(s: FirmSession, leftId: string, rightId: string) {
  const left = await getEvidence(s, leftId);
  const right = await getEvidence(s, rightId);
  if (left.matterId !== right.matterId || left.id === right.id) throw new NotFoundError("comparison");
  const lt = left.status === "clean" ? await getEvidenceText(s, leftId) : null;
  const rt = right.status === "clean" ? await getEvidenceText(s, rightId) : null;
  if (!lt || !rt) return { left, right, diff: null, tooLarge: false };
  const { diffLines } = await import("../similarity/diff");
  const { DIFF_MAX_CHARS } = await import("../similarity/diff");
  if (lt.content.length > DIFF_MAX_CHARS || rt.content.length > DIFF_MAX_CHARS) return { left, right, diff: null, tooLarge: true };
  const d = diffLines(lt.content, rt.content);
  return { left, right, diff: d.lines, tooLarge: d.tooLarge };
}
