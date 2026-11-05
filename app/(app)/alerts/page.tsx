import Link from "next/link";
import { notFound } from "next/navigation";
import { alertPreferencesAction, alertsReadAction } from "../../../lib/actions";
import { getFlash, withSession } from "../../../lib/server";
import { FlashBanner } from "../../../lib/ui";
import {
  ALERT_CHANNELS, CHANNEL_LABELS, EVENT_KIND_LABELS, getAlertPreferences, listMyAlerts, REMINDER_DAYS,
} from "../../../src/services/alerts";
import { INTERNAL_ROLES } from "../../../src/security/permissions";

export const dynamic = "force-dynamic";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const showDate = (d: string) => { const [y, m, day] = d.split("-").map(Number) as [number, number, number]; return `${MONTHS[m - 1]} ${day}, ${y}`; };
const dayLabel = (n: number) => (n === 0 ? "On the day" : n === 1 ? "1 day before" : `${n} days before`);
const STATUS: Record<string, string> = {
  delivered: "In Huis", queued: "Sending", sending: "Sending", sent: "Sent",
  waiting_for_provider: "Waiting: no sending service set up yet", failed: "Not sent",
};

export default async function AlertsPage({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const flash = await getFlash((await searchParams).f);
  const data = await withSession(async (s) => {
    if (!INTERNAL_ROLES.has(s.actor.role)) return null;
    return { alerts: await listMyAlerts(s), prefs: await getAlertPreferences(s) };
  });
  if (!data) notFound();
  const { alerts, prefs } = data;
  const inApp = alerts.filter((a) => a.channel === "in_app");
  const outside = alerts.filter((a) => a.channel !== "in_app");
  const unread = inApp.filter((a) => !a.read).length;

  return (
    <>
      <h1>Alerts</h1>
      <p className="sub">Reminders of confirmed court dates on Matters you&apos;re a member or lead attorney of.</p>
      <FlashBanner flash={flash} />

      <div className="card">
        <h2>Reminders {unread ? <span className="badge privileged">{unread} new</span> : null}</h2>
        {inApp.length === 0 ? <p className="notice">No reminders yet. They appear 30, 14, 7, 3 and 1 day before each confirmed court date, and on the day.</p> : (
          <>
            {unread ? (
              <form action={alertsReadAction} style={{ marginBottom: 8 }}><button type="submit" className="secondary">Mark all read</button></form>
            ) : null}
            <table><tbody>
              {inApp.map((a) => (
                <tr key={a.id} style={a.read ? { opacity: 0.7 } : undefined}>
                  <td style={{ width: 150 }}><strong>{a.daysBefore === 0 ? "Today" : a.daysBefore === 1 ? "Tomorrow" : `In ${a.daysBefore} days`}</strong></td>
                  <td>
                    <span className="badge">{EVENT_KIND_LABELS[a.kind]}</span> {a.title}
                    <div className="notice">{showDate(a.date)}{a.time ? ` · ${a.time}` : ""} · <Link href={`/matters/${a.matterId}/court`}>{a.matterTitle}</Link></div>
                  </td>
                  <td style={{ width: 1 }}>
                    {!a.read ? (
                      <form action={alertsReadAction}><input type="hidden" name="alertId" value={a.id} /><button type="submit" className="secondary">Mark read</button></form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody></table>
          </>
        )}
      </div>

      {outside.length ? (
        <div className="card">
          <h2>Email, text and phone reminders</h2>
          <table><tbody>
            {outside.slice(0, 50).map((a) => (
              <tr key={a.id}>
                <td style={{ width: 160 }}>{CHANNEL_LABELS[a.channel]}</td>
                <td>{a.title} <span className="notice">· {dayLabel(a.daysBefore)} · {a.matterTitle}</span></td>
                <td style={{ width: 260 }}><span className={a.status === "sent" ? "badge" : "badge walled"}>{STATUS[a.status] ?? a.status}</span></td>
              </tr>
            ))}
          </tbody></table>
          <p className="notice">Email, text and phone reminders are sent once production hosting has a sending service. Until then they wait here and go out when one is set up (if the court date is still ahead).</p>
        </div>
      ) : null}

      <div className="card">
        <h2>My reminder settings</h2>
        <form action={alertPreferencesAction}>
          <fieldset style={{ border: 0, padding: 0, margin: "0 0 10px" }}>
            <legend className="notice">Remind me by</legend>
            <div className="row" style={{ flexWrap: "wrap", gap: 14 }}>
              {ALERT_CHANNELS.map((c) => (
                <label key={c} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                  <input type="checkbox" name="channels" value={c} defaultChecked={prefs.channels.includes(c)} /> {CHANNEL_LABELS[c]}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset style={{ border: 0, padding: 0, margin: "0 0 10px" }}>
            <legend className="notice">When</legend>
            <div className="row" style={{ flexWrap: "wrap", gap: 14 }}>
              {REMINDER_DAYS.map((d) => (
                <label key={d} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                  <input type="checkbox" name="reminderDays" value={d} defaultChecked={prefs.reminderDays.includes(d)} /> {dayLabel(d)}
                </label>
              ))}
            </div>
          </fieldset>
          <label style={{ maxWidth: 360 }}>Mobile number for text messages (with country code)
            <input type="tel" name="smsNumber" defaultValue={prefs.smsNumber ?? ""} placeholder="+1 801 555 0100" maxLength={20} />
          </label>
          <label style={{ display: "inline-flex", gap: 6, alignItems: "center", marginTop: 10 }}>
            <input type="checkbox" name="includeDetails" defaultChecked={prefs.includeDetails} /> Include the court date&apos;s details (what, when, which Matter) in emails and texts
          </label>
          <p className="notice">
            Off by default: emails and texts can be read by others, and a court date&apos;s wording can be privileged. With it off, they say only
            &ldquo;You have a court date in 7 days&rdquo; with a link to Huis.
          </p>
          <div style={{ marginTop: 8 }}><button type="submit">Save</button></div>
        </form>
      </div>
    </>
  );
}
