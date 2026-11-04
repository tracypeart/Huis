import { createHash } from "node:crypto";
import { z } from "zod";
import type { FirmSession } from "../db/tenant";
import { NotFoundError, PermissionDeniedError, UserFacingError } from "../errors";
import { INTERNAL_ROLES } from "../security/permissions";
import { terms } from "../ai/local";
import { confidenceFor, findStatements, topicsNeeded, type Confidence } from "../contradictions/detect";
import { citeExactly, sourceText } from "./cite";
import { recordAudit } from "./audit";
import { addNode, decideNode, linkNodes } from "./dna";
import { getMatter } from "./matters";
import { getTimeline, type TimelineEntry } from "./timeline";

/**
 * Contradiction engine: potential contradictions between what someone says
 * they didn't know (a statement in a deposition, declaration, letter or note)
 * and the Matter's earlier dated evidence on the same subject.
 *
 * Worked out each time it's read, as the person reading it, from passages and
 * timeline items they can already open (walls, clean evidence and outside
 * users are handled by the database). Fixed rules, no AI, and every flag says
 * why it was raised. Huis only ever calls it a *potential* contradiction:
 * the attorney confirms (the statement becomes a Case DNA fact, with the
 * evidence linked "contradicts" to it) or rejects (not suggested again).
 */

export interface ConflictingItem {
  /** Timeline entry key (Case DNA item or email evidence id). */
  key: string;
  date: string;
  kind: TimelineEntry["kind"];
  label: string;
  nodeId: string | null;
  evidenceId: string | null;
  status: "confirmed" | "suggested";
  /** The statement's topic words this item mentions. */
  matched: string[];
  /** Where it comes from (titles), and, for an email, the passage that mentions the topic. */
  sourceTitles: string[];
  passage: { start: number; end: number; text: string } | null;
}

export interface PotentialContradiction {
  key: string;
  /** Fingerprint of what was shown (the statement and its items): a decision must name it, so it acts only on what was reviewed. */
  version: string;
  statement: {
    quote: string;
    evidenceId: string | null;
    noteId: string | null;
    sourceTitle: string;
    start: number;
    end: number;
    topics: string[];
    before: string | null;
    beforeText: string | null;
  };
  conflicting: ConflictingItem[];
  confidence: Confidence;
  /** Plain-language reason, e.g. "3 earlier items from 3 different sources mention surgery". */
  why: string;
  decision: "confirmed" | "rejected" | null;
  statementNodeId: string | null;
}

export interface ContradictionReport {
  potential: PotentialContradiction[];
  rejected: PotentialContradiction[];
  confirmed: { key: string; statementNodeId: string | null; label: string | null; decidedAt: Date }[];
  /** The Matter has more passages to examine than are read at once. */
  truncated: boolean;
}

/** Limits on one reading (passages examined; items shown per contradiction). */
export const MAX_PASSAGES = 5000;
export const MAX_ITEMS_PER_FLAG = 10;
const MAX_EMAIL_PASSAGES = 20_000;

function reader(s: FirmSession) {
  if (!INTERNAL_ROLES.has(s.actor.role)) throw new PermissionDeniedError("use the contradiction finder");
}
function writer(s: FirmSession) {
  reader(s);
  if (s.actor.role === "read_only") throw new PermissionDeniedError("decide on contradictions");
}

const flagKey = (source: string, start: number, quote: string) =>
  createHash("sha256").update(`${source}\u0000${start}\u0000${quote}`).digest("hex");
/** What the attorney reviewed: the statement and exactly which items were shown with it. */
const flagVersion = (key: string, itemKeys: string[]) =>
  createHash("sha256").update([key, ...[...itemKeys].sort()].join("\u0000")).digest("hex").slice(0, 32);

/** Statements compared per reading (strongest-looking first is not knowable in advance; first found, in source order). */
export const MAX_STATEMENTS = 500;

interface PassageRow { evidence_id: string | null; note_id: string | null; content: string; char_start: number; char_end: number; title: string }

/** Every potential contradiction in the Matter (or just one statement's), worked out as this person. */
async function compute(s: FirmSession, matterId: string, onlyKey?: string): Promise<{ flags: PotentialContradiction[]; truncated: boolean }> {
  // Passages that may hold a denial (a cheap first pass in the database; the rules decide).
  // Row-level security: only passages this person can open.
  const passages = (await s.client.query<PassageRow>(
    `SELECT c.evidence_id, c.note_id, c.content, c.char_start, c.char_end, coalesce(i.original_filename, n.title, 'Source') AS title
       FROM huis.brain_chunks c
       LEFT JOIN huis.evidence_items i ON i.id = c.evidence_id
       LEFT JOIN huis.matter_notes n ON n.id = c.note_id
      WHERE c.matter_id = $1
        AND c.content ~* '(know|knew|aware|told|inform|notif|notice|learn|heard|idea|recall|remember|receiv|found out|understood)'
      ORDER BY c.source_id, c.chunk_no LIMIT ${MAX_PASSAGES + 1}`, [matterId])).rows;
  let truncated = passages.length > MAX_PASSAGES;
  if (!passages.length) return { flags: [], truncated };

  // The latest year in each source completes "until May" (from all its passages the person can open).
  const sourceIds = [...new Set(passages.map((p) => p.evidence_id ?? p.note_id!))];
  const years = new Map<string, number>((await s.client.query<{ src: string; y: number }>(
    `SELECT coalesce(c.evidence_id, c.note_id)::text AS src, max(m[1]::int) AS y
       FROM huis.brain_chunks c, LATERAL regexp_matches(left(c.content, 4000), '\\m(19[0-9]{2}|20[0-9]{2})\\M', 'g') m
      WHERE c.matter_id = $1 AND coalesce(c.evidence_id, c.note_id) = ANY($2::uuid[])
      GROUP BY 1`, [matterId, sourceIds])).rows.map((r) => [r.src, r.y]));

  // Statements, once each. Passages overlap, and one may hold a sentence cut short:
  // within a source, a statement overlapping a longer one is the same statement.
  type Statement = PotentialContradiction["statement"] & { source: string; key: string };
  const found: Statement[] = [];
  for (const p of passages.slice(0, MAX_PASSAGES)) {
    const source = p.evidence_id ?? p.note_id!;
    for (const st of findStatements(p.content, years.get(source) ?? null)) {
      const start = p.char_start + st.start;
      found.push({
        key: flagKey(source, start, st.quote), source, quote: st.quote, evidenceId: p.evidence_id, noteId: p.note_id,
        sourceTitle: String(p.title).slice(0, 300), start, end: p.char_start + st.end, topics: st.topics, before: st.before, beforeText: st.beforeText,
      });
    }
  }
  const statements: Statement[] = [];
  const kept = new Map<string, Statement[]>();
  for (const st of [...found].sort((a, b) => b.quote.length - a.quote.length)) {
    const list = kept.get(st.source) ?? [];
    if (list.some((k) => st.start < k.end && k.start < st.end)) continue;
    list.push(st);
    kept.set(st.source, list);
    statements.push(st);
  }
  statements.sort((a, b) => a.source.localeCompare(b.source) || a.start - b.start);
  if (statements.length > MAX_STATEMENTS) { statements.length = MAX_STATEMENTS; truncated = true; }
  const wanted = onlyKey ? statements.filter((st) => st.key === onlyKey) : statements;
  if (!wanted.length) return { flags: [], truncated };

  // What they might contradict: the timeline (Case DNA's dated items and filed email), as this person sees it.
  const entries = (await getTimeline(s, matterId)).entries.filter((e) => e.kind !== "damage");
  const emailIds = entries.filter((e) => e.kind === "email").map((e) => e.evidenceId!);
  const emailPassages = new Map<string, { words: Set<string>; start: number; end: number; content: string }[]>();
  if (emailIds.length) {
    const rows = (await s.client.query<{ evidence_id: string; content: string; char_start: number; char_end: number }>(
      `SELECT evidence_id, content, char_start, char_end FROM huis.brain_chunks
        WHERE matter_id = $1 AND evidence_id = ANY($2::uuid[]) ORDER BY evidence_id, chunk_no LIMIT ${MAX_EMAIL_PASSAGES}`, [matterId, emailIds])).rows;
    for (const r of rows) {
      const list = emailPassages.get(r.evidence_id) ?? [];
      if (list.length < 8) list.push({ words: new Set(terms(r.content)), start: r.char_start, end: r.char_end, content: r.content });
      emailPassages.set(r.evidence_id, list);
    }
  }
  // Each item's words, worked out once, and an index from word to items (security review 12, F9).
  const prepared = entries.map((e) => {
    const own = new Set(terms(e.kind === "email" ? e.label : [e.label, e.details, ...e.sources.map((c) => c.quote)].join("\n").slice(0, 20_000)));
    const all = new Set(own);
    for (const p of e.kind === "email" ? emailPassages.get(e.evidenceId!) ?? [] : []) for (const w of p.words) all.add(w);
    return { e, own, all };
  });
  const byWord = new Map<string, number[]>();
  prepared.forEach((p, i) => { for (const w of p.all) { const l = byWord.get(w); if (l) l.push(i); else byWord.set(w, [i]); } });

  // Versions and near-duplicates of one document count as one source (a draft doesn't corroborate its final),
  // using the links Huis already keeps between similar documents (visible only when both are).
  const parent = new Map<string, string>();
  const root = (id: string): string => {
    let r = id;
    for (let i = 0; i < 1000 && parent.has(r) && parent.get(r) !== r; i++) r = parent.get(r)!;
    if (r !== id) parent.set(id, r);
    return r;
  };
  for (const p of (await s.client.query<{ item_a: string; item_b: string }>(
    "SELECT item_a, item_b FROM huis.evidence_similarity WHERE matter_id = $1 LIMIT 50000", [matterId])).rows) {
    const [a, b] = [root(p.item_a), root(p.item_b)];
    if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
  }
  /** An item's sources (documents, emails, notes); none for an item nobody has cited yet. */
  const sourcesOf = (e: TimelineEntry): string[] =>
    e.kind === "email" ? [e.evidenceId!] : [...new Set(e.sources.map((c) => (c.evidenceId ?? c.noteId)!))];

  const flags: PotentialContradiction[] = [];
  for (const st of wanted) {
    const need = topicsNeeded(st.topics);
    const own = root(st.source);
    const candidates = new Set(st.topics.flatMap((t) => byWord.get(t) ?? []));
    const items: (ConflictingItem & { sources: string[]; rawSources: string[] })[] = [];
    for (const i of [...candidates].sort((a, b) => a - b)) {
      const { e, all } = prepared[i]!;
      if (st.before && e.date >= st.before) continue;
      const raw = sourcesOf(e);
      // Never the statement's own document or note (or another version of it)…
      if (raw.length && raw.every((x) => root(x) === own)) continue;
      // …and it never counts as corroborating itself (security review 12, F8).
      const sources = [...new Set(raw.map(root))].filter((x) => x !== own);
      const matched = st.topics.filter((t) => all.has(t));
      if (matched.length < need) continue;
      let passage: ConflictingItem["passage"] = null;
      if (e.kind === "email") {
        // The email's passage that mentions the most topic words (cited if confirmed).
        let best = 0;
        for (const p of emailPassages.get(e.evidenceId!) ?? []) {
          const n = st.topics.filter((t) => p.words.has(t)).length;
          if (n > best) { best = n; passage = { start: p.start, end: p.end, text: p.content }; }
        }
      }
      items.push({
        key: e.key, date: e.date, kind: e.kind, label: e.label, nodeId: e.nodeId, evidenceId: e.evidenceId, status: e.status,
        matched, sources, rawSources: raw, passage,
        sourceTitles: e.kind === "email" ? ["This email"] : [...new Set(e.sources.map((c) => c.sourceTitle))],
      });
      if (items.length >= 1000) break;
    }
    if (!items.length) continue;
    items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    // Only cited evidence counts towards confidence; items with no source yet don't (security review 12, F7).
    const distinct = new Set(items.flatMap((i) => i.sources)).size;
    const unsourced = items.filter((i) => i.rawSources.length === 0).length;
    const confidence = confidenceFor(distinct);
    const words = [...new Set(items.flatMap((i) => i.matched))];
    const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
    const collapsed = new Set(items.flatMap((i) => i.rawSources.map(root).filter((x) => x !== own))).size < new Set(items.flatMap((i) => i.rawSources.filter((x) => root(x) !== own))).size;
    const why = `${plural(items.length, st.before ? "earlier item" : "item")} from ${plural(distinct, "different source")} ` +
      (collapsed ? "(versions of one document count once) " : "") +
      (unsourced ? `(${unsourced} with no source yet, not counted) ` : "") +
      `${items.length === 1 ? "mentions" : "mention"} ${words.map((w) => `“${w}”`).join(", ")}` +
      (st.before ? `, dated before ${st.beforeText ? `the statement's “${st.beforeText}”` : st.before}` : " (the statement gives no date, so any date counts)") + ".";
    const shown = items.slice(0, MAX_ITEMS_PER_FLAG).map(({ sources: _s, rawSources: _r, ...i }) => i);
    flags.push({
      key: st.key,
      version: flagVersion(st.key, shown.map((i) => i.key)),
      statement: {
        quote: st.quote, evidenceId: st.evidenceId, noteId: st.noteId, sourceTitle: st.sourceTitle, start: st.start, end: st.end,
        topics: st.topics, before: st.before, beforeText: st.beforeText,
      },
      conflicting: shown, confidence, why, decision: null, statementNodeId: null,
    });
  }
  const order: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
  flags.sort((a, b) => order[a.confidence] - order[b.confidence] || a.statement.sourceTitle.localeCompare(b.statement.sourceTitle) || a.statement.start - b.statement.start);
  return { flags, truncated };
}

/** Potential contradictions to decide, the rejected ones (to reconsider), and the confirmed ones. */
export async function getContradictions(s: FirmSession, matterId: string): Promise<ContradictionReport> {
  reader(s);
  await getMatter(s, matterId);
  const { flags, truncated } = await compute(s, matterId);
  const decisions = (await s.client.query<{ flag_key: string; decision: "confirmed" | "rejected"; statement_node_id: string | null; decided_at: Date; label: string | null }>(
    `SELECT d.flag_key, d.decision, d.statement_node_id, d.decided_at, n.label
       FROM huis.contradiction_decisions d LEFT JOIN huis.dna_nodes n ON n.id = d.statement_node_id
      WHERE d.matter_id = $1 ORDER BY d.decided_at DESC LIMIT 5000`, [matterId])).rows
    // A confirmed contradiction whose statement was since deleted from Case DNA no longer counts: it can be decided again.
    .filter((d) => d.decision === "rejected" || d.statement_node_id != null);
  const byKey = new Map(decisions.map((d) => [d.flag_key, d]));
  for (const f of flags) {
    const d = byKey.get(f.key);
    if (d) { f.decision = d.decision; f.statementNodeId = d.statement_node_id; }
  }
  return {
    potential: flags.filter((f) => !f.decision),
    rejected: flags.filter((f) => f.decision === "rejected"),
    // A confirmed contradiction lives on in Case DNA (shown while its statement is visible to this person).
    confirmed: decisions.filter((d) => d.decision === "confirmed").map((d) => ({
      key: d.flag_key, statementNodeId: d.label == null ? null : d.statement_node_id, label: d.label, decidedAt: d.decided_at,
    })),
    truncated,
  };
}

const keyInput = z.string().regex(/^[0-9a-f]{64}$/);

/** The flag as this person can see it right now (never one sent by the browser). */
async function currentFlag(s: FirmSession, matterId: string, key: unknown): Promise<PotentialContradiction> {
  const k = keyInput.safeParse(key);
  if (!k.success) throw new NotFoundError("Potential contradiction");
  await getMatter(s, matterId);
  const f = (await compute(s, matterId, k.data)).flags.find((x) => x.key === k.data);
  if (!f) throw new NotFoundError("Potential contradiction");
  return f;
}

/** Where to cite an email that conflicts: its passage about the subject, or else its subject line. */
function emailRange(text: string, passage: ConflictingItem["passage"]): { start: number; end: number } | null {
  if (passage) return { start: passage.start, end: passage.end };
  const m = /^Subject: .*$/m.exec(text.slice(0, 20_000));
  return m && m[0].length > "Subject: ".length ? { start: m.index, end: m.index + m[0].length } : null;
}

/**
 * Confirms a potential contradiction, exactly as the attorney reviewed it
 * (`version` must match what is shown now, or nothing happens): the statement
 * becomes a confirmed Case DNA fact, cited to the exact words where it was
 * said, and each conflicting item is linked "contradicts" to it. Huis's
 * suggested events among them are confirmed, and a conflicting email becomes
 * a fact cited to its passage about the subject (or its subject line). An
 * item that can't be cited is left out. Everything goes through the ordinary
 * Case DNA rules, in one transaction.
 */
export async function confirmContradiction(s: FirmSession, matterId: string, key: unknown, version?: unknown): Promise<string> {
  writer(s);
  const f = await currentFlag(s, matterId, key);
  if (typeof version !== "string" || version !== f.version) {
    throw new UserFacingError("This potential contradiction has changed since it was shown (new or removed evidence). Please review it again.", 409);
  }
  // A confirmation whose statement was deleted from Case DNA can be made again; any other decision stands.
  await s.client.query(
    "DELETE FROM huis.contradiction_decisions WHERE matter_id = $1 AND flag_key = $2 AND decision = 'confirmed' AND statement_node_id IS NULL", [matterId, f.key]);
  const existing = (await s.client.query("SELECT 1 FROM huis.contradiction_decisions WHERE matter_id = $1 AND flag_key = $2", [matterId, f.key])).rowCount;
  if (existing) throw new NotFoundError("Potential contradiction");
  const st = f.statement;
  const label = `Statement: “${st.quote.length > 280 ? `${st.quote.slice(0, 279)}…` : st.quote}”`;
  const statementId = await addNode(s, matterId, {
    kind: "fact", label, details: `From ${st.sourceTitle}. Marked as contradicted by the linked evidence.`,
  });
  // The citation must quote the statement itself (security review 12, F1 and F2), or nothing is saved.
  await citeExactly(s, { matterId, nodeId: statementId, evidenceId: st.evidenceId, noteId: st.noteId, start: st.start, end: st.end, expect: st.quote });
  let linked = 0;
  for (const item of f.conflicting) {
    let fromId = item.nodeId;
    if (!fromId && item.evidenceId) {
      // Every fact cites its source (security review 12, F3): an email that can't be cited is left out.
      const text = await sourceText(s, item.evidenceId, null);
      const range = text == null ? null : emailRange(text, item.passage);
      if (!text || !range) continue;
      // Undated, so the email doesn't appear twice on the timeline (the email itself is already there).
      fromId = await addNode(s, matterId, { kind: "fact", label: `Email of ${item.date}: ${item.label}`.slice(0, 300) });
      await citeExactly(s, { matterId, nodeId: fromId, evidenceId: item.evidenceId, noteId: null, start: range.start, end: range.end, text });
    }
    if (!fromId) continue;
    if (item.status === "suggested") await decideNode(s, fromId, "confirmed");
    await linkNodes(s, fromId, statementId, "contradicts");
    linked++;
  }
  if (!linked) throw new UserFacingError("None of the conflicting evidence can be cited any more. Nothing was saved.");
  await s.client.query(
    "INSERT INTO huis.contradiction_decisions (firm_id, matter_id, flag_key, decision, statement_node_id, decided_by) VALUES ($1, $2, $3, 'confirmed', $4, $5)",
    [s.actor.firmId, matterId, f.key, statementId, s.actor.userId]);
  await recordAudit(s, "contradiction.confirmed", { targetType: "dna", targetId: statementId, matterId, metadata: { items: String(linked), confidence: f.confidence } });
  return statementId;
}

/** Rejects a potential contradiction, so Huis doesn't suggest it again. */
export async function rejectContradiction(s: FirmSession, matterId: string, key: unknown): Promise<void> {
  writer(s);
  const f = await currentFlag(s, matterId, key);
  const r = await s.client.query(
    `INSERT INTO huis.contradiction_decisions (firm_id, matter_id, flag_key, decision, decided_by) VALUES ($1, $2, $3, 'rejected', $4)
     ON CONFLICT (matter_id, flag_key) DO NOTHING`, [s.actor.firmId, matterId, f.key, s.actor.userId]);
  if (!r.rowCount) throw new NotFoundError("Potential contradiction");
  await recordAudit(s, "contradiction.rejected", { targetType: "matter", targetId: matterId, matterId, metadata: { confidence: f.confidence } });
}

/** Withdraws a rejection (or a confirmation whose statement was deleted), so it is suggested again. */
export async function reconsiderContradiction(s: FirmSession, matterId: string, key: unknown): Promise<void> {
  writer(s);
  const k = keyInput.safeParse(key);
  if (!k.success) throw new NotFoundError("Decision");
  await getMatter(s, matterId);
  const r = await s.client.query(
    `DELETE FROM huis.contradiction_decisions
      WHERE matter_id = $1 AND flag_key = $2 AND (decision = 'rejected' OR statement_node_id IS NULL)`, [matterId, k.data]);
  if (!r.rowCount) throw new NotFoundError("Decision");
  await recordAudit(s, "contradiction.reconsidered", { targetType: "matter", targetId: matterId, matterId });
}
