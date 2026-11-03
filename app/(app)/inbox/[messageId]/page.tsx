import Link from "next/link";
import { notFound } from "next/navigation";
import { fileMessageAction, fileSuggestionAction } from "../../../../lib/actions";
import { getFlash, withSession } from "../../../../lib/server";
import { CLASSIFICATION_LABELS, FlashBanner } from "../../../../lib/ui";
import { NotFoundError, PermissionDeniedError } from "../../../../src/errors";
import { getFilingMode, getMessage, suggestMatters } from "../../../../src/services/inbox";
import { listMatterFolders, listMatters } from "../../../../src/services/matters";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const strength = (score: number) => (score >= 85 ? "Strong match" : score >= 55 ? "Likely" : "Possible");
const when = (d: Date | null) => (d ? new Date(d).toLocaleString("en-US", { timeZone: "America/Denver" }) : "—");

export default async function MessagePage({ params, searchParams }: {
  params: Promise<{ messageId: string }>; searchParams: Promise<{ matter?: string; f?: string }>;
}) {
  const { messageId } = await params;
  const sp = await searchParams;
  const flash = await getFlash(sp.f);
  const data = await withSession(async (s) => {
    let m;
    try { m = await getMessage(s, messageId); } catch (err) {
      if (err instanceof NotFoundError || err instanceof PermissionDeniedError) return null;
      throw err;
    }
    const matters = await listMatters(s);
    const matterId = sp.matter && UUID.test(sp.matter) && matters.some((x) => x.id === sp.matter) ? sp.matter : null;
    const folders = matterId ? await listMatterFolders(s, matterId) : [];
    const suggestions = !m.filedMatterId && !m.removed ? await suggestMatters(s, m.id) : [];
    return { m, matters, matterId, folders, suggestions, mode: await getFilingMode(s) };
  });
  if (!data) notFound();
  const { m } = data;

  return (
    <>
      <p className="notice"><Link href="/inbox">← Inbox</Link></p>
      <h1 style={{ wordBreak: "break-word" }}>{m.subject || "(no subject)"}</h1>
      <FlashBanner flash={flash} />
      <div className="card">
        <table><tbody>
          <tr><th>From</th><td>{m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress ?? "—"}</td></tr>
          <tr><th>To</th><td>{m.to.join(", ") || "—"}</td></tr>
          {m.cc.length ? <tr><th>Cc</th><td>{m.cc.join(", ")}</td></tr> : null}
          <tr><th>Received</th><td>{when(m.receivedAt)}</td></tr>
          <tr><th>Folder</th><td>{m.folderPath ?? "—"}</td></tr>
          <tr><th>Attachments</th><td>{m.hasAttachments ? "Yes (each becomes its own evidence item when filed)" : "None"}</td></tr>
          <tr><th>Matter</th><td>
            {m.filedMatterId ? (m.filedMatterTitle
              ? <>Filed in <Link href={`/matters/${m.filedMatterId}`}>{m.filedMatterTitle}</Link>{m.filedEvidenceId ? <> · <Link href={`/evidence/${m.filedEvidenceId}`}>open filed copy</Link></> : null}</>
              : "Filed in a Matter you don't have access to")
              : m.pendingFiling ? "Filing in progress…" : "Not filed"}
          </td></tr>
        </tbody></table>
      </div>

      {data.suggestions.length ? (
        <div className="card">
          <h2>Suggested Matters</h2>
          <p className="notice">
            Based on what&apos;s in this email. Only Matters you can see and add to are suggested.
            {data.mode === "manual" ? " Your firm files email manually: use the form below." : " One click files the email into that Matter's internal Correspondence folder."}
          </p>
          <table>
            <tbody>
              {data.suggestions.map((x) => (
                <tr key={x.matterId}>
                  <td style={{ width: "35%" }}>
                    <span className="badge" style={x.color ? { background: x.color, color: "#fff" } : undefined}>{x.title}</span>
                    <div className="notice">{strength(x.score)}</div>
                  </td>
                  <td><ul style={{ margin: 0, paddingLeft: 18 }}>{x.reasons.map((r) => <li key={r}>{r}</li>)}</ul></td>
                  <td style={{ width: 1, whiteSpace: "nowrap" }}>
                    {data.mode !== "manual" && !m.pendingFiling ? (
                      <form action={fileSuggestionAction}>
                        <input type="hidden" name="messageId" value={m.id} />
                        <input type="hidden" name="matterId" value={x.matterId} />
                        <button type="submit">File here</button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {!m.removed ? (
        <div className="card">
          <h2>File into a Matter</h2>
          <form method="get" className="row">
            <label style={{ flex: 1 }}>Matter
              <select name="matter" defaultValue={data.matterId ?? ""}>
                <option value="" disabled>Choose a Matter…</option>
                {data.matters.map((x) => <option key={x.id} value={x.id}>{x.title} ({x.huisNumber})</option>)}
              </select>
            </label>
            <button type="submit" className="secondary">Choose folder</button>
          </form>
          {data.matterId ? (
            <form action={fileMessageAction} style={{ marginTop: 12 }}>
              <input type="hidden" name="messageId" value={m.id} />
              <input type="hidden" name="matterId" value={data.matterId} />
              <label>Folder
                <select name="folderId" defaultValue={data.folders.find((f) => f.name === "Correspondence")?.id}>
                  {data.folders.map((f) => <option key={f.id} value={f.id}>{f.isPrivilegedArea ? "🔴 " : ""}{f.name} ({CLASSIFICATION_LABELS[f.classification]})</option>)}
                </select>
              </label>
              <label className="check" style={{ marginTop: 8 }}>
                <input type="checkbox" name="acknowledge" />
                <span>Required when filing into a folder people outside the firm can see: I understand this may waive privilege.</span>
              </label>
              <div style={{ marginTop: 12 }}><button type="submit">File email</button></div>
            </form>
          ) : null}
        </div>
      ) : <div className="card"><p className="notice">This email was deleted from the mailbox.</p></div>}

      <div className="card">
        <h2>Message</h2>
        <p className="notice">Shown as plain text. The filed copy keeps the original exactly as received.</p>
        <div className="doc-text">{(m.body ?? m.preview ?? "").slice(0, 200_000)}</div>
      </div>
    </>
  );
}
