import { createHash } from "node:crypto";
import { z } from "zod";
import { NOTICE_READERS, readCourtNotice, type NoticeReaderId } from "../court/connectors";
import { FREE_LOOK_DAYS } from "../court/nef";
import type { FirmSession } from "../db/tenant";
import { NotFoundError, PermissionDeniedError, UserFacingError } from "../errors";
import { ADMIN_ROLES, INTERNAL_ROLES } from "../security/permissions";
import { recordAudit } from "./audit";
import { getMatter } from "./matters";

/**
 * Court Intelligence, part 1: each Matter's court calendar, and federal court
 * notices.
 *
 * Attorneys add court dates; Huis proposes the dates it reads in federal court
 * notices (CM/ECF Notices of Electronic Filing) filed into the Matter, each
 * with the exact words it came from. A proposal never counts until someone
 * confirms it — Huis never silently creates a court deadline. Firm staff on
 * the Matter only (read-only staff read); clients and outside users never see
 * it; the database enforces all of this. The audit log records the kind of
 * change, never the wording.
 */

export const EVENT_KINDS = ["hearing", "deadline", "trial", "conference", "other"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export const EVENT_KIND_LABELS: Record<EventKind, string> = {
  hearing: "Hearing", deadline: "Deadline", trial: "Trial", conference: "Conference", other: "Other",
};
/** Reminders before a court date, in days (the standard schedule). */
export const ALERT_DAYS = [30, 14, 7, 3, 1] as const;

const uuid = z.uuid();
const reader = (s: FirmSession) => {
  if (!INTERNAL_ROLES.has(s.actor.role)) throw new PermissionDeniedError("use the court calendar");
};
const writer = (s: FirmSession) => {
  reader(s);
  if (s.actor.role === "read_only") throw new PermissionDeniedError("change the court calendar");
};

export interface CourtEvent {
  id: string; matterId: string; kind: EventKind; title: string; date: string; time: string | null; location: string | null;
  judge: string | null; notes: string; status: "suggested" | "confirmed" | "rejected"; origin: "attorney" | "huis";
  sourceEvidenceId: string | null; sourceTitle: string | null; quote: string | null; done: boolean; createdAt: Date;
  /** Which notice reader proposed it, and whether that reader has been checked against real notices. */
  reader: NoticeReaderId | null; readerVerified: boolean;
  /** Days from today (in the firm's time zone) until the date; negative once it has passed. */
  daysAway: number;
}

const COLS = `e.id, e.matter_id, e.kind, e.title, e.event_date::text AS date, to_char(e.event_time, 'HH24:MI') AS time, e.location, e.judge,
  e.notes, e.status, e.origin, e.source_evidence_id, i.original_filename AS source_title, e.quote, e.done_at IS NOT NULL AS done, e.created_at, e.reader,
  (e.event_date - (now() AT TIME ZONE (SELECT time_zone FROM huis.firms WHERE id = huis.current_firm_id()))::date) AS days_away`;
const FROM = "huis.court_events e LEFT JOIN huis.evidence_items i ON i.id = e.source_evidence_id";
const toEvent = (r: Record<string, unknown>): CourtEvent => ({
  id: r.id as string, matterId: r.matter_id as string, kind: r.kind as EventKind, title: r.title as string, date: r.date as string,
  time: (r.time as string | null) ?? null, location: (r.location as string | null) ?? null, judge: (r.judge as string | null) ?? null,
  notes: r.notes as string, status: r.status as CourtEvent["status"], origin: r.origin as CourtEvent["origin"],
  sourceEvidenceId: (r.source_evidence_id as string | null) ?? null, sourceTitle: (r.source_title as string | null) ?? null,
  reader: (r.reader as NoticeReaderId | null) ?? null,
  readerVerified: r.reader ? NOTICE_READERS.find((x) => x.id === r.reader)?.verified ?? false : true,
  quote: (r.quote as string | null) ?? null, done: Boolean(r.done), createdAt: r.created_at as Date, daysAway: Number(r.days_away),
});

async function event(s: FirmSession, id: string): Promise<CourtEvent> {
  if (!uuid.safeParse(id).success) throw new NotFoundError("Court date");
  const r = (await s.client.query(`SELECT ${COLS} FROM ${FROM} WHERE e.id = $1`, [id])).rows[0];
  if (!r) throw new NotFoundError("Court date");
  return toEvent(r);
}

/** The reminder a date is due for today, e.g. "In 7 days", or null between reminders. */
export function alertFor(daysAway: number): string | null {
  if (daysAway < 0) return "Past";
  if (daysAway === 0) return "Today";
  if (daysAway === 1) return "Tomorrow";
  return (ALERT_DAYS as readonly number[]).includes(daysAway) ? `In ${daysAway} days` : null;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------
export async function listCourtEvents(s: FirmSession, matterId: string, opts: { includeRejected?: boolean } = {}): Promise<CourtEvent[]> {
  reader(s);
  await getMatter(s, matterId);
  const { rows } = await s.client.query(
    `SELECT ${COLS} FROM ${FROM} WHERE e.matter_id = $1 ${opts.includeRejected ? "" : "AND e.status <> 'rejected'"}
      ORDER BY e.event_date, e.event_time NULLS FIRST, e.created_at LIMIT 2000`, [matterId]);
  return rows.map(toEvent);
}

export interface UpcomingDate extends CourtEvent { matterTitle: string; alert: string | null }

/** Confirmed, not-done court dates in the next `days` days, across the Matters this person can see. */
export async function upcomingCourtDates(s: FirmSession, days = 30): Promise<UpcomingDate[]> {
  if (!INTERNAL_ROLES.has(s.actor.role)) return [];
  const within = Math.min(Math.max(Math.trunc(days), 0), 366);
  const { rows } = await s.client.query(
    `SELECT ${COLS}, m.title AS matter_title FROM ${FROM} JOIN huis.matters m ON m.id = e.matter_id
      WHERE e.status = 'confirmed' AND e.done_at IS NULL
        AND e.event_date BETWEEN (now() AT TIME ZONE (SELECT time_zone FROM huis.firms WHERE id = huis.current_firm_id()))::date
                             AND (now() AT TIME ZONE (SELECT time_zone FROM huis.firms WHERE id = huis.current_firm_id()))::date + $1::int
      ORDER BY e.event_date, e.event_time NULLS FIRST LIMIT 200`, [within]);
  return rows.map((r) => {
    const e = toEvent(r);
    return { ...e, matterTitle: r.matter_title as string, alert: alertFor(e.daysAway) };
  });
}

export interface CourtNotice {
  evidenceId: string; subject: string; sentAt: Date | null; court: string | null; caseNumber: string | null; caseName: string | null;
  documentNumber: string | null; enteredOn: string | null; docketText: string; documentUrl: string | null; datesFound: number;
  /** Days left in the attorney's one free look at the document (null once it has passed or isn't known). */
  freeLookDaysLeft: number | null;
  /** The notice names a different case number than the Matter's. */
  caseMismatch: boolean;
  reader: NoticeReaderId; readerVerified: boolean;
}

const caseKey = (v: string | null | undefined) => (v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** The Matter's docket, read from the court notices filed into it (newest first). Huis keeps no copy. */
export async function courtNotices(s: FirmSession, matterId: string): Promise<CourtNotice[]> {
  reader(s);
  const matter = await getMatter(s, matterId);
  // Dates in the firm's own time zone, worked out by the database (security review 17, F7).
  const { rows } = await s.client.query(
    `SELECT i.id, coalesce(m.subject, '') AS subject, m.sent_at, m.from_addr, left(t.content, 200000) AS content,
            (now() AT TIME ZONE f.time_zone)::date::text AS today, (m.sent_at AT TIME ZONE f.time_zone)::date::text AS sent_day
       FROM huis.evidence_items i
       JOIN huis.evidence_email m ON m.evidence_id = i.id
       JOIN huis.evidence_text t ON t.evidence_id = i.id
       JOIN huis.firms f ON f.id = huis.current_firm_id()
      WHERE i.matter_id = $1 AND i.status = 'clean' AND i.duplicate_of IS NULL
        AND ((huis.is_court_sender(m.from_addr) AND position('Notice of Electronic Filing' IN t.content) > 0)
             OR huis.is_notice_sender('utah', m.from_addr))
      ORDER BY m.sent_at DESC NULLS LAST, i.id LIMIT 500`, [matterId]);
  const senders = (await s.client.query<{ address: string }>("SELECT address FROM huis.court_notice_senders")).rows.map((x) => x.address);
  const out: CourtNotice[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    // Only email from a court (or the firm's registered e-filing provider), read by the matching reader (F9).
    const n = readCourtNotice(String(r.content), r.from_addr as string | null, senders);
    if (!n) continue;
    // The same filing, sent to several attorneys of record, is one docket entry (F3).
    // Federal: the case, document number and entry date name the filing. Utah notices have neither, so their
    // whole body (without the headers that differ between attorneys' copies) names it (R18-8).
    const body = String(r.content).replace(/^[\s\S]*?\r?\n\r?\n/, "");
    const filing = n.connector === "federal"
      ? `${caseKey(n.caseNumber)}|${n.documentNumber ?? ""}|${n.enteredOn ?? ""}|${n.docketText.slice(0, 500)}`
      : `utah|${caseKey(n.caseNumber)}|${createHash("sha256").update(body).digest("hex")}`;
    if (seen.has(filing)) continue;
    seen.add(filing);
    const start = n.enteredOn ?? (r.sent_day as string | null);
    const today = String(r.today);
    const left = start ? FREE_LOOK_DAYS - Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) : null;
    out.push({
      evidenceId: r.id, subject: String(r.subject).slice(0, 300), sentAt: r.sent_at, court: n.court, caseNumber: n.caseNumber,
      caseName: n.caseName, documentNumber: n.documentNumber, enteredOn: n.enteredOn, docketText: n.docketText,
      documentUrl: n.documentUrl, datesFound: n.events.length,
      reader: n.connector, readerVerified: NOTICE_READERS.find((x) => x.id === n.connector)?.verified ?? false,
      freeLookDaysLeft: left != null && left > 0 && n.documentUrl ? Math.min(left, FREE_LOOK_DAYS) : null,
      // "2:26-cv-00123-DBB" (with the judge's initials) is the same case as "2:26-cv-00123".
      caseMismatch: Boolean(n.caseNumber && matter.courtCaseNumber
        && !caseKey(n.caseNumber).startsWith(caseKey(matter.courtCaseNumber)) && !caseKey(matter.courtCaseNumber).startsWith(caseKey(n.caseNumber))),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Changing
// ---------------------------------------------------------------------------
const audit = (s: FirmSession, action: string, matterId: string, targetId: string, metadata: Record<string, string> = {}) =>
  recordAudit(s, `court.${action}`, { targetType: "court_event", targetId, matterId, metadata });

const eventInput = z.object({
  kind: z.enum(EVENT_KINDS),
  title: z.string().trim().min(1).max(200),
  date: z.iso.date(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Enter the time as HH:MM.").nullish().or(z.literal("").transform(() => null)),
  location: z.string().trim().max(200).nullish().transform((v) => v || null),
  judge: z.string().trim().max(200).nullish().transform((v) => v || null),
  notes: z.string().trim().max(5000).optional().default(""),
});

export async function addCourtEvent(s: FirmSession, matterId: string, input: unknown): Promise<string> {
  writer(s);
  await getMatter(s, matterId);
  const v = eventInput.parse(input);
  const id = (await s.client.query<{ id: string }>(
    `INSERT INTO huis.court_events (firm_id, matter_id, kind, title, event_date, event_time, location, judge, notes, status, origin, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'confirmed', 'attorney', $10) RETURNING id`,
    [s.actor.firmId, matterId, v.kind, v.title, v.date, v.time ?? null, v.location, v.judge, v.notes, s.actor.userId])).rows[0]!.id;
  await audit(s, "added", matterId, id, { kind: v.kind });
  return id;
}

export async function updateCourtEvent(s: FirmSession, id: string, input: unknown): Promise<void> {
  writer(s);
  const e = await event(s, id);
  if (e.status === "suggested") throw new UserFacingError("Confirm Huis's proposed court date before changing it.");
  const v = eventInput.parse(input);
  await s.client.query(
    "UPDATE huis.court_events SET kind = $2, title = $3, event_date = $4, event_time = $5, location = $6, judge = $7, notes = $8 WHERE id = $1",
    [id, v.kind, v.title, v.date, v.time ?? null, v.location, v.judge, v.notes]);
  await audit(s, "changed", e.matterId, id, { kind: v.kind });
}

/** Confirm or reject a proposed court date (or reverse an earlier decision). */
export async function decideCourtEvent(s: FirmSession, id: string, decision: unknown): Promise<void> {
  writer(s);
  const d = z.enum(["confirmed", "rejected"]).parse(decision);
  const e = await event(s, id);
  // A decision that changes nothing records nothing (security review 17, F8).
  const r = await s.client.query("UPDATE huis.court_events SET status = $2 WHERE id = $1 AND status IS DISTINCT FROM $2", [id, d]);
  if (r.rowCount) await audit(s, d, e.matterId, id, { kind: e.kind });
}

export async function setCourtEventDone(s: FirmSession, id: string, done: boolean): Promise<void> {
  writer(s);
  const e = await event(s, id);
  if (e.status !== "confirmed") throw new UserFacingError("Only a confirmed court date can be marked done.");
  // The database records who and when.
  const r = await s.client.query(
    `UPDATE huis.court_events SET done_at = ${done ? "now()" : "NULL"}, done_by = ${done ? "huis.current_user_id()" : "NULL"}
      WHERE id = $1 AND done_at IS ${done ? "" : "NOT "}NULL`, [id]);
  if (r.rowCount) await audit(s, done ? "done" : "reopened", e.matterId, id, { kind: e.kind });
}

export async function deleteCourtEvent(s: FirmSession, id: string): Promise<void> {
  writer(s);
  const e = await event(s, id);
  if (e.origin === "huis") throw new UserFacingError("Huis's proposals can't be deleted; reject them instead, so they aren't proposed again.");
  await s.client.query("DELETE FROM huis.court_events WHERE id = $1", [id]);
  await audit(s, "deleted", e.matterId, id, { kind: e.kind });
}

// ---------------------------------------------------------------------------
// Calendar file (.ics) of confirmed dates
// ---------------------------------------------------------------------------
/** Text escaped for a calendar file (RFC 5545), with no line breaks or control characters left. */
export function icsText(v: string): string {
  return v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
/** Long lines folded at 75 octets, as calendar programs expect, never inside a character (security review 17, F5). */
function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > 75) {
      out.push(cur);
      cur = ` ${ch}`;
      bytes = 1 + b;
    } else {
      cur += ch;
      bytes += b;
    }
  }
  out.push(cur);
  return out.join("\r\n");
}

/** UTC offset of a time zone on a date, e.g. "-0700". */
function offsetOn(tz: string, iso: string): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(new Date(iso))
    .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  return m ? `${m[1]}${m[2]}${m[3]}` : "+0000";
}

/**
 * The VTIMEZONE a calendar file needs for each TZID it uses (RFC 5545; security review 17, F6).
 * US zones change on the second Sunday of March and the first Sunday of November; European
 * zones on the last Sundays of March and October. Other zones: null (times are written in UTC).
 */
export function vtimezone(tz: string, year: number): string[] | null {
  const winter = offsetOn(tz, `${year}-01-15T12:00:00Z`);
  const summer = offsetOn(tz, `${year}-07-15T12:00:00Z`);
  if (winter === summer) {
    return ["BEGIN:VTIMEZONE", `TZID:${tz}`, "BEGIN:STANDARD", "DTSTART:19700101T000000", `TZOFFSETFROM:${winter}`, `TZOFFSETTO:${winter}`, "END:STANDARD", "END:VTIMEZONE"];
  }
  const rules = tz.startsWith("America/") ? { on: ["DTSTART:19700308T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU"], off: ["DTSTART:19701101T020000", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU"] }
    : tz.startsWith("Europe/") ? { on: ["DTSTART:19700329T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU"], off: ["DTSTART:19701025T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU"] }
    : null;
  if (!rules) return null;
  return [
    "BEGIN:VTIMEZONE", `TZID:${tz}`,
    "BEGIN:DAYLIGHT", ...rules.on, `TZOFFSETFROM:${winter}`, `TZOFFSETTO:${summer}`, "END:DAYLIGHT",
    "BEGIN:STANDARD", ...rules.off, `TZOFFSETFROM:${summer}`, `TZOFFSETTO:${winter}`, "END:STANDARD",
    "END:VTIMEZONE",
  ];
}

export async function courtCalendarIcs(s: FirmSession, matterId: string, acknowledged: boolean): Promise<{ filename: string; body: string }> {
  reader(s);
  // Like every export: only with the person's confirmation that they'll store it securely.
  if (!acknowledged) throw new UserFacingError("Confirm that you will store the calendar file securely.");
  const m = await getMatter(s, matterId);
  const tz = (await s.client.query<{ tz: string }>("SELECT time_zone AS tz FROM huis.firms WHERE id = huis.current_firm_id()")).rows[0]!.tz;
  const events = (await listCourtEvents(s, matterId)).filter((e) => e.status === "confirmed");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Huis Law//Court Calendar//EN", "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${icsText(`${m.title} — court dates`)}`,
  ];
  const zone = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz) ? vtimezone(tz, new Date().getUTCFullYear()) : null;
  if (zone && events.some((e) => e.time)) lines.push(...zone);
  const utc = (date: string, time: string) => {
    // A zone without a known VTIMEZONE: the time is written in UTC, worked out from the zone's offset that day.
    const off = offsetOn(tz, `${date}T12:00:00Z`);
    const mins = (off[0] === "-" ? -1 : 1) * (Number(off.slice(1, 3)) * 60 + Number(off.slice(3, 5)));
    return new Date(Date.parse(`${date}T${time}:00Z`) - mins * 60_000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  };
  for (const e of events) {
    const day = e.date.replace(/-/g, "");
    lines.push("BEGIN:VEVENT", `UID:${e.id}@huis.law`, `DTSTAMP:${stamp}`);
    if (e.time) {
      const t = `${e.time.replace(":", "")}00`;
      lines.push(zone ? `DTSTART;TZID=${tz}:${day}T${t}` : `DTSTART:${utc(e.date, e.time)}`, "DURATION:PT1H");
    } else {
      const next = new Date(Date.parse(`${e.date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10).replace(/-/g, "");
      lines.push(`DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${next}`);
    }
    lines.push(`SUMMARY:${icsText(`${e.done ? "[Done] " : ""}${EVENT_KIND_LABELS[e.kind]}: ${e.title} (${m.huisNumber})`)}`);
    const where = [e.location, e.judge].filter(Boolean).join(" · ");
    if (where) lines.push(`LOCATION:${icsText(where)}`);
    lines.push(`DESCRIPTION:${icsText(`Privileged & Confidential — Attorney Work Product. ${m.title}.${e.notes ? ` ${e.notes}` : ""}`)}`);
    for (const d of ALERT_DAYS.filter((x) => x <= 30)) {
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsText(e.title)}`, `TRIGGER:-P${d}D`, "END:VALARM");
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  await audit(s, "calendar_exported", matterId, matterId, { count: String(events.length) });
  const safe = m.huisNumber.replace(/[^A-Za-z0-9-]+/g, "-").slice(0, 60) || "matter";
  return { filename: `${safe}-court-dates.ics`, body: `${lines.map(fold).join("\r\n")}\r\n` };
}

// ---------------------------------------------------------------------------
// Court notice senders (the firm's e-filing service provider)
// ---------------------------------------------------------------------------
export interface NoticeSender { id: string; address: string; label: string; createdAt: Date }

export async function listNoticeSenders(s: FirmSession): Promise<NoticeSender[]> {
  reader(s);
  const { rows } = await s.client.query("SELECT id, address, label, created_at FROM huis.court_notice_senders ORDER BY address LIMIT 200");
  return rows.map((r) => ({ id: r.id, address: r.address, label: r.label, createdAt: r.created_at }));
}

const senderInput = z.object({
  address: z.email("Enter the sender's email address.").max(320).transform((v) => v.trim().toLowerCase()),
  label: z.string().trim().min(1).max(100),
});

/**
 * Registers the address the firm's e-filing provider sends Utah court notices from.
 * Administrators only. The firm's email already filed from it is read again.
 */
export async function addNoticeSender(s: FirmSession, input: unknown): Promise<string> {
  if (!ADMIN_ROLES.has(s.actor.role)) throw new PermissionDeniedError("register court notice senders");
  const v = senderInput.parse(input);
  // Free email services can't be registered: anyone could send from them.
  if (/@(gmail|googlemail|outlook|hotmail|live|yahoo|aol|icloud|me|proton|protonmail|gmx|mail)\.[a-z.]+$/i.test(v.address)) {
    throw new UserFacingError("That's a personal email service. Register your e-filing provider's own notification address.");
  }
  const existing = (await s.client.query<{ id: string }>("SELECT id FROM huis.court_notice_senders WHERE address = $1", [v.address])).rows[0];
  if (existing) return existing.id;
  const id = (await s.client.query<{ id: string }>(
    "INSERT INTO huis.court_notice_senders (firm_id, address, label, added_by) VALUES ($1, $2, $3, $4) RETURNING id",
    [s.actor.firmId, v.address, v.label, s.actor.userId])).rows[0]!.id;
  // Only when newly registered: the firm's email from it is read again (R18-7).
  await s.client.query("SELECT huis.requeue_notices_from($1)", [v.address]);
  await recordAudit(s, "court.notice_sender_added", { targetType: "firm", targetId: s.actor.firmId, metadata: { domain: v.address.split("@")[1] ?? "" } });
  return id;
}

export async function removeNoticeSender(s: FirmSession, id: string): Promise<void> {
  if (!ADMIN_ROLES.has(s.actor.role)) throw new PermissionDeniedError("register court notice senders");
  if (!uuid.safeParse(id).success) throw new NotFoundError("Sender");
  const r = await s.client.query("DELETE FROM huis.court_notice_senders WHERE id = $1 RETURNING address", [id]);
  if (!r.rowCount) throw new NotFoundError("Sender");
  await recordAudit(s, "court.notice_sender_removed", { targetType: "firm", targetId: s.actor.firmId, metadata: { domain: String(r.rows[0].address).split("@")[1] ?? "" } });
}
