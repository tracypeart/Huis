import Link from "next/link";
import { notFound } from "next/navigation";
import { moveEvidenceAction } from "../../../../lib/actions";
import { getFlash, withSession } from "../../../../lib/server";
import { CLASSIFICATION_LABELS, EvidenceStatus, FlashBanner, formatBytes } from "../../../../lib/ui";
import { NotFoundError } from "../../../../src/errors";
import { custodyLog, getEmailHeaders, getEvidence, getEvidenceText, listContainedItems, listSimilar } from "../../../../src/services/evidence";
import { getMatter, listMatterFolders } from "../../../../src/services/matters";
import { INTERNAL_ROLES } from "../../../../src/security/permissions";

export const dynamic = "force-dynamic";

const EVENT_LABELS: Record<string, string> = {
  received: "Received and fingerprinted",
  integrity_verified: "Stored copy verified against fingerprint",
  scanned_clean: "Virus scan: clean",
  scanned_infected: "Virus scan: threat found — quarantined",
  scan_failed: "Security check failed — held",
  duplicate_detected: "Identical to an earlier upload",
  downloaded: "Original downloaded",
  viewed: "Viewed",
  moved: "Moved to another folder",
  extracted: "Taken out of its email or archive and fingerprinted",
  contained_item_extracted: "A contained file was taken out as its own item",
  text_extracted: "Text made readable and searchable",
  quarantined_contains_threat: "Quarantined: something inside it contains a threat",
};

const EXTRACTION_LABELS: Record<string, string> = {
  pending: "Waiting to be read",
  done: "Readable and searchable",
  partial: "Partly readable",
  no_text: "No readable text",
  unsupported: "Can't be read yet",
  needs_provider: "Waiting for transcription service",
  failed: "Couldn't be read",
};

const when = (d: Date) => new Date(d).toLocaleString("en-US", { timeZone: "America/Denver" });

export default async function EvidenceDetail({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ f?: string }>;
}) {
  const { id } = await params;
  const flash = await getFlash((await searchParams).f);
  const data = await withSession(async (s) => {
    let item;
    try { item = await getEvidence(s, id); } catch (err) { if (err instanceof NotFoundError) return null; throw err; }
    const matter = await getMatter(s, item.matterId);
    const custody = await custodyLog(s, id);
    const internal = INTERNAL_ROLES.has(s.actor.role);
    const parent = item.parentId ? await getEvidence(s, item.parentId).catch(() => null) : null;
    return {
      item, matter, custody, internal, parent,
      text: item.status === "clean" ? await getEvidenceText(s, id) : null,
      email: await getEmailHeaders(s, id),
      contained: await listContainedItems(s, id),
      similar: await listSimilar(s, id),
      folders: internal && s.actor.role !== "read_only" ? await listMatterFolders(s, item.matterId) : [],
    };
  });
  if (!data) notFound();
  const { item: e, matter: m, custody } = data;

  return (
    <>
      <p className="notice"><Link href={`/matters/${m.id}`}>← {m.title}</Link></p>
      <h1 style={{ wordBreak: "break-word" }}>{e.originalFilename}</h1>
      <p className="sub">
        {e.relativePath ?? (e.containerPath ? `Inside: ${e.containerPath}` : "Uploaded file")} · {formatBytes(e.sizeBytes)} · <EvidenceStatus status={e.status} />
        {e.extractionStatus ? <> · <span className="badge">{EXTRACTION_LABELS[e.extractionStatus]}</span></> : null}
      </p>
      {data.parent ? (
        <p className="notice">Found inside <Link href={`/evidence/${data.parent.id}`}>{data.parent.originalFilename}</Link>. It has its own fingerprint, scan and chain of custody.</p>
      ) : null}
      <FlashBanner flash={flash} />

      {data.email ? (
        <div className="card">
          <h2>Email</h2>
          <table><tbody>
            <tr><th>Subject</th><td>{data.email.subject ?? "(no subject)"}</td></tr>
            <tr><th>From</th><td>{data.email.from ?? "—"}</td></tr>
            <tr><th>To</th><td>{data.email.to.join(", ") || "—"}</td></tr>
            {data.email.cc.length ? <tr><th>Cc</th><td>{data.email.cc.join(", ")}</td></tr> : null}
            {data.email.bcc.length ? <tr><th>Bcc</th><td>{data.email.bcc.join(", ")}</td></tr> : null}
            <tr><th>Sent</th><td>{data.email.sentAt ? when(data.email.sentAt) : "—"}</td></tr>
          </tbody></table>
        </div>
      ) : null}

      {data.contained.length ? (
        <div className="card">
          <h2>{data.email ? "Attachments" : "Contents"} ({data.contained.length})</h2>
          <table>
            <thead><tr><th>File</th><th>Size</th><th>Security</th><th>Readable</th></tr></thead>
            <tbody>
              {data.contained.map((c) => (
                <tr key={c.id}>
                  <td style={{ wordBreak: "break-word" }}><Link href={`/evidence/${c.id}`}>{c.originalFilename}</Link>
                    {c.containerPath && c.containerPath !== c.originalFilename ? <div className="notice">{c.containerPath}</div> : null}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>{formatBytes(c.sizeBytes)}</td>
                  <td><EvidenceStatus status={c.status} /></td>
                  <td>{c.extractionStatus ? EXTRACTION_LABELS[c.extractionStatus] : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {data.similar.length ? (
        <div className="card">
          <h2>Similar documents ({data.similar.length})</h2>
          <p className="notice">
            <strong>Versions</strong> have the same document name once words like “final”, “v2” or dates are ignored, and overlapping wording.{" "}
            <strong>Near-duplicates</strong> have almost the same wording under a different name. Exact copies are shown as duplicates above.
            Similarity is estimated from the readable text; always check against the originals.
          </p>
          <table>
            <thead><tr><th>Document</th><th>Relationship</th><th>Same wording</th><th>Folder</th><th></th></tr></thead>
            <tbody>
              {data.similar.map((x) => (
                <tr key={x.id}>
                  <td style={{ wordBreak: "break-word" }}><Link href={`/evidence/${x.id}`}>{x.originalFilename}</Link>
                    <div className="notice">Uploaded {when(x.uploadedAt)}{x.dateReceived ? ` · received ${x.dateReceived}` : ""}</div>
                  </td>
                  <td>{x.kind === "version" ? "Another version" : "Near-duplicate"}</td>
                  <td>about {Math.round(x.score * 100)}%</td>
                  <td>{x.folderIsPrivileged ? <span className="badge privileged">{x.folderName}</span> : x.folderName}</td>
                  <td><Link href={`/evidence/${e.id}/compare/${x.id}`}>Compare</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="grid">
        <div className="card">
          <h2>Original</h2>
          <table><tbody>
            <tr><th>Folder</th><td>{e.folderIsPrivileged ? <span className="badge privileged">{e.folderName}</span> : e.folderName}</td></tr>
            <tr><th>File type (by content)</th><td>{e.detectedContentType ?? "Checking…"}</td></tr>
            <tr><th>Security scan</th><td>{e.scanDetail ?? "In progress — the file is held until it passes."}</td></tr>
            <tr><th>Received from</th><td>{e.receivedFrom ?? "—"}</td></tr>
            <tr><th>Date received</th><td>{e.dateReceived ?? "—"}</td></tr>
            <tr><th>Source</th><td>{e.source.replace(/_/g, " ")}</td></tr>
            <tr><th>Uploaded by</th><td>{e.uploadedByName ?? "—"} on {when(e.uploadedAt)}</td></tr>
            <tr><th>SHA-256 fingerprint</th><td><code style={{ wordBreak: "break-all", fontSize: ".8rem" }}>{e.sha256}</code></td></tr>
            {e.duplicateOf ? <tr><th>Duplicate of</th><td><Link href={`/evidence/${e.duplicateOf}`}>Earlier identical file</Link></td></tr> : null}
            {e.pageCount ? <tr><th>Pages</th><td>{e.pageCount}</td></tr> : null}
            {e.extractionDetail ? <tr><th>Reading</th><td>{e.extractionDetail}</td></tr> : null}
          </tbody></table>
          <div style={{ marginTop: 16 }}>
            {e.status === "clean" ? (
              <a className="button" href={`/api/evidence/${e.id}/download`}>Download original</a>
            ) : (
              <p className="notice">This file cannot be opened until it passes its security scan.</p>
            )}
          </div>
          <p className="notice" style={{ marginTop: 12 }}>
            The original is never changed. Annotation, redaction and exhibit copies arrive in a later step and are kept separately.
          </p>
        </div>

        <div className="card">
          <h2>Chain of custody</h2>
          {custody.brokenAt === null
            ? <div className="flash success">Integrity verified: this record has not been altered.</div>
            : <div className="flash error" role="alert">Custody record integrity check FAILED at entry #{custody.brokenAt}.</div>}
          <table>
            <thead><tr><th>When</th><th>Event</th><th>By</th></tr></thead>
            <tbody>
              {custody.events.map((c) => (
                <tr key={c.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{when(c.occurredAt)}</td>
                  <td>{EVENT_LABELS[c.event] ?? c.event}
                    {c.event === "moved" ? <div className="notice">{String(c.details.from)} → {String(c.details.to)}</div> : null}
                  </td>
                  <td>{c.actorName ?? "Huis system"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.folders.length > 0 ? (
            <form action={moveEvidenceAction} className="row" style={{ marginTop: 16 }}>
              <input type="hidden" name="evidenceId" value={e.id} />
              <label>Move to folder
                <select name="folderId" defaultValue={e.folderId}>
                  {data.folders.map((f) => (
                    <option key={f.id} value={f.id}>{f.isPrivilegedArea ? "🔴 " : ""}{f.name} ({CLASSIFICATION_LABELS[f.classification]})</option>
                  ))}
                </select>
              </label>
              <button type="submit" className="secondary">Move</button>
              <label className="check" style={{ flexBasis: "100%" }}>
                <input type="checkbox" name="acknowledge" />
                <span>
                  Required when moving into a folder people outside the firm can see (such as Client Uploads): I understand this may
                  waive privilege and I have reviewed this file.
                </span>
              </label>
            </form>
          ) : null}
        </div>
      </div>

      {data.text ? (
        <div className="card">
          <h2>Text {data.text.method === "ocr" ? "(read from scanned images — check against the original)" : data.text.method === "transcript" ? "(transcript)" : ""}</h2>
          <p className="notice">
            {data.text.charCount.toLocaleString()} characters{data.text.truncated ? " — very long; only the first 5 million characters are kept for search" : ""}.
            The downloaded original is the authoritative copy.
          </p>
          <div className="doc-text">{data.text.content.slice(0, 200_000)}</div>
          {data.text.content.length > 200_000 ? <p className="notice">Showing the first 200,000 characters. Use Search to find specific passages.</p> : null}
        </div>
      ) : null}
    </>
  );
}
