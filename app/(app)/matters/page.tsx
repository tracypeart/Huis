import Link from "next/link";
import { getFlash, withSession } from "../../../lib/server";
import { date, FlashBanner } from "../../../lib/ui";
import { listMatters } from "../../../src/services/matters";
import { can } from "../../../src/security/permissions";

export const dynamic = "force-dynamic";

export default async function Matters({ searchParams }: { searchParams: Promise<{ f?: string; q?: string }> }) {
  const { f, q } = await searchParams;
  const flash = await getFlash(f);
  const { matters, canCreate } = await withSession(async (s) => ({
    matters: await listMatters(s), canCreate: can(s.actor.role, "matters.create"),
  }));
  const needle = (q ?? "").trim().toLowerCase();
  const shown = needle
    ? matters.filter((m) => [m.title, m.huisNumber, m.courtCaseNumber, m.firmMatterNumber].some((v) => v?.toLowerCase().includes(needle)))
    : matters;

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
        <div><h1>Matters</h1><p className="sub">Every matter you have access to. Walled matters appear only for their members.</p></div>
        {canCreate ? <Link className="button" href="/matters/new">New matter</Link> : null}
      </div>
      <FlashBanner flash={flash} />
      <div className="card">
        <form className="row" method="get" style={{ marginBottom: 12 }}>
          <input name="q" defaultValue={q} placeholder="Search by title, Huis number or court case number" style={{ flex: 1, minWidth: 240 }} />
          <button type="submit" className="secondary">Search</button>
        </form>
        {shown.length === 0 ? <p className="notice">No matters found.</p> : (
          <table>
            <thead><tr><th>Matter</th><th>Huis number</th><th>Court case</th><th>Firm number</th><th>State</th><th>Status</th><th>Opened</th></tr></thead>
            <tbody>
              {shown.map((m) => (
                <tr key={m.id}>
                  <td><Link href={`/matters/${m.id}`}>{m.title}</Link> {m.restricted ? <span className="badge walled">Ethical wall</span> : null}</td>
                  <td>{m.huisNumber}</td>
                  <td>{m.courtCaseNumber ?? "—"}</td>
                  <td>{m.firmMatterNumber ?? "—"}</td>
                  <td>{m.jurisdictionState}</td>
                  <td><span className="badge">{m.status}</span></td>
                  <td>{date(m.openedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
