import { terms } from "./local";
import { findDates } from "../dna/extract";

/**
 * Huis AI Router: sends each question to the specialized agent that fits it,
 * by fixed, explainable rules (no AI), and says why. The attorney can always
 * choose the agent instead.
 *
 * Agents (Phase 6 part 2), all built on what Huis already has, answering only
 * from what the reader can open:
 *   timeline        — the Matter's chronology, for a date range, a person or a subject
 *   email           — filed email, by person or subject
 *   evidence        — passages that may prove or disprove a claim's element
 *   contradictions  — potential and confirmed contradictions
 *   privilege       — documents in the privileged area or marked privileged / work product
 *   matter          — the Matter Brain (the default)
 */
export const AGENTS = ["timeline", "email", "evidence", "contradictions", "privilege", "matter"] as const;
export type AgentName = (typeof AGENTS)[number];

export const AGENT_LABELS: Record<AgentName, string> = {
  timeline: "Timeline agent", email: "Email agent", evidence: "Evidence agent", contradictions: "Contradiction agent",
  privilege: "Privilege agent", matter: "Matter Brain",
};

export interface RouteContext {
  /** Confirmed people and organizations in the Matter's Case DNA. */
  people: { id: string; label: string; email: string | null }[];
  /** Confirmed claim elements. */
  elements: { id: string; label: string; claim: string }[];
}

export interface AgentParams {
  from?: string;
  to?: string;
  personId?: string;
  elementId?: string;
  /** Word stems the question is about (used to narrow results). */
  topics?: string[];
}

export interface Route { agent: AgentName; params: AgentParams; why: string }

const RULES: { agent: AgentName; re: RegExp; reason: string }[] = [
  { agent: "contradictions", re: /\b(contradict\w*|inconsisten\w*|conflicting|conflicts?)\b/i, reason: "the question asks about contradictions" },
  { agent: "privilege", re: /\b(privileg\w*|work[- ]product)\b/i, reason: "the question asks about privilege" },
  { agent: "email", re: /\b(e-?mails?|emailed|correspondence|messages?|wrote|sent)\b/i, reason: "the question asks about email" },
];
const EVIDENCE_WORDS = /\b(evidence|support\w*|prov(?:e|es|ed|ing)|proof|show\w*|establish\w*|element)\b/i;
const TIME_WORDS = /\b(when|timeline|chronolog\w*|dates?|dated|happened|sequence|between|before|after|since|until)\b/i;

/** Words that steer routing or dates; never a subject to narrow by. */
const NOT_TOPICS = new Set(terms(
  "when what who whom which how why where timeline chronology chronological date dates dated happened happen sequence between before after since until " +
  "email emails emailed correspondence message messages wrote sent send evidence support supports supporting prove proves proof show shows establish element " +
  "contradiction contradictions contradict contradicts inconsistent inconsistency conflicting conflict privilege privileged work product " +
  "matter case find list all any every each key important tell give documents document things thing everything about regarding concerning " +
  "build make create discuss discusses discussed discussing mention mentions mentioned mentioning event events occur occurred anything something " +
  "january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec",
));

function dateRange(question: string, explicit: { from?: string; to?: string }): { from?: string; to?: string; text?: string } {
  const dates = findDates(question, 4);
  if (!dates.length) return explicit;
  const before = (d: { index: number }) => question.slice(Math.max(0, d.index - 12), d.index).toLowerCase();
  if (dates.length >= 2) {
    const [a, b] = [dates[0]!.date, dates[1]!.date].sort();
    return { from: a, to: b, text: `${a} to ${b}` };
  }
  const d = dates[0]!;
  if (/\b(after|since|from)\s*$/.test(before(d))) return { from: d.date, text: `from ${d.date}` };
  if (/\b(before|until|till|by)\s*$/.test(before(d))) return { to: d.date, text: `until ${d.date}` };
  return { from: d.date, to: d.date, text: d.date };
}

/** The person a question names: their email, or a name word (3+ letters) that is theirs alone. */
function personIn(question: string, people: RouteContext["people"]): RouteContext["people"][number] | undefined {
  const q = question.toLowerCase();
  const byEmail = people.find((p) => p.email && q.includes(p.email));
  if (byEmail) return byEmail;
  const words = new Set(q.split(/[^\p{L}\p{N}'-]+/u).filter((w) => w.length >= 3));
  const hits = people.filter((p) => p.label.toLowerCase().split(/[^\p{L}\p{N}'-]+/u).some((w) => w.length >= 3 && words.has(w)));
  if (!hits.length) return undefined;
  // Prefer the person matching most name words (e.g. "Cindy Manager" over another "Cindy").
  const score = (p: RouteContext["people"][number]) => p.label.toLowerCase().split(/[^\p{L}\p{N}'-]+/u).filter((w) => words.has(w)).length;
  hits.sort((a, b) => score(b) - score(a));
  return hits.length === 1 || score(hits[0]!) > score(hits[1]!) ? hits[0] : undefined;
}

/** The claim element a question is about: the one sharing the most words with it (at least two). */
function elementIn(question: string, elements: RouteContext["elements"]): RouteContext["elements"][number] | undefined {
  const q = new Set(terms(question));
  let best: RouteContext["elements"][number] | undefined;
  let bestScore = 1;
  for (const e of elements) {
    const score = new Set(terms(e.label).filter((t) => q.has(t))).size;
    if (score > bestScore) { best = e; bestScore = score; }
  }
  return best;
}

/** Which agent answers a question, with what, and why. `choice` is the attorney's own pick ("auto" lets Huis route). */
export function route(question: string, ctx: RouteContext, choice: AgentName | "auto" = "auto"): Route {
  const q = question.slice(0, 2000);
  const person = personIn(q, ctx.people);
  // People's names identify a person, not a subject (all of them, not just the one picked).
  const nameWords = new Set(ctx.people.flatMap((p) => terms(p.label)));
  const topics = [...new Set(terms(q).filter((t) => !NOT_TOPICS.has(t) && !nameWords.has(t) && !/^\d+$/.test(t)))].slice(0, 12);
  const range = dateRange(q, {});
  const element = elementIn(q, ctx.elements);

  let agent: AgentName = "matter";
  let reason = "no specialized agent fits, so the Matter Brain answers from the Matter's passages";
  if (choice !== "auto") {
    agent = choice;
    reason = "you chose this agent";
  } else {
    const rule = RULES.find((r) => r.re.test(q));
    if (rule) { agent = rule.agent; reason = rule.reason; }
    else if (element && EVIDENCE_WORDS.test(q)) { agent = "evidence"; reason = "the question asks for evidence on a claim element"; }
    else if (TIME_WORDS.test(q) || range.from || range.to) { agent = "timeline"; reason = "the question asks when, or about dates"; }
  }

  const params: AgentParams = {};
  const notes: string[] = [];
  if (agent === "timeline" || agent === "email") {
    if (range.from) params.from = range.from;
    if (range.to) params.to = range.to;
    if (range.text) notes.push(`dates ${range.text}`);
    if (person) { params.personId = person.id; notes.push(`person ${person.label}`); }
  }
  if (agent === "evidence") {
    if (element) { params.elementId = element.id; notes.push(`element "${element.label}" (${element.claim})`); }
    else notes.push("no claim element named in the question");
  }
  if (agent !== "contradictions" && agent !== "matter" && topics.length) {
    params.topics = topics;
    notes.push(`about ${topics.map((t) => `“${t}”`).join(", ")}`);
  }
  return { agent, params, why: `${AGENT_LABELS[agent]}: ${reason}${notes.length ? `; ${notes.join("; ")}` : ""}.` };
}
