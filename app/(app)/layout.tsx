import Link from "next/link";
import { withSession } from "../../lib/server";
import { ROLE_LABELS } from "../../lib/ui";
import { can, INTERNAL_ROLES } from "../../src/security/permissions";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { actor, firmName } = await withSession(async (s) => {
    const { rows } = await s.client.query<{ name: string }>("SELECT name FROM huis.firms");
    return { actor: s.actor, firmName: rows[0]?.name ?? "" };
  });
  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <div className="logo">Huis Law IP<small>{firmName}</small></div>
        <Link href="/dashboard">Dashboard</Link>
        {INTERNAL_ROLES.has(actor.role) ? <Link href="/inbox">Inbox</Link> : null}
        <Link href="/matters">Matters</Link>
        <Link href="/search">Search</Link>
        {INTERNAL_ROLES.has(actor.role) ? <Link href="/prompts">AI Prompts</Link> : null}
        {INTERNAL_ROLES.has(actor.role) ? <Link href="/authorities">Legal Authorities</Link> : null}
        {can(actor.role, "clients.view") ? <Link href="/clients">Clients</Link> : null}
        {can(actor.role, "contacts.view") ? <Link href="/contacts">People &amp; Contacts</Link> : null}
        {can(actor.role, "users.manage") ? <Link href="/users">Users &amp; Access</Link> : null}
        {can(actor.role, "audit.view") ? <Link href="/audit">Audit Log</Link> : null}
        <div className="spacer" />
        <div className="who">{actor.fullName}<br />{ROLE_LABELS[actor.role]}</div>
        <form action="/api/auth/signout" method="post"><button type="submit">Sign out</button></form>
      </nav>
      <main className="main">{children}</main>
    </div>
  );
}
