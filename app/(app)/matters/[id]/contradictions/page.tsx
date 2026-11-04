import Link from "next/link";
import { notFound } from "next/navigation";
import { contradictionDecideAction } from "../../../../../lib/actions";
import { getFlash, withSession } from "../../../../../lib/server";
import { FlashBanner } from "../../../../../lib/ui";
import { WORK_PRODUCT_LABEL } from "../../../../../src/ai/gateway";
import { NotFoundError } from "../../../../../src/errors";
import { getContradictions, type PotentialContradiction } from "../../../../../src/services/contradictions";
import { getMatter } from "../../../../../src/services/matters";
import { INTERNAL_ROLES } from "../../../../../src/security/permissions";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Potential contradictions shown at once. */
const SHOWN = 100;
const CONFIDENCE = { high: "High", medium: "Medium", low: "Low" } as const;

function Decide({ matterId, flag, decisions }: { matterId: string; flag: PotentialContradiction; decisions: ("confirm" | "reject" | "reconsider")[] }) {
  const labels = { confirm: "Confirm contradiction", reject: "Not a contradiction", reconsider: "Reconsider" };
  return (
    <div className="row">
      {decisions.map((d) => (
        <form key={d} action={contradictionDecideAction}>
          <input type="hidden" name="matterId" value={matterId} /><input type="hidden" name="key" value={flag.key} /><input type="hidden" name="version" value={flag.version} />
          <input type="hidden" name="decision" value={d} />
          <button type="submit" className={d === "confirm" ? "" : "secondary"}>{labels[d]}</button>
        </form>
      ))}
    </div>
  );
}

function Flag({ matterId, flag, canWrite, rejected }: { matterId: string; flag: PotentialContradiction; canWrite: boolean; rejected?: boolean }) {
  const st = flag.statement;
  return (
    <div className="card">
      <p className="notice" style={{ marginTop: 0 }}>
        <span className={`badge${flag.confidence === "high" ? " privileged" : flag.confidence === "medium" ? " walled" : ""}`}>
          {CONFIDENCE[flag.confidence]} confidence
        </span>{" "}
        Potential contradiction · {flag.why}
      </p>
      <h3 style={{ marginBottom: 4 }}>Statement</h3>
      <blockquote style={{ margin: "0 0 4px", paddingLeft: 12, borderLeft: "3px solid #ccd3dd" }}>“{st.quote}”</blockquote>
      <p className="notice" style={{ marginTop: 0 }}>
        {st.evidenceId ? <Link href={`/evidence/${st.evidenceId}`}>{st.sourceTitle}</Link> : <>Note: {st.sourceTitle}</>}
        {st.beforeText ? <> · claims no knowledge {st.beforeText}</> : null}
      </p>
      <h3 style={{ marginBottom: 4 }}>Earlier evidence on the same subject</h3>
      <table><tbody>
        {flag.conflicting.map((c) => (
          <tr key={c.key}>
            <td style={{ whiteSpace: "nowrap", width: 110 }}>{c.date}</td>
            <td>
              <span className="badge">{c.kind === "email" ? "Email" : c.kind === "fact" ? "Fact" : "Event"}</span>{" "}
              {c.status === "suggested" ? <span className="badge walled">Suggested by Huis</span> : null}{" "}
              {c.nodeId ? <Link href={`/matters/${matterId}/dna/${c.nodeId}`}>{c.label}</Link> : <Link href={`/evidence/${c.evidenceId}`}>{c.label}</Link>}
              <div className="notice">
                Mentions {c.matched.map((w) => `“${w}”`).join(", ")}{c.kind !== "email" && c.sourceTitles.length ? ` · from ${c.sourceTitles.join(", ")}` : ""}
              </div>
              {c.passage ? <div className="notice">“{c.passage.text.replace(/\s+/g, " ").slice(0, 240)}{c.passage.text.length > 240 ? "…" : ""}”</div> : null}
            </td>
          </tr>
        ))}
      </tbody></table>
      {canWrite ? (
        <div style={{ marginTop: 8 }}>
          <Decide matterId={matterId} flag={flag} decisions={rejected ? ["reconsider"] : ["confirm", "reject"]} />
          {rejected ? null : (
            <p className="notice">
              Confirming adds the statement to Case DNA as a fact cited to {st.sourceTitle}, and links each item above to it as contradicting it
              (confirming any of Huis&apos;s suggestions among them).
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default async function ContradictionsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ f?: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const flash = await getFlash((await searchParams).f);
  const data = await withSession(async (s) => {
    if (!INTERNAL_ROLES.has(s.actor.role)) return null;
    let matter;
    try { matter = await getMatter(s, id); } catch (e) { if (e instanceof NotFoundError) return null; throw e; }
    return { matter, report: await getContradictions(s, id), canWrite: s.actor.role !== "read_only" };
  });
  if (!data) notFound();
  const { matter: m, report: r } = data;

  return (
    <>
      <p className="notice">
        <Link href={`/matters/${m.id}`}>← {m.title}</Link> · <Link href={`/matters/${m.id}/timeline`}>Timeline</Link> · <Link href={`/matters/${m.id}/dna`}>Case DNA™</Link>
      </p>
      <h1>Contradictions</h1>
      <p className="sub">
        Where someone says they didn&apos;t know, weren&apos;t told or first learned of something later, and the Matter&apos;s earlier evidence mentions the same subject.
        Huis flags <strong>potential</strong> contradictions by fixed rules and says why; you decide whether the evidence really contradicts the statement.
        <br /><span className="badge privileged">{WORK_PRODUCT_LABEL}</span>
      </p>
      <FlashBanner flash={flash} />
      {r.truncated ? <p className="notice">This Matter is very large: Huis examined the first 5,000 passages that may hold such a statement.</p> : null}

      <h2>To decide ({r.potential.length})</h2>
      {r.potential.length === 0 ? (
        <div className="card"><p className="notice">
          Nothing to decide. Huis looks in the Matter&apos;s documents, transcripts and notes for statements such as “I didn&apos;t know about the surgery until May”,
          and compares them with the timeline. New evidence is checked as soon as it has been read.
        </p></div>
      ) : r.potential.slice(0, SHOWN).map((f) => <Flag key={f.key} matterId={m.id} flag={f} canWrite={data.canWrite} />)}
      {r.potential.length > SHOWN ? <p className="notice">Showing the first {SHOWN}, strongest first.</p> : null}

      {r.confirmed.length ? (
        <div className="card">
          <h2>Confirmed ({r.confirmed.length})</h2>
          <ul style={{ paddingLeft: 18 }}>
            {r.confirmed.map((c) => (
              <li key={c.key}>
                {c.statementNodeId ? <Link href={`/matters/${m.id}/dna/${c.statementNodeId}`}>{c.label}</Link> : <span className="notice">Statement no longer available</span>}
                <span className="notice"> · {c.decidedAt.toISOString().slice(0, 10)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {r.rejected.length ? (
        <>
          <h2>Not contradictions ({r.rejected.length})</h2>
          {r.rejected.slice(0, SHOWN).map((f) => <Flag key={f.key} matterId={m.id} flag={f} canWrite={data.canWrite} rejected />)}
        </>
      ) : null}
    </>
  );
}
