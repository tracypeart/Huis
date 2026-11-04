import { createHash } from "node:crypto";
import { z } from "zod";
import type { FirmSession } from "../db/tenant";
import { NotFoundError, PermissionDeniedError } from "../errors";
import { INTERNAL_ROLES } from "../security/permissions";
import {
  confidenceFor, findStatements, sharedTopics, topicsNeeded, type Confidence,
} from "../contradictions/detect";
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

interface PassageRow { evidence_id: string | null; note_id: string | null; content: string; char_start: number; char_end: number; title: string }

/** Every potential contradiction in the Matter, worked out as this person. */
async function compute(s: FirmSession, matterId: string): Promise<{ flags: PotentialContradiction[]; truncated: boolean }> {
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
  const truncated = passages.length > MAX_PASSAGES;
  if (!passages.length) return { flags: [], truncated };

  // The latest year in each source completes "until May" (from all its passages the person can open).
  const sourceIds = [...new Set(passages.map((p) => p.evidence_id ?? p.note_id!))];
  const years = new Map<string, number>((await s.client.query<{ src: string; y: number }>(
    `SELECT coalesce(c.evidence_id, c.note_id)::text AS src, max(m[1]::int) AS y
       FROM huis.brain_chunks c, LATERAL regexp_matches(left(c.content, 4000), '\\m(19[0-9]{2}|20[0-9]{2})\\M', 'g') m
      WHERE c.matter_id = $1 AND coalesce(c.evidence_id, c.note_id) = ANY($2::uuid[])
      GROUP BY 1`, [matterId, sourceIds])).rows.map((r) => [r.src, r.y]));

  // Statements, once each (passages overlap).
  const seen = new Set<string>();
  const statements: (PotentialContradiction["statement"] & { source: string; key: string })[] = [];
  for (const p of passages.slice(0, MAX_PASSAGES)) {
    const source = p.evidence_id ?? p.note_id!;
    for (const st of findStatements(p.content, years.get(source) ?? null)) {
      const start = p.char_start + st.start;
      const key = flagKey(source, start, st.quote);
      if (seen.has(key)) continue;
      seen.add(key);
      statements.push({
        key, source, quote: st.quote, evidenceId: p.evidence_id, noteId: p.note_id, sourceTitle: String(p.title).slice(0, 300),
        start, end: p.char_start + st.end, topics: st.topics, before: st.before, beforeText: st.beforeText,
      });
    }
  }
  if (!statements.length) return { flags: [], truncated };

  // What they might contradict: the timeline (Case DNA's dated items and filed email), as this person sees it.
  const entries = (await getTimeline(s, matterId)).entries.filter((e) => e.kind !== "damage");
  const emailIds = entries.filter((e) => e.kind === "email").map((e) => e.evidenceId!);
  const emailText = new Map<string, { content: string; start: number; end: number }[]>();
  if (emailIds.length) {
    const rows = (await s.client.query<{ evidence_id: string; content: string; char_start: number; char_end: number }>(
      `SELECT evidence_id, content, char_start, char_end FROM huis.brain_chunks
        WHERE matter_id = $1 AND evidence_id = ANY($2::uuid[]) ORDER BY evidence_id, chunk_no LIMIT ${MAX_EMAIL_PASSAGES}`, [matterId, emailIds])).rows;
    for (const r of rows) {
      const list = emailText.get(r.evidence_id) ?? [];
      if (list.length < 8) list.push({ content: r.content, start: r.char_start, end: r.char_end });
      emailText.set(r.evidence_id, list);
    }
  }
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
  const sourcesOf = (e: TimelineEntry): string[] =>
    e.kind === "email" ? [e.evidenceId!] : e.sources.length ? [...new Set(e.sources.map((c) => (c.evidenceId ?? c.noteId)!))] : [`item:${e.key}`];

  const flags: PotentialContradiction[] = [];
  for (const st of statements) {
    const need = topicsNeeded(st.topics);
    const items: (ConflictingItem & { sources: string[]; rawSources: string[] })[] = [];
    for (const e of entries) {
      if (st.before && e.date >= st.before) continue;
      const sources = [...new Set(sourcesOf(e).map(root))];
      // Never the statement's own document or note (or another version of it).
      if (sources.every((x) => x === root(st.source))) continue;
      let matched: string[];
      let passage: ConflictingItem["passage"] = null;
      if (e.kind === "email") {
        // The email's subject, and its passage that mentions the most topic words (cited if confirmed).
        let best: string[] = [];
        for (const c of emailText.get(e.evidenceId!) ?? []) {
          const m = sharedTopics(st.topics, c.content);
          if (m.length > best.length) { best = m; passage = { start: c.start, end: c.end, text: c.content }; }
        }
        matched = [...new Set([...sharedTopics(st.topics, e.label), ...best])];
      } else {
        matched = sharedTopics(st.topics, [e.label, e.details, ...e.sources.map((c) => c.quote)].join("\n"));
      }
      if (matched.length < need) continue;
      items.push({
        key: e.key, date: e.date, kind: e.kind, label: e.label, nodeId: e.nodeId, evidenceId: e.evidenceId, status: e.status,
        matched, sources, rawSources: sourcesOf(e), passage,
        sourceTitles: e.kind === "email" ? ["This email"] : [...new Set(e.sources.map((c) => c.sourceTitle))],
      });
    }
    if (!items.length) continue;
    const distinct = new Set(items.flatMap((i) => i.sources)).size;
    const confidence = confidenceFor(distinct);
    const words = [...new Set(items.flatMap((i) => i.matched))];
    const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
    const collapsed = new Set(items.flatMap((i) => i.rawSources)).size > distinct;
    const why = `${plural(items.length, st.before ? "earlier item" : "item")} from ${plural(distinct, "different source")} ` +
      (collapsed ? "(versions of one document count once) " : "") +
      `${items.length === 1 ? "mentions" : "mention"} ${words.map((w) => `“${w}”`).join(", ")}` +
      (st.before ? `, dated before ${st.beforeText ? `the statement's “${st.beforeText}”` : st.before}` : " (the statement gives no date, so any date counts)") + ".";
    flags.push({
      key: st.key,
      statement: {
        quote: st.quote, evidenceId: st.evidenceId, noteId: st.noteId, sourceTitle: st.sourceTitle, start: st.start, end: st.end,
        topics: st.topics, before: st.before, beforeText: st.beforeText,
      },
      conflicting: items.slice(0, MAX_ITEMS_PER_FLAG).map(({ sources: _s, rawSources: _r, ...i }) => i),
      confidence, why, decision: null, statementNodeId: null,
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
      WHERE d.matter_id = $1 ORDER BY d.decided_at DESC LIMIT 5000`, [matterId])).rows;
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
  const f = (await compute(s, matterId)).flags.find((x) => x.key === k.data);
  if (!f) throw new NotFoundError("Potential contradiction");
  return f;
}

/**
 * Confirms a potential contradiction: the statement becomes a confirmed Case
 * DNA fact (cited to where it was said), and each conflicting item is linked
 * "contradicts" to it. Huis's suggested events among them are confirmed, and a
 * conflicting email becomes a fact cited to the passage that mentions the
 * subject. Everything goes through the ordinary Case DNA rules.
 */
export async function confirmContradiction(s: FirmSession, matterId: string, key: unknown): Promise<string> {
  writer(s);
  const f = await currentFlag(s, matterId, key);
  const existing = (await s.client.query("SELECT 1 FROM huis.contradiction_decisions WHERE matter_id = $1 AND flag_key = $2", [matterId, f.key])).rowCount;
  if (existing) throw new NotFoundError("Potential contradiction");
  const st = f.statement;
  const label = `Statement: “${st.quote.length > 280 ? `${st.quote.slice(0, 279)}…` : st.quote}”`;
  const statementId = await addNode(s, matterId, {
    kind: "fact", label, details: `From ${st.sourceTitle}. Marked as contradicted by the linked evidence.`,
  });
  await s.client.query(
    `INSERT INTO huis.dna_citations (firm_id, matter_id, node_id, evidence_id, note_id, char_start, char_end, quote)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'x')`,
    [s.actor.firmId, matterId, statementId, st.evidenceId, st.noteId, st.start, st.end]);
  let linked = 0;
  for (const item of f.conflicting) {
    let fromId = item.nodeId;
    if (fromId && item.status === "suggested") await decideNode(s, fromId, "confirmed");
    if (!fromId && item.evidenceId) {
      // Undated, so the email doesn't appear twice on the timeline (the email itself is already there).
      fromId = await addNode(s, matterId, { kind: "fact", label: `Email of ${item.date}: ${item.label}`.slice(0, 300) });
      const p = item.passage;
      if (p) {
        await s.client.query(
          `INSERT INTO huis.dna_citations (firm_id, matter_id, node_id, evidence_id, char_start, char_end, quote)
           VALUES ($1, $2, $3, $4, $5, $6, 'x')`, [s.actor.firmId, matterId, fromId, item.evidenceId, p.start, p.end]);
      }
    }
    if (!fromId) continue;
    await linkNodes(s, fromId, statementId, "contradicts");
    linked++;
  }
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

/** Withdraws a rejection, so the potential contradiction is suggested again. */
export async function reconsiderContradiction(s: FirmSession, matterId: string, key: unknown): Promise<void> {
  writer(s);
  const k = keyInput.safeParse(key);
  if (!k.success) throw new NotFoundError("Decision");
  await getMatter(s, matterId);
  const r = await s.client.query("DELETE FROM huis.contradiction_decisions WHERE matter_id = $1 AND flag_key = $2 AND decision = 'rejected'", [matterId, k.data]);
  if (!r.rowCount) throw new NotFoundError("Decision");
  await recordAudit(s, "contradiction.reconsidered", { targetType: "matter", targetId: matterId, matterId });
}
