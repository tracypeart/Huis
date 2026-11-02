import { z } from "zod";
import type { FirmSession } from "../db/tenant";
import { NotFoundError, PermissionDeniedError, UserFacingError } from "../errors";
import { INTERNAL_ROLES } from "../security/permissions";
import { storageKeys } from "../storage/store";
import { recordAudit } from "./audit";
import { getEvidence, SharingAcknowledgementRequired, type EvidenceItem } from "./evidence";

/**
 * Working copies: the page viewer, annotations (highlights, notes, redaction
 * marks) and produced copies (redacted / exhibit / Bates). The original is
 * never changed.
 */

const isStaff = (s: FirmSession) => INTERNAL_ROLES.has(s.actor.role);
const canWork = (s: FirmSession) => isStaff(s) && s.actor.role !== "read_only";

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------
export interface ViewablePdf { item: EvidenceItem; storageKey: string; pages: number | null; isViewingCopy: boolean }

/** What the page viewer can show for an item (null when it can't be shown as pages). */
export async function viewablePdf(s: FirmSession, evidenceId: string): Promise<ViewablePdf | null> {
  const item = await getEvidence(s, evidenceId);
  if (item.status !== "clean") return null;
  const r = (await s.client.query<{ storage_key: string; page_count: number | null }>(
    "SELECT storage_key, page_count FROM huis.evidence_renditions WHERE evidence_id = $1", [evidenceId])).rows[0];
  if (r) return { item, storageKey: r.storage_key, pages: r.page_count, isViewingCopy: true };
  if (item.detectedContentType === "PDF") {
    return { item, storageKey: storageKeys.original(s.actor.firmId, item.matterId, item.id), pages: item.pageCount, isViewingCopy: false };
  }
  return null;
}

/** Opening a document in the viewer is recorded like any other view. */
export async function openInViewer(s: FirmSession, evidenceId: string): Promise<ViewablePdf> {
  const v = await viewablePdf(s, evidenceId);
  if (!v) throw new NotFoundError("Viewable document");
  await s.client.query("SELECT huis.record_evidence_view($1)", [evidenceId]);
  await recordAudit(s, "evidence.viewed", { targetType: "evidence", targetId: evidenceId, matterId: v.item.matterId, metadata: { via: "viewer" } });
  return v;
}

// ---------------------------------------------------------------------------
// Annotations (attorney work product: firm staff only)
// ---------------------------------------------------------------------------
export interface Annotation {
  id: string; page: number; kind: "highlight" | "note" | "redaction";
  x: number; y: number; w: number; h: number; color: string | null; note: string | null;
  createdBy: string; createdByName: string | null; createdAt: Date; mine: boolean;
}

const fraction = z.number().finite().min(0).max(1);
export const annotationInput = z.object({
  page: z.number().int().min(1).max(100000),
  kind: z.enum(["highlight", "note", "redaction"]),
  x: fraction, y: fraction,
  w: z.number().finite().gt(0).max(1), h: z.number().finite().gt(0).max(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
  note: z.string().max(5000).nullish(),
}).refine((a) => a.x + a.w <= 1.0001 && a.y + a.h <= 1.0001, { message: "The mark must be inside the page." });

export async function listAnnotations(s: FirmSession, evidenceId: string): Promise<Annotation[]> {
  await getEvidence(s, evidenceId);
  if (!isStaff(s)) return [];
  const { rows } = await s.client.query(
    `SELECT a.*, u.full_name FROM huis.evidence_annotations a LEFT JOIN huis.users u ON u.id = a.created_by
      WHERE a.evidence_id = $1 ORDER BY a.page, a.y, a.x LIMIT 5000`, [evidenceId]);
  return rows.map((r) => ({
    id: r.id, page: r.page, kind: r.kind, x: r.x, y: r.y, w: r.w, h: r.h, color: r.color, note: r.note,
    createdBy: r.created_by, createdByName: r.full_name, createdAt: r.created_at, mine: r.created_by === s.actor.userId,
  }));
}

export async function addAnnotation(s: FirmSession, evidenceId: string, input: unknown): Promise<string> {
  const item = await getEvidence(s, evidenceId);
  if (!canWork(s)) throw new PermissionDeniedError("mark up documents");
  if (item.status !== "clean") throw new PermissionDeniedError("mark up this file until it passes its security scan");
  const a = annotationInput.parse(input);
  const { rows } = await s.client.query<{ id: string }>(
    `INSERT INTO huis.evidence_annotations (firm_id, evidence_id, page, kind, x, y, w, h, color, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [s.actor.firmId, evidenceId, a.page, a.kind, a.x, a.y, a.w, a.h, a.color ?? null,
     a.kind === "redaction" ? null : (a.note ?? null), s.actor.userId]);
  if (a.kind === "redaction") {
    await recordAudit(s, "evidence.redaction_marked", { targetType: "evidence", targetId: evidenceId, matterId: item.matterId, metadata: { page: a.page } });
  }
  return rows[0]!.id;
}

export async function deleteAnnotation(s: FirmSession, evidenceId: string, annotationId: string): Promise<void> {
  const item = await getEvidence(s, evidenceId);
  if (!canWork(s)) throw new PermissionDeniedError("mark up documents");
  if (!z.uuid().safeParse(annotationId).success) throw new NotFoundError("Mark");
  const { rows } = await s.client.query<{ kind: string; page: number }>(
    "DELETE FROM huis.evidence_annotations WHERE id = $1 AND evidence_id = $2 RETURNING kind, page", [annotationId, evidenceId]);
  if (!rows[0]) throw new NotFoundError("Mark");
  if (rows[0].kind === "redaction") {
    await recordAudit(s, "evidence.redaction_removed", { targetType: "evidence", targetId: evidenceId, matterId: item.matterId, metadata: { page: rows[0].page } });
  }
}

// ---------------------------------------------------------------------------
// Produced copies
// ---------------------------------------------------------------------------
export const copyRequestInput = z.object({
  redact: z.boolean(),
  exhibitLabel: z.string().trim().max(40).regex(/^([A-Za-z0-9][A-Za-z0-9 .#-]{0,39})?$/, "Exhibit labels may use letters, numbers, spaces, '.', '#' and '-'.").optional(),
  batesPrefix: z.string().trim().toUpperCase().max(24).regex(/^([A-Z0-9][A-Z0-9_-]{0,23})?$/, "Bates prefixes may use letters, numbers, '-' and '_'.").optional(),
  folderId: z.uuid(),
  acknowledgePrivilegeWaiverRisk: z.boolean().optional(),
});

const COPY_ERRORS: Record<string, string> = {
  not_clean: "This file can't be copied until it passes its security scan.",
  nothing_to_do: "Choose redaction, an exhibit label or Bates numbering.",
  invalid_label: "Exhibit labels may use letters, numbers, spaces, '.', '#' and '-'.",
  invalid_prefix: "Bates prefixes may use letters, numbers, '-' and '_'.",
  no_pages: "Copies can only be made of documents that open as pages (PDFs, Office files and photos).",
  too_many_pages: "Copies are limited to 2,000 pages.",
  no_redactions: "Mark at least one area to redact in the viewer first.",
};

export async function requestCopy(s: FirmSession, evidenceId: string, input: unknown): Promise<string> {
  const item = await getEvidence(s, evidenceId);
  if (!canWork(s)) throw new PermissionDeniedError("produce copies");
  const c = copyRequestInput.parse(input);
  const r = (await s.client.query<{ r: string }>("SELECT huis.request_copy($1, $2, $3, $4, $5, $6) AS r", [
    evidenceId, c.redact, c.exhibitLabel || null, c.batesPrefix || null, c.folderId, Boolean(c.acknowledgePrivilegeWaiverRisk),
  ])).rows[0]!.r;
  if (r === "folder_not_found") throw new NotFoundError("Folder");
  if (r === "acknowledgement_required") throw new SharingAcknowledgementRequired();
  if (COPY_ERRORS[r]) throw new UserFacingError(COPY_ERRORS[r]!);
  await recordAudit(s, "evidence.copy_requested", {
    targetType: "evidence", targetId: evidenceId, matterId: item.matterId,
    metadata: { request: r, redact: c.redact, exhibit: c.exhibitLabel || null, bates: c.batesPrefix || null, folder: c.folderId },
  });
  return r;
}

export interface CopyRequest {
  id: string; redact: boolean; exhibitLabel: string | null; batesPrefix: string | null;
  batesStart: number | null; batesEnd: number | null; redactionCount: number; status: string;
  producedId: string | null; requestedAt: Date; requestedByName: string | null; lastError: string | null;
}

/** Copies requested from a document (firm staff only). */
export async function listCopies(s: FirmSession, evidenceId: string): Promise<CopyRequest[]> {
  await getEvidence(s, evidenceId);
  if (!isStaff(s)) return [];
  const { rows } = await s.client.query(
    `SELECT c.*, u.full_name FROM huis.copy_requests c LEFT JOIN huis.users u ON u.id = c.requested_by
      WHERE c.source_id = $1 ORDER BY c.requested_at DESC LIMIT 100`, [evidenceId]);
  return rows.map((r) => ({
    id: r.id, redact: r.redact, exhibitLabel: r.exhibit_label, batesPrefix: r.bates_prefix,
    batesStart: r.bates_start === null ? null : Number(r.bates_start), batesEnd: r.bates_end === null ? null : Number(r.bates_end),
    redactionCount: Array.isArray(r.redactions) ? r.redactions.length : 0, status: r.status, producedId: r.produced_id,
    requestedAt: r.requested_at, requestedByName: r.full_name, lastError: r.status === "failed" ? "Huis couldn't produce this copy." : null,
  }));
}

/** For a produced copy: the document it was made from (firm staff who can see it). */
export async function producedFrom(s: FirmSession, evidenceId: string): Promise<{ id: string; filename: string } | null> {
  if (!isStaff(s)) return null;
  const { rows } = await s.client.query(
    `SELECT e.id, e.original_filename FROM huis.copy_requests c JOIN huis.evidence_items e ON e.id = c.source_id
      WHERE c.produced_id = $1`, [evidenceId]);
  return rows[0] ? { id: rows[0].id, filename: rows[0].original_filename } : null;
}
