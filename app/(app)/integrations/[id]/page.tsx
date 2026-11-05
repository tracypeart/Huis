import Link from "next/link";
import { notFound } from "next/navigation";
import { integrationImportAction, integrationRefreshAction } from "../../../../lib/actions";
import { getFlash, withSession } from "../../../../lib/server";
import { CLASSIFICATION_LABELS, FlashBanner } from "../../../../lib/ui";
import { NotFoundError, PermissionDeniedError } from "../../../../src/errors";
import { integrationInfo } from "../../../../src/integrations/registry";
import { browse, getConnection, LOCATION, listImports } from "../../../../src/services/integrations";
import { listMatterFolders, listMatters } from "../../../../src/services/matters";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const when = (d: Date | string | null | undefined) => (d ? new Date(d).toLocaleString("en-US", { timeZone: "America/Denver" }) : "—");
const size = (n: number | null | undefined) =>
  n == null ? "" : n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`;
const IMPORT_STATUS: Record<string, string> = { queued: "Waiting", running: "Copying…", done: "Imported", skipped: "Already in the Matter", failed: "Failed" };

export default async function BrowsePage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ at?: string; matter?: string; f?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const flash = await getFlash(sp.f);
  const at = sp.at && LOCATION.test(sp.at) ? sp.at : "root";
  const data = await withSession(async (s) => {
    let c;
    try { c = await getConnection(s, id); } catch (err) {
      if (err instanceof NotFoundError || err instanceof PermissionDeniedError) return null;
      throw err;
    }
    const listing = await browse(s, c.id, at);
    const matters = await listMatters(s);
    const matterId = sp.matter && UUID.test(sp.matter) && matters.some((x) => x.id === sp.matter) ? sp.matter : null;
    const folders = matterId ? await listMatterFolders(s, matterId) : [];
    return { c, listing, matters, matterId, folders, imports: await listImports(s, c.id, 20) };
  });
  if (!data) notFound();
  const { c, listing } = data;
  const link = (to: string) => {
    const q = new URLSearchParams();
    if (to !== "root") q.set("at", to);
    if (data.matterId) q.set("matter", data.matterId);
    const qs = q.toString();
    return `/integrations/${c.id}${qs ? `?${qs}` : ""}`;
  };
  const waiting = listing.status === "queued" || listing.status === "running" || data.imports.some((i) => i.status === "queued" || i.status === "running");
  const files = listing.items.filter((i) => i.kind === "file");
  // Google Drive: Huis sees only the files chosen for it in Google's file picker (drive.file).
  const picked = c.provider === "google_drive";

  return (
    <>
      {/* Folder listings and imports are done by the Huis worker; check back shortly while one is in progress. */}
      {waiting ? <meta httpEquiv="refresh" content="3" /> : null}
      <p className="notice"><Link href="/integrations">← Integrations</Link></p>
      <h1>{integrationInfo(c.provider)?.name ?? c.provider}</h1>
      <p className="sub">{c.accountLabel ?? "Connected account"} · read-only · only you can browse this account</p>
      <FlashBanner flash={flash} />
      {c.status === "needs_reconnect" ? (
        <div className="card"><p>This account needs reconnecting{c.lastError ? ` (${c.lastError})` : ""}. <a href={`/api/integrations/${c.provider}/start`}>Reconnect</a></p></div>
      ) : null}

      <div className="card">
        <h2>Import into a Matter</h2>
        <form method="get" className="row">
          {at !== "root" ? <input type="hidden" name="at" value={at} /> : null}
          <label style={{ flex: 1 }}>Matter
            <select name="matter" defaultValue={data.matterId ?? ""}>
              <option value="" disabled>Choose a Matter…</option>
              {data.matters.map((x) => <option key={x.id} value={x.id}>{x.title} ({x.huisNumber})</option>)}
            </select>
          </label>
          <button type="submit" className="secondary">Choose folder</button>
        </form>
        {!data.matterId ? <p className="notice">Choose the Matter first, then tick the files below.</p> : null}
      </div>

      <div className="card">
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0 }}>{listing.title ?? "Loading…"}</h2>
          <form action={integrationRefreshAction}>
            <input type="hidden" name="connectionId" value={c.id} /><input type="hidden" name="at" value={at} />
            <button type="submit" className="secondary">Refresh</button>
          </form>
        </div>
        {listing.parent ? <p className="notice"><Link href={link(listing.parent)}>↑ Up</Link></p> : null}
        {picked ? (
          <p>{/* A plain link: the picker is a document of its own (security review 21, R21-2). */}<a className="button" href={`/integrations/${c.id}/pick`}>Choose files in Google Drive</a>{" "}
            <span className="notice">Huis can open only the files you choose with Google&apos;s file picker.</span></p>
        ) : null}
        {listing.status === "queued" || listing.status === "running"
          ? <p className="notice">{listing.items.length ? "Checking this folder for changes…" : "Fetching this folder…"}</p> : null}
        {listing.status === "failed" ? <p className="notice">Couldn&apos;t list this folder{listing.error ? `: ${listing.error}` : ""}.</p> : null}
        {/* The last listing stays usable while it is being refreshed. */}
        {listing.status === "ready" || listing.items.length ? (
          <form action={integrationImportAction}>
            <input type="hidden" name="connectionId" value={c.id} />
            <input type="hidden" name="at" value={at} />
            {data.matterId ? <input type="hidden" name="matterId" value={data.matterId} /> : null}
            <table><tbody>
              {listing.items.length === 0 ? <tr><td className="notice">{picked ? "You haven't chosen any files for Huis yet." : "This folder is empty."}</td></tr> : null}
              {listing.items.map((i) => (
                <tr key={i.id}>
                  <td style={{ width: 1 }}>{i.kind === "file" && data.matterId ? <input type="checkbox" name="item" value={i.id} aria-label={`Import ${i.name}`} /> : null}</td>
                  <td>
                    {i.kind === "file" ? <span>📄 {i.name}</span> : <Link href={link(i.id)}>{i.kind === "site" ? "🌐" : "📁"} {i.name}</Link>}
                  </td>
                  <td className="notice" style={{ whiteSpace: "nowrap" }}>{i.kind === "file" ? size(i.size) : ""}</td>
                  <td className="notice" style={{ whiteSpace: "nowrap" }}>{i.modified ? when(i.modified) : ""}</td>
                </tr>
              ))}
            </tbody></table>
            {listing.truncated ? <p className="notice">This folder has more items than Huis lists at once; open a subfolder to narrow it down.</p> : null}
            {data.matterId && files.length ? (
              <>
                <label style={{ marginTop: 12 }}>Matter folder
                  <select name="folderId" defaultValue={data.folders.find((f) => f.name === "Correspondence")?.id}>
                    {data.folders.map((f) => <option key={f.id} value={f.id}>{f.isPrivilegedArea ? "🔴 " : ""}{f.name} ({CLASSIFICATION_LABELS[f.classification]})</option>)}
                  </select>
                </label>
                <label className="check" style={{ marginTop: 8 }}>
                  <input type="checkbox" name="acknowledge" />
                  <span>Required when importing into a folder people outside the firm can see: I understand this may waive privilege.</span>
                </label>
                <div style={{ marginTop: 12 }}><button type="submit">Import selected files</button></div>
              </>
            ) : null}
          </form>
        ) : null}
        <p className="notice">{picked
          ? "Huis keeps only the names, sizes and dates of the files you chose. Google Docs, Sheets and Slides aren't listed: download them as a file (such as PDF or Word) first. "
          : "Huis keeps only names, sizes and dates of the folders you open. "}A file&apos;s contents are copied only when you import it, and the same version is imported into a Matter once.</p>
      </div>

      {data.imports.length ? (
        <div className="card">
          <h2>Your recent imports</h2>
          <table><tbody>
            {data.imports.map((i) => (
              <tr key={i.id}>
                <td>{i.evidenceId && (i.status === "done" || i.status === "skipped") ? <Link href={`/evidence/${i.evidenceId}`}>{i.name}</Link> : i.name}
                  <div className="notice">{i.matterTitle ? <Link href={`/matters/${i.matterId}`}>{i.matterTitle}</Link> : "A Matter you can no longer see"} · {when(i.requestedAt)}</div></td>
                <td style={{ width: 220 }}><span className={`badge${i.status === "failed" ? " privileged" : ""}`}>{IMPORT_STATUS[i.status] ?? i.status}</span>
                  {i.error && i.status !== "skipped" ? <div className="notice">{i.error}</div> : null}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
      ) : null}
    </>
  );
}
