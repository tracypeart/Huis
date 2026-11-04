import Link from "next/link";
import { notFound } from "next/navigation";
import { dnaAddNodeAction, dnaDecideAction } from "../../../../../lib/actions";
import { getFlash, withSession } from "../../../../../lib/server";
import { FlashBanner } from "../../../../../lib/ui";
import { WORK_PRODUCT_LABEL } from "../../../../../src/ai/gateway";
import { NotFoundError } from "../../../../../src/errors";
import { getMatter } from "../../../../../src/services/matters";
import { getTimeline, timelineFilters, type TimelineEntry } from "../../../../../src/services/timeline";
import { CATEGORIES, CATEGORY_LABELS } from "../../../../../src/timeline/categories";
import { INTERNAL_ROLES } from "../../../../../src/security/permissions";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Entries shown on the page at once (the download has all of them). */
const SHOWN = 1000;
const KIND_LABEL: Record<TimelineEntry["kind"], string> = { event: "Event", fact: "Fact", damage: "Damage", email: "Email" };

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function TimelinePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const sp = await searchParams;
  const flash = await getFlash(one(sp.f));
  const raw = Object.fromEntries(["category", "from", "to", "person", "q", "show", "source", "emails"].map((k) => [k, one(sp[k]) || undefined]));
  const filters = timelineFilters.parse(raw);
  const data = await withSession(async (s) => {
    if (!INTERNAL_ROLES.has(s.actor.role)) return null;
    let matter;
    try { matter = await getMatter(s, id); } catch (e) { if (e instanceof NotFoundError) return null; throw e; }
    return { matter, timeline: await getTimeline(s, id, filters), canWrite: s.actor.role !== "read_only" };
  });
  if (!data) notFound();
  const { matter: m, timeline: tl } = data;
  const base = `/matters/${m.id}/timeline`;
  // The current filters (without the category), for the category links and for coming back after a change.
  const keep = (extra: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...filters, category: undefined, ...extra })) {
      if (v && !(k === "show" && v === "all") && !(k === "source" && v === "any") && !(k === "emails" && v === "yes")) q.set(k, String(v));
    }
    const s = q.toString();
    return s ? `${base}?${s}` : base;
  };
  const here = keep({ category: filters.category });
  const shown = tl.entries.slice(0, SHOWN);
  const filtered = Object.entries(raw).some(([k, v]) => v && k !== "f");

  return (
    <>
      <p className="notice">
        <Link href={`/matters/${m.id}`}>← {m.title}</Link> · <Link href={`/matters/${m.id}/dna`}>Case DNA™</Link> · <Link href={`/matters/${m.id}/brain`}>Matter Brain</Link> · <Link href={`/matters/${m.id}/contradictions`}>Contradictions</Link>
      </p>
      <h1>Timeline</h1>
      <p className="sub">
        Everything in this Matter that has a date: events, facts and damages from Case DNA, and filed email. Each entry links to where it came from.
        Huis suggests; you decide.<br /><span className="badge privileged">{WORK_PRODUCT_LABEL}</span>
      </p>
      <FlashBanner flash={flash} />
      {tl.truncated ? <p className="notice">This Matter has a very large number of dated items: the timeline reads the first 5,000 items and 5,000 emails.</p> : null}

      <div className="card">
        <nav aria-label="Timeline views" className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          <Link href={keep({})} className={`badge${filters.category ? "" : " privileged"}`}>Master</Link>
          {CATEGORIES.map((c) => (
            <Link key={c} href={keep({ category: c })} className={`badge${filters.category === c ? " privileged" : ""}`}>
              {CATEGORY_LABELS[c]} ({tl.categoryCounts[c]})
            </Link>
          ))}
        </nav>
        <form method="get" action={base} style={{ marginTop: 12 }}>
          {filters.category ? <input type="hidden" name="category" value={filters.category} /> : null}
          <div className="row">
            <label style={{ flex: 1 }}>From<input type="date" name="from" defaultValue={filters.from ?? ""} /></label>
            <label style={{ flex: 1 }}>To<input type="date" name="to" defaultValue={filters.to ?? ""} /></label>
            <label style={{ flex: 2 }}>Person
              <select name="person" defaultValue={filters.person ?? ""}>
                <option value="">Anyone</option>
                {tl.people.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </label>
            <label style={{ flex: 2 }}>Words<input name="q" maxLength={200} defaultValue={filters.q ?? ""} /></label>
          </div>
          <div className="row">
            <label style={{ flex: 1 }}>Show
              <select name="show" defaultValue={filters.show}><option value="all">Confirmed and Huis&apos;s suggestions</option><option value="confirmed">Confirmed only</option></select>
            </label>
            <label style={{ flex: 1 }}>Sources
              <select name="source" defaultValue={filters.source}>
                <option value="any">Any</option><option value="evidence">Backed by evidence</option><option value="none">No source yet</option>
              </select>
            </label>
            <label style={{ flex: 1 }}>Filed email
              <select name="emails" defaultValue={filters.emails}><option value="yes">Include</option><option value="no">Leave out</option></select>
            </label>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button type="submit">Apply</button>
            {filtered ? <Link href={base} className="button secondary">Clear</Link> : null}
          </div>
        </form>
      </div>

      <div className="card">
        <h2>
          {filters.category ? CATEGORY_LABELS[filters.category] : "Master"} timeline ({tl.entries.length.toLocaleString()}
          {tl.entries.length !== tl.total ? ` of ${tl.total.toLocaleString()}` : ""})
        </h2>
        {shown.length === 0 ? (
          <p className="notice">{tl.total === 0
            ? "Nothing dated yet. Huis adds dates it finds in documents as suggestions, and filed email appears here on the day it was sent."
            : "Nothing matches these filters."}</p>
        ) : (
          <table>
            <thead><tr><th style={{ width: 110 }}>Date</th><th>What happened</th><th style={{ width: 200 }}>Categories</th>{data.canWrite ? <th style={{ width: 1 }} /> : null}</tr></thead>
            <tbody>
              {shown.map((e) => (
                <tr key={e.key}>
                  <td style={{ whiteSpace: "nowrap" }}>{e.date}</td>
                  <td>
                    <span className="badge">{KIND_LABEL[e.kind]}</span>{" "}
                    {e.status === "suggested" ? <span className="badge walled">Suggested by Huis</span> : null}{" "}
                    {e.nodeId ? <Link href={`/matters/${m.id}/dna/${e.nodeId}`}>{e.label}</Link> : <Link href={`/evidence/${e.evidenceId}`}>{e.label}</Link>}
                    {e.amount != null ? <span className="notice"> · ${e.amount.toLocaleString("en-US")}</span> : null}
                    {e.kind === "email" && e.from ? <div className="notice">From {e.from}{e.to.length ? ` to ${e.to.slice(0, 3).join(", ")}${e.to.length > 3 ? ` and ${e.to.length - 3} more` : ""}` : ""}</div> : null}
                    {e.people.length ? <div className="notice">People: {e.people.map((p) => p.label).join(", ")}</div> : null}
                    {e.sources.length ? (
                      <ul style={{ paddingLeft: 18, margin: "4px 0" }}>
                        {e.sources.slice(0, 3).map((c) => (
                          <li key={c.id} className="notice">
                            {c.evidenceId ? <Link href={`/evidence/${c.evidenceId}`}>{c.sourceTitle}</Link> : <span>Note: {c.sourceTitle}</span>}
                            {c.isEmail ? " (email)" : ""} — “{c.quote.length > 200 ? `${c.quote.slice(0, 200)}…` : c.quote}”
                          </li>
                        ))}
                        {e.sources.length > 3 ? <li className="notice">and {e.sources.length - 3} more</li> : null}
                      </ul>
                    ) : e.kind !== "email" ? <div className="notice">No source yet.</div> : null}
                  </td>
                  <td>
                    {e.categories.length ? e.categories.map((c) => <span key={c} className="badge" style={{ marginRight: 4 }}>{CATEGORY_LABELS[c]}</span>) : <span className="notice">None</span>}
                    {e.categoriesBy === "huis" && e.categories.length ? <div className="notice">Suggested by Huis</div> : null}
                  </td>
                  {data.canWrite ? (
                    <td style={{ whiteSpace: "nowrap" }}>
                      {e.status === "suggested" && e.nodeId ? (
                        <div className="row">
                          {(["confirmed", "rejected"] as const).map((d) => (
                            <form key={d} action={dnaDecideAction}>
                              <input type="hidden" name="matterId" value={m.id} /><input type="hidden" name="nodeId" value={e.nodeId!} />
                              <input type="hidden" name="decision" value={d} /><input type="hidden" name="back" value={here} />
                              <button type="submit" className={d === "confirmed" ? "" : "secondary"}>{d === "confirmed" ? "Confirm" : "Reject"}</button>
                            </form>
                          ))}
                        </div>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tl.entries.length > SHOWN ? <p className="notice">Showing the first {SHOWN.toLocaleString()}. Narrow the filters, or download the timeline for all of them.</p> : null}
      </div>

      {data.canWrite ? (
        <>
          <div className="card">
            <h2>Add an event</h2>
            <form action={dnaAddNodeAction}>
              <input type="hidden" name="matterId" value={m.id} /><input type="hidden" name="back" value={here} />
              <input type="hidden" name="kind" value="event" /><input type="hidden" name="categoriesShown" value="1" />
              <div className="row">
                <label style={{ flex: 1 }}>Date<input type="date" name="eventDate" required /></label>
                <label style={{ flex: 3 }}>What happened<input name="label" maxLength={300} required /></label>
              </div>
              <fieldset style={{ border: 0, padding: 0, margin: "8px 0" }}>
                <legend className="notice">Categories (leave all unticked for none)</legend>
                {CATEGORIES.map((c) => (
                  <label key={c} style={{ display: "inline-flex", gap: 4, marginRight: 12, fontWeight: 400 }}>
                    <input type="checkbox" name="categories" value={c} defaultChecked={filters.category === c} /> {CATEGORY_LABELS[c]}
                  </label>
                ))}
              </fieldset>
              <label>Details<textarea name="details" rows={2} maxLength={20000} /></label>
              <div style={{ marginTop: 8 }}><button type="submit">Add to timeline</button></div>
              <p className="notice">To cite where it comes from or link the people involved, open the event in Case DNA after adding it.</p>
            </form>
          </div>

          <div className="card">
            <h2>Download this timeline</h2>
            <p className="notice">A spreadsheet (CSV) of the entries shown with these filters, with their sources. It contains privileged material.</p>
            <form method="post" action={`/api/matters/${m.id}/timeline`}>
              {Object.entries(filters).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={String(v)} /> : null))}
              <label style={{ display: "flex", gap: 8, fontWeight: 400 }}>
                <input type="checkbox" name="acknowledge" required />
                I understand this download contains privileged and confidential work product and I will store it securely.
              </label>
              <div style={{ marginTop: 8 }}><button type="submit" className="secondary">Download timeline</button></div>
            </form>
          </div>
        </>
      ) : null}
    </>
  );
}
