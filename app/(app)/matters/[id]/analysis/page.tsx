import Link from "next/link";
import { notFound } from "next/navigation";
import { reanalyzeAction } from "../../../../../lib/actions";
import { getFlash, withSession } from "../../../../../lib/server";
import { FlashBanner } from "../../../../../lib/ui";
import { WORK_PRODUCT_LABEL } from "../../../../../src/ai/gateway";
import { NotFoundError } from "../../../../../src/errors";
import { analyzeMatter } from "../../../../../src/services/analysis";
import { getMatter } from "../../../../../src/services/matters";
import { INTERNAL_ROLES } from "../../../../../src/security/permissions";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const when = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

export default async function AnalysisPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ f?: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const flash = await getFlash((await searchParams).f);
  const data = await withSession(async (s) => {
    if (!INTERNAL_ROLES.has(s.actor.role)) return null;
    let matter;
    try { matter = await getMatter(s, id); } catch (e) { if (e instanceof NotFoundError) return null; throw e; }
    return { matter, a: await analyzeMatter(s, id), canRun: s.actor.role !== "read_only" };
  });
  if (!data) notFound();
  const { matter: m, a } = data;
  const base = `/matters/${m.id}`;
  const row = (label: string, value: number | string, href?: string) => (
    <tr><th style={{ fontWeight: 400 }}>{label}</th><td style={{ textAlign: "right", width: 80 }}>{href && value ? <Link href={href}>{value}</Link> : value}</td></tr>
  );

  return (
    <>
      <p className="notice">
        <Link href={base}>← {m.title}</Link> · <Link href={`${base}/timeline`}>Timeline</Link> · <Link href={`${base}/dna`}>Case DNA™</Link> · <Link href={`${base}/contradictions`}>Contradictions</Link>
      </p>
      <h1>Matter analysis</h1>
      <p className="sub">
        What&apos;s in this Matter and what still needs attention, counted by fixed rules from what you can open. It is worked out fresh each time
        you open this page. It isn&apos;t a score: every number links to the items behind it.<br /><span className="badge privileged">{WORK_PRODUCT_LABEL}</span>
      </p>
      <FlashBanner flash={flash} />

      <div className="card">
        <h2>Since the last complete analysis</h2>
        <p>
          {a.sinceLast.evidence} new {a.sinceLast.evidence === 1 ? "evidence item" : "evidence items"} and {a.sinceLast.notes} new {a.sinceLast.notes === 1 ? "note" : "notes"}
          {a.lastRun ? <> since {when(a.lastRun.at)} ({a.lastRun.by}).</> : <> (the Matter hasn&apos;t been reanalyzed yet).</>}
        </p>
        <p className="notice">
          Huis analyzes every item as it arrives: it scans and reads it, adds it to the Matter Brain, and suggests dated events and people.
          <strong> Reanalyze Matter</strong> tries again to read anything Huis couldn&apos;t read before, and starts a new period for this count.
        </p>
        {data.canRun ? (
          <form action={reanalyzeAction}><input type="hidden" name="matterId" value={m.id} /><button type="submit">Reanalyze Matter</button></form>
        ) : null}
      </div>

      <div className="card">
        <h2>Next steps</h2>
        {a.steps.length === 0 ? <p className="notice">Nothing needs attention right now.</p> : (
          <ul style={{ paddingLeft: 18 }}>{a.steps.map((s, i) => <li key={i} style={{ marginBottom: 6 }}><Link href={s.href}>{s.text}</Link></li>)}</ul>
        )}
        <p className="notice">Each step comes from one fixed rule (for example, a claim element with no confirmed supporting fact).</p>
      </div>

      <div className="grid">
        <div className="card">
          <h2>Evidence</h2>
          <table><tbody>
            {row("Items", a.evidence.total, base)}
            {row("Clean (scanned, safe)", a.evidence.clean)}
            {row("Waiting for virus scan", a.evidence.waitingScan)}
            {row("Quarantined (infected)", a.evidence.quarantined)}
            {row("Scan failed", a.evidence.scanFailed)}
            {row("No readable text", a.evidence.unreadable)}
          </tbody></table>
        </div>
        <div className="card">
          <h2>Matter Brain</h2>
          <table><tbody>
            {row("Documents ready", `${a.brain.documentsReady} of ${a.brain.documents}`, `${base}/brain`)}
            {row("Being added", a.brain.waiting)}
            {row("Couldn't be added", a.brain.failed)}
            {row("Only partly included (very large)", a.brain.partial)}
            {row("Attorney notes", a.brain.notes)}
          </tbody></table>
        </div>
        <div className="card">
          <h2>Case DNA</h2>
          <table><tbody>
            {row("Suggested events to review", a.dna.suggestedEvents, `${base}/dna`)}
            {row("Suggested people to review", a.dna.suggestedPeople, `${base}/dna`)}
            {row("People and organizations", a.dna.people)}
            {row("Events", a.dna.events)}
            {row("Facts", a.dna.facts)}
            {row("Claims and defenses", a.dna.claims)}
          </tbody></table>
        </div>
        <div className="card">
          <h2>Timeline and contradictions</h2>
          <table><tbody>
            {row("Confirmed dated items", a.timeline.dated, `${base}/timeline?show=confirmed&emails=no`)}
            {row("…with no source yet", a.timeline.withoutSource, `${base}/timeline?show=confirmed&source=none&emails=no`)}
            {row("Potential contradictions to decide", a.contradictions.potential, `${base}/contradictions`)}
            {row("Confirmed contradictions", a.contradictions.confirmed)}
          </tbody></table>
        </div>
      </div>

      {a.claims.length ? (
        <div className="card">
          <h2>Claims and their elements</h2>
          <table><tbody>
            {a.claims.map((c) => (
              <tr key={c.id}>
                <td><Link href={`${base}/dna/${c.id}`}>{c.label}</Link></td>
                <td className="notice">
                  {c.elements - c.unsupported.length} of {c.elements} elements have a confirmed supporting fact
                  {c.contradicted ? ` · ${c.contradicted} with contradicting facts` : ""}
                </td>
              </tr>
            ))}
          </tbody></table>
          <p className="notice">Counts of what&apos;s been linked in Case DNA, not a judgment of the case. Templates are a starting point, not legal advice.</p>
        </div>
      ) : null}
    </>
  );
}
