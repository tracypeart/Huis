import { clock, findCourtDates, usDate, type FoundCourtEvent } from "./nef";

/**
 * Utah court notices: notices of hearing, minute entries and e-filing
 * receipts about Utah state cases, read from email.
 *
 * Utah sends these through each firm's e-filing service provider (EFSP), and
 * "notification methods are unique to the EFSP" (Utah eFiling FAQ for
 * attorneys), so there is no single published format. This reader is
 * deliberately conservative and is marked **unverified** until it has been
 * checked against real (redacted) Utah notices (open item O-7):
 *  - it reads only email from a Utah courts address (utcourts.gov) or a sender
 *    the firm's administrator has registered as its EFSP;
 *  - it needs a Utah court and a case number in the text;
 *  - it proposes only dates written as a court date is set ("… set for",
 *    "… scheduled for", "… due by", a "Date: … Time: …" block), and every
 *    proposal still needs an attorney to confirm it.
 *
 * No scraping, and never the attorney's e-filing credentials (Utah forbids
 * giving third parties access to e-filing accounts).
 */

const MAX_TEXT = 100_000;
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

export interface UtahNotice {
  court: string | null;
  caseNumber: string | null;
  caseName: string | null;
  /** The notice's own short summary (its first lines after the court), for the docket. */
  summary: string;
  events: FoundCourtEvent[];
}

/** Whether an address is the Utah courts' own (an address at utcourts.gov). */
export function isUtahCourtSender(from: string | null | undefined): boolean {
  const addr = (from ?? "").match(/<([^<>\s]+@[^<>\s]+)>\s*$/)?.[1] ?? (from ?? "").trim();
  return /^[^@\s]{1,64}@(?:[a-z0-9-]{1,63}\.){0,4}utcourts\.gov$/i.test(addr);
}

const COURT = /\b((?:First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth)\s+(?:Judicial\s+)?District\s+(?:Juvenile\s+)?Court|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+(?:County|City)\s+Justice\s+Court|Utah\s+(?:Supreme\s+Court|Court\s+of\s+Appeals))\b/;
// Utah district case numbers are nine digits (e.g. 260900123); appellate ones look like 20260123-CA.
const CASE = /\bCase\s*(?:No\.?|Number|#)?\s*:?\s*(\d{9}|\d{8}-(?:CA|SC))\b/i;

/** "Wednesday, May 20, 2026" / "May 20, 2026" → YYYY-MM-DD. */
function longDate(month: string, day: string, year: string): string | null {
  const m = MONTHS[month.toLowerCase().replace(/\.$/, "")];
  return m ? usDate(String(m), day, year) : null;
}

const WEEKDAY = String.raw`(?:(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,?\s+)?`;
const LONG = String.raw`(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2}),?\s+(\d{4})`;
const TIME = String.raw`(\d{1,2}:\d{2}\s*[AaPp]\.?\s*[Mm]\.?)`;
// "A Pretrial Conference is scheduled for Wednesday, May 20, 2026 at 10:00 AM in Courtroom W43."
const SCHEDULED = new RegExp(
  String.raw`([A-Z][A-Za-z/&'\- ]{1,60}?)\s+(?:is\s+|has\s+been\s+)?(?:set|scheduled|reset|rescheduled|continued)\s+(?:for|on|to)\s+${WEEKDAY}${LONG}` +
  String.raw`(?:\s*(?:at|@)\s*${TIME})?(?:\s+(?:in|at)\s+((?:Room|Courtroom|Webex|WebEx|Zoom|Video)[^;\n]{0,80}?))?\s*(?=\.(?:\s|$)|;|$)`, "g");
// A block: "Hearing Type: Pretrial Conference … Date: 05/20/2026 … Time: 10:00 AM" (each line short, the block bounded).
const BLOCK = /(?:Hearing|Event)(?:\s+Type)?:[ \t]*([A-Za-z][A-Za-z/&' -]{1,60})[ \t]*\r?\n(?:[^\n]{0,120}\r?\n){0,4}?[ \t]*(?:Hearing\s+)?Date:[ \t]*(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ \t]*\r?\n?[ \t]*Time:[ \t]*(\d{1,2}:\d{2}[ \t]*[AaPp]\.?[ \t]*[Mm]\.?))?/g;

const CANCELLED = /\b(vacat\w*|strick\w*|stricken|struck|cancel\w*|terminat\w*|withdrawn|moot)\b/i;
const clean = (s: string | undefined) => (s ? s.replace(/\s+/g, " ").trim().replace(/^(?:the|a|an)\s+/i, "") : "");

export function parseUtahNotice(input: string): UtahNotice | null {
  const text = input.slice(0, MAX_TEXT);
  const court = COURT.exec(text);
  const kase = CASE.exec(text);
  // A Utah court and a case number, or it isn't a Utah court notice.
  if (!court || !kase) return null;
  const events: FoundCourtEvent[] = [];
  const seen = new Set<string>();
  const add = (e: FoundCourtEvent) => {
    const key = `${e.title.toLowerCase()}|${e.date}|${e.time ?? ""}`;
    if (seen.has(key) || events.length >= 20) return;
    seen.add(key);
    events.push(e);
  };
  // The rest of the sentence a date was found in ("… is VACATED", "… has been cancelled").
  const rest = (at: number, len: number) => text.slice(at, at + len + 120).split(/\.(?:\s|$)/)[0] ?? "";
  for (const m of text.matchAll(SCHEDULED)) {
    const date = longDate(m[2]!, m[3]!, m[4]!);
    const title = clean(m[1]);
    if (!date || !title || CANCELLED.test(rest(m.index!, m[0].length))) continue;
    add({
      // ("Pretrial Conference" is a conference, not a trial.)
      kind: /\b(conference|status|scheduling|mediation)\b/i.test(title) ? "conference" : /\btrial\b/i.test(title) ? "trial"
        : /\b(hearing|arraignment|sentencing|review)\b/i.test(title) ? "hearing" : "deadline",
      title: title.slice(0, 120), date, time: clock(m[5]), location: clean(m[6]).slice(0, 120) || null, judge: null,
      start: m.index!, end: m.index! + m[0].length,
    });
  }
  for (const m of text.matchAll(BLOCK)) {
    const date = usDate(m[2]!, m[3]!, m[4]!);
    const title = clean(m[1]);
    if (!date || !title || CANCELLED.test(m[0])) continue;
    add({ kind: /\bconference\b/i.test(title) ? "conference" : /\btrial\b/i.test(title) ? "trial" : "hearing", title: title.slice(0, 120), date,
      time: clock(m[5]), location: null, judge: null, start: m.index!, end: m.index! + m[0].length });
  }
  // The federal patterns also cover "… set for 5/20/2026 …" and "… due by …" in Utah wording.
  for (const e of findCourtDates(text, 0)) add(e);
  const after = text.slice(court.index + court[0].length, court.index + court[0].length + 600);
  return {
    court: court[1]!.replace(/\s+/g, " "),
    caseNumber: kase[1]!,
    caseName: (/\b([A-Z][A-Za-z.'&-]+(?:\s+[A-Z][A-Za-z.'&-]+){0,4}\s+v(?:s)?\.\s+[A-Z][A-Za-z.'&-]+(?:\s+[A-Z][A-Za-z.'&-]+){0,4})/.exec(text)?.[1]) ?? null,
    summary: after.replace(/\s+/g, " ").trim().slice(0, 300),
    events: events.sort((a, b) => a.start - b.start),
  };
}
