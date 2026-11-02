import { withSession } from "../../../lib/server";
import { notFound } from "next/navigation";
import { listAuditEvents, verifyAuditChain } from "../../../src/services/audit";
import { can } from "../../../src/security/permissions";

export const dynamic = "force-dynamic";

export default async function Audit() {
  const data = await withSession(async (s) => {
    if (!can(s.actor.role, "audit.view")) return null;
    const events = await listAuditEvents(s, 200);
    const broken = await verifyAuditChain(s);
    const users = await s.client.query<{ id: string; full_name: string }>("SELECT id, full_name FROM huis.users");
    return { events, broken, names: new Map(users.rows.map((u) => [u.id, u.full_name])) };
  });
  if (!data) notFound();
  const { events, broken, names } = data;
  return (
    <>
      <h1>Audit Log</h1>
      <p className="sub">Every action in your firm, in order. Entries can never be edited or deleted.</p>
      {broken === null ? (
        <div className="flash success">Integrity check passed: the audit chain is intact.</div>
      ) : (
        <div className="flash error" role="alert">Integrity check FAILED at entry #{broken}. Contact Huis security immediately.</div>
      )}
      <div className="card">
        <table>
          <thead><tr><th>#</th><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td>{e.id}</td>
                <td>{new Date(e.occurredAt).toLocaleString("en-US", { timeZone: "America/Denver" })}</td>
                <td>{e.actorUserId ? names.get(e.actorUserId) ?? "Unknown" : "System"}</td>
                <td><code>{e.action}</code></td>
                <td className="notice">{Object.keys(e.metadata).length ? JSON.stringify(e.metadata) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
