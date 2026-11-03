import { createHash, randomUUID } from "node:crypto";
import { PassThrough, Transform, type Readable } from "node:stream";
import { ZipFile } from "yazl";
import { WORK_PRODUCT_LABEL } from "../ai/gateway";
import type { FirmSession, HuisDb, RequestContext } from "../db/tenant";
import { PermissionDeniedError, UserFacingError } from "../errors";
import { INTERNAL_ROLES } from "../security/permissions";
import { type EvidenceVault, storageKeys } from "../storage/store";
import { recordAudit } from "./audit";
import { getMatter } from "./matters";

/**
 * Full export of a Matter: every clean original exactly as received, its
 * readable text, the chain of custody, the Matter's attorney notes, the
 * exporter's own Matter Brain questions, Case DNA, viewer marks and a
 * manifest, plus a SHA-256 checksum for every file in the export.
 *
 * Who: the Matter's owner, or a firm administrator who can see the Matter
 * (walls apply). The export is assembled from what that person can see at
 * that moment, under the same database rules as everything else, and Huis
 * keeps no copy. Each exported item is recorded in its chain of custody.
 */

export class ExportAcknowledgementRequired extends UserFacingError {
  constructor() {
    super("Confirm that you will store the export securely: it contains privileged and confidential material.");
    this.name = "ExportAcknowledgementRequired";
  }
}

export async function canExportMatter(s: FirmSession, matterId: string): Promise<boolean> {
  if (!INTERNAL_ROLES.has(s.actor.role) || s.actor.role === "read_only") return false;
  return Boolean((await s.client.query<{ ok: boolean }>("SELECT huis.can_export_matter($1) AS ok", [matterId])).rows[0]?.ok);
}

// ---------------------------------------------------------------------------
// Safe names inside the ZIP
// ---------------------------------------------------------------------------
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
/** One path segment that is safe on Windows, macOS and Linux: no separators, control characters or traversal. */
export function safeSegment(name: string, fallback = "unnamed"): string {
  // Typographic punctuation as plain characters, so older ZIP tools keep names intact
  // (the manifest keeps every original name exactly).
  let s = name.normalize("NFC").replace(/[\u2010-\u2015\u2212]/g, "-").replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f]/g, "\"").replace(/\u2026/g, "...").replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000]/g, " ").replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "_").replace(/^[\s.]+|[\s.]+$/g, "");
  if (!s || s === "." || s === "..") s = fallback;
  if (RESERVED.test(s)) s = `_${s}`;
  if (s.length > 120) {
    const dot = s.lastIndexOf(".");
    const ext = dot > 0 && s.length - dot <= 12 ? s.slice(dot) : "";
    s = s.slice(0, 120 - ext.length) + ext;
  }
  return s;
}

/** Unique (case-insensitively) within a folder: "letter.pdf", "letter (2).pdf"… */
function uniquePath(used: Set<string>, folder: string, file: string): string {
  const dot = file.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [file.slice(0, dot), file.slice(dot)] : [file, ""];
  for (let i = 1; ; i++) {
    const candidate = `${folder}/${i === 1 ? file : `${stem} (${i})${ext}`}`;
    if (!used.has(candidate.toLowerCase())) { used.add(candidate.toLowerCase()); return candidate; }
  }
}

/** CSV cell, also defused for spreadsheets (a cell starting with = + - @ can't run as a formula). */
function csv(v: unknown): string {
  let s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------------------------------------------------------------------------
// Planning (inside the person's database session)
// ---------------------------------------------------------------------------
interface ItemRow {
  id: string; matter_id: string; original_filename: string; folder_name: string; classification: string; is_privileged_area: boolean;
  status: string; source: string; sha256: string; size_bytes: string; received_from: string | null; date_received: string | null;
  uploader: string | null; uploaded_at: Date; parent_id: string | null; duplicate_of: string | null; has_text: boolean;
}

export interface ExportPlan {
  exportId: string;
  zipName: string;
  ctx: RequestContext;
  firmId: string;
  matterId: string;
  documents: { path: string; content: string }[];
  originals: { path: string; evidenceId: string; matterId: string; sha256: string }[];
  texts: { path: string; evidenceId: string }[];
  itemCount: number;
}

export async function prepareMatterExport(s: FirmSession, matterId: string, acknowledged: boolean): Promise<ExportPlan> {
  const matter = await getMatter(s, matterId);
  if (!(await canExportMatter(s, matterId))) throw new PermissionDeniedError("export this Matter");
  if (!acknowledged) throw new ExportAcknowledgementRequired();
  const exportId = randomUUID();
  const q = <T extends Record<string, unknown>>(sql: string, args: unknown[] = []) => s.client.query<T>(sql, args).then((r) => r.rows);

  const people = await q(
    `SELECT u.full_name, u.role, mm.access FROM huis.matter_members mm JOIN huis.users u ON u.id = mm.user_id WHERE mm.matter_id = $1 ORDER BY u.full_name`, [matterId]);
  const client = matter.clientId ? (await q("SELECT display_name, kind, email, phone FROM huis.clients WHERE id = $1", [matter.clientId]))[0] ?? null : null;
  const contacts = await q(
    `SELECT ct.full_name, ct.kind, ct.email, ct.organization, mc.role_label FROM huis.matter_contacts mc JOIN huis.contacts ct ON ct.id = mc.contact_id
      WHERE mc.matter_id = $1 ORDER BY ct.full_name`, [matterId]);
  const items = await q<ItemRow & Record<string, unknown>>(
    `SELECT i.id, i.matter_id, i.original_filename, f.name AS folder_name, f.classification, f.is_privileged_area, i.status, i.source, i.sha256,
            i.size_bytes::text, i.received_from, i.date_received::text, u.full_name AS uploader, i.uploaded_at, i.parent_id, i.duplicate_of,
            EXISTS (SELECT 1 FROM huis.evidence_text t WHERE t.evidence_id = i.id) AS has_text
       FROM huis.evidence_items i JOIN huis.matter_folders f ON f.id = i.folder_id LEFT JOIN huis.users u ON u.id = i.uploaded_by
      WHERE i.matter_id = $1 ORDER BY f.name, i.uploaded_at, i.id`, [matterId]);
  const custody = await q(
    `SELECT c.evidence_id, c.event, c.details, c.occurred_at, u.full_name AS actor
       FROM huis.evidence_custody_events c JOIN huis.evidence_items i ON i.id = c.evidence_id LEFT JOIN huis.users u ON u.id = c.actor_user_id
      WHERE i.matter_id = $1 ORDER BY c.evidence_id, c.id`, [matterId]);
  const chains = new Map<string, string | null>();
  for (const it of items) {
    chains.set(it.id, (await q<{ b: string | null }>("SELECT huis.verify_custody_chain($1)::text AS b", [it.id]))[0]?.b ?? null);
  }
  const notes = await q(
    `SELECT n.title, n.body, coalesce(u.full_name, 'Former user') AS author, n.created_at, n.updated_at
       FROM huis.matter_notes n LEFT JOIN huis.users u ON u.id = n.author_id WHERE n.matter_id = $1 ORDER BY n.created_at`, [matterId]);
  // Questions and answers are private: only the exporter's own.
  const answers = await q("SELECT question, answer, citations, provider, model, created_at FROM huis.brain_answers WHERE matter_id = $1 ORDER BY created_at", [matterId]);
  const nodes = await q(
    `SELECT id, kind, label, details, event_date::text AS event_date, email, role, amount, status, origin, created_at, decided_at
       FROM huis.dna_nodes WHERE matter_id = $1 ORDER BY kind, created_at`, [matterId]);
  const links = await q("SELECT from_id, to_id, relation, status, origin, created_at FROM huis.dna_links WHERE matter_id = $1 ORDER BY created_at", [matterId]);
  const dnaCitations = await q("SELECT node_id, evidence_id, note_id, char_start, char_end, quote FROM huis.dna_citations WHERE matter_id = $1 ORDER BY id", [matterId]);
  const marks = await q(
    `SELECT a.evidence_id, a.page, a.kind, a.x, a.y, a.w, a.h, a.color, a.note, u.full_name AS author, a.created_at
       FROM huis.evidence_annotations a JOIN huis.evidence_items i ON i.id = a.evidence_id LEFT JOIN huis.users u ON u.id = a.created_by
      WHERE i.matter_id = $1 ORDER BY a.evidence_id, a.page, a.created_at`, [matterId]);

  // Paths inside the ZIP.
  const used = new Set<string>();
  const originals: ExportPlan["originals"] = [];
  const texts: ExportPlan["texts"] = [];
  const pathOf = new Map<string, string>();
  for (const it of items) {
    if (it.status !== "clean") continue;
    const folder = `evidence/files/${safeSegment(it.folder_name, "Folder")}`;
    const p = uniquePath(used, folder, safeSegment(it.original_filename));
    pathOf.set(it.id, p);
    originals.push({ path: p, evidenceId: it.id, matterId: it.matter_id, sha256: it.sha256 });
    if (it.has_text) texts.push({ path: uniquePath(used, `evidence/text/${safeSegment(it.folder_name, "Folder")}`, `${safeSegment(it.original_filename)}.txt`), evidenceId: it.id });
  }

  const header = ["evidence_id", "file_in_export", "original_filename", "folder", "folder_classification", "privileged_area", "scan_status",
    "source", "sha256", "size_bytes", "received_from", "date_received", "uploaded_by", "uploaded_at", "contained_in", "duplicate_of", "custody_chain", "note"];
  const rows = items.map((it) => [
    it.id, pathOf.get(it.id) ?? "", it.original_filename, it.folder_name, it.classification, it.is_privileged_area ? "yes" : "no", it.status,
    it.source, it.sha256, it.size_bytes, it.received_from, it.date_received, it.uploader, it.uploaded_at, it.parent_id, it.duplicate_of,
    chains.get(it.id) === null ? "intact" : `broken at event ${chains.get(it.id)}`,
    it.status === "clean" ? "" : "Not included: this file did not pass its security scan (or hasn't yet).",
  ].map(csv).join(","));

  const now = new Date();
  const exporter = (await q<{ full_name: string }>("SELECT full_name FROM huis.users WHERE id = $1", [s.actor.userId]))[0]?.full_name ?? "Unknown";
  const readme = [
    `${WORK_PRODUCT_LABEL.toUpperCase()}`,
    "",
    `Matter: ${matter.title} (${matter.huisNumber})${matter.courtCaseNumber ? ` · Court case ${matter.courtCaseNumber}` : ""}`,
    `Exported by ${exporter} on ${now.toISOString()} · Export ${exportId}`,
    "",
    "This export contains privileged and confidential material, including material marked Privileged & Confidential and",
    "attorney work product. Store it securely, share it only as you would the originals, and delete it when no longer needed.",
    "",
    "Contents",
    "  matter.json                Matter details, client, people on the Matter, linked contacts",
    "  evidence/manifest.csv      Every item: file in this export, folder, privileged area, SHA-256, received, custody check",
    "  evidence/files/…           Originals exactly as received (their SHA-256 matches the manifest)",
    "  evidence/text/…            The text Huis read from each item (OCR and transcripts included)",
    "  evidence/custody.json      Chain of custody for every item",
    "  evidence/marks.json        Highlights, notes and redaction marks made in the viewer (the originals are unchanged)",
    "  matter-brain/notes.json    Attorney notes",
    "  matter-brain/my-questions.json   Questions you asked the Matter Brain, and the answers (yours only; others' are private)",
    "  case-dna.json              Case DNA: people, events, claims, elements, facts, damages, links and citations",
    "  SHA256SUMS.txt             A checksum for every file in this export (check with: sha256sum -c SHA256SUMS.txt)",
    "",
    "Items that did not pass their security scan are listed in the manifest but not included.",
    "",
  ].join("\n");

  const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  const documents = [
    { path: "README.txt", content: readme },
    { path: "matter.json", content: json({ label: WORK_PRODUCT_LABEL, exportId, exportedAt: now, exportedBy: exporter, matter, client, people, contacts }) },
    { path: "evidence/manifest.csv", content: `${header.join(",")}\n${rows.join("\n")}\n` },
    { path: "evidence/custody.json", content: json(items.map((it) => ({
      evidenceId: it.id, originalFilename: it.original_filename, chain: chains.get(it.id) === null ? "intact" : `broken at event ${chains.get(it.id)}`,
      events: custody.filter((c) => c.evidence_id === it.id).map((c) => ({ event: c.event, by: c.actor ?? "Huis", at: c.occurred_at, details: c.details })),
    }))) },
    { path: "evidence/marks.json", content: json(marks) },
    { path: "matter-brain/notes.json", content: json({ label: WORK_PRODUCT_LABEL, notes }) },
    { path: "matter-brain/my-questions.json", content: json({ label: WORK_PRODUCT_LABEL, answers }) },
    { path: "case-dna.json", content: json({ label: WORK_PRODUCT_LABEL, nodes, links, citations: dnaCitations }) },
  ];

  const recorded = (await q<{ n: number }>("SELECT huis.record_matter_export($1, $2) AS n", [matterId, exportId]))[0]?.n ?? 0;
  await recordAudit(s, "matter.exported", { targetType: "matter", targetId: matterId, matterId, metadata: { export_id: exportId, items: String(recorded) } });

  const stamp = now.toISOString().slice(0, 10);
  return {
    exportId, ctx: { firmId: s.actor.firmId, userId: s.actor.userId }, firmId: s.actor.firmId, matterId,
    zipName: `${safeSegment(`${matter.huisNumber} ${matter.title}`, "Matter").slice(0, 80)} - export ${stamp}.zip`,
    documents, originals, texts, itemCount: recorded,
  };
}

// ---------------------------------------------------------------------------
// Streaming the ZIP (after the planning session has closed)
// ---------------------------------------------------------------------------
function hashing(onDone: (hex: string) => void): Transform {
  const h = createHash("sha256");
  return new Transform({
    transform(chunk: Buffer, _e, cb) { h.update(chunk); cb(null, chunk); },
    flush(cb) { onDone(h.digest("hex")); cb(); },
  });
}

/**
 * Streams the export. Originals come from the encrypted vault one at a time;
 * each item's text is read when its turn comes, in a fresh database session
 * as the same person (so access is checked again). Ends with SHA256SUMS.txt.
 */
export function streamMatterExport(plan: ExportPlan, deps: { db: HuisDb; vault: EvidenceVault; ctx: RequestContext }): Readable {
  const zip = new ZipFile();
  const out = zip.outputStream as unknown as Readable;
  // Any failure (a file that fails its integrity check, a database error) ends the download with an error,
  // so a partial export can never look complete.
  const fail = (e: unknown) => { if (!out.destroyed) out.destroy(e instanceof Error ? e : new Error("export failed")); };
  (zip as unknown as NodeJS.EventEmitter).on("error", fail);
  const sums: string[] = [];
  const add = (path: string, hex: string) => sums.push(`${hex}  ${path}`);
  const mtime = new Date();

  for (const d of plan.documents) {
    const buf = Buffer.from(d.content, "utf8");
    add(d.path, createHash("sha256").update(buf).digest("hex"));
    zip.addBuffer(buf, d.path, { mtime });
  }
  for (const o of plan.originals) {
    zip.addReadStreamLazy(o.path, { mtime, compress: true }, (cb) => {
      deps.vault.get(plan.firmId, storageKeys.original(plan.firmId, o.matterId, o.evidenceId)).then((plain) => {
        const h = hashing((hex) => {
          add(o.path, hex);
          if (hex !== o.sha256) fail(new Error(`integrity check failed for ${o.path}`));
        });
        // A file that fails its integrity check ends the whole download (never a silent partial copy).
        h.on("error", fail);
        plain.on("error", fail);
        cb(null, plain.pipe(h));
      }, (e) => { fail(e); cb(e, undefined as never); });
    });
  }
  for (const t of plan.texts) {
    zip.addReadStreamLazy(t.path, { mtime }, (cb) => {
      deps.db.withFirm(deps.ctx, async (s) => (await s.client.query<{ content: string }>(
        "SELECT t.content FROM huis.evidence_text t JOIN huis.evidence_items i ON i.id = t.evidence_id WHERE t.evidence_id = $1 AND i.status = 'clean'",
        [t.evidenceId])).rows[0]?.content ?? "").then((content) => {
        const buf = Buffer.from(content, "utf8");
        add(t.path, createHash("sha256").update(buf).digest("hex"));
        const p = new PassThrough();
        p.end(buf);
        cb(null, p);
      }, (e) => { fail(e); cb(e, undefined as never); });
    });
  }
  // Written last, once every file before it has been read and hashed.
  zip.addReadStreamLazy("SHA256SUMS.txt", { mtime }, (cb) => {
    const p = new PassThrough();
    p.end(`${sums.sort((a, b) => a.slice(66).localeCompare(b.slice(66))).join("\n")}\n`);
    cb(null, p);
  });
  zip.end();
  return out;
}
