import { z } from "zod";
import type { FirmSession } from "../db/tenant";
import { NotFoundError, PermissionDeniedError } from "../errors";
import { INTERNAL_ROLES } from "../security/permissions";
import { recordAudit } from "./audit";
import { EVENT_KIND_LABELS, type EventKind } from "./court";

/**
 * Court date reminders: each person's settings and their alerts.
 *
 * Firm staff only, each person their own (the database enforces it). A
 * reminder stores no wording: what it says is read from the court date each
 * time, under the court calendar's rules, so it disappears with the court
 * date or with access to the Matter.
 */

export const ALERT_CHANNELS = ["in_app", "email", "sms", "push"] as const;
export type AlertChannelName = (typeof ALERT_CHANNELS)[number];
export const CHANNEL_LABELS: Record<AlertChannelName, string> = { in_app: "In Huis", email: "Email", sms: "Text message (SMS)", push: "Phone notification" };
export const REMINDER_DAYS = [30, 14, 7, 3, 1, 0] as const;

const staffOnly = (s: FirmSession) => {
  if (!INTERNAL_ROLES.has(s.actor.role)) throw new PermissionDeniedError("use court reminders");
};

export interface AlertPreferences {
  channels: AlertChannelName[]; reminderDays: number[]; includeDetails: boolean; smsNumber: string | null; saved: boolean;
}

export async function getAlertPreferences(s: FirmSession): Promise<AlertPreferences> {
  staffOnly(s);
  const r = (await s.client.query("SELECT channels, reminder_days, include_details, sms_number FROM huis.alert_preferences WHERE user_id = $1", [s.actor.userId])).rows[0];
  return r
    ? { channels: r.channels, reminderDays: r.reminder_days, includeDetails: r.include_details, smsNumber: r.sms_number, saved: true }
    : { channels: ["in_app"], reminderDays: [...REMINDER_DAYS], includeDetails: false, smsNumber: null, saved: false };
}

const prefsInput = z.object({
  channels: z.array(z.enum(ALERT_CHANNELS)).max(4).transform((v) => [...new Set(v)]),
  reminderDays: z.array(z.coerce.number().refine((n) => (REMINDER_DAYS as readonly number[]).includes(n), "Choose from the listed reminders.")).max(6)
    .transform((v) => [...new Set(v)].sort((a, b) => b - a)),
  includeDetails: z.boolean().optional().default(false),
  smsNumber: z.string().trim().transform((v) => v.replace(/[\s().-]/g, "")).pipe(z.string().regex(/^\+[1-9][0-9]{6,14}$/, "Enter the mobile number with its country code, e.g. +1 801 555 0100."))
    .nullish().or(z.literal("").transform(() => null)),
}).refine((v) => !v.channels.includes("sms") || Boolean(v.smsNumber), "Add a mobile number to get text messages.");

export async function setAlertPreferences(s: FirmSession, input: unknown): Promise<void> {
  staffOnly(s);
  const v = prefsInput.parse(input);
  await s.client.query(
    `INSERT INTO huis.alert_preferences (firm_id, user_id, channels, reminder_days, include_details, sms_number, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (user_id) DO UPDATE SET channels = EXCLUDED.channels, reminder_days = EXCLUDED.reminder_days,
       include_details = EXCLUDED.include_details, sms_number = EXCLUDED.sms_number, updated_at = now()`,
    [s.actor.firmId, s.actor.userId, v.channels, v.reminderDays, v.includeDetails, v.smsNumber ?? null]);
  // Which channels and whether details leave Huis — never the phone number.
  await recordAudit(s, "alerts.preferences_changed", { targetType: "user", targetId: s.actor.userId,
    metadata: { channels: v.channels.join(","), details: String(v.includeDetails) } });
}

export interface CourtAlert {
  id: string; matterId: string; matterTitle: string; courtEventId: string; kind: EventKind; title: string; date: string; time: string | null;
  daysBefore: number; channel: AlertChannelName; status: string; createdAt: Date; read: boolean;
}

/** Your reminders, newest first: in Huis, and the state of those sent (or waiting to be sent) outside it. */
export async function listMyAlerts(s: FirmSession, limit = 100): Promise<CourtAlert[]> {
  staffOnly(s);
  // Row-level security: only your own, while you can see the Matter and the court date.
  const { rows } = await s.client.query(
    `SELECT a.id::text AS id, a.matter_id, m.title AS matter_title, a.court_event_id, e.kind, e.title, e.event_date::text AS date,
            to_char(e.event_time, 'HH24:MI') AS time, a.days_before, a.channel, a.status, a.created_at, a.read_at IS NOT NULL AS read
       FROM huis.court_alerts a
       JOIN huis.court_events e ON e.id = a.court_event_id
       JOIN huis.matters m ON m.id = a.matter_id
      WHERE a.user_id = $1
      ORDER BY a.created_at DESC, a.id DESC LIMIT $2`, [s.actor.userId, Math.min(Math.max(limit, 1), 500)]);
  return rows.map((r) => ({
    id: r.id, matterId: r.matter_id, matterTitle: r.matter_title, courtEventId: r.court_event_id, kind: r.kind, title: r.title, date: r.date,
    time: r.time, daysBefore: r.days_before, channel: r.channel, status: r.status, createdAt: r.created_at, read: r.read,
  }));
}

/** Unread reminders in Huis (for the alerts bell). */
export async function unreadAlertCount(s: FirmSession): Promise<number> {
  if (!INTERNAL_ROLES.has(s.actor.role)) return 0;
  return (await s.client.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM huis.court_alerts WHERE user_id = $1 AND channel = 'in_app' AND read_at IS NULL", [s.actor.userId])).rows[0]!.n;
}

export async function markAlertsRead(s: FirmSession, alertId?: string): Promise<number> {
  staffOnly(s);
  if (alertId !== undefined && !/^[0-9]{1,19}$/.test(alertId)) throw new NotFoundError("Reminder");
  const r = alertId
    ? await s.client.query("UPDATE huis.court_alerts SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL", [alertId, s.actor.userId])
    : await s.client.query("UPDATE huis.court_alerts SET read_at = now() WHERE user_id = $1 AND channel = 'in_app' AND read_at IS NULL", [s.actor.userId]);
  return r.rowCount ?? 0;
}

export { EVENT_KIND_LABELS };
