import Link from "next/link";
import { createMatterAction } from "../../../../lib/actions";
import { getFlash, withSession } from "../../../../lib/server";
import { FlashBanner, StateSelect } from "../../../../lib/ui";
import { listClients } from "../../../../src/services/clients";
import { listUsers } from "../../../../src/services/users";
import { ATTORNEY_ROLES, can } from "../../../../src/security/permissions";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function NewMatter({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const flash = await getFlash((await searchParams).f);
  const data = await withSession(async (s) => {
    if (!can(s.actor.role, "matters.create")) return null;
    const users = await listUsers(s);
    return {
      clients: await listClients(s),
      attorneys: users.filter((u) => u.status === "active" && ATTORNEY_ROLES.has(u.role)),
      me: s.actor.userId,
    };
  });
  if (!data) notFound();
  const { clients, attorneys, me } = data;

  return (
    <>
      <h1>New matter</h1>
      <p className="sub">The attorney creates the matter; Huis assigns its number and sets up its folders, including the red Privileged &amp; Confidential area.</p>
      <FlashBanner flash={flash} />
      {clients.length === 0 ? (
        <div className="card"><p>Add a client first. <Link href="/clients">Go to Clients</Link></p></div>
      ) : (
        <div className="card">
          <form action={createMatterAction} className="stack">
            <label>Matter title<input name="title" required maxLength={300} placeholder="e.g. Smith v. Acme Corporation" /></label>
            <label>Client
              <select name="clientId" required>{clients.map((c) => <option key={c.id} value={c.id}>{c.displayName}</option>)}</select>
            </label>
            <label>Lead attorney
              <select name="leadAttorneyId" required defaultValue={attorneys.some((a) => a.id === me) ? me : undefined}>
                {attorneys.map((a) => <option key={a.id} value={a.id}>{a.fullName}</option>)}
              </select>
            </label>
            <label>Jurisdiction (state)<StateSelect name="jurisdictionState" /></label>
            <label>Court<input name="courtName" maxLength={300} placeholder="e.g. Third District Court, Salt Lake County" /></label>
            <label>Court case number (optional — add it later if not assigned yet)<input name="courtCaseNumber" maxLength={100} /></label>
            <label>Your firm&apos;s own matter number (optional)<input name="firmMatterNumber" maxLength={100} /></label>
            <label>Practice area<input name="practiceArea" maxLength={100} placeholder="e.g. Employment" /></label>
            <label className="check">
              <input type="checkbox" name="restricted" />
              <span><strong>Ethical wall.</strong> Only people explicitly added to this matter can see it — including firm administrators.</span>
            </label>
            <button type="submit">Create matter</button>
          </form>
        </div>
      )}
    </>
  );
}
