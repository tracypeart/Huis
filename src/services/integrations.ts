import { z } from "zod";
import type { FirmSession } from "../db/tenant";
import { NotFoundError, PermissionDeniedError, UserFacingError } from "../errors";
import { sealCredential } from "../mail/credentials";
import { INTEGRATIONS, type IntegrationInfo } from "../integrations/registry";
import { credentialId } from "../integrations/credentials";
import type { ListedItem } from "../integrations/types";
import { INTERNAL_ROLES } from "../security/permissions";
import { recordAudit } from "./audit";
import { SharingAcknowledgementRequired } from "./evidence";

/**
 * Integration Hub (Phase 9): connections to outside systems, browsing them and
 * importing from them into Matters.
 *
 * A connection is private to the person who made it (their own OneDrive):
 * nobody else at the firm can browse it, administrators included. The
 * database enforces this, and the sign-in token is sealed so only the worker
 * can use it.
 */

const uuid = z.uuid();
const staffOnly = (s: FirmSession, what: string) => {
  if (!INTERNAL_ROLES.has(s.actor.role)) throw new PermissionDeniedError(what);
};

export interface IntegrationConnection {
  id: string; provider: string; accountLabel: string | null; tenant: string | null; status: string; lastError: string | null; createdAt: Date;
}

export interface HubEntry extends IntegrationInfo { connections: IntegrationConnection[] }

export async function listMyConnections(s: FirmSession): Promise<IntegrationConnection[]> {
  staffOnly(s, "use integrations");
  const { rows } = await s.client.query(
    `SELECT id, provider, account_label, external_tenant, status, last_error, created_at FROM huis.integration_connections
      WHERE status <> 'disconnected' ORDER BY created_at`);
  return rows.map((r) => ({ id: r.id, provider: r.provider, accountLabel: r.account_label, tenant: r.external_tenant,
    status: r.status, lastError: r.last_error, createdAt: r.created_at }));
}

/** Every system the hub knows about, with this person's own connections. */
export async function integrationHub(s: FirmSession): Promise<HubEntry[]> {
  const mine = await listMyConnections(s);
  return INTEGRATIONS.map((i) => ({ ...i, connections: mine.filter((c) => c.provider === i.provider) }));
}

export async function getConnection(s: FirmSession, id: string): Promise<IntegrationConnection> {
  if (!uuid.safeParse(id).success) throw new NotFoundError("Connection");
  const c = (await listMyConnections(s)).find((x) => x.id === id);
  if (!c) throw new NotFoundError("Connection");
  return c;
}

/** Records a newly authorized account (called from the connect callback). */
export async function connectIntegration(s: FirmSession, p: {
  provider: "onedrive" | "dropbox" | "google_drive"; subject: string; tenant: string | null; label: string | null; refreshToken: string; masterKey: string;
}): Promise<string> {
  staffOnly(s, "connect an outside system");
  if (s.actor.role === "read_only") throw new PermissionDeniedError("connect an outside system");
  const sealed = sealCredential(p.masterKey, credentialId(s.actor.firmId, p.provider, p.subject), p.refreshToken);
  const id = (await s.client.query<{ id: string | null }>("SELECT huis.connect_integration($1, $2, $3, $4, $5) AS id",
    [p.provider, p.subject, p.tenant, p.label, sealed])).rows[0]!.id;
  if (!id) throw new UserFacingError("This account is already connected to Huis by someone else in your firm.");
  await recordAudit(s, "integration.connected", { targetType: "integration", targetId: id, metadata: { provider: p.provider } });
  return id;
}

export async function disconnectIntegration(s: FirmSession, id: string): Promise<void> {
  const c = await getConnection(s, id);
  await s.client.query("SELECT huis.disconnect_integration($1)", [c.id]);
  await recordAudit(s, "integration.disconnected", { targetType: "integration", targetId: c.id, metadata: { provider: c.provider } });
}

// ---------------------------------------------------------------------------
// Browsing
// ---------------------------------------------------------------------------
const LOCATION_SHAPE = /^(root|sites|picked|site:[A-Za-z0-9,._-]{1,300}|drive:[A-Za-z0-9!._-]{1,200}:[A-Za-z0-9!._-]{1,200}|dbx:id:[A-Za-z0-9_-]{1,200}|gdrive:[A-Za-z0-9_-]{10,200})$/;
/** What a file id starts with, per system. */
const FILE_ID_PREFIX: Record<string, string> = { onedrive: "drive:", dropbox: "dbx:", google_drive: "gdrive:" };
/** Systems whose files are chosen in the system's own picker rather than browsed (Google Drive, drive.file). */
export const PICKER_PROVIDERS = new Set(["google_drive"]);
/** A folder or file id of the provider's shape, with no "." or ".." part (which would become other Graph paths). */
export const LOCATION = { test: (v: string) => LOCATION_SHAPE.test(v) && !v.split(/[:,]/).some((p) => /^\.+$/.test(p)) };
/** A listing older than this is fetched again when the folder is opened. */
const STALE_MS = 5 * 60 * 1000;

export interface FolderListing {
  location: string; status: "queued" | "running" | "ready" | "failed"; title: string | null; parent: string | null;
  items: ListedItem[]; truncated: boolean; error: string | null; fetchedAt: Date;
}

async function readListing(s: FirmSession, connectionId: string, location: string): Promise<FolderListing | null> {
  const r = (await s.client.query(
    `SELECT location, status, title, parent, items, truncated, last_error, requested_at FROM huis.integration_listings
      WHERE connection_id = $1 AND location = $2`, [connectionId, location])).rows[0];
  if (!r) return null;
  return { location: r.location, status: r.status, title: r.title, parent: r.parent, items: r.items ?? [], truncated: r.truncated,
    error: r.last_error, fetchedAt: r.requested_at };
}

/** A folder in the person's own connection. Asks the worker to fetch it when it isn't held or is stale. */
export async function browse(s: FirmSession, connectionId: string, location = "root", refresh = false): Promise<FolderListing> {
  const c = await getConnection(s, connectionId);
  if (!LOCATION.test(location)) throw new NotFoundError("Folder");
  if (PICKER_PROVIDERS.has(c.provider)) {
    // Nothing to browse: the files the person last chose in the picker (checked by the worker).
    if (location !== "picked") throw new NotFoundError("Folder");
    return (await readListing(s, c.id, "picked"))
      ?? { location: "picked", status: "ready", title: null, parent: null, items: [], truncated: false, error: null, fetchedAt: new Date() };
  }
  if (location === "picked") throw new NotFoundError("Folder");
  let l = await readListing(s, c.id, location);
  const age = l ? Date.now() - l.fetchedAt.getTime() : 0;
  const stale = l && l.status === "ready" && age > STALE_MS;
  // A failed folder is asked for again after a minute (not on every page refresh), or when the person asks.
  const retry = l && l.status === "failed" && age > 60_000;
  if (!l || refresh || stale || retry) {
    if (s.actor.role === "read_only") throw new PermissionDeniedError("browse an outside system");
    await s.client.query("SELECT huis.request_integration_listing($1, $2)", [c.id, location]);
    l = (await readListing(s, c.id, location))!;
  }
  return l;
}

/** Google Drive file ids as the picker returns them. */
const PICKED = z.array(z.string().regex(/^[A-Za-z0-9_-]{10,200}$/)).min(1).max(200);

/**
 * Records the files the person chose in Google's picker. The worker checks each one with the connection's own
 * sign-in and lists only files that account can open; nothing is copied until the person imports.
 */
export async function pickFiles(s: FirmSession, connectionId: string, files: unknown): Promise<number> {
  const c = await getConnection(s, connectionId);
  if (!PICKER_PROVIDERS.has(c.provider)) throw new NotFoundError("Connection");
  if (s.actor.role === "read_only") throw new PermissionDeniedError("choose files from an outside system");
  const parsed = PICKED.safeParse(files);
  if (!parsed.success) throw new UserFacingError("Choose between 1 and 200 files.");
  const ids = [...new Set(parsed.data)];
  await s.client.query("SELECT huis.request_integration_picked($1, $2)", [c.id, ids]);
  await recordAudit(s, "integration.files_chosen", { targetType: "integration", targetId: c.id, metadata: { provider: c.provider, files: ids.length } });
  return ids.length;
}

// ---------------------------------------------------------------------------
// Importing
// ---------------------------------------------------------------------------
export const importInput = z.object({
  matterId: z.uuid(),
  folderId: z.uuid(),
  items: z.array(z.string().max(400)).min(1).max(200),
  acknowledgePrivilegeWaiverRisk: z.boolean().optional(),
});

/** Asks the worker to copy chosen files into a Matter as evidence. */
export async function importFiles(s: FirmSession, connectionId: string, input: unknown): Promise<{ queued: number; already: number }> {
  const c = await getConnection(s, connectionId);
  const v = importInput.parse(input);
  const items = [...new Set(v.items)];
  const prefix = FILE_ID_PREFIX[c.provider];
  if (!prefix || items.some((i) => !LOCATION.test(i) || !i.startsWith(prefix))) throw new UserFacingError("Choose files from the list.");
  let r: { queued?: number; already?: number; error?: string };
  try {
    r = (await s.client.query<{ r: typeof r }>("SELECT huis.request_integration_import($1, $2, $3, $4, $5) AS r",
      [c.id, v.matterId, v.folderId, items, Boolean(v.acknowledgePrivilegeWaiverRisk)])).rows[0]!.r;
  } catch (err) {
    if ((err as { message?: string }).message === "that file was not listed") throw new UserFacingError("Choose files from the list.");
    throw err;
  }
  if (r.error === "folder_not_found") throw new NotFoundError("Folder");
  if (r.error === "acknowledgement_required") throw new SharingAcknowledgementRequired();
  await recordAudit(s, "integration.import_requested", {
    targetType: "integration", targetId: c.id, matterId: v.matterId,
    metadata: { provider: c.provider, folder: v.folderId, files: items.length, queued: r.queued ?? 0 },
  });
  return { queued: r.queued ?? 0, already: r.already ?? 0 };
}

export interface ImportRequest {
  id: string; matterId: string; matterTitle: string | null; name: string; status: string; error: string | null; evidenceId: string | null;
  requestedAt: Date; completedAt: Date | null;
}

/** This person's recent import requests for a connection. */
export async function listImports(s: FirmSession, connectionId: string, limit = 50): Promise<ImportRequest[]> {
  const c = await getConnection(s, connectionId);
  const { rows } = await s.client.query(
    `SELECT i.id, i.matter_id, m.title, i.external_name, i.status, i.last_error, i.evidence_id, i.requested_at, i.completed_at
       FROM huis.integration_imports i LEFT JOIN huis.matters m ON m.id = i.matter_id
      WHERE i.connection_id = $1 ORDER BY i.requested_at DESC LIMIT $2`, [c.id, Math.min(Math.max(limit, 1), 200)]);
  return rows.map((r) => ({ id: r.id, matterId: r.matter_id, matterTitle: r.title, name: r.external_name, status: r.status,
    error: r.last_error, evidenceId: r.evidence_id, requestedAt: r.requested_at, completedAt: r.completed_at }));
}

export interface SyncRecord {
  id: string; system: string; externalId: string; version: string | null; internalType: string; internalId: string;
  direction: string; status: string; lastSyncedAt: Date;
}

/** What in a Matter came from (or went to) outside systems. */
export async function matterSyncRecords(s: FirmSession, matterId: string): Promise<SyncRecord[]> {
  staffOnly(s, "see integration records");
  if (!uuid.safeParse(matterId).success) throw new NotFoundError("Matter");
  const { rows } = await s.client.query(
    `SELECT id, external_system, external_record_id, external_version, internal_type, internal_id, sync_direction, sync_status, last_synced_at
       FROM huis.sync_records WHERE matter_id = $1 ORDER BY last_synced_at DESC LIMIT 500`, [matterId]);
  return rows.map((r) => ({ id: r.id, system: r.external_system, externalId: r.external_record_id, version: r.external_version,
    internalType: r.internal_type, internalId: r.internal_id, direction: r.sync_direction, status: r.sync_status, lastSyncedAt: r.last_synced_at }));
}
