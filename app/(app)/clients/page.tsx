import { createClientAction } from "../../../lib/actions";
import { getFlash, withSession } from "../../../lib/server";
import { FlashBanner } from "../../../lib/ui";
import { listClients } from "../../../src/services/clients";
import { can } from "../../../src/security/permissions";

export const dynamic = "force-dynamic";

export default async function Clients({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const flash = await getFlash((await searchParams).f);
  const { clients, canCreate } = await withSession(async (s) => ({
    clients: await listClients(s), canCreate: can(s.actor.role, "clients.create"),
  }));
  return (
    <>
      <h1>Clients</h1>
      <p className="sub">Clients are confidential to your firm.</p>
      <FlashBanner flash={flash} />
      {canCreate ? (
        <div className="card">
          <h2>Add a client</h2>
          <form action={createClientAction} className="row">
            <label>Type<select name="kind"><option value="person">Person</option><option value="organization">Organization</option></select></label>
            <label>Name<input name="displayName" required maxLength={300} /></label>
            <label>Email<input name="email" type="email" maxLength={300} /></label>
            <label>Phone<input name="phone" maxLength={50} /></label>
            <button type="submit">Add client</button>
          </form>
        </div>
      ) : null}
      <div className="card">
        {clients.length === 0 ? <p className="notice">No clients yet.</p> : (
          <table>
            <thead><tr><th>Name</th><th>Type</th><th>Email</th><th>Phone</th></tr></thead>
            <tbody>{clients.map((c) => (
              <tr key={c.id}><td>{c.displayName}</td><td>{c.kind}</td><td>{c.email ?? "—"}</td><td>{c.phone ?? "—"}</td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </>
  );
}
