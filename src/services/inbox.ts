import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FirmSession } from "../db/tenant";
import { NotFoundError, PermissionDeniedError, UserFacingError } from "../errors";
import { sealCredential } from "../mail/credentials";
import { INTERNAL_ROLES } from "../security/permissions";
import { recordAudit } from "./audit";
import { SharingAcknowledgementRequired } from "./evidence";

/**
 * Huis Inbox: connected mailboxes and their mail.
 *
 * Unfiled mail is private to the mailbox's owner and the delegates the owner
 * chooses — the database enforces this, including against firm owners and
 * administrators. Filing copies the original message into a Matter.
 */

const uuid = z.uuid();
const staffOnly = (s: FirmSession) => {
  if (!INTERNAL_ROLES.has(s.actor.role)) throw new PermissionDeniedError("use the inbox");
};

export interface Mailbox {
  id: string; ownerUserId: string; mine: boolean; provider: string; accountAddress: string | null; displayName: string | null;
  scope: "all" | "selected"; syncSince: string | null; manage: boolean; status: string;
  lastSyncedAt: Date | null; lastError: string | null; messageCount: number; unfiledCount: number;
}

export async function listMailboxes(s: FirmSession): Promise<Mailbox[]> {
  staffOnly(s);
  const { rows } = await s.client.query(
    `SELECT c.id, c.owner_user_id, c.provider, c.account_address, c.display_name, c.scope, c.sync_since, c.manage, c.status,
            c.last_synced_at, c.last_error,
            (SELECT count(*)::int FROM huis.mail_messages m WHERE m.connection_id = c.id AND m.removed_at IS NULL) AS message_count,
            (SELECT count(*)::int FROM huis.mail_messages m WHERE m.connection_id = c.id AND m.removed_at IS NULL AND m.filed_matter_id IS NULL) AS unfiled_count
       FROM huis.mail_connections c WHERE c.status <> 'disconnected' ORDER BY c.created_at`);
  return rows.map((r) => ({
    id: r.id, ownerUserId: r.owner_user_id, mine: r.owner_user_id === s.actor.userId, provider: r.provider,
    accountAddress: r.account_address, displayName: r.display_name, scope: r.scope,
    syncSince: r.sync_since ? String(r.sync_since).slice(0, 10) : null, manage: r.manage, status: r.status,
    lastSyncedAt: r.last_synced_at, lastError: r.last_error, messageCount: r.message_count, unfiledCount: r.unfiled_count,
  }));
}

export async function getMailbox(s: FirmSession, id: string): Promise<Mailbox> {
  if (!uuid.safeParse(id).success) throw new NotFoundError("Mailbox");
  const m = (await listMailboxes(s)).find((x) => x.id === id);
  if (!m) throw new NotFoundError("Mailbox");
  return m;
}

/** Records a newly authorized mailbox (called from the connect callback). */
export async function connectMailbox(s: FirmSession, p: {
  provider: "microsoft"; subject: string; address: string | null; displayName: string; refreshToken: string; masterKey: string;
}): Promise<string> {
  staffOnly(s);
  if (s.actor.role === "read_only") throw new PermissionDeniedError("connect a mailbox");
  const sealed = sealCredential(p.masterKey, { firmId: s.actor.firmId, provider: p.provider, subject: p.subject }, p.refreshToken);
  const id = (await s.client.query<{ id: string | null }>("SELECT huis.connect_mailbox($1, $2, $3, $4, $5, $6) AS id",
    [p.provider, p.subject, p.address, p.displayName, sealed, randomUUID()])).rows[0]!.id;
  if (!id) throw new UserFacingError("This mailbox is already connected to Huis by someone else in your firm.");
  await recordAudit(s, "mailbox.connected", { targetType: "mailbox", targetId: id, metadata: { provider: p.provider } });
  return id;
}

export const mailboxSettingsInput = z.object({
  scope: z.enum(["all", "selected"]),
  syncSince: z.iso.date().nullish(),
  manage: z.boolean(),
  status: z.enum(["active", "paused", "disconnected"]),
});

export async function updateMailbox(s: FirmSession, id: string, input: unknown): Promise<void> {
  const m = await getMailbox(s, id);
  if (!m.mine) throw new PermissionDeniedError("change another person's mailbox");
  const v = mailboxSettingsInput.parse(input);
  const ok = (await s.client.query<{ ok: boolean }>("SELECT huis.update_mailbox($1, $2, $3, $4, $5) AS ok",
    [id, v.scope, v.syncSince ?? null, v.manage, v.status])).rows[0]!.ok;
  if (!ok) throw new NotFoundError("Mailbox");
  await recordAudit(s, v.status === "disconnected" ? "mailbox.disconnected" : "mailbox.updated", {
    targetType: "mailbox", targetId: id, metadata: { scope: v.scope, manage: v.manage, status: v.status },
  });
}

export interface MailFolder { id: string; path: string; included: boolean; total: number | null; lastSyncedAt: Date | null }

export async function listMailFolders(s: FirmSession, connectionId: string): Promise<MailFolder[]> {
  await getMailbox(s, connectionId);
  const { rows } = await s.client.query(
    "SELECT id, path, included, total_items, last_synced_at FROM huis.mail_folders WHERE connection_id = $1 ORDER BY path", [connectionId]);
  return rows.map((r) => ({ id: r.id, path: r.path, included: r.included, total: r.total_items, lastSyncedAt: r.last_synced_at }));
}

export async function setFolderIncluded(s: FirmSession, folderId: string, included: boolean): Promise<void> {
  if (!uuid.safeParse(folderId).success) throw new NotFoundError("Folder");
  const ok = (await s.client.query<{ ok: boolean }>("SELECT huis.set_mail_folder_included($1, $2) AS ok", [folderId, included])).rows[0]!.ok;
  if (!ok) throw new NotFoundError("Folder");
}

export async function setDelegate(s: FirmSession, connectionId: string, userId: string, granted: boolean): Promise<void> {
  const m = await getMailbox(s, connectionId);
  if (!m.mine) throw new PermissionDeniedError("change who can see another person's mailbox");
  if (!uuid.safeParse(userId).success) throw new NotFoundError("User");
  const ok = (await s.client.query<{ ok: boolean }>("SELECT huis.set_mail_delegate($1, $2, $3) AS ok", [connectionId, userId, granted])).rows[0]!.ok;
  if (!ok) throw new UserFacingError("That person can't be given access (only active firm staff who aren't read-only).");
  await recordAudit(s, granted ? "mailbox.delegate_added" : "mailbox.delegate_removed", { targetType: "mailbox", targetId: connectionId, metadata: { user: userId } });
}

export async function listDelegates(s: FirmSession, connectionId: string): Promise<{ userId: string; name: string }[]> {
  await getMailbox(s, connectionId);
  const { rows } = await s.client.query(
    `SELECT d.user_id, u.full_name FROM huis.mail_delegates d JOIN huis.users u ON u.id = d.user_id
      WHERE d.connection_id = $1 ORDER BY u.full_name`, [connectionId]);
  return rows.map((r) => ({ userId: r.user_id, name: r.full_name }));
}

export async function requestSync(s: FirmSession, connectionId: string): Promise<void> {
  await getMailbox(s, connectionId);
  await s.client.query("SELECT huis.request_mailbox_sync($1)", [connectionId]);
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
export interface MailMessage {
  id: string; connectionId: string; folderPath: string | null; subject: string | null; fromAddress: string | null; fromName: string | null;
  to: string[]; cc: string[]; receivedAt: Date | null; hasAttachments: boolean; preview: string | null; isRead: boolean | null;
  filedMatterId: string | null; filedMatterTitle: string | null; filedMatterColor: string | null; filedEvidenceId: string | null;
  pendingFiling: boolean; removed: boolean;
}

const MESSAGE_SELECT = `
  SELECT m.id, m.connection_id, f.path AS folder_path, m.subject, m.from_address, m.from_name, m.to_addresses, m.cc_addresses,
         m.received_at, m.has_attachments, m.preview, m.is_read, m.filed_matter_id, m.filed_evidence_id, m.removed_at,
         mt.title AS matter_title, mt.color AS matter_color,
         EXISTS (SELECT 1 FROM huis.mail_filings q WHERE q.message_id = m.id AND q.status IN ('queued', 'running')) AS pending
    FROM huis.mail_messages m
    LEFT JOIN huis.mail_folders f ON f.id = m.folder_id
    LEFT JOIN huis.matters mt ON mt.id = m.filed_matter_id`;

const toMessage = (r: Record<string, any>): MailMessage => ({
  id: r.id, connectionId: r.connection_id, folderPath: r.folder_path, subject: r.subject, fromAddress: r.from_address, fromName: r.from_name,
  to: r.to_addresses, cc: r.cc_addresses, receivedAt: r.received_at, hasAttachments: r.has_attachments, preview: r.preview, isRead: r.is_read,
  // A filed matter the viewer can't see (e.g. behind a wall) shows as filed, without its name.
  filedMatterId: r.filed_matter_id, filedMatterTitle: r.matter_title ?? null, filedMatterColor: r.matter_color ?? null,
  filedEvidenceId: r.filed_evidence_id, pendingFiling: r.pending, removed: r.removed_at !== null,
});

export const listMessagesInput = z.object({
  connectionId: z.uuid().optional(),
  q: z.string().trim().max(500).optional(),
  status: z.enum(["all", "unfiled", "filed"]).default("all"),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).max(100_000).default(0),
});

/** Inbox list and search (exact phrases in quotes, "or", -exclude). */
export async function listMessages(s: FirmSession, input: unknown): Promise<MailMessage[]> {
  staffOnly(s);
  const v = listMessagesInput.parse(input);
  const where: string[] = ["m.removed_at IS NULL"];
  const params: unknown[] = [];
  if (v.connectionId) { params.push(v.connectionId); where.push(`m.connection_id = $${params.length}`); }
  if (v.status === "unfiled") where.push("m.filed_matter_id IS NULL");
  if (v.status === "filed") where.push("m.filed_matter_id IS NOT NULL");
  let order = "m.received_at DESC NULLS LAST";
  if (v.q) {
    params.push(v.q);
    where.push(`m.tsv @@ websearch_to_tsquery('english', $${params.length})`);
    order = `ts_rank(m.tsv, websearch_to_tsquery('english', $${params.length})) DESC, m.received_at DESC`;
  }
  params.push(v.limit, v.offset);
  const { rows } = await s.client.query(
    `${MESSAGE_SELECT} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  // Recorded without the search text or results: the audit log is readable by
  // firm administrators, who must not learn what's in someone's mailbox.
  if (v.q) await recordAudit(s, "mailbox.searched", { targetType: "mailbox", targetId: v.connectionId });
  return rows.map(toMessage);
}

export async function getMessage(s: FirmSession, id: string): Promise<MailMessage & { body: string | null }> {
  staffOnly(s);
  if (!uuid.safeParse(id).success) throw new NotFoundError("Email");
  const { rows } = await s.client.query(`${MESSAGE_SELECT.replace("SELECT m.id,", "SELECT m.body_text, m.id,")} WHERE m.id = $1`, [id]);
  if (!rows[0]) throw new NotFoundError("Email");
  await recordAudit(s, "mailbox.message_viewed", { targetType: "mail_message", targetId: id });
  return { ...toMessage(rows[0]), body: rows[0].body_text };
}

export const fileMessageInput = z.object({
  matterId: z.uuid(),
  folderId: z.uuid(),
  acknowledgePrivilegeWaiverRisk: z.boolean().optional(),
});

const FILING_ERRORS: Record<string, string> = {
  removed: "This email was deleted from the mailbox and can no longer be filed.",
  already_filed: "This email is already filed in that Matter.",
};

export async function fileMessage(s: FirmSession, messageId: string, input: unknown): Promise<string> {
  staffOnly(s);
  if (!uuid.safeParse(messageId).success) throw new NotFoundError("Email");
  const v = fileMessageInput.parse(input);
  const r = (await s.client.query<{ r: string }>("SELECT huis.request_mail_filing($1, $2, $3, $4, 'manual') AS r",
    [messageId, v.matterId, v.folderId, Boolean(v.acknowledgePrivilegeWaiverRisk)])).rows[0]!.r;
  if (r === "folder_not_found") throw new NotFoundError("Folder");
  if (r === "acknowledgement_required") throw new SharingAcknowledgementRequired();
  if (FILING_ERRORS[r]) throw new UserFacingError(FILING_ERRORS[r]!);
  await recordAudit(s, "mailbox.filing_requested", { targetType: "mail_message", targetId: messageId, matterId: v.matterId, metadata: { folder: v.folderId } });
  return r;
}

/** Matter color for color-coded organization (matter owners and editors). */
export async function setMatterColor(s: FirmSession, matterId: string, color: string | null): Promise<void> {
  if (!uuid.safeParse(matterId).success) throw new NotFoundError("Matter");
  const c = z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().parse(color);
  const { rowCount } = await s.client.query("UPDATE huis.matters SET color = $2 WHERE id = $1", [matterId, c]);
  if (!rowCount) throw new PermissionDeniedError("change this Matter");
}
