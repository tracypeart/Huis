/**
 * Federal court notices: reads a CM/ECF "Notice of Electronic Filing" (NEF)
 * email and finds the court, case, document and docket text, and the dates
 * the docket text sets (hearings, conferences, trials, deadlines).
 *
 * Fixed rules, no AI. Everything found is only a *proposal*: an attorney
 * confirms each court date before it counts, because a missed or wrong
 * deadline can harm a client. Every proposal keeps its position in the email
 * so the exact words it came from can be shown.
 *
 * Bounded on any input: notices are short, so only the first part of a very
 * long text is read, and every pattern is linear.
 */

const MAX_TEXT = 200_000;
const MAX_EVENTS = 20;

export type CourtEventKind = "hearing" | "deadline" | "trial" | "conference";

export interface FoundCourtEvent {
  kind: CourtEventKind;
  /** e.g. "Motion Hearing", "Responses due". */
  title: string;
  /** Calendar date, YYYY-MM-DD. */
  date: string;
  /** 24-hour HH:MM, when the notice gives one. */
  time: string | null;
  location: string | null;
  judge: string | null;
  /** Position of the sentence in the text it was read from. */
  start: number;
  end: number;
}

export interface Nef {
  court: string | null;
  caseNumber: string | null;
  caseName: string | null;
  documentNumber: string | null;
  /** When the clerk entered the transaction (YYYY-MM-DD). */
  enteredOn: string | null;
  docketText: string;
  /** Link to the filed document (the attorney's one free look). */
  documentUrl: string | null;
  events: FoundCourtEvent[];
}

const pad = (n: number) => String(n).padStart(2, "0");

/** m/d/yyyy (or m/d/yy) → YYYY-MM-DD, or null for an impossible date. */
export function usDate(m: string, d: string, y: string): string | null {
  let year = Number(y);
  if (y.length === 2) year += 2000;
  const mo = Number(m), day = Number(d);
  if (year < 1900 || year > 2100 || mo < 1 || mo > 12 || day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, mo - 1, day));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return `${year}-${pad(mo)}-${pad(day)}`;
}

/** "10:00 AM" → "10:00"; "2:30 PM" → "14:30". */
export function clock(t: string | undefined): string | null {
  const m = t ? /^(\d{1,2}):(\d{2})\s*([AaPp])\.?\s*[Mm]\.?$/.exec(t.trim()) : null;
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 1 || h > 12 || min > 59) return null;
  if (/p/i.test(m[3]!) && h !== 12) h += 12;
  if (/a/i.test(m[3]!) && h === 12) h = 0;
  return `${pad(h)}:${pad(min)}`;
}

/**
 * Whether an email's sender is a federal court's CM/ECF system (an address at
 * a uscourts.gov host). Security review 17, F9: wording alone can be copied
 * by anyone, so only email from the courts is read as a court notice.
 */
export function isCourtSender(from: string | null | undefined): boolean {
  const addr = (from ?? "").match(/<([^<>\s]+@[^<>\s]+)>\s*$/)?.[1] ?? (from ?? "").trim();
  return /^[^@\s]{1,64}@(?:[a-z0-9-]{1,63}\.){0,4}uscourts\.gov$/i.test(addr);
}

/** Whether a text reads as a CM/ECF Notice of Electronic Filing. */
export function isNef(text: string): boolean {
  const head = text.slice(0, 20_000);
  return /Notice of Electronic Filing/i.test(head) && /(CM\/ECF|uscourts\.gov|U\.S\.\s+(District|Bankruptcy)\s+Court|United States (District|Bankruptcy) Court)/i.test(head);
}

const DATE = String.raw`(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})`;
const TIME = String.raw`(\d{1,2}:\d{2}\s*[AaPp]\.?\s*[Mm]\.?)`;

// "Motion Hearing set for 5/20/2026 at 10:00 AM in Room 7.100 before Judge David Barlow."
const SET_FOR = new RegExp(
  String.raw`([A-Z][A-Za-z/&'\- ]{1,60}?)\s+(?:set|reset|re-set|rescheduled|continued)\s+(?:for|to)\s+${DATE}` +
  String.raw`(?:\s*(?:at|@)?\s*${TIME})?` +
  // (A period inside "Room 7.100" or "Dustin B. Pead" doesn't end the sentence: only a period followed by a space does.)
  String.raw`(?:\s+(?:in|at)\s+((?:Room|Courtroom|Chambers|Zoom|Video|Telephon)[^;\n]{0,80}?))?` +
  String.raw`(?:\s+before\s+((?:Chief\s+|Senior\s+)?(?:District\s+|Magistrate\s+|Bankruptcy\s+)?Judge(?:\s+(?:[A-Z][a-z'\-]+|[A-Z]\.)){1,6}))?` +
  String.raw`\s*(?=\.(?:\s|$)|;|$)`,
  "g");
// "Responses due by 5/4/2026." / "Discovery due by 6/1/2026."
const DUE_BY = new RegExp(String.raw`(?:([A-Z][A-Za-z/&'\- ]{1,60}?)\s+)?due\s+(?:by|on)\s+${DATE}`, "g");
// "Dispositive motions deadline 7/15/2026" / "Deadline to amend pleadings: 6/1/2026"
const DEADLINE = new RegExp(String.raw`([A-Z][A-Za-z/&'\- ]{1,60}?\s+[Dd]eadline|Deadline\s+(?:to|for)\s+[a-z][A-Za-z/&'\- ]{1,60}?)\s*(?:is|set\s+for|of|:)?\s*${DATE}`, "g");

function kindOf(title: string): CourtEventKind {
  if (/\btrial\b/i.test(title)) return "trial";
  if (/\b(conference|status|scheduling|settlement|mediation)\b/i.test(title)) return "conference";
  if (/\b(hearing|argument|sentencing|arraignment|appearance)\b/i.test(title)) return "hearing";
  return "deadline";
}

const clean = (s: string | undefined) => (s ? s.replace(/\s+/g, " ").trim().replace(/[,:]$/, "") : "");
/** "The Dispositive motions deadline" → "Dispositive motions deadline". */
const title = (s: string | undefined) => clean(s).replace(/^(?:the|a|an|any|all)\s+/i, "");

/** The sentence around a position (a period followed by a space ends one; "7.100" and "B. Pead" don't). */
export function sentenceAt(text: string, at: number): string {
  const before = text.slice(Math.max(0, at - 400), at);
  const b = Math.max(before.lastIndexOf(". "), before.lastIndexOf(".\n"), before.lastIndexOf("; "));
  const after = text.slice(at, at + 400);
  const e = after.search(/\.(?:\s|$)|;/);
  return `${b >= 0 ? before.slice(b + 2) : before}${e >= 0 ? after.slice(0, e) : after}`;
}
/** Security review 17, F4: a date the same sentence vacates, strikes or cancels is not a date to keep. */
export const CANCELLED = /\b(vacat\w*|strick\w*|stricken|struck|cancel\w*|terminat\w*|withdrawn|moot)\b/i;

/** Court dates set in a piece of docket text, positioned relative to `offset`. */
export function findCourtDates(docket: string, offset = 0): FoundCourtEvent[] {
  const text = docket.slice(0, 20_000);
  const out: FoundCourtEvent[] = [];
  const seen = new Set<string>();
  const add = (e: FoundCourtEvent) => {
    const key = `${e.kind}|${e.title.toLowerCase()}|${e.date}|${e.time ?? ""}`;
    if (seen.has(key) || out.length >= MAX_EVENTS) return;
    seen.add(key);
    out.push(e);
  };
  for (const m of text.matchAll(SET_FOR)) {
    const date = usDate(m[2]!, m[3]!, m[4]!);
    const name = title(m[1]);
    if (!date || !name || /^(signed|entered|filed|dated)$/i.test(name) || CANCELLED.test(sentenceAt(text, m.index!))) continue;
    add({
      kind: kindOf(name), title: name.slice(0, 120), date, time: clock(m[5]), location: clean(m[6]).slice(0, 120) || null,
      judge: clean(m[7]).slice(0, 120) || null, start: offset + m.index!, end: offset + m.index! + m[0].length,
    });
  }
  for (const m of text.matchAll(DUE_BY)) {
    const date = usDate(m[2]!, m[3]!, m[4]!);
    if (!date || CANCELLED.test(sentenceAt(text, m.index!))) continue;
    const what = title(m[1]);
    add({ kind: "deadline", title: `${what || "Filing"} due`.slice(0, 120), date, time: null, location: null, judge: null,
      start: offset + m.index!, end: offset + m.index! + m[0].length });
  }
  for (const m of text.matchAll(DEADLINE)) {
    const date = usDate(m[2]!, m[3]!, m[4]!);
    if (!date || CANCELLED.test(sentenceAt(text, m.index!))) continue;
    add({ kind: "deadline", title: title(m[1]).slice(0, 120), date, time: null, location: null, judge: null,
      start: offset + m.index!, end: offset + m.index! + m[0].length });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Reads a Notice of Electronic Filing, or returns null when the text isn't one. */
export function parseNef(input: string): Nef | null {
  const text = input.slice(0, MAX_TEXT);
  if (!isNef(text)) return null;
  const line = (label: string) => {
    const m = new RegExp(String.raw`^[ \t]*${label}[ \t]*:[ \t]*(.{1,300})$`, "im").exec(text);
    return m ? clean(m[1]) : null;
  };
  const court = (() => {
    // Security review 17, F1: look for "District of …" only in the short stretch after "… Court",
    // with one bounded whitespace run, so no input can make the search slow.
    const head = /(?:U\.S\.|United States)[ \t]{1,5}(District|Bankruptcy)[ \t]{1,5}Court/.exec(text.slice(0, 20_000));
    if (head) {
      const after = text.slice(head.index + head[0].length, head.index + head[0].length + 400).replace(/^\s{0,300}/, "");
      const d = /^((?:Northern|Southern|Eastern|Western|Middle|Central)[ \t]+)?District of [A-Z][A-Za-z ]{2,40}/.exec(after);
      if (d) return `U.S. ${head[1]} Court, ${clean(d[0])}`;
    }
    const host = /https?:\/\/ecf\.([a-z]{2,6})\.uscourts\.gov/i.exec(text);
    return host ? `U.S. federal court (${host[1]!.toLowerCase()})` : null;
  })();
  const entered = /entered on\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i.exec(text);
  // Docket text: from its label to the "Notice has been electronically mailed" line (or a blank line run).
  const docketAt = /Docket Text:\s*/i.exec(text);
  let docketText = "";
  let docketStart = 0;
  if (docketAt) {
    docketStart = docketAt.index + docketAt[0].length;
    const rest = text.slice(docketStart, docketStart + 8000);
    const stop = rest.search(/\n\s*\S[^\n]{0,80}Notice has been (?:electronically )?(?:mailed|delivered)|\n\s*\n\s*\n|The following document\(s\) are associated/i);
    docketText = (stop >= 0 ? rest.slice(0, stop) : rest).trimEnd();
  }
  const url = /https:\/\/ecf\.[a-z]{2,6}\.uscourts\.gov\/doc1\/[0-9]{6,20}(?:\?[A-Za-z0-9_=&.%-]{0,300})?/i.exec(text);
  return {
    court,
    caseNumber: line("Case Number"),
    caseName: line("Case Name"),
    documentNumber: (() => { const d = line("Document Number"); const m = d ? /^\d{1,6}/.exec(d) : null; return m ? m[0] : null; })(),
    enteredOn: entered ? usDate(entered[1]!, entered[2]!, entered[3]!) : null,
    docketText: docketText.replace(/[ \t]+/g, " ").slice(0, 4000),
    documentUrl: url ? url[0] : null,
    events: docketText ? findCourtDates(docketText, docketStart) : [],
  };
}

/** The attorney's free look at a filed document lasts 15 days from the notice. */
export const FREE_LOOK_DAYS = 15;
