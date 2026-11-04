import Link from "next/link";
import { withSession } from "../../../lib/server";
import { date } from "../../../lib/ui";
import { listMatters } from "../../../src/services/matters";
import { EVENT_KIND_LABELS, upcomingCourtDates } from "../../../src/services/court";
import { can, INTERNAL_ROLES } from "../../../src/security/permissions";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const data = await withSession(async (s) => {
    const matters = await listMatters(s);
    const counts = await s.client.query<{ clients: number; users: number; plan: string; trial_ends_at: Date | null }>(
      `SELECT (SELECT count(*)::int FROM huis.clients) AS clients,
              (SELECT count(*)::int FROM huis.users WHERE status = 'active') AS users,
              f.plan, f.trial_ends_at FROM huis.firms f`,
    );
    return { matters, c: counts.rows[0], actor: s.actor, court: await upcomingCourtDates(s, 30) };
  });
  const open = data.matters.filter((m) => m.status === "open");
  const staff = INTERNAL_ROLES.has(data.actor.role);
  const trialDays = data.c?.trial_ends_at
    ? Math.max(0, Math.ceil((new Date(data.c.trial_ends_at).getTime() - Date.now()) / 86_400_000)) : null;

  return (
    <>
      <h1>Welcome, {data.actor.fullName.split(" ")[0]}</h1>
      <p className="sub">{staff ? "Here is where your firm's matters stand." : "Here are the matters your law firm has shared with you."}</p>
      {staff && data.c?.plan === "trial" && trialDays !== null ? (
        <div className="flash success">Free trial: {trialDays} day{trialDays === 1 ? "" : "s"} remaining.</div>
      ) : null}
      {staff ? (
        <div className="card" style={{ marginBottom: 20 }}>
          <h2>Court dates in the next 30 days</h2>
          {data.court.length === 0 ? <p className="notice">No confirmed court dates in the next 30 days.</p> : (
            <table><tbody>
              {data.court.map((e) => (
                <tr key={e.id}>
                  <td style={{ width: 130, whiteSpace: "nowrap" }}><strong>{e.date}</strong>{e.time ? <div className="notice">{e.time}</div> : null}</td>
                  <td>
                    <span className="badge">{EVENT_KIND_LABELS[e.kind]}</span> {e.title}
                    <div className="notice"><Link href={`/matters/${e.matterId}/court`}>{e.matterTitle}</Link></div>
                  </td>
                  <td style={{ width: 120 }}>{e.alert ? <span className={e.daysAway <= 3 ? "badge privileged" : "badge walled"}>{e.alert}</span> : <span className="notice">In {e.daysAway} days</span>}</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </div>
      ) : null}
      <div className="grid" style={{ marginBottom: 20 }}>
        <div className="card"><div className="stat">{open.length}</div><div className="stat-label">Open matters</div></div>
        {can(data.actor.role, "clients.view") ? (
          <div className="card"><div className="stat">{data.c?.clients ?? 0}</div><div className="stat-label">Clients</div></div>
        ) : null}
        {can(data.actor.role, "users.manage") ? (
          <div className="card"><div className="stat">{data.c?.users ?? 0}</div><div className="stat-label">Active users</div></div>
        ) : null}
      </div>
      <div className="card">
        <h2>Recent matters</h2>
        {data.matters.length === 0 ? (
          <p className="notice">
            No matters yet.{" "}
            {can(data.actor.role, "matters.create") ? <Link href="/matters/new">Create your first matter</Link> : null}
          </p>
        ) : (
          <table>
            <thead><tr><th>Matter</th><th>Huis number</th><th>Court case</th><th>Opened</th></tr></thead>
            <tbody>
              {data.matters.slice(0, 8).map((m) => (
                <tr key={m.id}>
                  <td><Link href={`/matters/${m.id}`}>{m.title}</Link> {m.restricted ? <span className="badge walled">Ethical wall</span> : null}</td>
                  <td>{m.huisNumber}</td>
                  <td>{m.courtCaseNumber ?? "—"}</td>
                  <td>{date(m.openedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {staff ? (
        <div className="card">
          <h2>Coming next</h2>
          <p className="notice">A full export of each Matter&apos;s Brain and evidence, then case timelines and the contradiction engine, AI legal research, court calendars (Utah first) and integrations.</p>
        </div>
      ) : null}
    </>
  );
}
