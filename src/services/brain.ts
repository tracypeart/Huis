import { z } from "zod";
import { aiProvider, AiDisabledError, type Passage } from "../ai/gateway";
import { terms } from "../ai/local";
import type { FirmSession } from "../db/tenant";
import { NotFoundError, PermissionDeniedError, UserFacingError } from "../errors";
import { INTERNAL_ROLES } from "../security/permissions";
import { recordAudit } from "./audit";
import { getMatter } from "./matters";

/**
 * Matter Brain: each Matter's knowledge base, and asking it questions.
 *
 * Firm staff only — AI output is attorney-facing, never shown to clients,
 * co-counsel or experts. The database decides which passages a person can
 * see (the evidence's own rules, so ethical walls apply), so an answer can
 * only be built from what that person could open themselves. Questions and
 * answers are private to the person who asked, and the audit log records
 * that a question was asked, never what.
 */

const uuid = z.uuid();
const staffOnly = (s: FirmSession, what: string) => {
  if (!INTERNAL_ROLES.has(s.actor.role)) throw new PermissionDeniedError(what);
};
const writer = (s: FirmSession, what: string) => {
  staffOnly(s, what);
  if (s.actor.role === "read_only") throw new PermissionDeniedError(what);
};

/** Passages used for one answer. */
const PASSAGES = 8;
const PER_SOURCE = 3;

export async function getAiProviderSetting(s: FirmSession): Promise<"off" | "local"> {
  const r = (await s.client.query<{ ai_provider: "off" | "local" }>("SELECT ai_provider FROM huis.firms WHERE id = $1", [s.actor.firmId])).rows[0];
  return r?.ai_provider ?? "off";
}

export async function setAiProviderSetting(s: FirmSession, provider: string): Promise<void> {
  const v = z.enum(["off", "local"]).parse(provider);
  await s.client.query("SELECT huis.set_ai_provider($1)", [v]);
  await recordAudit(s, "firm.ai_provider_changed", { targetType: "firm", targetId: s.actor.firmId, metadata: { provider: v } });
}

// ---------------------------------------------------------------------------
// Attorney notes
// ---------------------------------------------------------------------------
export interface MatterNote { id: string; title: string; body: string; authorId: string; authorName: string; mine: boolean; updatedAt: Date }

const noteInput = z.object({ title: z.string().trim().min(1).max(300), body: z.string().trim().min(1).max(200_000) });

export async function listNotes(s: FirmSession, matterId: string): Promise<MatterNote[]> {
  staffOnly(s, "see attorney notes");
  await getMatter(s, matterId);
  const { rows } = await s.client.query(
    `SELECT n.id, n.title, n.body, n.author_id, coalesce(u.full_name, 'Former user') AS author_name, n.updated_at
       FROM huis.matter_notes n LEFT JOIN huis.users u ON u.id = n.author_id
      WHERE n.matter_id = $1 ORDER BY n.updated_at DESC LIMIT 200`, [matterId]);
  return rows.map((r) => ({ id: r.id, title: r.title, body: r.body, authorId: r.author_id, authorName: r.author_name,
    mine: r.author_id === s.actor.userId, updatedAt: r.updated_at }));
}

export async function addNote(s: FirmSession, matterId: string, input: unknown): Promise<string> {
  writer(s, "add attorney notes");
  await getMatter(s, matterId);
  const v = noteInput.parse(input);
  const id = (await s.client.query<{ id: string }>(
    "INSERT INTO huis.matter_notes (firm_id, matter_id, author_id, title, body) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [s.actor.firmId, matterId, s.actor.userId, v.title, v.body])).rows[0]!.id;
  await recordAudit(s, "matter.note_added", { targetType: "note", targetId: id, matterId });
  return id;
}

export async function updateNote(s: FirmSession, noteId: string, input: unknown): Promise<void> {
  writer(s, "change attorney notes");
  if (!uuid.safeParse(noteId).success) throw new NotFoundError("Note");
  const v = noteInput.parse(input);
  const r = await s.client.query("UPDATE huis.matter_notes SET title = $2, body = $3 WHERE id = $1 RETURNING matter_id", [noteId, v.title, v.body]);
  if (!r.rowCount) throw new NotFoundError("Note");
  await recordAudit(s, "matter.note_changed", { targetType: "note", targetId: noteId, matterId: r.rows[0].matter_id });
}

export async function deleteNote(s: FirmSession, noteId: string): Promise<void> {
  staffOnly(s, "delete attorney notes");
  if (!uuid.safeParse(noteId).success) throw new NotFoundError("Note");
  const r = await s.client.query("DELETE FROM huis.matter_notes WHERE id = $1 RETURNING matter_id", [noteId]);
  if (!r.rowCount) throw new NotFoundError("Note");
  await recordAudit(s, "matter.note_deleted", { targetType: "note", targetId: noteId, matterId: r.rows[0].matter_id });
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------
export interface BrainStatus { documents: number; documentsReady: number; notes: number; passages: number; waiting: number; failed: number }

export async function brainStatus(s: FirmSession, matterId: string): Promise<BrainStatus> {
  staffOnly(s, "use the Matter Brain");
  await getMatter(s, matterId);
  const r = (await s.client.query(
    `SELECT count(*) FILTER (WHERE evidence_id IS NOT NULL)::int AS documents,
            count(*) FILTER (WHERE evidence_id IS NOT NULL AND status = 'indexed')::int AS ready,
            count(*) FILTER (WHERE note_id IS NOT NULL)::int AS notes,
            coalesce(sum(chunk_count) FILTER (WHERE status = 'indexed'), 0)::int AS passages,
            count(*) FILTER (WHERE status IN ('queued', 'running'))::int AS waiting,
            count(*) FILTER (WHERE status = 'failed')::int AS failed
       FROM huis.brain_sources WHERE matter_id = $1`, [matterId])).rows[0];
  return { documents: r.documents, documentsReady: r.ready, notes: r.notes, passages: r.passages, waiting: r.waiting, failed: r.failed };
}

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------
export interface Citation {
  n: number; evidenceId: string | null; noteId: string | null; start: number; end: number; excerpt: string; sourceTitle: string;
}
export interface BrainAnswer {
  id: string; matterId: string; question: string; answer: string; citations: Citation[]; provider: string; createdAt: Date;
  /** A source has since become unavailable to this person: the answer is withheld. */
  withheld: boolean;
}

const questionInput = z.string().trim().min(3, "Ask a question of at least a few words.").max(2000);

/** Words for the word-match half of the search: letters and digits only, so nothing can be injected into the query. */
function lexicalQuery(question: string): string | null {
  const words = [...new Set(question.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && terms(w).length > 0))].slice(0, 30);
  return words.length ? words.join(" | ") : null;
}

export async function askMatter(s: FirmSession, matterId: string, question: unknown): Promise<string> {
  staffOnly(s, "use the Matter Brain");
  const q = questionInput.parse(question);
  await getMatter(s, matterId);
  let provider;
  try { provider = aiProvider(await getAiProviderSetting(s)); } catch (e) {
    if (e instanceof AiDisabledError) throw new UserFacingError("AI features are turned off for your firm. An administrator can turn them on.");
    throw e;
  }
  const started = Date.now();
  const [vec] = await provider.embed([q]);
  const lex = lexicalQuery(q);
  // Row-level security limits this to passages from sources this person can open.
  const { rows } = await s.client.query(
    `WITH scored AS (
       SELECT c.id, c.content, c.evidence_id, c.note_id, c.source_id, c.char_start, c.char_end,
              CASE WHEN $3::text IS NULL THEN 0 ELSE ts_rank_cd(c.tsv, to_tsquery('english', $3::text), 32) END AS lex,
              CASE WHEN c.model = $4 AND c.embedding IS NOT NULL AND vector_dims(c.embedding) = vector_dims($2::vector)
                   THEN 1 - (c.embedding <=> $2::vector) ELSE 0 END AS sem
         FROM huis.brain_chunks c WHERE c.matter_id = $1
     ), ranked AS (
       SELECT *, sem + least(lex * 2, 1) AS score, row_number() OVER (PARTITION BY source_id ORDER BY sem + least(lex * 2, 1) DESC) AS k
         FROM scored
     )
     SELECT r.*, coalesce(i.original_filename, n.title) AS source_title
       FROM ranked r
       LEFT JOIN huis.evidence_items i ON i.id = r.evidence_id
       LEFT JOIN huis.matter_notes n ON n.id = r.note_id
      WHERE r.k <= $5 AND r.score > 0.05
      ORDER BY r.score DESC LIMIT $6`,
    [matterId, JSON.stringify(vec), lex, provider.model, PER_SOURCE, PASSAGES]);
  const passages: Passage[] = rows.map((r, i) => ({ n: i + 1, text: r.content }));
  const result = await provider.answer(q, passages);
  const citations: Citation[] = rows.map((r, i) => ({
    n: i + 1, evidenceId: r.evidence_id, noteId: r.note_id, start: r.char_start, end: r.char_end,
    excerpt: String(r.content).slice(0, 400), sourceTitle: String(r.source_title ?? "Source").slice(0, 300),
  }));
  const id = (await s.client.query<{ id: string }>(
    `INSERT INTO huis.brain_answers (firm_id, matter_id, asked_by, question, answer, citations, provider, model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [s.actor.firmId, matterId, s.actor.userId, q, result.text.slice(0, 100_000), JSON.stringify(citations), provider.name, provider.model])).rows[0]!.id;
  await s.client.query(
    `INSERT INTO huis.ai_requests (firm_id, user_id, matter_id, purpose, provider, model, input_chars, output_chars, duration_ms)
     VALUES ($1, $2, $3, 'ask', $4, $5, $6, $7, $8)`,
    [s.actor.firmId, s.actor.userId, matterId, provider.name, provider.model,
      q.length + passages.reduce((a, p) => a + p.text.length, 0), result.text.length, Date.now() - started]);
  // The question itself is work product: never in the audit log administrators read.
  await recordAudit(s, "matter.brain_asked", { targetType: "matter", targetId: matterId, matterId, metadata: { provider: provider.name } });
  return id;
}

export async function getAnswer(s: FirmSession, answerId: string): Promise<BrainAnswer> {
  staffOnly(s, "use the Matter Brain");
  if (!uuid.safeParse(answerId).success) throw new NotFoundError("Answer");
  const r = (await s.client.query("SELECT * FROM huis.brain_answers WHERE id = $1", [answerId])).rows[0];
  if (!r) throw new NotFoundError("Answer");
  const citations = (Array.isArray(r.citations) ? r.citations : []) as Citation[];
  // Re-check every source as it stands now: if any is no longer available to this person, withhold the answer.
  const evidence = citations.map((c) => c.evidenceId).filter((x): x is string => Boolean(x));
  const notes = citations.map((c) => c.noteId).filter((x): x is string => Boolean(x));
  const visible = (await s.client.query<{ id: string }>(
    `SELECT id FROM huis.evidence_items WHERE id = ANY($1::uuid[]) AND matter_id = $3 AND status = 'clean'
     UNION SELECT id FROM huis.matter_notes WHERE id = ANY($2::uuid[]) AND matter_id = $3`, [evidence, notes, r.matter_id])).rows;
  const seen = new Set(visible.map((x) => x.id));
  const withheld = citations.some((c) => !seen.has((c.evidenceId ?? c.noteId)!));
  return {
    id: r.id, matterId: r.matter_id, question: r.question, provider: r.provider, createdAt: r.created_at, withheld,
    answer: withheld ? "" : r.answer, citations: withheld ? [] : citations,
  };
}

export async function listMyQuestions(s: FirmSession, matterId: string): Promise<{ id: string; question: string; createdAt: Date }[]> {
  staffOnly(s, "use the Matter Brain");
  await getMatter(s, matterId);
  const { rows } = await s.client.query(
    "SELECT id, question, created_at FROM huis.brain_answers WHERE matter_id = $1 ORDER BY created_at DESC LIMIT 30", [matterId]);
  return rows.map((r) => ({ id: r.id, question: r.question, createdAt: r.created_at }));
}

export async function deleteAnswer(s: FirmSession, answerId: string): Promise<void> {
  staffOnly(s, "use the Matter Brain");
  if (!uuid.safeParse(answerId).success) throw new NotFoundError("Answer");
  const r = await s.client.query("DELETE FROM huis.brain_answers WHERE id = $1", [answerId]);
  if (!r.rowCount) throw new NotFoundError("Answer");
}
