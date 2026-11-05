import pg from "pg";

/**
 * Court date reminders, sent from the worker.
 *
 * Reminders inside Huis (the alerts bell) need nothing more. Email, SMS and
 * push go through an `AlertSender` for each channel. None is set up until
 * production hosting chooses a sending service (open item O-2): until then
 * those reminders are kept as "waiting for a sending service" — visible to
 * the person, never silently dropped — and are sent once one is set up.
 *
 * What leaves Huis is deliberately bare ("You have a court date in 7 days")
 * unless the person asked for details: an email or text message can be read
 * by others, and a court date's wording can be privileged.
 */

export type AlertChannel = "email" | "sms" | "push";

export interface AlertMessage {
  channel: AlertChannel;
  /** Email address or phone number (E.164); push uses the person's devices. */
  to: string;
  subject: string;
  text: string;
}

export interface AlertSender {
  readonly channel: AlertChannel;
  readonly name: string;
  send(message: AlertMessage): Promise<void>;
}

interface Claimed {
  alert_id: string; channel: AlertChannel; email: string; sms_number: string | null; days_before: number; event_date: string | Date;
  include_details: boolean; kind: string | null; title: string | null; event_time: string | null; matter_title: string | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const isoDate = (d: string | Date) => (typeof d === "string" ? d.slice(0, 10)
  : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
const showDate = (iso: string) => { const [y, m, d] = iso.split("-").map(Number) as [number, number, number]; return `${MONTHS[m - 1]} ${d}, ${y}`; };
const when = (days: number) => (days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`);
/** One line, no control characters, bounded (it goes into a subject or a text message). */
const oneLine = (v: string, max: number) => v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** The message for a reminder: bare unless the person asked for details. */
export function alertMessage(a: Omit<Claimed, "alert_id" | "email" | "sms_number" | "channel">, channel: AlertChannel, to: string, link: string): AlertMessage {
  const date = showDate(isoDate(a.event_date));
  if (!a.include_details || !a.title) {
    const text = `Huis Law: you have a court date ${when(a.days_before)} (${date}). Open Huis to see it: ${link}`;
    return { channel, to, subject: `Court date ${when(a.days_before)}`, text };
  }
  const time = a.event_time ? ` at ${a.event_time}` : "";
  const what = oneLine(`${a.kind ? `${a.kind[0]!.toUpperCase()}${a.kind.slice(1)}: ` : ""}${a.title}`, 140);
  const matter = a.matter_title ? ` (${oneLine(a.matter_title, 80)})` : "";
  return {
    channel, to,
    subject: oneLine(`Court date ${when(a.days_before)}: ${what}`, 160),
    text: `Huis Law: ${what}${matter} ${when(a.days_before)}, ${date}${time}. ${link}\nPrivileged & Confidential.`,
  };
}

export class CourtAlertWorker {
  private lastQueued = 0;

  constructor(
    private readonly pool: pg.Pool,
    private readonly senders: Partial<Record<AlertChannel, AlertSender>>,
    private readonly link: string,
    /** How often to look for reminders that are due (they are only ever queued once). */
    private readonly queueEveryMs = 10 * 60_000,
  ) {}

  /** Queues today's reminders (at most every few minutes). Returns how many were added. */
  async queueDue(force = false): Promise<number> {
    if (!force && Date.now() - this.lastQueued < this.queueEveryMs) return 0;
    this.lastQueued = Date.now();
    const r = await this.pool.query<{ n: number }>("SELECT huis.worker_queue_court_alerts() AS n");
    // A sending service that has been set up picks up the reminders that waited for one.
    for (const ch of Object.keys(this.senders) as AlertChannel[]) {
      await this.pool.query("SELECT huis.worker_retry_waiting_court_alerts($1)", [ch]);
    }
    return r.rows[0]?.n ?? 0;
  }

  /** Sends one reminder that leaves Huis. Returns false when none is waiting. */
  async deliverOnce(): Promise<boolean> {
    const a = (await this.pool.query<Claimed>("SELECT * FROM huis.worker_claim_court_alert()")).rows[0];
    if (!a) return false;
    const sender = this.senders[a.channel];
    const to = a.channel === "sms" ? a.sms_number : a.email;
    if (!sender) {
      await this.pool.query("SELECT huis.worker_finish_court_alert($1, 'waiting_for_provider', $2)", [a.alert_id, `No ${a.channel} sending service is set up yet`]);
      return true;
    }
    if (!to) {
      await this.pool.query("SELECT huis.worker_finish_court_alert($1, 'failed', $2)", [a.alert_id, a.channel === "sms" ? "No mobile number" : "No address"]);
      return true;
    }
    try {
      await sender.send(alertMessage(a, a.channel, to, this.link));
      await this.pool.query("SELECT huis.worker_finish_court_alert($1, 'sent', NULL)", [a.alert_id]);
    } catch (err) {
      // Never the message itself in the error.
      const msg = err instanceof Error ? err.name : "send failed";
      await this.pool.query("SELECT huis.worker_finish_court_alert($1, 'failed', $2)", [a.alert_id, `${sender.name}: ${msg}`.slice(0, 200)]);
    }
    return true;
  }

  /** One pass for the worker loop. */
  async runOnce(): Promise<boolean> {
    const queued = await this.queueDue();
    return (await this.deliverOnce()) || queued > 0;
  }
}
