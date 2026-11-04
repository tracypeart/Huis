import Link from "next/link";
import { notFound } from "next/navigation";
import { dnaAddClaimAction, dnaAddNodeAction, dnaDecideAction, dnaImportPeopleAction } from "../../../../../lib/actions";
import { getFlash, withSession } from "../../../../../lib/server";
import { FlashBanner } from "../../../../../lib/ui";
import { WORK_PRODUCT_LABEL } from "../../../../../src/ai/gateway";
import { TEMPLATE_NOTE } from "../../../../../src/dna/templates";
import { NotFoundError } from "../../../../../src/errors";
import { CLAIM_TEMPLATES, KIND_LABELS, listNodes, MAX_LISTED, type DnaNode, type NodeKind } from "../../../../../src/services/dna";
import { getMatter } from "../../../../../src/services/matters";
import { INTERNAL_ROLES } from "../../../../../src/security/permissions";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECTIONS: NodeKind[] = ["person", "organization", "event", "fact", "damage"];
const SINGULAR = { person: "Person", organization: "Organization", event: "Event", fact: "Fact", damage: "Damage" } as const;

export default async function CaseDnaPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ f?: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const flash = await getFlash((await searchParams).f);
  const data = await withSession(async (s) => {
    if (!INTERNAL_ROLES.has(s.actor.role)) return null;
    let matter;
    try { matter = await getMatter(s, id); } catch (e) { if (e instanceof NotFoundError) return null; throw e; }
    return { matter, nodes: await listNodes(s, id), canWrite: s.actor.role !== "read_only" };
  });
  if (!data) notFound();
  const { matter: m, nodes } = data;
  const suggested = nodes.filter((n) => n.status === "suggested");
  const confirmed = nodes.filter((n) => n.status === "confirmed");
  const claims = confirmed.filter((n) => n.kind === "claim" || n.kind === "defense");
  const href = (n: DnaNode) => `/matters/${m.id}/dna/${n.id}`;
  const back = `/matters/${m.id}/dna`;

  return (
    <>
      <p className="notice"><Link href={`/matters/${m.id}`}>← {m.title}</Link> · <Link href={`/matters/${m.id}/brain`}>Matter Brain</Link> · <Link href={`/matters/${m.id}/timeline`}>Timeline</Link></p>
      <h1>Case DNA™</h1>
      <p className="sub">
        How this case fits together: people, events, claims and their elements, facts and damages, each linked to the evidence behind it.
        Huis suggests; you decide.<br /><span className="badge privileged">{WORK_PRODUCT_LABEL}</span>
      </p>
      <FlashBanner flash={flash} />
      {nodes.length >= MAX_LISTED ? <p className="notice">This map is very large: showing the first {MAX_LISTED.toLocaleString()} items (everything confirmed comes first).</p> : null}

      <div className="card">
        <h2>Claims and defenses</h2>
        {claims.length === 0 ? <p className="notice">No claims yet. Add one to see its elements and the evidence for each.</p> : (
          <ul style={{ paddingLeft: 18 }}>
            {claims.map((c) => <li key={c.id}><Link href={href(c)}>{c.label}</Link> <span className="badge">{c.kind}</span></li>)}
          </ul>
        )}
        {data.canWrite ? (
          <form action={dnaAddClaimAction} style={{ marginTop: 12 }}>
            <input type="hidden" name="matterId" value={m.id} />
            <div className="row">
              <label style={{ flex: 2 }}>Start from
                <select name="template" defaultValue={CLAIM_TEMPLATES[0]!.key}>
                  {CLAIM_TEMPLATES.map((t) => <option key={t.key} value={t.key}>{t.title}</option>)}
                  <option value="custom">My own claim or defense (name it below)</option>
                </select>
              </label>
              <label style={{ flex: 1 }}>Type
                <select name="kind" defaultValue="claim"><option value="claim">Claim</option><option value="defense">Defense</option></select>
              </label>
            </div>
            <label>Name (for your own)<input name="label" maxLength={300} /></label>
            <div style={{ marginTop: 8 }}><button type="submit">Add claim</button></div>
            <p className="notice">{TEMPLATE_NOTE}</p>
          </form>
        ) : null}
      </div>

      {suggested.length ? (
        <div className="card">
          <h2>Suggested by Huis ({suggested.length})</h2>
          <p className="notice">Found in the Matter&apos;s documents and email. Nothing counts until you confirm it; rejected suggestions aren&apos;t suggested again.</p>
          <table><tbody>
            {suggested.slice(0, 100).map((n) => (
              <tr key={n.id}>
                <td style={{ width: 110 }}><span className="badge">{n.kind}</span></td>
                <td><Link href={href(n)}>{n.label}</Link>{n.eventDate ? <div className="notice">{n.eventDate}</div> : null}{n.email ? <div className="notice">{n.email}</div> : null}</td>
                <td style={{ whiteSpace: "nowrap", width: 1 }}>
                  {data.canWrite ? (
                    <div className="row">
                      {(["confirmed", "rejected"] as const).map((d) => (
                        <form key={d} action={dnaDecideAction}>
                          <input type="hidden" name="matterId" value={m.id} /><input type="hidden" name="nodeId" value={n.id} />
                          <input type="hidden" name="decision" value={d} /><input type="hidden" name="back" value={back} />
                          <button type="submit" className={d === "confirmed" ? "" : "secondary"}>{d === "confirmed" ? "Confirm" : "Reject"}</button>
                        </form>
                      ))}
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody></table>
          {suggested.length > 100 ? <p className="notice">Showing the first 100.</p> : null}
        </div>
      ) : null}

      <div className="grid">
        {SECTIONS.map((kind) => {
          const list = confirmed.filter((n) => n.kind === kind);
          return (
            <div className="card" key={kind}>
              <h2>{KIND_LABELS[kind]}</h2>
              {list.length === 0 ? <p className="notice">None yet.</p> : (
                <ul style={{ paddingLeft: 18 }}>
                  {list.map((n) => (
                    <li key={n.id}>
                      {n.eventDate ? <span className="notice">{n.eventDate} · </span> : null}
                      <Link href={href(n)}>{n.label}</Link>
                      {n.role ? <span className="notice"> · {n.role}</span> : null}
                      {n.amount != null ? <span className="notice"> · ${n.amount.toLocaleString("en-US")}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
              {kind === "person" && data.canWrite ? (
                <form action={dnaImportPeopleAction}>
                  <input type="hidden" name="matterId" value={m.id} />
                  <button type="submit" className="secondary">Add the client and contacts</button>
                </form>
              ) : null}
            </div>
          );
        })}
      </div>

      {data.canWrite ? (
        <div className="card">
          <h2>Add to Case DNA</h2>
          <form action={dnaAddNodeAction}>
            <input type="hidden" name="matterId" value={m.id} />
            <div className="row">
              <label style={{ flex: 1 }}>Type
                <select name="kind" defaultValue="fact">
                  {(["person", "organization", "event", "fact", "damage"] as const).map((k) => <option key={k} value={k}>{SINGULAR[k]}</option>)}
                </select>
              </label>
              <label style={{ flex: 3 }}>Name or description<input name="label" maxLength={300} required /></label>
            </div>
            <div className="row">
              <label style={{ flex: 1 }}>Date (events)<input type="date" name="eventDate" /></label>
              <label style={{ flex: 1 }}>Email (people)<input type="email" name="email" maxLength={320} /></label>
              <label style={{ flex: 1 }}>Role (e.g. witness)<input name="role" maxLength={100} /></label>
              <label style={{ flex: 1 }}>Amount (damages)<input type="number" name="amount" min={0} step="0.01" /></label>
            </div>
            <label>Details<textarea name="details" rows={2} maxLength={20000} /></label>
            <div style={{ marginTop: 8 }}><button type="submit">Add</button></div>
          </form>
        </div>
      ) : null}
    </>
  );
}
