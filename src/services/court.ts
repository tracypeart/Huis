import { z } from "zod";
import { FREE_LOOK_DAYS, parseNef } from "../court/nef";
import type { FirmSession } from "../db/tenant";
import { NotFoundError, PermissionDeniedError, UserFacingError } from "../errors";
import { INTERNAL_ROLES } from "../security/permissions";
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
  /** Days from today (in the firm's time zone) until the date; negative once it has passed. */
  daysAway: number;
}

const COLS = `e.id, e.matter_id, e.kind, e.title, e.event_date::text AS date, to_char(e.event_time, 'HH24:MI') AS time, e.location, e.judge,
  e.notes, e.status, e.origin, e.source_evidence_id, i.original_filename AS source_title, e.quote, e.done_at IS NOT NULL AS done, e.created_at,
  (e.event_date - (now() AT TIME ZONE (SELECT time_zone FROM huis.firms WHERE id = huis.current_firm_id()))::date) AS days_away`;
const FROM = "huis.court_events e LEFT JOIN huis.evidence_items i ON i.id = e.source_evidence_id";
const toEvent = (r: Record<string, unknown>): CourtEvent => ({
  id: r.id as string, matterId: r.matter_id as string, kind: r.kind as EventKind, title: r.title as string, date: r.date as string,
  time: (r.time as string | null) ?? null, location: (r.location as string | null) ?? null, judge: (r.judge as string | null) ?? null,
  notes: r.notes as string, status: r.status as CourtEvent["status"], origin: r.origin as CourtEvent["origin"],
  sourceEvidenceId: (r.source_evidence_id as string | null) ?? null, sourceTitle: (r.source_title as string | null) ?? null,
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
}

const caseKey = (v: string | null | undefined) => (v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** The Matter's docket, read from the federal court notices filed into it (newest first). Huis keeps no copy. */
export async function courtNotices(s: FirmSession, matterId: string): Promise<CourtNotice[]> {
  reader(s);
  const matter = await getMatter(s, matterId);
  const { rows } = await s.client.query(
    `SELECT i.id, coalesce(m.subject, '') AS subject, m.sent_at, left(t.content, 200000) AS content,
            (now() AT TIME ZONE f.time_zone)::date AS today
       FROM huis.evidence_items i
       JOIN huis.evidence_email m ON m.evidence_id = i.id
       JOIN huis.evidence_text t ON t.evidence_id = i.id
       JOIN huis.firms f ON f.id = huis.current_firm_id()
      WHERE i.matter_id = $1 AND i.status = 'clean' AND i.duplicate_of IS NULL
        AND position('Notice of Electronic Filing' IN t.content) > 0
      ORDER BY m.sent_at DESC NULLS LAST LIMIT 500`, [matterId]);
  const out: CourtNotice[] = [];
  for (const r of rows) {
    const n = parseNef(String(r.content));
    if (!n) continue;
    const start = n.enteredOn ?? (r.sent_at ? new Date(r.sent_at).toISOString().slice(0, 10) : null);
    const today = new Date(r.today).toISOString().slice(0, 10);
    const left = start ? FREE_LOOK_DAYS - Math.round((Date.parse(today) - Date.parse(start)) / 86_400_000) : null;
    out.push({
      evidenceId: r.id, subject: String(r.subject).slice(0, 300), sentAt: r.sent_at, court: n.court, caseNumber: n.caseNumber,
      caseName: n.caseName, documentNumber: n.documentNumber, enteredOn: n.enteredOn, docketText: n.docketText,
      documentUrl: n.documentUrl, datesFound: n.events.length,
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
  await s.client.query("UPDATE huis.court_events SET status = $2 WHERE id = $1", [id, d]);
  await audit(s, d, e.matterId, id, { kind: e.kind });
}

export async function setCourtEventDone(s: FirmSession, id: string, done: boolean): Promise<void> {
  writer(s);
  const e = await event(s, id);
  if (e.status !== "confirmed") throw new UserFacingError("Only a confirmed court date can be marked done.");
  // The database records who and when.
  await s.client.query(`UPDATE huis.court_events SET done_at = ${done ? "now()" : "NULL"}, done_by = ${done ? "huis.current_user_id()" : "NULL"} WHERE id = $1`, [id]);
  await audit(s, done ? "done" : "reopened", e.matterId, id, { kind: e.kind });
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
/** Long lines folded at 75 octets, as calendar programs expect. */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join("\r\n");
}

export async function courtCalendarIcs(s: FirmSession, matterId: string): Promise<{ filename: string; body: string }> {
  reader(s);
  const m = await getMatter(s, matterId);
  const tz = (await s.client.query<{ tz: string }>("SELECT time_zone AS tz FROM huis.firms WHERE id = huis.current_firm_id()")).rows[0]!.tz;
  const events = (await listCourtEvents(s, matterId)).filter((e) => e.status === "confirmed");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Huis Law//Court Calendar//EN", "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${icsText(`${m.title} — court dates`)}`,
  ];
  for (const e of events) {
    const day = e.date.replace(/-/g, "");
    lines.push("BEGIN:VEVENT", `UID:${e.id}@huis.law`, `DTSTAMP:${stamp}`);
    if (e.time) {
      const t = `${e.time.replace(":", "")}00`;
      lines.push(`DTSTART;TZID=${icsText(tz)}:${day}T${t}`, "DURATION:PT1H");
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
