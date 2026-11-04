import { z } from "zod";
import type { FirmSession } from "../db/tenant";
import { NotFoundError, PermissionDeniedError, UserFacingError } from "../errors";
import { INTERNAL_ROLES } from "../security/permissions";
import { terms } from "../ai/local";
import { AGENTS, route, type AgentName, type AgentParams, type Route } from "../ai/router";
import { recordAudit } from "./audit";
import { askMatter, type FoundPassage } from "./brain";
import { getContradictions } from "./contradictions";
import { findEvidenceFor } from "./dna";
import { getTimeline, type TimelineEntry } from "./timeline";
import { myConversation } from "./workspace";

/**
 * Specialized agents behind one interface (Phase 6 part 2).
 *
 * A question in an AI Workspace conversation goes to the agent that fits it
 * (the router's fixed rules, or the attorney's own choice). A Matter Brain
 * answer is saved as before. Any other agent's turn saves only the question,
 * the agent and its settings; its answer is worked out again, as the person
 * reading, every time it's shown, from what that person can open. Nothing an
 * agent says can be written into the database, and sharing never reveals
 * anything a reader can't see.
 */

function staff(s: FirmSession) {
  if (!INTERNAL_ROLES.has(s.actor.role)) throw new PermissionDeniedError("use the AI Workspace");
}

/** What a turn may be asked with (anything else is dropped). */
const paramsSchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  personId: z.uuid().optional(),
  elementId: z.uuid().optional(),
  topics: z.array(z.string().regex(/^[\p{L}\p{N}]{1,40}$/u)).max(12).optional(),
}).strip();

/** People and claim elements in the Matter (as this person sees them), for routing. */
async function routeContext(s: FirmSession, matterId: string) {
  const people = (await s.client.query<{ id: string; label: string; email: string | null }>(
    `SELECT id, label, email FROM huis.dna_nodes WHERE matter_id = $1 AND kind IN ('person', 'organization') AND status = 'confirmed'
      ORDER BY label LIMIT 2000`, [matterId])).rows;
  const elements = (await s.client.query<{ id: string; label: string; claim: string }>(
    `SELECT e.id, e.label, c.label AS claim FROM huis.dna_nodes e
       JOIN huis.dna_links l ON l.from_id = e.id AND l.relation = 'element_of' AND l.status = 'confirmed'
       JOIN huis.dna_nodes c ON c.id = l.to_id
      WHERE e.matter_id = $1 AND e.kind = 'element' AND e.status = 'confirmed' LIMIT 2000`, [matterId])).rows;
  return { people, elements };
}

/** Where a question would go, without asking it (shown before asking, and used by askAgent). */
export async function previewRoute(s: FirmSession, matterId: string, question: string, choice: AgentName | "auto" = "auto"): Promise<Route> {
  staff(s);
  return route(question, await routeContext(s, matterId), choice);
}

/** Asks a question in one's own conversation, through the router (or the agent the attorney chose). */
export async function askAgent(s: FirmSession, conversationId: string, question: unknown, choice: unknown = "auto"): Promise<{ agent: AgentName; id: string }> {
  staff(s);
  const q = z.string().trim().min(1).max(2000).parse(question);
  const pick = z.enum([...AGENTS, "auto"]).catch("auto").parse(choice);
  const c = await myConversation(s, conversationId);
  const r = route(q, await routeContext(s, c.matterId), pick);
  if (r.agent === "matter") {
    const id = await askMatter(s, c.matterId, q, c.id);
    await s.client.query("UPDATE huis.ai_conversations SET updated_at = now() WHERE id = $1", [c.id]);
    return { agent: "matter", id };
  }
  const id = (await s.client.query<{ id: string }>(
    `INSERT INTO huis.ai_agent_turns (firm_id, matter_id, conversation_id, asked_by, question, agent, params, why)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [s.actor.firmId, c.matterId, c.id, s.actor.userId, q, r.agent, JSON.stringify(paramsSchema.parse(r.params)), r.why.slice(0, 2000)])).rows[0]!.id;
  await s.client.query("UPDATE huis.ai_conversations SET updated_at = now() WHERE id = $1", [c.id]);
  // The question itself is work product: never in the audit log.
  await recordAudit(s, "ai.agent_asked", { targetType: "matter", targetId: c.matterId, matterId: c.matterId, metadata: { agent: r.agent } });
  return { agent: r.agent, id };
}

// ---------------------------------------------------------------------------
// Running an agent (always as the person reading)
// ---------------------------------------------------------------------------
export interface PrivilegedItem { id: string; title: string; folder: string; classification: string; privilegedArea: boolean }
export interface ContradictionSummary { quote: string; sourceTitle: string; confidence: string; why: string; items: number }

export type AgentResult =
  | { kind: "timeline" | "email"; entries: TimelineEntry[]; total: number; notes: string[] }
  | { kind: "evidence"; element: { id: string; label: string } | null; passages: FoundPassage[]; notes: string[] }
  | { kind: "contradictions"; potential: ContradictionSummary[]; potentialCount: number; confirmed: number; rejected: number; notes: string[] }
  | { kind: "privilege"; items: PrivilegedItem[]; total: number; notes: string[] };

/** Entries shown per agent answer. */
export const SHOWN = 50;

async function runTimeline(s: FirmSession, matterId: string, p: AgentParams, emailsOnly: boolean): Promise<AgentResult> {
  const notes: string[] = [];
  if (p.personId) {
    const visible = (await s.client.query("SELECT 1 FROM huis.dna_nodes WHERE id = $1 AND matter_id = $2", [p.personId, matterId])).rowCount;
    if (!visible) notes.push("The person this question named is no longer in Case DNA, so everyone is included.");
  }
  const personOk = p.personId && !notes.length ? p.personId : undefined;
  const tl = await getTimeline(s, matterId, { from: p.from, to: p.to, person: personOk });
  let entries = emailsOnly ? tl.entries.filter((e) => e.kind === "email") : tl.entries;
  if (p.topics?.length) {
    // An entry counts when its own words (and, for an email, its text) mention one of the subject words.
    const emailIds = entries.filter((e) => e.kind === "email").map((e) => e.evidenceId!);
    const bodies = new Map<string, string>();
    if (emailIds.length) {
      for (const r of (await s.client.query<{ evidence_id: string; content: string }>(
        `SELECT evidence_id, string_agg(left(content, 4000), ' ' ORDER BY chunk_no) AS content FROM huis.brain_chunks
          WHERE matter_id = $1 AND evidence_id = ANY($2::uuid[]) AND chunk_no < 8 GROUP BY evidence_id`, [matterId, emailIds])).rows) {
        bodies.set(r.evidence_id, r.content);
      }
    }
    const want = new Set(p.topics);
    entries = entries.filter((e) => {
      const text = [e.label, e.details, e.from ?? "", ...e.to, ...e.people.map((x) => x.label), ...e.sources.map((c) => c.quote),
        e.evidenceId ? bodies.get(e.evidenceId) ?? "" : ""].join("\n");
      return terms(text.slice(0, 40_000)).some((t) => want.has(t));
    });
  }
  return { kind: emailsOnly ? "email" : "timeline", entries: entries.slice(0, SHOWN), total: entries.length, notes };
}

async function runEvidence(s: FirmSession, matterId: string, p: AgentParams): Promise<AgentResult> {
  if (!p.elementId) return { kind: "evidence", element: null, passages: [], notes: ["Name a claim element (from Case DNA) to find evidence for it."] };
  const el = (await s.client.query<{ id: string; label: string }>(
    "SELECT id, label FROM huis.dna_nodes WHERE id = $1 AND matter_id = $2 AND kind = 'element'", [p.elementId, matterId])).rows[0];
  if (!el) return { kind: "evidence", element: null, passages: [], notes: ["That claim element is no longer in Case DNA."] };
  try {
    return { kind: "evidence", element: el, passages: await findEvidenceFor(s, el.id), notes: [] };
  } catch (e) {
    if (e instanceof UserFacingError) return { kind: "evidence", element: el, passages: [], notes: [e.message] };
    throw e;
  }
}

async function runContradictions(s: FirmSession, matterId: string): Promise<AgentResult> {
  const r = await getContradictions(s, matterId);
  return {
    kind: "contradictions",
    potential: r.potential.slice(0, 10).map((f) => ({
      quote: f.statement.quote, sourceTitle: f.statement.sourceTitle, confidence: f.confidence, why: f.why, items: f.conflicting.length,
    })),
    potentialCount: r.potential.length, confirmed: r.confirmed.length, rejected: r.rejected.length,
    notes: r.truncated ? ["This Matter is very large: only part of it was examined."] : [],
  };
}

async function runPrivilege(s: FirmSession, matterId: string, p: AgentParams): Promise<AgentResult> {
  // Row-level security: only items this person can open.
  const rows = (await s.client.query<{ id: string; title: string; folder: string; classification: string; area: boolean }>(
    `SELECT i.id, i.original_filename AS title, f.name AS folder, f.classification::text AS classification, f.is_privileged_area AS area
       FROM huis.evidence_items i JOIN huis.matter_folders f ON f.id = i.folder_id
      WHERE i.matter_id = $1 AND i.status = 'clean'
        AND (f.is_privileged_area OR f.classification IN ('attorney_client_privileged', 'attorney_work_product'))
      ORDER BY f.is_privileged_area DESC, f.name, i.original_filename LIMIT 2000`, [matterId])).rows;
  let items = rows.map((r) => ({ id: r.id, title: r.title, folder: r.folder, classification: r.classification, privilegedArea: r.area }));
  if (p.topics?.length) {
    const want = new Set(p.topics);
    const narrowed = items.filter((i) => terms(i.title).some((t) => want.has(t)));
    if (narrowed.length) items = narrowed;
  }
  return {
    kind: "privilege", items: items.slice(0, SHOWN), total: items.length,
    notes: ["Listed because of where they are filed (the privileged area, or a folder marked privileged or work product). Whether privilege applies is the attorney's call."],
  };
}

export async function runAgent(s: FirmSession, matterId: string, agent: AgentName, params: unknown): Promise<AgentResult> {
  staff(s);
  const p = paramsSchema.catch({}).parse(params);
  switch (agent) {
    case "timeline": return runTimeline(s, matterId, p, false);
    case "email": return runTimeline(s, matterId, p, true);
    case "evidence": return runEvidence(s, matterId, p);
    case "contradictions": return runContradictions(s, matterId);
    case "privilege": return runPrivilege(s, matterId, p);
    default: throw new NotFoundError("Agent");
  }
}

export interface AgentTurn {
  id: string; question: string; agent: Exclude<AgentName, "matter">; why: string; createdAt: Date; mine: boolean; result: AgentResult;
}

/** A conversation's agent turns, each answered now, as this person (the conversation's own visibility applies). */
export async function agentTurns(s: FirmSession, conversationId: string): Promise<AgentTurn[]> {
  staff(s);
  const rows = (await s.client.query<{ id: string; matter_id: string; question: string; agent: AgentName; params: unknown; why: string; created_at: Date; asked_by: string }>(
    `SELECT id, matter_id, question, agent, params, why, created_at, asked_by FROM huis.ai_agent_turns
      WHERE conversation_id = $1 ORDER BY created_at, id LIMIT 200`, [conversationId])).rows;
  const out: AgentTurn[] = [];
  for (const r of rows) {
    out.push({
      id: r.id, question: r.question, agent: r.agent as AgentTurn["agent"], why: r.why, createdAt: r.created_at, mine: r.asked_by === s.actor.userId,
      result: await runAgent(s, r.matter_id, r.agent, r.params),
    });
  }
  return out;
}
