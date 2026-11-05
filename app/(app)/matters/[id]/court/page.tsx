import Link from "next/link";
import { notFound } from "next/navigation";
import { courtAddAction, courtDecideAction, courtDeleteAction, courtDoneAction, courtUpdateAction } from "../../../../../lib/actions";
import { getFlash, withSession } from "../../../../../lib/server";
import { FlashBanner } from "../../../../../lib/ui";
import { WORK_PRODUCT_LABEL } from "../../../../../src/ai/gateway";
import { NotFoundError } from "../../../../../src/errors";
import {
  alertFor, courtNotices, EVENT_KIND_LABELS, EVENT_KINDS, listCourtEvents, type CourtEvent,
} from "../../../../../src/services/court";
import { getMatter } from "../../../../../src/services/matters";
import { INTERNAL_ROLES } from "../../../../../src/security/permissions";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** A calendar date shown without time-zone shifts, e.g. "Wed, Nov 11, 2026". */
const showDate = (d: string) => {
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  return `${DAYS[new Date(Date.UTC(y, m - 1, day)).getUTCDay()]}, ${MONTHS[m - 1]} ${day}, ${y}`;
};
const showTime = (t: string | null) => {
  if (!t) return null;
  const [h, min] = t.split(":").map(Number) as [number, number];
  return `${((h + 11) % 12) + 1}:${String(min).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

export default async function CourtPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ f?: string; past?: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const sp = await searchParams;
  const flash = await getFlash(sp.f);
  const data = await withSession(async (s) => {
    if (!INTERNAL_ROLES.has(s.actor.role)) return null;
    let matter;
    try { matter = await getMatter(s, id); } catch (e) { if (e instanceof NotFoundError) return null; throw e; }
    return { matter, events: await listCourtEvents(s, id), notices: await courtNotices(s, id), canWrite: s.actor.role !== "read_only" };
  });
  if (!data) notFound();
  const { matter: m, events, notices } = data;
  const proposed = events.filter((e) => e.status === "suggested");
  const confirmed = events.filter((e) => e.status === "confirmed");
  const upcoming = confirmed.filter((e) => e.daysAway >= 0 && !e.done);
  const past = confirmed.filter((e) => e.daysAway < 0 || e.done);
  const hidden = (e: CourtEvent) => (
    <>
      <input type="hidden" name="matterId" value={m.id} />
      <input type="hidden" name="eventId" value={e.id} />
    </>
  );
  const when = (e: CourtEvent) => (
    <>
      <strong>{showDate(e.date)}</strong>
      {e.time ? <div className="notice">{showTime(e.time)}</div> : <div className="notice">All day</div>}
    </>
  );
  const details = (e: CourtEvent) => (
    <>
      <span className="badge">{EVENT_KIND_LABELS[e.kind]}</span> {e.title}
      {e.location || e.judge ? <div className="notice">{[e.location, e.judge].filter(Boolean).join(" · ")}</div> : null}
      {e.notes ? <div className="notice">{e.notes}</div> : null}
      {e.reader && !e.readerVerified ? (
        <div className="notice"><span className="badge walled">Utah format not yet verified</span> Read from a Utah notice by a reader not yet checked against real notices: compare it with the notice carefully.</div>
      ) : null}
      {e.quote && e.sourceEvidenceId ? (
        <div className="notice">From <Link href={`/evidence/${e.sourceEvidenceId}`}>{e.sourceTitle ?? "the court notice"}</Link>: “{e.quote}”</div>
      ) : null}
    </>
  );
  const fields = (e?: CourtEvent) => (
    <>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <label style={{ flex: 1 }}>Type
          <select name="kind" defaultValue={e?.kind ?? "hearing"}>
            {EVENT_KINDS.map((k) => <option key={k} value={k}>{EVENT_KIND_LABELS[k]}</option>)}
          </select>
        </label>
        <label style={{ flex: 3 }}>What<input name="title" maxLength={200} required defaultValue={e?.title} placeholder="e.g. Motion hearing, Responses due" /></label>
      </div>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <label style={{ flex: 1 }}>Date<input type="date" name="date" required defaultValue={e?.date} /></label>
        <label style={{ flex: 1 }}>Time (blank for all day)<input type="time" name="time" defaultValue={e?.time ?? ""} /></label>
        <label style={{ flex: 2 }}>Where<input name="location" maxLength={200} defaultValue={e?.location ?? ""} /></label>
        <label style={{ flex: 2 }}>Judge<input name="judge" maxLength={200} defaultValue={e?.judge ?? ""} /></label>
      </div>
      <label>Notes<textarea name="notes" rows={2} maxLength={5000} defaultValue={e?.notes} /></label>
    </>
  );

  return (
    <>
      <p className="notice"><Link href={`/matters/${m.id}`}>← {m.title}</Link> · <Link href={`/matters/${m.id}/timeline`}>Timeline</Link> · <Link href="/alerts">Alerts</Link> · <Link href="/court-connections">Court connections</Link></p>
      <h1>Court calendar</h1>
      <p className="sub">
        {m.courtCaseNumber ? <>Case {m.courtCaseNumber}. </> : null}
        Hearings, conferences, trials and deadlines for this Matter. Huis proposes the dates it reads in federal court notices filed into the Matter; nothing counts until you confirm it.
        <br /><span className="badge privileged">{WORK_PRODUCT_LABEL}</span>
      </p>
      <FlashBanner flash={flash} />

      {proposed.length ? (
        <div className="card">
          <h2>Proposed by Huis ({proposed.length}) — please check each one</h2>
          <p className="notice">Read from court notices. Check each date against the order itself before confirming; a wrong deadline can harm the client. Rejected dates aren&apos;t proposed again.</p>
          <table><tbody>
            {proposed.map((e) => (
              <tr key={e.id}>
                <td style={{ width: 170, verticalAlign: "top" }}>{when(e)}</td>
                <td style={{ verticalAlign: "top" }}>{details(e)}</td>
                <td style={{ whiteSpace: "nowrap", width: 1, verticalAlign: "top" }}>
                  {data.canWrite ? (
                    <div className="row">
                      {(["confirmed", "rejected"] as const).map((d) => (
                        <form key={d} action={courtDecideAction}>
                          {hidden(e)}<input type="hidden" name="decision" value={d} />
                          <button type="submit" className={d === "confirmed" ? "" : "secondary"}>{d === "confirmed" ? "Confirm" : "Reject"}</button>
                        </form>
                      ))}
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody></table>
        </div>
      ) : null}

      <div className="card">
        <h2>Upcoming</h2>
        {upcoming.length === 0 ? <p className="notice">No upcoming confirmed court dates.</p> : (
          <table><tbody>
            {upcoming.map((e) => {
              const alert = alertFor(e.daysAway);
              return (
                <tr key={e.id}>
                  <td style={{ width: 170, verticalAlign: "top" }}>{when(e)}</td>
                  <td style={{ verticalAlign: "top" }}>
                    {details(e)}
                    {data.canWrite ? (
                      <details style={{ marginTop: 6 }}>
                        <summary className="notice">Change</summary>
                        <form action={courtUpdateAction} style={{ marginTop: 6 }}>
                          {hidden(e)}{fields(e)}
                          <div style={{ marginTop: 6 }}><button type="submit" className="secondary">Save</button></div>
                        </form>
                        {e.origin === "attorney" ? (
                          <form action={courtDeleteAction} style={{ marginTop: 6 }}>{hidden(e)}<button type="submit" className="secondary">Delete</button></form>
                        ) : null}
                      </details>
                    ) : null}
                  </td>
                  <td style={{ width: 130, verticalAlign: "top" }}>
                    {alert ? <span className={e.daysAway <= 3 ? "badge privileged" : "badge walled"}>{alert}</span> : <span className="notice">In {e.daysAway} days</span>}
                    {data.canWrite ? (
                      <form action={courtDoneAction} style={{ marginTop: 6 }}>{hidden(e)}<input type="hidden" name="done" value="1" /><button type="submit" className="secondary">Mark done</button></form>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody></table>
        )}
        <p className="notice">Reminders: 30, 14, 7, 3 and 1 day before each date, shown here and on your dashboard.</p>
        <form method="post" action={`/api/matters/${m.id}/court`} className="row" style={{ alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" name="acknowledge" required /> I&apos;ll store this privileged calendar file securely
          </label>
          <button type="submit" className="secondary">Download calendar file (.ics)</button>
        </form>
        <p className="notice">Adds the confirmed dates, with reminders, to Outlook, Google Calendar or Apple Calendar. It doesn&apos;t update itself: download it again after changes.</p>
      </div>

      {past.length ? (
        <div className="card">
          <h2>Past and done ({past.length})</h2>
          <table><tbody>
            {past.slice(-50).reverse().map((e) => (
              <tr key={e.id}>
                <td style={{ width: 170 }}>{when(e)}</td>
                <td>{details(e)}{e.done ? <div className="notice">Done</div> : null}</td>
                <td style={{ width: 1 }}>
                  {data.canWrite && e.done ? (
                    <form action={courtDoneAction}>{hidden(e)}<input type="hidden" name="done" value="0" /><button type="submit" className="secondary">Reopen</button></form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody></table>
        </div>
      ) : null}

      {data.canWrite ? (
        <div className="card">
          <h2>Add a court date</h2>
          <form action={courtAddAction}>
            <input type="hidden" name="matterId" value={m.id} />
            {fields()}
            <div style={{ marginTop: 8 }}><button type="submit">Add</button></div>
          </form>
        </div>
      ) : null}

      <div className="card">
        <h2>Docket from court notices ({notices.length})</h2>
        <p className="notice">
          Court notices filed into this Matter, newest first: federal CM/ECF notices, and Utah notices from a Utah courts address or your firm&apos;s
          registered e-filing provider (see <Link href="/court-connections">Court connections</Link>). File them from the Huis Inbox. Each federal notice gives you one free look at the
          filed document for 15 days: download it during that look to avoid PACER fees.
        </p>
        {notices.length === 0 ? <p className="notice">No federal court notices filed into this Matter yet.</p> : (
          <table><tbody>
            {notices.map((n) => (
              <tr key={n.evidenceId}>
                <td style={{ width: 120, verticalAlign: "top" }}>{n.enteredOn ? showDate(n.enteredOn) : "—"}{n.documentNumber ? <div className="notice">Doc. {n.documentNumber}</div> : null}</td>
                <td style={{ verticalAlign: "top" }}>
                  <div>{n.docketText ? (n.docketText.length > 500 ? `${n.docketText.slice(0, 497)}…` : n.docketText) : n.subject}</div>
                  <div className="notice">
                    {[n.court, n.caseNumber].filter(Boolean).join(" · ")} · <Link href={`/evidence/${n.evidenceId}`}>Open the notice</Link>
                    {n.datesFound ? <> · {n.datesFound} date{n.datesFound === 1 ? "" : "s"} found</> : null}
                  </div>
                  {!n.readerVerified ? <div className="notice"><span className="badge walled">Utah format not yet verified</span></div> : null}
                  {n.caseMismatch ? <div className="notice"><span className="badge walled">Different case number</span> This notice names case {n.caseNumber}, not this Matter&apos;s {m.courtCaseNumber}. Check it was filed to the right Matter.</div> : null}
                </td>
                <td style={{ width: 170, verticalAlign: "top" }}>
                  {n.documentUrl && n.freeLookDaysLeft ? (
                    <>
                      <a className="button secondary" href={n.documentUrl} target="_blank" rel="noopener noreferrer">Open document</a>
                      <div className="notice">Free look: {n.freeLookDaysLeft} day{n.freeLookDaysLeft === 1 ? "" : "s"} left</div>
                    </>
                  ) : n.documentUrl ? <span className="notice">Free look has ended (PACER fees apply)</span> : null}
                </td>
              </tr>
            ))}
          </tbody></table>
        )}
      </div>
    </>
  );
}
