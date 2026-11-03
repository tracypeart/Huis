import { notFound } from "next/navigation";
import { addMatterMemberAction, linkContactAction, matterColorAction, setCourtCaseNumberAction } from "../../../../lib/actions";
import { getFlash, withSession } from "../../../../lib/server";
import { CLASSIFICATION_LABELS, CONTACT_LABELS, date, FlashBanner, ROLE_LABELS } from "../../../../lib/ui";
import { NotFoundError } from "../../../../src/errors";
import { listContacts } from "../../../../src/services/contacts";
import { getMatter, listMatterFolders } from "../../../../src/services/matters";
import { listUsers } from "../../../../src/services/users";
import { listEvidence } from "../../../../src/services/evidence";
import Link from "next/link";
import EvidenceUploader from "./uploader";
import { EvidenceStatus, formatBytes } from "../../../../lib/ui";
import { can, INTERNAL_ROLES, type Role } from "../../../../src/security/permissions";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function MatterOverview({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ f?: string }>;
}) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const flash = await getFlash((await searchParams).f);

  const data = await withSession(async (s) => {
    let matter;
    try {
      matter = await getMatter(s, id);
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
    const internal = INTERNAL_ROLES.has(s.actor.role);
    // One database connection per request: run queries one after another.
    const folders = await listMatterFolders(s, id);
    const members = await s.client.query<{ user_id: string; full_name: string; role: Role; access: string }>(
      `SELECT mm.user_id, u.full_name, u.role, mm.access FROM huis.matter_members mm
         JOIN huis.users u ON u.id = mm.user_id WHERE mm.matter_id = $1 ORDER BY u.full_name`, [id]);
    const linked = internal ? await s.client.query<{ id: string; full_name: string; kind: string; role_label: string | null }>(
      `SELECT c.id, c.full_name, c.kind, mc.role_label FROM huis.matter_contacts mc
         JOIN huis.contacts c ON c.id = mc.contact_id WHERE mc.matter_id = $1 ORDER BY c.full_name`, [id]) : null;
    const myAccess = members.rows.find((m) => m.user_id === s.actor.userId)?.access;
    const canManage = myAccess === "owner" || (!matter.restricted && can(s.actor.role, "matters.manage_members"));
    const canEdit = myAccess === "owner" || myAccess === "edit" || (!matter.restricted && can(s.actor.role, "firm.manage"));
    const lead = (await s.client.query<{ full_name: string }>("SELECT full_name FROM huis.users WHERE id = $1", [matter.leadAttorneyId])).rows[0];
    const client = internal
      ? (await s.client.query<{ display_name: string }>("SELECT display_name FROM huis.clients WHERE id = $1", [matter.clientId])).rows[0]
      : undefined;
    return {
      matter, folders, internal, canManage, canEdit,
      members: members.rows, contacts: linked?.rows ?? [],
      leadName: lead?.full_name ?? "—", clientName: client?.display_name,
      people: canManage ? (await listUsers(s)).filter((u) => u.status === "active") : [],
      allContacts: internal && can(s.actor.role, "contacts.view") ? await listContacts(s) : [],
      evidence: await listEvidence(s, id),
      canUpload: s.actor.role !== "read_only" && (internal || s.actor.role === "client"),
      isClient: s.actor.role === "client",
    };
  });
  if (!data) notFound();
  const { matter: m } = data;
  const memberIds = new Set(data.members.map((x) => x.user_id));

  return (
    <>
      <h1>{m.title}</h1>
      <p className="sub">
        {m.huisNumber} {m.restricted ? <span className="badge walled">Ethical wall — members only</span> : null}
      </p>
      <FlashBanner flash={flash} />

      <div className="grid">
        <div className="card">
          <h2>Overview</h2>
          <table><tbody>
            {data.clientName ? <tr><th>Client</th><td>{data.clientName}</td></tr> : null}
            <tr><th>Lead attorney</th><td>{data.leadName}</td></tr>
            <tr><th>Huis number</th><td>{m.huisNumber}</td></tr>
            <tr><th>Court case number</th><td>{m.courtCaseNumber ?? "Not yet assigned"}</td></tr>
            <tr><th>Firm number</th><td>{m.firmMatterNumber ?? "—"}</td></tr>
            <tr><th>Court</th><td>{m.courtName ?? "—"} ({m.jurisdictionState})</td></tr>
            <tr><th>Practice area</th><td>{m.practiceArea ?? "—"}</td></tr>
            <tr><th>Status</th><td><span className="badge">{m.status}</span></td></tr>
            <tr><th>Opened</th><td>{date(m.openedAt)}</td></tr>
          </tbody></table>
          {data.canEdit ? (
            <form action={setCourtCaseNumberAction} className="row" style={{ marginTop: 12 }}>
              <input type="hidden" name="matterId" value={m.id} />
              <label>Court case number<input name="courtCaseNumber" defaultValue={m.courtCaseNumber ?? ""} maxLength={100} /></label>
              <button type="submit" className="secondary">Save</button>
            </form>
          ) : null}
          {data.canEdit ? (
            <form action={matterColorAction} className="row" style={{ marginTop: 12 }}>
              <input type="hidden" name="matterId" value={m.id} />
              <label>Color (inbox and lists)<input type="color" name="color" defaultValue={m.color ?? "#2563eb"} /></label>
              <button type="submit" className="secondary">Save color</button>
            </form>
          ) : null}
        </div>

        <div className="card">
          <h2>Folders</h2>
          {data.folders.map((f) => (
            <div key={f.id} className={`folder${f.isPrivilegedArea ? " privileged" : ""}`}>
              <span aria-hidden="true">{f.isPrivilegedArea ? "🔴" : "📁"}</span>
              <span style={{ flex: 1 }}>{f.name}</span>
              <span className={`badge${f.isPrivilegedArea ? " privileged" : ""}`}>{CLASSIFICATION_LABELS[f.classification] ?? f.classification}</span>
            </div>
          ))}
          {data.internal ? (
            <p className="notice">
              Placing material in the red area records an attorney&apos;s designation of it as potentially privileged or
              confidential. It does not by itself create legal privilege — the attorney determines privilege status.
            </p>
          ) : null}
        </div>
      </div>

      <div className="card">
        <h2>Evidence &amp; documents</h2>
        {data.canUpload ? (() => {
          const uploadable = data.isClient ? data.folders.filter((f) => f.classification === "client_accessible" && !f.isPrivilegedArea) : data.folders;
          const preferred = uploadable.find((f) => f.name === (data.isClient ? "Client Uploads" : "Evidence")) ?? uploadable[0];
          return preferred ? (
            <EvidenceUploader matterId={m.id} isClient={data.isClient} defaultFolderId={preferred.id}
              folders={uploadable.map((f) => ({ id: f.id, name: f.name, isPrivilegedArea: f.isPrivilegedArea }))} />
          ) : null;
        })() : null}
        {data.evidence.length === 0 ? <p className="notice" style={{ marginTop: 12 }}>Nothing uploaded yet.</p> : (<>
          <form className="row" method="get" action="/search" style={{ marginTop: 16 }}>
            <input type="hidden" name="matter" value={m.id} />
            <input name="q" placeholder="Search inside this matter's documents and emails" style={{ flex: 1, minWidth: 240 }} />
            <button type="submit" className="secondary">Search</button>
          </form>
          <table style={{ marginTop: 16 }}>
            <thead><tr><th>File</th><th>Folder</th><th>Size</th><th>Security</th><th>Received from</th><th>Uploaded</th></tr></thead>
            <tbody>
              {data.evidence.filter((e) => !e.parentId).map((e) => (
                <tr key={e.id}>
                  <td style={{ wordBreak: "break-word" }}>
                    <Link href={`/evidence/${e.id}`}>{e.originalFilename}</Link>
                    {e.relativePath ? <div className="notice">{e.relativePath}</div> : null}
                    {e.childCount ? <div className="notice">+ {e.childCount} item(s) inside</div> : null}
                    {e.duplicateOf ? <div><span className="badge">Duplicate</span></div> : null}
                  </td>
                  <td>{e.folderIsPrivileged ? <span className="badge privileged">{e.folderName}</span> : e.folderName}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{formatBytes(e.sizeBytes)}</td>
                  <td><EvidenceStatus status={e.status} /></td>
                  <td>{e.receivedFrom ?? "—"}</td>
                  <td>{date(e.uploadedAt)}<div className="notice">{e.uploadedByName}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>)}
      </div>

      <div className="card">
        <h2>Who can access this matter</h2>
        <table>
          <thead><tr><th>Name</th><th>Role</th><th>Matter access</th></tr></thead>
          <tbody>
            {data.members.map((x) => (
              <tr key={x.user_id}>
                <td>{x.full_name}</td>
                <td>{ROLE_LABELS[x.role]} {INTERNAL_ROLES.has(x.role) ? null : <span className="badge privileged">Outside the firm</span>}</td>
                <td>{x.access}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!m.restricted && data.internal ? (
          <p className="notice">All active firm staff can also see this matter. Mark a matter as an ethical wall to limit it to members.</p>
        ) : null}
        {data.canManage ? (
          <form action={addMatterMemberAction} className="stack" style={{ marginTop: 16 }}>
            <input type="hidden" name="matterId" value={m.id} />
            <div className="row">
              <label>Person
                <select name="userId" required>
                  {data.people.filter((p) => !memberIds.has(p.id)).map((p) => (
                    <option key={p.id} value={p.id}>{p.fullName} — {ROLE_LABELS[p.role]}</option>
                  ))}
                </select>
              </label>
              <label>Access
                <select name="access" defaultValue="view">
                  <option value="view">View</option><option value="edit">Edit</option><option value="owner">Owner</option>
                </select>
              </label>
            </div>
            <label className="check">
              <input type="checkbox" name="acknowledge" />
              <span>
                <strong>Required for clients, co-counsel, experts and other people outside the firm:</strong> I understand that sharing
                privileged communications with third parties can waive privilege, and I have reviewed what this person will be able to see.
                People outside the firm get view-only access and never see the red privileged area.
              </span>
            </label>
            <div><button type="submit">Grant access</button></div>
          </form>
        ) : null}
      </div>

      {data.internal ? (
        <div className="card">
          <h2>People on this matter</h2>
          {data.contacts.length === 0 ? <p className="notice">No judges, opposing counsel, witnesses or experts linked yet.</p> : (
            <table>
              <thead><tr><th>Name</th><th>Type</th><th>Role in matter</th></tr></thead>
              <tbody>{data.contacts.map((c) => (
                <tr key={c.id}><td>{c.full_name}</td><td>{CONTACT_LABELS[c.kind] ?? c.kind}</td><td>{c.role_label ?? "—"}</td></tr>
              ))}</tbody>
            </table>
          )}
          {data.allContacts.length > 0 ? (
            <form action={linkContactAction} className="row" style={{ marginTop: 12 }}>
              <input type="hidden" name="matterId" value={m.id} />
              <label>Contact
                <select name="contactId">{data.allContacts.map((c) => (
                  <option key={c.id} value={c.id}>{c.fullName} — {CONTACT_LABELS[c.kind]}</option>
                ))}</select>
              </label>
              <label>Role in matter<input name="roleLabel" maxLength={100} placeholder="e.g. Presiding judge" /></label>
              <button type="submit" className="secondary">Link</button>
            </form>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
