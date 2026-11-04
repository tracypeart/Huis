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

export interface Route {
  agent: AgentName;
  params: AgentParams;
  /** Why this agent, in words that name nothing from Case DNA (saved with the turn). */
  reason: string;
  /** The full explanation, with names (built for whoever is reading; never saved). */
  why: string;
}

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
  "please thanks thank me us our we you can could would should will lawsuit litigation chronology summary summarize overview describe explain " +
  "january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec",
));

const MONTH_NUM: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_YEAR = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?,?\s+(19\d{2}|20\d{2})\b/gi;
const YEAR_ALONE = /\b(?:in|during|throughout|of)\s+(19\d{2}|20\d{2})\b/i;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
const pad = (n: number) => String(n).padStart(2, "0");

/** The word ("after", "before"…) that governs a date: the last one earlier in the same clause (security review 14, F3). */
function direction(question: string, index: number): "after" | "before" | null {
  const clause = question.slice(0, index).split(/[.;?!]/).pop() ?? "";
  const words = [...clause.toLowerCase().matchAll(/\b(after|since|following|from|before|until|till|prior to|by)\b/g)];
  const w = words.at(-1)?.[1];
  return !w ? null : ["before", "until", "till", "prior to", "by"].includes(w) ? "before" : "after";
}

interface Range { from?: string; to?: string; text?: string; note?: string }

/** Dates a question asks about: full dates, a month and year, or a year (security review 14, F3 and F4). */
function dateRange(question: string): Range {
  // Spans: [start, end] of each date written, in order.
  const spans: { from: string; to: string; index: number; end: number }[] = [];
  for (const d of findDates(question, 4)) spans.push({ from: d.date, to: d.date, index: d.index, end: d.index + d.length });
  for (const m of question.matchAll(MONTH_YEAR)) {
    const i = m.index ?? 0;
    // A month already inside a full date ("April 18, 2026") isn't a month on its own.
    if (spans.some((x) => i >= x.index && i < x.end)) continue;
    const y = Number(m[2]);
    const mo = MONTH_NUM[m[1]!.toLowerCase().replace(/\.$/, "")]!;
    spans.push({ from: `${y}-${pad(mo)}-01`, to: lastDay(y, mo), index: i, end: i + m[0].length });
  }
  if (!spans.length) {
    const y = YEAR_ALONE.exec(question);
    if (y) spans.push({ from: `${y[1]}-01-01`, to: `${y[1]}-12-31`, index: y.index, end: y.index + y[0].length });
  }
  spans.sort((a, b) => a.index - b.index);
  if (!spans.length) {
    return /\b(jan(uary)?|feb(ruary)?|march|april|june|july|august|sept(ember)?|october|november|december)\b/i.test(question)
      ? { note: "a month without a year was not used as a date range" } : {};
  }
  if (spans.length >= 2) {
    const from = [spans[0]!.from, spans[1]!.from].sort()[0]!;
    const to = [spans[0]!.to, spans[1]!.to].sort()[1]!;
    return { from, to, text: `${from} to ${to}` };
  }
  const d = spans[0]!;
  const dir = direction(question, d.index);
  if (dir === "after") return { from: d.from, text: `from ${d.from}` };
  if (dir === "before") return { to: d.to, text: `until ${d.to}` };
  return { from: d.from, to: d.to, text: d.from === d.to ? d.from : `${d.from} to ${d.to}` };
}

/** Words that are never enough, alone, to name someone ("the", "company", "bank"…). */
const NOT_NAME_WORDS = new Set((
  "the and for with from about into over under that this these those there their they them then than was were are has have had " +
  "company co corp corporation inc incorporated llc llp ltd limited group holdings partners partnership associates firm law office offices " +
  "department dept division team board bank trust services service solutions systems international national american united global " +
  "county city state court hospital clinic center centre school university college church foundation fund health medical " +
  "will price may june bill mark grant rose hope faith joy dean case march april august"
).split(" "));

const wordsOf = (t: string) => t.split(/[^\p{L}\p{N}'-]+/u).filter(Boolean);
const EMAIL_IN_TEXT = /[^\s<>(),;:"']+@[^\s<>(),;:"']+\.[a-z]{2,}/gi;

/**
 * The person a question names (security review 14, F1 and F2):
 * an email address written in full (the exact address, never part of another), or else
 * their name: every word of it, or a distinctive word of it written with a capital letter.
 * When two people fit equally, nobody is picked (Huis doesn't guess).
 */
function personIn(question: string, people: RouteContext["people"]): RouteContext["people"][number] | undefined {
  const addresses = new Set([...question.matchAll(EMAIL_IN_TEXT)].map((m) => m[0].toLowerCase().replace(/[.]+$/, "")));
  if (addresses.size) {
    const byEmail = people.filter((p) => p.email && addresses.has(p.email));
    return byEmail.length === 1 ? byEmail[0] : undefined;
  }
  const qWords = wordsOf(question.replace(EMAIL_IN_TEXT, " "));
  const lower = new Set(qWords.map((w) => w.toLowerCase()));
  const capitalized = new Set(qWords.filter((w) => /^\p{Lu}/u.test(w)).map((w) => w.toLowerCase()));
  const scored = people.map((p) => {
    const name = wordsOf(p.label.toLowerCase()).filter((w) => w.length >= 2);
    const distinctive = name.filter((w) => w.length >= 3 && !NOT_NAME_WORDS.has(w));
    const all = name.length > 0 && name.every((w) => lower.has(w));
    const some = distinctive.filter((w) => capitalized.has(w)).length;
    return { p, score: all ? 100 + name.length : some };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return undefined;
  return scored.length === 1 || scored[0]!.score > scored[1]!.score ? scored[0]!.p : undefined;
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
  const topics = [...new Set(terms(q.replace(EMAIL_IN_TEXT, " ")).filter((t) => !NOT_TOPICS.has(t) && !nameWords.has(t) && !/^\d+$/.test(t)))].slice(0, 12);
  const range = dateRange(q);
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
  if (agent === "timeline" || agent === "email") {
    if (range.from) params.from = range.from;
    if (range.to) params.to = range.to;
    if (person) params.personId = person.id;
  }
  if (agent === "evidence" && element) params.elementId = element.id;
  if (agent !== "contradictions" && agent !== "matter" && topics.length) params.topics = topics;
  const full = describe(agent, reason, params, {
    person: person ? person.label : undefined,
    element: element && params.elementId ? `"${element.label}" (${element.claim})` : undefined,
    dateNote: agent === "timeline" || agent === "email" ? range.note : undefined,
  });
  return { agent, params, reason, why: full };
}

/**
 * The explanation shown with an answer, built for whoever reads it: names come from Case DNA
 * as that reader sees it (security review 14, F9), so a name that is no longer available isn't shown.
 */
export function describe(agent: AgentName, reason: string, p: AgentParams, names: { person?: string; element?: string; dateNote?: string } = {}): string {
  const notes: string[] = [];
  if (p.from || p.to) notes.push(`dates ${p.from && p.to ? (p.from === p.to ? p.from : `${p.from} to ${p.to}`) : p.from ? `from ${p.from}` : `until ${p.to}`}`);
  if (names.dateNote) notes.push(names.dateNote);
  if (p.personId) notes.push(names.person ? `person ${names.person}` : "a person no longer available to you");
  if (agent === "evidence") notes.push(p.elementId ? (names.element ? `element ${names.element}` : "a claim element no longer available to you") : "no claim element named in the question");
  if (p.topics?.length) notes.push(`about ${p.topics.map((t) => `“${t}”`).join(", ")}`);
  return `${AGENT_LABELS[agent]}: ${reason}${notes.length ? `; ${notes.join("; ")}` : ""}.`;
}
