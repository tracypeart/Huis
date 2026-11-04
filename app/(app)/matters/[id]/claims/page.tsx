import Link from "next/link";
import { notFound } from "next/navigation";
import { citeAuthorityAction, unciteAction } from "../../../../../lib/actions";
import { getFlash, withSession } from "../../../../../lib/server";
import { FlashBanner } from "../../../../../lib/ui";
import { WORK_PRODUCT_LABEL } from "../../../../../src/ai/gateway";
import { NotFoundError } from "../../../../../src/errors";
import { claimsMatrix, KIND_LABELS, listAuthorities, STANCES, type CitedAuthority } from "../../../../../src/services/authorities";
import { getMatter } from "../../../../../src/services/matters";
import { INTERNAL_ROLES } from "../../../../../src/security/permissions";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STANCE_LABELS = { supports: "Supports", opposes: "Cuts against", explains: "Explains" } as const;

function Cited({ list, matterId, canWrite }: { list: CitedAuthority[]; matterId: string; canWrite: boolean }) {
  if (!list.length) return null;
  return (
    <ul style={{ paddingLeft: 18, margin: "4px 0" }}>
      {list.map((c) => (
        <li key={c.linkId} className="notice">
          <span className="badge">{STANCE_LABELS[c.stance]}</span>{" "}
          <a href={c.authority.url} target="_blank" rel="noopener noreferrer nofollow">{c.authority.citation}</a>{c.pinpoint ? `, ${c.pinpoint}` : ""}
          {c.authority.verified ? null : <> <span className="badge walled">Unverified</span></>} — {c.proposition}
          {canWrite ? (
            <form action={unciteAction} style={{ display: "inline", marginLeft: 6 }}>
              <input type="hidden" name="matterId" value={matterId} /><input type="hidden" name="linkId" value={c.linkId} />
              <button type="submit" className="secondary" style={{ padding: "0 6px" }}>Remove</button>
            </form>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export default async function ClaimsMatrixPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ f?: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const flash = await getFlash((await searchParams).f);
  const data = await withSession(async (s) => {
    if (!INTERNAL_ROLES.has(s.actor.role)) return null;
    let matter;
    try { matter = await getMatter(s, id); } catch (e) { if (e instanceof NotFoundError) return null; throw e; }
    const canWrite = s.actor.role !== "read_only";
    return { matter, claims: await claimsMatrix(s, id), library: canWrite ? await listAuthorities(s) : [], canWrite };
  });
  if (!data) notFound();
  const { matter: m } = data;

  const CiteForm = ({ nodeId }: { nodeId: string }) => !data.canWrite ? null : data.library.length === 0
    ? <p className="notice">Add authorities to the <Link href="/authorities">library</Link> to cite them here.</p> : (
      <details style={{ marginTop: 4 }}>
        <summary className="notice">Cite an authority</summary>
        <form action={citeAuthorityAction}>
          <input type="hidden" name="matterId" value={m.id} /><input type="hidden" name="nodeId" value={nodeId} />
          <div className="row">
            <label style={{ flex: 3 }}>Authority
              <select name="authorityId">{data.library.map((a) => <option key={a.id} value={a.id}>{KIND_LABELS[a.kind]}: {a.citation}{a.verified ? "" : " (unverified)"}</option>)}</select>
            </label>
            <label style={{ flex: 1 }}>It
              <select name="stance" defaultValue="supports">{STANCES.map((st) => <option key={st} value={st}>{STANCE_LABELS[st].toLowerCase()}</option>)}</select>
            </label>
            <label style={{ flex: 1 }}>Pinpoint<input name="pinpoint" maxLength={100} placeholder="e.g. at 1171" /></label>
          </div>
          <label>For the proposition that…<input name="proposition" maxLength={1000} required /></label>
          <div style={{ marginTop: 6 }}><button type="submit">Cite</button></div>
        </form>
      </details>
    );

  return (
    <>
      <p className="notice">
        <Link href={`/matters/${m.id}`}>← {m.title}</Link> · <Link href={`/matters/${m.id}/dna`}>Case DNA™</Link> · <Link href="/authorities">Legal Authorities</Link>
      </p>
      <h1>Claims matrix</h1>
      <p className="sub">
        Each claim and defense, its elements, the facts and sources behind each, and the law cited for it, with the gaps by fixed rules.
        Templates and gaps are a starting point, not legal advice.<br /><span className="badge privileged">{WORK_PRODUCT_LABEL}</span>
      </p>
      <FlashBanner flash={flash} />
      {data.claims.length === 0 ? (
        <div className="card"><p className="notice">No claims yet. <Link href={`/matters/${m.id}/dna`}>Add one in Case DNA</Link> to see its elements here.</p></div>
      ) : data.claims.map((c) => (
        <div className="card" key={c.id}>
          <h2 style={{ marginBottom: 4 }}><Link href={`/matters/${m.id}/dna/${c.id}`}>{c.label}</Link> <span className="badge">{c.kind}</span></h2>
          <Cited list={c.authorities} matterId={m.id} canWrite={data.canWrite} />
          <CiteForm nodeId={c.id} />
          <table style={{ marginTop: 8 }}>
            <thead><tr><th>Element</th><th style={{ width: 90 }}>Supporting</th><th style={{ width: 100 }}>Contradicting</th><th style={{ width: 70 }}>Sources</th><th style={{ width: 220 }}>Gaps</th></tr></thead>
            <tbody>
              {c.elements.map((e) => (
                <tr key={e.id}>
                  <td>
                    <Link href={`/matters/${m.id}/dna/${c.id}`}>{e.label}</Link>
                    <Cited list={e.authorities} matterId={m.id} canWrite={data.canWrite} />
                    <CiteForm nodeId={e.id} />
                  </td>
                  <td>{e.supporting}</td>
                  <td>{e.contradicting}</td>
                  <td>{e.sources}</td>
                  <td>{e.gaps.length ? e.gaps.map((g) => <div key={g} className="notice">• {g}</div>) : <span className="notice">None</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  );
}
