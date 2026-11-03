import Link from "next/link";
import { notFound } from "next/navigation";
import { autoFileAction, mailDelegateAction, mailFolderAction, updateMailboxAction } from "../../../../../lib/actions";
import { getFlash, withSession } from "../../../../../lib/server";
import { FlashBanner } from "../../../../../lib/ui";
import { NotFoundError, PermissionDeniedError } from "../../../../../src/errors";
import { INTERNAL_ROLES } from "../../../../../src/security/permissions";
import { getFilingMode, getMailbox, listDelegates, listMailFolders } from "../../../../../src/services/inbox";
import { listUsers } from "../../../../../src/services/users";

export const dynamic = "force-dynamic";

export default async function MailboxSettings({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ f?: string }> }) {
  const { id } = await params;
  const flash = await getFlash((await searchParams).f);
  const data = await withSession(async (s) => {
    let m;
    try { m = await getMailbox(s, id); } catch (err) {
      if (err instanceof NotFoundError || err instanceof PermissionDeniedError) return null;
      throw err;
    }
    if (!m.mine) return null;
    const delegates = await listDelegates(s, id);
    const staff = (await listUsers(s).catch(() => [])).filter((u) =>
      INTERNAL_ROLES.has(u.role) && u.role !== "read_only" && u.id !== s.actor.userId && u.status === "active");
    return { m, folders: await listMailFolders(s, id), delegates, staff, mode: await getFilingMode(s) };
  });
  if (!data) notFound();
  const { m } = data;
  const delegateIds = new Set(data.delegates.map((d) => d.userId));

  return (
    <>
      <p className="notice"><Link href="/inbox">← Inbox</Link></p>
      <h1>{m.accountAddress ?? m.displayName}</h1>
      <p className="sub">Outlook mailbox · read-only access · unfiled mail is visible only to you and the people below</p>
      <FlashBanner flash={flash} />

      <div className="card">
        <h2>What Huis brings in</h2>
        <form action={updateMailboxAction}>
          <input type="hidden" name="connectionId" value={m.id} />
          <label className="check"><input type="radio" name="scope" value="all" defaultChecked={m.scope === "all"} /> <span>The whole mailbox (new folders included automatically)</span></label>
          <label className="check"><input type="radio" name="scope" value="selected" defaultChecked={m.scope === "selected"} /> <span>Only the folders I choose below</span></label>
          <label style={{ marginTop: 8 }}>Only mail received on or after (optional)
            <input type="date" name="syncSince" defaultValue={m.syncSince ?? ""} />
          </label>
          <label className="check" style={{ marginTop: 8 }}>
            <input type="checkbox" name="manage" defaultChecked={m.manage} />
            <span><strong>Let Huis manage</strong>: keep this mailbox in sync continuously (every few minutes). Otherwise Huis syncs when you press “Sync now”.</span>
          </label>
          <label style={{ marginTop: 8 }}>Status
            <select name="status" defaultValue={m.status === "paused" ? "paused" : "active"}>
              <option value="active">Active</option><option value="paused">Paused</option>
            </select>
          </label>
          <div style={{ marginTop: 12 }}><button type="submit">Save</button></div>
        </form>
      </div>

      <div className="card">
        <h2>Automatic filing</h2>
        <p className="notice">
          When on, Huis files email received from now on into a Matter by itself — only Matters you&apos;re on, only when the email has
          the Matter&apos;s Huis number or court case number (or belongs to a conversation already filed there) <em>and</em> the client
          or a contact linked to the Matter is on it, and only into the Matter&apos;s internal Correspondence folder. Email already in
          Huis is never filed automatically. Every automatic filing records why it was made. Needs “Let Huis manage” on.
          {data.mode !== "automatic" ? " Your firm's filing mode isn't Automatic, so this has no effect until an administrator changes it." : ""}
        </p>
        <form action={autoFileAction} className="row">
          <input type="hidden" name="connectionId" value={m.id} />
          <input type="hidden" name="on" value={m.autoFile ? "false" : "true"} />
          <span>{m.autoFile ? "On" : "Off"}</span>
          <button type="submit" className="secondary">{m.autoFile ? "Turn off" : "Turn on"}</button>
        </form>
      </div>

      <div className="card">
        <h2>Folders</h2>
        {data.folders.length === 0 ? <p className="notice">Folders appear after the first sync.</p> : (
          <table>
            <thead><tr><th>Folder</th><th>Items</th><th>Brought into Huis</th></tr></thead>
            <tbody>
              {data.folders.map((f) => (
                <tr key={f.id}>
                  <td>{f.path}</td>
                  <td>{f.total?.toLocaleString() ?? "—"}</td>
                  <td>
                    <form action={mailFolderAction} className="row">
                      <input type="hidden" name="connectionId" value={m.id} />
                      <input type="hidden" name="folderId" value={f.id} />
                      <input type="hidden" name="included" value={f.included ? "false" : "true"} />
                      <span>{f.included ? "Yes" : "No"}</span>
                      <button type="submit" className="secondary">{f.included ? "Exclude" : "Include"}</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Who else can see this mailbox</h2>
        <p className="notice">For example, your assistant. They can read and file your unfiled email but can&apos;t change these settings. Firm administrators can&apos;t see it unless you add them here.</p>
        <table>
          <tbody>
            {data.staff.map((u) => (
              <tr key={u.id}>
                <td>{u.fullName}</td>
                <td>
                  <form action={mailDelegateAction}>
                    <input type="hidden" name="connectionId" value={m.id} />
                    <input type="hidden" name="userId" value={u.id} />
                    <input type="hidden" name="granted" value={delegateIds.has(u.id) ? "false" : "true"} />
                    <button type="submit" className={delegateIds.has(u.id) ? "" : "secondary"}>{delegateIds.has(u.id) ? "Remove access" : "Give access"}</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Disconnect</h2>
        <p className="notice">Deletes Huis&apos;s access and every unfiled email from Huis. Emails already filed stay in their Matters. You can also remove Huis&apos;s access in your Microsoft account settings.</p>
        <form action={updateMailboxAction}>
          <input type="hidden" name="connectionId" value={m.id} />
          <input type="hidden" name="scope" value={m.scope} />
          <input type="hidden" name="status" value="disconnected" />
          <button type="submit" className="danger">Disconnect mailbox</button>
        </form>
      </div>
    </>
  );
}
