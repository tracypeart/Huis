import Link from "next/link";
import { ZodError } from "zod";
import { withSession } from "../../../lib/server";
import { Snippet } from "../../../lib/snippet";
import { date } from "../../../lib/ui";
import { listMatters } from "../../../src/services/matters";
import { searchEvidence, type SearchHit } from "../../../src/services/search";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Search({ searchParams }: { searchParams: Promise<{ q?: string; matter?: string }> }) {
  const { q = "", matter } = await searchParams;
  const matterId = matter && UUID.test(matter) ? matter : undefined;
  const { matters, hits, error } = await withSession(async (s) => {
    const matters = await listMatters(s);
    if (!q.trim()) return { matters, hits: null as SearchHit[] | null, error: null as string | null };
    try {
      return { matters, hits: await searchEvidence(s, { q, matterId, limit: 100 }), error: null };
    } catch (err) {
      if (err instanceof ZodError) return { matters, hits: null, error: err.issues[0]?.message ?? "Check your search." };
      throw err;
    }
  });

  return (
    <>
      <h1>Search</h1>
      <p className="sub">
        Searches the words inside every document, email, scan and attachment you&apos;re allowed to see. Use quotes for an exact
        phrase (&quot;March meeting&quot;), <code>or</code> for either word, and a minus sign to exclude (<code>-draft</code>).
      </p>
      <div className="card">
        <form className="row" method="get">
          <input name="q" defaultValue={q} placeholder='e.g. "surgery" FMLA -draft' style={{ flex: 1, minWidth: 260 }} autoFocus />
          <select name="matter" defaultValue={matterId ?? ""}>
            <option value="">All my matters</option>
            {matters.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
          </select>
          <button type="submit">Search</button>
        </form>
      </div>
      {error ? <div className="flash error">{error}</div> : null}
      {hits ? (
        <div className="card">
          <p className="notice">{hits.length === 0 ? "No matches." : `${hits.length}${hits.length === 100 ? "+" : ""} result(s), best matches first.`}</p>
          {hits.map((h) => (
            <div key={h.evidenceId} className="hit">
              <div>
                <Link href={`/evidence/${h.evidenceId}`}><strong>{h.emailSubject ?? h.filename}</strong></Link>{" "}
                {h.folderIsPrivileged ? <span className="badge privileged">{h.folderName}</span> : <span className="badge">{h.folderName}</span>}
              </div>
              <div className="notice">
                {h.matterTitle} · {h.huisNumber}
                {h.emailFrom ? ` · from ${h.emailFrom}` : ""}
                {h.emailSentAt ? ` · ${date(h.emailSentAt)}` : ""}
                {h.containerPath ? ` · inside: ${h.containerPath}` : h.emailSubject ? ` · ${h.filename}` : ""}
              </div>
              {h.snippet ? <p className="snippet-line"><Snippet text={h.snippet} /></p> : null}
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
