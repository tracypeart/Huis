import { terms } from "../ai/local";

/**
 * Contradiction engine, step 1: finding statements that deny knowledge or
 * notice ("I didn't know about the surgery until May", "No one told me",
 * "I first learned of it on May 6, 2026"), by fixed rules (no AI).
 *
 * Each statement keeps what it is about (its topic words) and, when it says
 * so, the date before which the person claims not to have known. Step 2 (the
 * service) compares it with the Matter's earlier dated evidence. Huis only
 * ever calls the result a *potential* contradiction; the attorney decides.
 */
export interface FoundStatement {
  /** Position in the text it was found in. */
  start: number;
  end: number;
  quote: string;
  /** Word stems the statement is about (e.g. "surgery", "fmla", "leave"). */
  topics: string[];
  /** The claimed "not until" date (ISO), when the statement gives one. */
  before: string | null;
  /** How the date was read, for the explanation ("until May (2026)"). */
  beforeText: string | null;
}

// "I didn't know", "she was not aware", "we never received", "I had no idea", "I don't recall being told"…
const SUBJECT = String.raw`(?:i|we|he|she|they|my\s+client|the\s+(?:employee|plaintiff|defendant|witness|company))`;
const NEGATION = String.raw`(?:did\s*n[o'’]?t|didn[’']t|never|was\s+not|wasn[’']t|were\s+not|weren[’']t|had\s+no|have\s+no|has\s+no|do\s+not|don[’']t|could\s+not|couldn[’']t)`;
const KNOWING = String.raw`(?:know|knew|known|aware|awareness|told|informed|notified|notice|receive|received|see|saw|seen|hear|heard|learn|learned|learnt|knowledge|idea|recall|remember|understand|understood)`;
const DENIAL = new RegExp(
  String.raw`\b${SUBJECT}\s+(?:\w+\s+)?${NEGATION}\s+(?:\w+\s+){0,2}?${KNOWING}\b` +
  String.raw`|\b(?:no\s*one|nobody|no\s+one\s+ever)\s+(?:\w+\s+)?(?:told|informed|notified|mentioned|said)\b` +
  String.raw`|\bfirst\s+(?:learned|learnt|heard|found\s+out|became\s+aware|knew|was\s+told|was\s+informed)\b` +
  String.raw`|\b(?:did\s*n[o'’]?t|didn[’']t)\s+find\s+out\b`,
  "i");

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
// "until May", "before May 6, 2026", "not until 5/6/2026", "in May 2026" (after "first learned"), "on May 6".
const BOUND = new RegExp(
  String.raw`\b(until|till|til|before|prior\s+to|in|on|around|about)\s+(?:early\s+|mid[-\s]|late\s+)?` +
  String.raw`(?:(${MONTH})\.?(?:\s+(\d{1,2})(?:st|nd|rd|th)?)?(?:,?\s+(\d{4}))?|(\d{1,2})/(\d{1,2})/(\d{4})|(\d{4})-(\d{2})-(\d{2}))\b`,
  "i");
const YEAR = /\b(19\d{2}|20\d{2}|2100)\b/g;

/** What a denial is made of; never a topic. */
const NOT_TOPICS = new Set(terms(
  "know knew known knowing aware awareness told tell telling informed inform notified notify notice receive received see saw seen hear heard " +
  "learn learned learnt first found find out idea knowledge recall remember understand understood until till til before prior around about " +
  "never didn didnt wasn wasnt were weren don dont doesn couldn hadn haven isn aren wouldn shouldn had have no one nobody anyone anything something ever even really honestly " +
  "me us him her them myself himself herself themselves we they he she my client employee plaintiff defendant witness company " +
  "early mid late day days week weeks month months year years time later afterwards then yes okay " +
  "january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec " +
  "monday tuesday wednesday thursday friday saturday sunday",
));

function iso(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? dt.toISOString().slice(0, 10) : null;
}

/** The latest year written in some text (to complete "until May"); null if none. */
export function latestYear(text: string): number | null {
  let best: number | null = null;
  let n = 0;
  YEAR.lastIndex = 0;
  for (let m = YEAR.exec(text); m && n++ < 500; m = YEAR.exec(text)) best = Math.max(best ?? 0, Number(m[1]));
  return best;
}

/** The "not until" date in a statement. A month alone means its first day; a missing year comes from the document. */
export function claimedBefore(sentence: string, yearHint: number | null): { date: string; text: string } | null {
  const m = BOUND.exec(sentence.slice(0, 600));
  if (!m) return null;
  let date: string | null = null;
  if (m[2]) {
    const year = m[4] ? Number(m[4]) : yearHint;
    if (!year) return null;
    date = iso(year, MONTHS[m[2].toLowerCase().replace(/\.$/, "")]!, m[3] ? Number(m[3]) : 1);
  } else if (m[7]) date = iso(Number(m[7]), Number(m[5]), Number(m[6]));
  else if (m[8]) date = iso(Number(m[8]), Number(m[9]), Number(m[10]));
  if (!date) return null;
  const said = m[0].replace(/\s+/g, " ").trim();
  return { date, text: m[4] || m[7] || m[8] || !m[2] ? said : `${said} (${date.slice(0, 4)})` };
}

export const MAX_STATEMENTS = 200;
const MAX_SENTENCE = 600;
const MAX_TEXT = 200_000;

/** Statements denying knowledge or notice, with their topics and any claimed date. */
export function findStatements(input: string, yearHint: number | null = null): FoundStatement[] {
  const text = input.slice(0, MAX_TEXT);
  const year = yearHint ?? latestYear(text);
  const out: FoundStatement[] = [];
  // Sentences: split at . ! ? followed by a space, and at line breaks.
  const re = /[^.!?\n]+(?:[.!?]+|\n|$)/g;
  let examined = 0;
  for (let m = re.exec(text); m && out.length < MAX_STATEMENTS && examined++ < 20_000; m = re.exec(text)) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    const raw = m[0];
    if (raw.length > MAX_SENTENCE || !DENIAL.test(raw)) continue;
    const lead = raw.length - raw.trimStart().length;
    const quote = raw.replace(/\s+/g, " ").trim();
    const topics = [...new Set(terms(quote).filter((t) => !NOT_TOPICS.has(t) && !/^\d+$/.test(t)))].slice(0, 12);
    if (topics.length === 0) continue; // "I don't know." says nothing to compare
    const bound = claimedBefore(quote, year);
    out.push({
      start: m.index + lead, end: m.index + raw.trimEnd().length, quote: quote.slice(0, 1500), topics,
      before: bound?.date ?? null, beforeText: bound?.text ?? null,
    });
  }
  return out;
}

/** Topic words an item's text shares with a statement. */
export function sharedTopics(topics: string[], text: string): string[] {
  const have = new Set(terms(text.slice(0, 20_000)));
  return topics.filter((t) => have.has(t));
}

/** How many topic words an item must share to count: two when the statement has two or more, else one. */
export function topicsNeeded(topics: string[]): number {
  return Math.min(2, topics.length);
}

export type Confidence = "high" | "medium" | "low";

/**
 * Fixed rule: the more separate sources that conflict, the stronger the flag.
 * Three or more different sources → high; two → medium; one → low.
 */
export function confidenceFor(distinctSources: number): Confidence {
  return distinctSources >= 3 ? "high" : distinctSources === 2 ? "medium" : "low";
}
