/**
 * Finds dated events in a document's text, for Case DNA suggestions: each
 * sentence that contains a date becomes a suggested event, cited to where it
 * appears. Runs in linear time (simple patterns, bounded input) and suggests
 * at most a few dozen events per document; attorneys confirm or reject them.
 */
export interface FoundEvent { date: string; label: string; quote: string; start: number; end: number }

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_NAMES = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
// "April 18, 2026" · "Apr. 18 2026" · "18 April 2026" · "4/18/2026" · "2026-04-18"
const DATE = new RegExp(
  `\\b(?:(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})` +
  `|(\\d{1,2})\\s+(${MONTH_NAMES})\\.?,?\\s+(\\d{4})` +
  `|(\\d{1,2})/(\\d{1,2})/(\\d{4})` +
  `|(\\d{4})-(\\d{2})-(\\d{2}))\\b`, "gi");

export const MAX_EVENTS = 40;
const MAX_EXAMINED = 2000;
const MAX_TEXT = 2_000_000;

function iso(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null; // e.g. February 30
  return dt.toISOString().slice(0, 10);
}

/** "Ms." or "Inc." isn't the end of a sentence. */
const ABBREVIATION = /\b(?:Mr|Ms|Mrs|Dr|Jr|Sr|St|No|Inc|Co|Corp|Ltd|vs|v|Esq|Hon|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)$/i;
function abbreviationBefore(text: string, dot: number): boolean {
  return text[dot] === "." && ABBREVIATION.test(text.slice(Math.max(0, dot - 6), dot));
}

/** The sentence around a position: back to the previous sentence end or line break, forward to the next (bounded). */
function sentenceAround(text: string, from: number, to: number): { start: number; end: number } {
  let start = from;
  const minStart = Math.max(0, from - 300);
  while (start > minStart && !(/[.!?\n]/.test(text[start - 1]!) && !abbreviationBefore(text, start - 1))) start--;
  let end = to;
  const maxEnd = Math.min(text.length, to + 300);
  while (end < maxEnd && !(/[.!?\n]/.test(text[end]!) && !abbreviationBefore(text, end))) end++;
  if (end < text.length && /[.!?]/.test(text[end]!)) end++;
  while (start < end && /\s/.test(text[start]!)) start++;
  return { start, end };
}

export function findEvents(input: string): FoundEvent[] {
  const text = input.slice(0, MAX_TEXT);
  const out: FoundEvent[] = [];
  const seen = new Set<string>();
  DATE.lastIndex = 0;
  // Only so many date-like matches are examined per document, however the text is built.
  let examined = 0;
  for (let m = DATE.exec(text); m && out.length < MAX_EVENTS && examined++ < MAX_EXAMINED; m = DATE.exec(text)) {
    let date: string | null = null;
    if (m[1]) date = iso(Number(m[3]), MONTHS[m[1].toLowerCase()]!, Number(m[2]));
    else if (m[5]) date = iso(Number(m[6]), MONTHS[m[5].toLowerCase()]!, Number(m[4]));
    else if (m[9]) date = iso(Number(m[9]), Number(m[7]), Number(m[8]));
    else if (m[10]) date = iso(Number(m[10]), Number(m[11]), Number(m[12]));
    if (!date) continue;
    const { start, end } = sentenceAround(text, m.index, m.index + m[0].length);
    const quote = text.slice(start, end).replace(/\s+/g, " ").trim();
    if (quote.length < 12) continue;
    const key = `${date}|${quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, label: quote.length > 300 ? `${quote.slice(0, 297)}…` : quote, quote: quote.slice(0, 1500), start, end });
  }
  return out;
}

/** Every full date written in a text (positions and ISO dates), in order; at most `max`. */
export function findDates(input: string, max = 20): { date: string; index: number; length: number }[] {
  const text = input.slice(0, 20_000);
  const out: { date: string; index: number; length: number }[] = [];
  const re = new RegExp(DATE.source, "gi");
  let examined = 0;
  for (let m = re.exec(text); m && out.length < max && examined++ < 500; m = re.exec(text)) {
    let date: string | null = null;
    if (m[1]) date = iso(Number(m[3]), MONTHS[m[1].toLowerCase()]!, Number(m[2]));
    else if (m[5]) date = iso(Number(m[6]), MONTHS[m[5].toLowerCase()]!, Number(m[4]));
    else if (m[9]) date = iso(Number(m[9]), Number(m[7]), Number(m[8]));
    else if (m[10]) date = iso(Number(m[10]), Number(m[11]), Number(m[12]));
    if (date) out.push({ date, index: m.index, length: m[0].length });
  }
  return out;
}
