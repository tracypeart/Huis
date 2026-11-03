import Link from "next/link";
import { notFound } from "next/navigation";
import {
  dnaAddElementAction, dnaAddFactAction, dnaDecideAction, dnaDeleteNodeAction, dnaLinkAction, dnaUnlinkAction, dnaUpdateNodeAction,
} from "../../../../../../lib/actions";
import { getFlash, withSession } from "../../../../../../lib/server";
import { FlashBanner } from "../../../../../../lib/ui";
import { WORK_PRODUCT_LABEL } from "../../../../../../src/ai/gateway";
import { TEMPLATE_NOTE } from "../../../../../../src/dna/templates";
import { NotFoundError, UserFacingError } from "../../../../../../src/errors";
import type { FoundPassage } from "../../../../../../src/services/brain";
import {
  claimView, findEvidenceFor, getNode, listNodes, RELATION_LABELS, RELATIONS, type ClaimView, type DnaCitation, type NodeDetail,
} from "../../../../../../src/services/dna";
import { INTERNAL_ROLES } from "../../../../../../src/security/permissions";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function Sources({ list }: { list: DnaCitation[] }) {
  if (!list.length) return null;
  return (
    <ul style={{ paddingLeft: 18, margin: "4px 0" }}>
      {list.map((c) => (
        <li key={c.id} className="notice">
          {c.evidenceId ? <Link href={`/evidence/${c.evidenceId}`}>{c.sourceTitle}</Link> : <span>Note: {c.sourceTitle}</span>}
          {c.isEmail ? " (email)" : ""} — “{c.quote.length > 240 ? `${c.quote.slice(0, 240)}…` : c.quote}”
        </li>
      ))}
    </ul>
  );
}

export default async function DnaNodePage({ params, searchParams }: {
  params: Promise<{ id: string; nodeId: string }>; searchParams: Promise<{ f?: string; find?: string }>;
}) {
  const { id, nodeId } = await params;
  if (!UUID.test(id) || !UUID.test(nodeId)) notFound();
  const sp = await searchParams;
  const flash = await getFlash(sp.f);
  const data = await withSession(async (s) => {
    if (!INTERNAL_ROLES.has(s.actor.role)) return null;
    let detail: NodeDetail;
    try { detail = await getNode(s, nodeId); } catch (e) { if (e instanceof NotFoundError) return null; throw e; }
    if (detail.node.matterId !== id) return null;
    const isClaim = detail.node.kind === "claim" || detail.node.kind === "defense";
    const view: ClaimView | null = isClaim ? await claimView(s, nodeId) : null;
    let found: { elementId: string; passages: FoundPassage[]; error?: string } | null = null;
    if (view && sp.find && UUID.test(sp.find) && view.elements.some((e) => e.element.id === sp.find)) {
      try { found = { elementId: sp.find, passages: await findEvidenceFor(s, sp.find) }; } catch (e) {
        if (e instanceof UserFacingError) found = { elementId: sp.find, passages: [], error: e.message }; else throw e;
      }
    }
    const others = (await listNodes(s, id)).filter((n) => n.id !== nodeId && n.status === "confirmed");
    return { detail, view, found, others, canWrite: s.actor.role !== "read_only" };
  });
  if (!data) notFound();
  const { node: n } = data.detail;
  const here = `/matters/${id}/dna/${n.id}`;
  const hidden = (back = here) => (<><input type="hidden" name="matterId" value={id} /><input type="hidden" name="back" value={back} /></>);

  return (
    <>
      <p className="notice"><Link href={`/matters/${id}/dna`}>← Case DNA</Link></p>
      <h1>{n.label}</h1>
      <p className="sub">
        <span className="badge">{n.kind}</span> {n.status === "suggested" ? <span className="badge walled">Suggested by Huis</span> : null}
        {n.status === "rejected" ? <span className="badge">Rejected</span> : null}
        {n.eventDate ? ` · ${n.eventDate}` : ""}{n.email ? ` · ${n.email}` : ""}{n.role ? ` · ${n.role}` : ""}
        {n.amount != null ? ` · $${n.amount.toLocaleString("en-US")}` : ""}
        <br /><span className="badge privileged">{WORK_PRODUCT_LABEL}</span>
      </p>
      <FlashBanner flash={flash} />

      {n.status === "suggested" && data.canWrite ? (
        <div className="card row">
          <span style={{ flex: 1 }}>Huis found this in the Matter&apos;s documents. Does it belong in the case map?</span>
          {(["confirmed", "rejected"] as const).map((d) => (
            <form key={d} action={dnaDecideAction}>
              {hidden()}<input type="hidden" name="nodeId" value={n.id} /><input type="hidden" name="decision" value={d} />
              <button type="submit" className={d === "confirmed" ? "" : "secondary"}>{d === "confirmed" ? "Confirm" : "Reject"}</button>
            </form>
          ))}
        </div>
      ) : null}

      {n.details ? <div className="card"><div className="doc-text" style={{ fontFamily: "inherit" }}>{n.details}</div></div> : null}
      {data.detail.citations.length ? <div className="card"><h2>Where this comes from</h2><Sources list={data.detail.citations} /></div> : null}

      {data.view ? (
        <>
          <p className="notice">{TEMPLATE_NOTE}</p>
          {data.view.elements.map(({ element: e, supporting, contradicting }, i) => (
            <div className="card" key={e.id}>
              <h2>{i + 1}. {e.label}</h2>
              {e.details ? <p className="notice">{e.details}</p> : null}
              <div className="grid">
                <div>
                  <h3>Supporting ({supporting.length})</h3>
                  {supporting.length === 0 ? <p className="notice">Nothing yet.</p> : supporting.map((f) => (
                    <div key={f.id} style={{ marginBottom: 8 }}>
                      <Link href={`/matters/${id}/dna/${f.id}`}>{f.label}</Link><Sources list={f.citations} />
                    </div>
                  ))}
                </div>
                <div>
                  <h3>Contradicting ({contradicting.length})</h3>
                  {contradicting.length === 0 ? <p className="notice">Nothing yet.</p> : contradicting.map((f) => (
                    <div key={f.id} style={{ marginBottom: 8 }}>
                      <Link href={`/matters/${id}/dna/${f.id}`}>{f.label}</Link><Sources list={f.citations} />
                    </div>
                  ))}
                </div>
              </div>
              {data.found?.elementId === e.id ? (
                <div style={{ marginTop: 8 }}>
                  <h3>Passages in this Matter that may bear on this element</h3>
                  {data.found.error ? <p className="notice">{data.found.error}</p> : data.found.passages.length === 0 ? <p className="notice">Nothing found.</p> : (
                    <table><tbody>
                      {data.found.passages.map((p) => (
                        <tr key={p.chunkId}>
                          <td>
                            <div className="notice">{p.evidenceId ? <Link href={`/evidence/${p.evidenceId}`}>{p.sourceTitle}</Link> : `Note: ${p.sourceTitle}`}</div>
                            <div>{p.content.length > 500 ? `${p.content.slice(0, 500)}…` : p.content}</div>
                          </td>
                          {data.canWrite ? (
                            <td style={{ whiteSpace: "nowrap", width: 1 }}>
                              {(["supports", "contradicts"] as const).map((rel) => (
                                <form key={rel} action={dnaAddFactAction} style={{ marginBottom: 4 }}>
                                  {hidden()}<input type="hidden" name="elementId" value={e.id} /><input type="hidden" name="chunkId" value={p.chunkId} />
                                  <input type="hidden" name="relation" value={rel} />
                                  <button type="submit" className={rel === "supports" ? "" : "secondary"}>{rel === "supports" ? "Supports" : "Contradicts"}</button>
                                </form>
                              ))}
                            </td>
                          ) : null}
                        </tr>
                      ))}
                    </tbody></table>
                  )}
                </div>
              ) : (
                <p style={{ marginTop: 8 }}><Link className="button secondary" href={`${here}?find=${e.id}`}>Find evidence in this Matter</Link></p>
              )}
            </div>
          ))}
          {data.canWrite ? (
            <div className="card">
              <h2>Add an element</h2>
              <form action={dnaAddElementAction}>
                {hidden()}<input type="hidden" name="claimId" value={n.id} />
                <label>Element<input name="label" maxLength={300} required /></label>
                <label>What must be shown<textarea name="details" rows={2} maxLength={20000} /></label>
                <div style={{ marginTop: 8 }}><button type="submit">Add element</button></div>
              </form>
            </div>
          ) : null}
          <div className="grid">
            <div className="card"><h2>Witnesses</h2>
              {data.view.witnesses.length === 0 ? <p className="notice">Link people to facts as witnesses to see them here.</p> : (
                <ul style={{ paddingLeft: 18 }}>{data.view.witnesses.map((w) => <li key={w.id}><Link href={`/matters/${id}/dna/${w.id}`}>{w.label}</Link>{w.role ? <span className="notice"> · {w.role}</span> : null}</li>)}</ul>
              )}
            </div>
            <div className="card"><h2>Emails</h2><Sources list={data.view.emails} />{data.view.emails.length ? null : <p className="notice">None yet.</p>}</div>
            <div className="card"><h2>Other evidence</h2><Sources list={data.view.evidence} />{data.view.evidence.length ? null : <p className="notice">None yet.</p>}</div>
          </div>
        </>
      ) : null}

      <div className="card">
        <h2>Connections</h2>
        {data.detail.links.length === 0 ? <p className="notice">Not linked to anything yet.</p> : (
          <table><tbody>
            {data.detail.links.map((l) => (
              <tr key={l.id}>
                <td>
                  {l.direction === "out" ? <>This {RELATION_LABELS[l.relation]} </> : null}
                  <Link href={`/matters/${id}/dna/${l.other.id}`}>{l.other.label}</Link> <span className="badge">{l.other.kind}</span>
                  {l.direction === "in" ? <> {RELATION_LABELS[l.relation]} this</> : null}
                  {l.status === "suggested" ? <span className="badge walled"> suggested</span> : null}
                </td>
                {data.canWrite ? (
                  <td style={{ width: 1, whiteSpace: "nowrap" }}>
                    {l.origin === "attorney" ? (
                      <form action={dnaUnlinkAction}>{hidden()}<input type="hidden" name="linkId" value={l.id} /><button type="submit" className="secondary">Remove</button></form>
                    ) : (
                      <form action={dnaDecideAction}>{hidden()}<input type="hidden" name="linkId" value={l.id} /><input type="hidden" name="decision" value="rejected" /><button type="submit" className="secondary">Reject</button></form>
                    )}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody></table>
        )}
        {data.canWrite && n.status === "confirmed" && data.others.length ? (
          <form action={dnaLinkAction} className="row" style={{ marginTop: 12 }}>
            {hidden()}<input type="hidden" name="fromId" value={n.id} />
            <label style={{ flex: 1 }}>This
              <select name="relation" defaultValue="related_to">
                {RELATIONS.filter((r) => r !== "element_of").map((r) => <option key={r} value={r}>{RELATION_LABELS[r]}</option>)}
              </select>
            </label>
            <label style={{ flex: 2 }}>…
              <select name="toId" required defaultValue="">
                <option value="" disabled>Choose…</option>
                {data.others.map((o) => <option key={o.id} value={o.id}>{o.label.slice(0, 120)} ({o.kind})</option>)}
              </select>
            </label>
            <button type="submit" className="secondary">Link</button>
          </form>
        ) : null}
      </div>

      {data.canWrite && n.status === "confirmed" ? (
        <div className="card">
          <h2>Edit</h2>
          <form action={dnaUpdateNodeAction}>
            {hidden()}<input type="hidden" name="nodeId" value={n.id} />
            <label>Name or description<input name="label" maxLength={300} required defaultValue={n.label} /></label>
            <div className="row">
              {n.kind === "event" ? <label style={{ flex: 1 }}>Date<input type="date" name="eventDate" defaultValue={n.eventDate ?? ""} /></label> : <input type="hidden" name="eventDate" value={n.eventDate ?? ""} />}
              {n.kind === "person" || n.kind === "organization" ? <label style={{ flex: 1 }}>Email<input type="email" name="email" defaultValue={n.email ?? ""} /></label> : <input type="hidden" name="email" value={n.email ?? ""} />}
              {n.kind === "person" ? <label style={{ flex: 1 }}>Role<input name="role" maxLength={100} defaultValue={n.role ?? ""} /></label> : <input type="hidden" name="role" value={n.role ?? ""} />}
              {n.kind === "damage" ? <label style={{ flex: 1 }}>Amount<input type="number" min={0} step="0.01" name="amount" defaultValue={n.amount ?? ""} /></label> : <input type="hidden" name="amount" value={n.amount ?? ""} />}
            </div>
            <label>Details<textarea name="details" rows={3} maxLength={20000} defaultValue={n.details} /></label>
            <div className="row" style={{ marginTop: 8 }}>
              <button type="submit">Save</button>
            </div>
          </form>
          {n.origin === "attorney" ? (
            <form action={dnaDeleteNodeAction} style={{ marginTop: 8 }}>
              <input type="hidden" name="matterId" value={id} /><input type="hidden" name="nodeId" value={n.id} />
              <button type="submit" className="secondary">Delete</button>
            </form>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
