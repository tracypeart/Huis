import { createContactAction } from "../../../lib/actions";
import { getFlash, withSession } from "../../../lib/server";
import { CONTACT_LABELS, FlashBanner } from "../../../lib/ui";
import { CONTACT_KINDS, listContacts } from "../../../src/services/contacts";
import { can } from "../../../src/security/permissions";

export const dynamic = "force-dynamic";

export default async function Contacts({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const flash = await getFlash((await searchParams).f);
  const { contacts, canCreate } = await withSession(async (s) => ({
    contacts: await listContacts(s), canCreate: can(s.actor.role, "contacts.create"),
  }));
  return (
    <>
      <h1>People &amp; Contacts</h1>
      <p className="sub">Reusable profiles for judges, opposing counsel, witnesses and experts. Link them to any matter.</p>
      <FlashBanner flash={flash} />
      {canCreate ? (
        <div className="card">
          <h2>Add a person</h2>
          <form action={createContactAction} className="row">
            <label>Type<select name="kind">{CONTACT_KINDS.map((k) => <option key={k} value={k}>{CONTACT_LABELS[k]}</option>)}</select></label>
            <label>Full name<input name="fullName" required maxLength={200} /></label>
            <label>Organization<input name="organization" maxLength={300} /></label>
            <label>Email<input name="email" type="email" /></label>
            <label>Phone<input name="phone" maxLength={50} /></label>
            <label>Bar number<input name="barNumber" maxLength={50} /></label>
            <button type="submit">Add</button>
          </form>
        </div>
      ) : null}
      <div className="card">
        {contacts.length === 0 ? <p className="notice">No contacts yet.</p> : (
          <table>
            <thead><tr><th>Name</th><th>Type</th><th>Organization</th><th>Email</th><th>Bar #</th></tr></thead>
            <tbody>{contacts.map((c) => (
              <tr key={c.id}><td>{c.fullName}</td><td>{CONTACT_LABELS[c.kind]}</td><td>{c.organization ?? "—"}</td><td>{c.email ?? "—"}</td><td>{c.barNumber ?? "—"}</td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </>
  );
}
