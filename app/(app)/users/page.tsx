import { changeRoleAction, disableUserAction, endSessionsAction, inviteUserAction, reissueInviteAction } from "../../../lib/actions";
import { getFlash, withSession } from "../../../lib/server";
import { FlashBanner, ROLE_LABELS } from "../../../lib/ui";
import { listUsers } from "../../../src/services/users";
import { can, ROLES } from "../../../src/security/permissions";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function Users({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const flash = await getFlash((await searchParams).f);
  const data = await withSession(async (s) => {
    if (!can(s.actor.role, "users.manage")) return null;
    const loc = await s.client.query<{ id: string; name: string }>("SELECT id, name FROM huis.firm_locations ORDER BY created_at");
    return { users: await listUsers(s), locations: loc.rows, me: s.actor.userId };
  });
  if (!data) notFound();
  const { users, locations, me } = data;
  return (
    <>
      <h1>Users &amp; Access</h1>
      <p className="sub">
        Each person gets one license at one firm location. People outside the firm (clients, co-counsel, experts) only ever see
        matters you explicitly add them to.
      </p>
      <FlashBanner flash={flash} />
      <div className="card">
        <h2>Add a person</h2>
        <form action={inviteUserAction} className="row">
          <label>Full name<input name="fullName" required maxLength={200} /></label>
          <label>Email<input name="email" type="email" required /></label>
          <label>Role<select name="role" defaultValue="attorney">{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select></label>
          <label>Location<select name="locationId">{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
          <button type="submit">Add and create invitation link</button>
        </form>
        <p className="notice">
          You&apos;ll get a one-time invitation link to send them. Huis never connects accounts by email address — only through this link.
        </p>
      </div>
      <div className="card">
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Sign-in</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.fullName}{u.id === me ? " (you)" : ""}</td>
                <td>{u.email}</td>
                <td>
                  {u.id === me ? ROLE_LABELS[u.role] : (
                    <form action={changeRoleAction} className="row">
                      <input type="hidden" name="userId" value={u.id} />
                      <select name="role" defaultValue={u.role}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select>
                      <button type="submit" className="secondary">Save</button>
                    </form>
                  )}
                </td>
                <td>{u.signInLinked ? "Linked" : (
                  u.status === "active" ? (
                    <form action={reissueInviteAction}>
                      <input type="hidden" name="userId" value={u.id} />
                      <button type="submit" className="secondary">New invitation link</button>
                    </form>
                  ) : "—"
                )}</td>
                <td><span className="badge">{u.status}</span></td>
                <td>
                  {u.status === "active" && u.signInLinked ? (
                    <form action={endSessionsAction} style={{ marginBottom: 6 }}>
                      <input type="hidden" name="userId" value={u.id} />
                      <button type="submit" className="secondary">Sign out everywhere</button>
                    </form>
                  ) : null}
                  {u.status === "active" && u.id !== me ? (
                    <form action={disableUserAction}>
                      <input type="hidden" name="userId" value={u.id} />
                      <button type="submit" className="danger">Remove access</button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
