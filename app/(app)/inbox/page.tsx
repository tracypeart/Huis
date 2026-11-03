import Link from "next/link";
import { authConfig } from "../../../src/auth/config";
import { ZodError } from "zod";
import { filingModeAction, syncMailboxAction } from "../../../lib/actions";
import { getFlash, withSession } from "../../../lib/server";
import { FlashBanner } from "../../../lib/ui";
import { INTERNAL_ROLES } from "../../../src/security/permissions";
import { getFilingMode, listMailboxes, listMessages, suggestMatters, type MailMessage, type MatterSuggestion } from "../../../src/services/inbox";
import { can } from "../../../src/security/permissions";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const when = (d: Date | null) => (d ? new Date(d).toLocaleString("en-US", { timeZone: "America/Denver", dateStyle: "medium", timeStyle: "short" }) : "—");
const STATUS: Record<string, string> = { active: "Connected", paused: "Paused", needs_reconnect: "Needs reconnecting", disconnected: "Disconnected" };

export default async function Inbox({ searchParams }: { searchParams: Promise<{ q?: string; mailbox?: string; show?: string; f?: string }> }) {
  const sp = await searchParams;
  const flash = await getFlash(sp.f);
  const q = (sp.q ?? "").slice(0, 500);
  const show = sp.show === "filed" || sp.show === "all" ? sp.show : "unfiled";
  const data = await withSession(async (s) => {
    if (!INTERNAL_ROLES.has(s.actor.role)) return null;
    const mailboxes = await listMailboxes(s);
    const connectionId = sp.mailbox && UUID.test(sp.mailbox) ? sp.mailbox : undefined;
    let messages: MailMessage[] = [];
    let error: string | null = null;
    try {
      messages = await listMessages(s, { connectionId, q: q || undefined, status: show, limit: 100 });
    } catch (err) {
      if (err instanceof ZodError) error = err.issues[0]?.message ?? "Check your search."; else throw err;
    }
    // Top suggestion for unfiled email on this page (first 50).
    const suggested = new Map<string, MatterSuggestion>();
    for (const m of messages.slice(0, 50)) {
      if (m.filedMatterId || m.pendingFiling) continue;
      const top = (await suggestMatters(s, m.id))[0];
      if (top) suggested.set(m.id, top);
    }
    return {
      mailboxes, messages, error, connectionId, suggested, canConnect: s.actor.role !== "read_only",
      mode: await getFilingMode(s), isAdmin: can(s.actor.role, "firm.manage"), gmail: Boolean(authConfig().google),
    };
  });
  if (!data) {
    return (<><h1>Inbox</h1><div className="card"><p>The Huis Inbox is available to firm staff.</p></div></>);
  }

  return (
    <>
      <h1>Inbox</h1>
      <p className="sub">
        Your connected mailboxes. Unfiled email is private: only you and the people you choose can see it, not firm administrators.
        Filing copies the original email (with its attachments) into a Matter as evidence.
      </p>
      <FlashBanner flash={flash} />

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>Mailboxes</h2>
          {data.canConnect ? (
            <div className="row">
              <a className="button" href="/api/mailboxes/microsoft/start">Connect Outlook</a>
              {data.gmail ? <a className="button" href="/api/mailboxes/google/start">Connect Gmail</a> : null}
            </div>
          ) : null}
        </div>
        {data.mailboxes.length === 0 ? (
          <p className="notice">No mailbox connected yet. Connecting asks Microsoft or Google for read-only access: Huis can read your mail but can&apos;t send, change or delete it.</p>
        ) : (
          <table>
            <thead><tr><th>Mailbox</th><th>Status</th><th>Mail</th><th>Last synced</th><th /></tr></thead>
            <tbody>
              {data.mailboxes.map((m) => (
                <tr key={m.id}>
                  <td><Link href={`/inbox?mailbox=${m.id}`}>{m.accountAddress ?? m.displayName}</Link>
                    <div className="notice">{m.mine ? "Your mailbox" : "Shared with you"}{m.manage ? " · Huis keeps it in sync" : ""}</div></td>
                  <td>{STATUS[m.status] ?? m.status}{m.lastError ? <div className="notice">{m.status === "needs_reconnect" ? `${m.provider === "google" ? "Google" : "Microsoft"} access expired — reconnect.` : "Last sync had a problem; Huis will retry."}</div> : null}</td>
                  <td>{m.unfiledCount.toLocaleString()} unfiled · {m.messageCount.toLocaleString()} total</td>
                  <td>{when(m.lastSyncedAt)}</td>
                  <td className="row">
                    <form action={syncMailboxAction}><input type="hidden" name="connectionId" value={m.id} /><button type="submit" className="secondary">Sync now</button></form>
                    {m.mine ? <Link className="button secondary" href={`/inbox/mailboxes/${m.id}`}>Settings</Link> : null}
                    {m.mine && m.status === "needs_reconnect" ? <a className="button" href={`/api/mailboxes/${m.provider === "google" ? "google" : "microsoft"}/start`}>Reconnect</a> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {data.isAdmin ? (
        <div className="card">
          <h2>Firm filing mode</h2>
          <form action={filingModeAction} className="row">
            <label>How email is filed into Matters
              <select name="mode" defaultValue={data.mode}>
                <option value="manual">Manual — Huis suggests; people file themselves</option>
                <option value="assisted">Assisted — one-click filing to a suggested Matter</option>
                <option value="automatic">Automatic — Huis files clear matches (a case or Huis number plus the client or a contact) by itself</option>
              </select>
            </label>
            <button type="submit" className="secondary">Save</button>
          </form>
          <p className="notice">Automatic filing also has to be turned on by each attorney for their own mailbox, and only ever files into a Matter&apos;s internal Correspondence folder — never a folder the client can see.</p>
        </div>
      ) : null}

      {data.mailboxes.length ? (
        <div className="card">
          <form className="row" method="get" action="/inbox">
            {data.connectionId ? <input type="hidden" name="mailbox" value={data.connectionId} /> : null}
            <label style={{ flex: 1 }}>Search email
              <input name="q" defaultValue={q} placeholder='e.g. "deposition notice" or smith -lunch' />
            </label>
            <label>Show
              <select name="show" defaultValue={show}>
                <option value="unfiled">Unfiled</option><option value="filed">Filed</option><option value="all">All</option>
              </select>
            </label>
            <button type="submit">Search</button>
          </form>
          {data.error ? <div className="flash error">{data.error}</div> : null}
          {data.messages.length === 0 ? <p className="notice">No email here{q ? " matches that search" : ""}.</p> : (
            <table>
              <thead><tr><th>From</th><th>Subject</th><th>Received</th><th>Matter</th></tr></thead>
              <tbody>
                {data.messages.map((m) => (
                  <tr key={m.id}>
                    <td style={{ wordBreak: "break-word" }}>{m.fromName ?? m.fromAddress ?? "—"}<div className="notice">{m.fromAddress}</div></td>
                    <td style={{ wordBreak: "break-word" }}><Link href={`/inbox/${m.id}`}>{m.subject || "(no subject)"}</Link>{m.hasAttachments ? " 📎" : ""}
                      <div className="notice">{m.preview?.slice(0, 140)}</div></td>
                    <td style={{ whiteSpace: "nowrap" }}>{when(m.receivedAt)}</td>
                    <td>
                      {m.filedMatterId ? (
                        <span className="badge" style={m.filedMatterColor ? { background: m.filedMatterColor, color: "#fff" } : undefined}>
                          {m.filedMatterTitle ?? "Filed"}
                        </span>
                      ) : m.pendingFiling ? <span className="badge">Filing…</span> : data.suggested.get(m.id) ? (
                        <span className="notice">Suggested: <span className="badge" style={data.suggested.get(m.id)!.color ? { background: data.suggested.get(m.id)!.color!, color: "#fff" } : undefined}>{data.suggested.get(m.id)!.title}</span></span>
                      ) : <span className="notice">Unfiled</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </>
  );
}
