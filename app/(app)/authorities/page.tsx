import { notFound } from "next/navigation";
import { addAuthorityAction, deleteAuthorityAction, updateAuthorityAction, verifyAuthorityAction } from "../../../lib/actions";
import { getFlash, withSession } from "../../../lib/server";
import { FlashBanner } from "../../../lib/ui";
import { AUTHORITY_KINDS, KIND_LABELS, listAuthorities, VERIFIER_ROLES, type Authority } from "../../../src/services/authorities";
import { INTERNAL_ROLES } from "../../../src/security/permissions";

export const dynamic = "force-dynamic";

function Fields({ a }: { a?: Authority }) {
  return (
    <>
      <div className="row">
        <label style={{ flex: 1 }}>Type
          <select name="kind" defaultValue={a?.kind ?? "case"}>{AUTHORITY_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}</select>
        </label>
        <label style={{ flex: 3 }}>Citation<input name="citation" maxLength={300} required defaultValue={a?.citation} placeholder="e.g. 29 U.S.C. § 2615(a)(2)" /></label>
      </div>
      <div className="row">
        <label style={{ flex: 3 }}>Case name or title<input name="title" maxLength={300} defaultValue={a?.title} /></label>
        <label style={{ flex: 2 }}>Court<input name="court" maxLength={200} defaultValue={a?.court} /></label>
        <label style={{ flex: 1 }}>Year<input name="year" type="number" min={1600} max={2100} defaultValue={a?.year ?? ""} /></label>
        <label style={{ flex: 1 }}>Jurisdiction<input name="jurisdiction" maxLength={100} defaultValue={a?.jurisdiction} placeholder="e.g. Utah" /></label>
      </div>
      <label>Link to the authority itself (https)<input name="url" type="url" maxLength={2000} required defaultValue={a?.url} placeholder="https://www.law.cornell.edu/…" /></label>
      <label>Note (seen by everyone at the firm: no client or Matter details)<textarea name="note" rows={2} maxLength={4000} defaultValue={a?.note} /></label>
    </>
  );
}

export default async function AuthoritiesPage({ searchParams }: { searchParams: Promise<{ f?: string; q?: string }> }) {
  const sp = await searchParams;
  const flash = await getFlash(sp.f);
  const q = (sp.q ?? "").slice(0, 200);
  const data = await withSession(async (s) => {
    if (!INTERNAL_ROLES.has(s.actor.role)) return null;
    return { list: await listAuthorities(s, q), canWrite: s.actor.role !== "read_only", canVerify: VERIFIER_ROLES.has(s.actor.role) };
  });
  if (!data) notFound();

  return (
    <>
      <h1>Legal Authorities</h1>
      <p className="sub">
        Your firm&apos;s library of cases, statutes, regulations and rules, cited in Matters&apos; claims matrices. Each links to its real record.
        Huis never cites from memory. An authority is <strong>unverified</strong> until an attorney checks it against that record; changing
        its citation or link clears the check.
      </p>
      <FlashBanner flash={flash} />
      <form method="get" className="row card"><label style={{ flex: 1 }}>Search<input name="q" defaultValue={q} maxLength={200} /></label><button type="submit" className="secondary">Search</button></form>

      <div className="card">
        {data.list.length === 0 ? <p className="notice">{q ? "Nothing matches." : "No authorities yet."}</p> : data.list.map((a) => (
          <details key={a.id} style={{ borderTop: "1px solid var(--border, #e5e7eb)", padding: "8px 0" }}>
            <summary>
              <span className="badge">{KIND_LABELS[a.kind]}</span> <strong>{a.citation}</strong>{a.title ? ` · ${a.title}` : ""}{" "}
              {a.verified ? <span className="badge">Verified</span> : <span className="badge walled">Unverified</span>}
              {a.official ? <> <span className="badge">Official source</span></> : null}
              <span className="notice"> · cited in {a.citedIn} {a.citedIn === 1 ? "place" : "places"}</span>
            </summary>
            <p className="notice">
              <a href={a.url} target="_blank" rel="noopener noreferrer nofollow">{a.url}</a>
              {a.court ? ` · ${a.court}` : ""}{a.year ? ` · ${a.year}` : ""}{a.jurisdiction ? ` · ${a.jurisdiction}` : ""} · added by {a.addedBy}
              {a.verified ? ` · verified by ${a.verified.by} on ${a.verified.at.toISOString().slice(0, 10)}` : ""}
            </p>
            {a.note ? <p className="notice">{a.note}</p> : null}
            {data.canWrite ? (
              <>
                {data.canVerify ? (
                  <form action={verifyAuthorityAction} style={{ marginBottom: 8 }}>
                    <input type="hidden" name="authorityId" value={a.id} /><input type="hidden" name="verified" value={a.verified ? "0" : "1"} />
                    <input type="hidden" name="checkedKind" value={a.kind} /><input type="hidden" name="checkedCitation" value={a.citation} />
                    <input type="hidden" name="checkedUrl" value={a.url} /><input type="hidden" name="checkedTitle" value={a.title} />
                    <input type="hidden" name="checkedCourt" value={a.court} /><input type="hidden" name="checkedYear" value={a.year ?? ""} />
                    <input type="hidden" name="checkedJurisdiction" value={a.jurisdiction} />
                    <button type="submit" className={a.verified ? "secondary" : ""}>{a.verified ? "Withdraw verification" : "I checked it against its record: mark verified"}</button>
                  </form>
                ) : !a.verified ? <p className="notice">An attorney verifies authorities.</p> : null}
                <form action={updateAuthorityAction}>
                  <input type="hidden" name="authorityId" value={a.id} /><Fields a={a} />
                  <div style={{ marginTop: 8 }}><button type="submit" className="secondary">Save changes</button></div>
                </form>
                {a.citedIn === 0 ? (
                  <form action={deleteAuthorityAction} style={{ marginTop: 6 }}>
                    <input type="hidden" name="authorityId" value={a.id} /><button type="submit" className="secondary">Remove from library</button>
                  </form>
                ) : null}
              </>
            ) : null}
          </details>
        ))}
      </div>

      {data.canWrite ? (
        <div className="card">
          <h2>Add an authority</h2>
          <form action={addAuthorityAction}>
            <Fields />
            <div style={{ marginTop: 8 }}><button type="submit">Add</button></div>
            <p className="notice">Official sources (for example CourtListener, Cornell LII, GovInfo, the U.S. Code, eCFR, federal and Utah courts) get a badge; other links (such as Westlaw or Lexis) are accepted too.</p>
          </form>
        </div>
      ) : null}
    </>
  );
}
