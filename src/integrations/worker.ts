import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import pg from "pg";
import { openCredential, sealCredential } from "../mail/credentials";
import { refreshAccess } from "../mail/microsoft";
import { storageKeys, type EvidenceVault } from "../storage/store";
import { credentialId } from "./credentials";
import { dropboxAccountId, DropboxSource, refreshDropboxAccess } from "./dropbox";
import { googleAccountSub, GoogleDriveSource, refreshGoogleDriveAccess } from "./google-drive";
import { onedriveAccountOid, ONEDRIVE_SCOPES, OneDriveSource } from "./onedrive";
import type { FileSource } from "./types";

/** Largest file Huis imports from an outside system (matches the upload limit). */
export const MAX_IMPORT_BYTES = Number(process.env.HUIS_MAX_FILE_BYTES ?? 100 * 1024 ** 3);

export interface IntegrationConfig {
  masterKey: string;
  microsoft: { clientId: string; clientSecret: string } | null;
  dropbox?: { clientId: string; clientSecret: string } | null;
  /** The firm's Google app (the same one Gmail uses), for Google Drive. */
  google?: { clientId: string; clientSecret: string } | null;
  /** For tests: build the source from an access token. */
  sourceFor?: (provider: string, accessToken: string) => FileSource;
}

interface Held { firm_id: string; provider: string; account_subject: string; ciphertext: Buffer | null }
interface ListingJob extends Held { listing_id: string; lock_token: string; connection_id: string; location: string }
interface ImportJob extends Held {
  import_id: string; lock_token: string; matter_id: string; connection_id: string; external_id: string; external_name: string;
  /** The version the person saw in the listing when they chose the file (security review 22, R22-3). */
  expected_version: string | null;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : "integration error").slice(0, 300);
const flag = (e: unknown, k: "reconnect" | "final") => Boolean((e as Record<string, unknown> | null)?.[k]);

/**
 * Lists folders and imports files for connected outside systems. Runs inside
 * the worker, whose database role can only call worker_* functions.
 */
export class IntegrationWorker {
  constructor(private readonly pool: pg.Pool, private readonly vault: EvidenceVault, private readonly cfg: IntegrationConfig) {}

  private async open(h: Held, saveRotated: (sealed: Buffer) => Promise<void>): Promise<FileSource> {
    if (!h.ciphertext) throw Object.assign(new Error("reconnect the account"), { reconnect: true });
    const id = credentialId(h.firm_id, h.provider, h.account_subject);
    const refreshToken = openCredential(this.cfg.masterKey, id, h.ciphertext);
    let access: { accessToken: string; refreshToken: string };
    if (h.provider === "onedrive") {
      if (!this.cfg.microsoft) throw new Error("Microsoft is not configured");
      access = await refreshAccess({ ...this.cfg.microsoft, refreshToken, scopes: ONEDRIVE_SCOPES });
    } else if (h.provider === "dropbox") {
      if (!this.cfg.dropbox) throw new Error("Dropbox is not configured");
      access = await refreshDropboxAccess({ ...this.cfg.dropbox, refreshToken });
    } else if (h.provider === "google_drive") {
      if (!this.cfg.google) throw new Error("Google is not configured");
      access = await refreshGoogleDriveAccess({ ...this.cfg.google, refreshToken });
    } else {
      throw Object.assign(new Error("this system isn't connected yet"), { final: true });
    }
    // Security review 20, R20-1: the token must belong to the account this connection was recorded for, so
    // nobody can file their own (working) token under a colleague's account id and lock them out.
    const owner = h.provider === "dropbox" ? await dropboxAccountId(access.accessToken)
      : h.provider === "google_drive" ? await googleAccountSub(access.accessToken)
      : await onedriveAccountOid(access.accessToken);
    const expected = h.provider === "onedrive" ? (h.account_subject.split(":")[1] ?? "").toLowerCase() : h.account_subject;
    if (!owner || owner !== expected) throw Object.assign(new Error("this sign-in belongs to a different account; reconnect"), { reconnect: true });
    if (access.refreshToken !== refreshToken) await saveRotated(sealCredential(this.cfg.masterKey, id, access.refreshToken));
    if (this.cfg.sourceFor) return this.cfg.sourceFor(h.provider, access.accessToken);
    if (h.provider === "dropbox") return new DropboxSource(access.accessToken);
    if (h.provider === "google_drive") return new GoogleDriveSource(access.accessToken);
    return new OneDriveSource(access.accessToken);
  }

  /** Lists one requested folder. Returns false when none is waiting. */
  async listOnce(): Promise<boolean> {
    const j = (await this.pool.query<ListingJob>("SELECT * FROM huis.worker_claim_integration_listing()")).rows[0];
    if (!j) return false;
    const save = (title: string | null, parent: string | null, items: unknown, truncated: boolean, error: string | null, reconnect: boolean) =>
      this.pool.query("SELECT huis.worker_save_integration_listing($1, $2, $3, $4, $5, $6, $7, $8)",
        [j.listing_id, j.lock_token, title, parent, JSON.stringify(items), truncated, error, reconnect]);
    try {
      const source = await this.open(j, (sealed) =>
        this.pool.query("SELECT huis.worker_save_integration_credentials('listing', $1, $2, $3)", [j.listing_id, j.lock_token, sealed]).then(() => undefined));
      const l = await source.list(j.location);
      await save(l.title, l.parent, l.items, l.truncated, null, false);
    } catch (err) {
      await save(null, null, [], false, errText(err), flag(err, "reconnect")).catch(() => undefined);
    }
    return true;
  }

  /** Imports one requested file into its Matter. Returns false when none is waiting. */
  async importOnce(): Promise<boolean> {
    const f = (await this.pool.query<ImportJob>("SELECT * FROM huis.worker_claim_integration_import()")).rows[0];
    if (!f) return false;
    const evidenceId = randomUUID();
    const key = storageKeys.original(f.firm_id, f.matter_id, evidenceId);
    let stored = false;
    try {
      const source = await this.open(f, (sealed) =>
        this.pool.query("SELECT huis.worker_save_integration_credentials('import', $1, $2, $3)", [f.import_id, f.lock_token, sealed]).then(() => undefined));
      const file = await source.describe(f.external_id);
      // Security review 22, R22-3: import the version the person chose, never a newer one they haven't seen.
      if (f.expected_version !== null && file.version !== f.expected_version) {
        throw Object.assign(new Error("the file changed after it was chosen; open the folder again and choose it again"), { final: true });
      }
      if (file.size !== null && file.size > MAX_IMPORT_BYTES) throw Object.assign(new Error("the file is too large to import"), { final: true });
      let size = 0;
      const cap = new Transform({
        transform(chunk: Buffer, _e, cb) {
          size += chunk.length;
          if (size > MAX_IMPORT_BYTES) cb(Object.assign(new Error("the file is too large to import"), { final: true }));
          else cb(null, chunk);
        },
      });
      const body = await source.download(f.external_id, file.version);
      body.on("error", (e) => cap.destroy(e));
      const put = await this.vault.put(f.firm_id, key, body.pipe(cap));
      stored = true;
      // Security review 19, R19-3: the version recorded must be the version copied. A file saved again while
      // it was being copied (a new size or version afterwards) is tried again, so the record and the bytes match.
      const after = await source.describe(f.external_id);
      if ((file.size !== null && put.size !== file.size) || after.version !== file.version || after.size !== file.size) {
        throw new Error("the file changed while it was being copied");
      }
      const result = (await this.pool.query<{ r: string }>(
        "SELECT huis.worker_complete_integration_import($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) AS r",
        [f.import_id, f.lock_token, evidenceId, put.size, put.sha256, key, file.version, file.modified, file.mime, file.path])).rows[0]?.r;
      // Not recorded (a duplicate, or the requester lost access): remove the stored copy.
      if (result !== "done") await this.vault.delete(key).catch(() => undefined);
    } catch (err) {
      if (stored) await this.vault.delete(key).catch(() => undefined);
      await this.pool.query("SELECT huis.worker_fail_integration_import($1, $2, $3, $4, $5)",
        [f.import_id, f.lock_token, errText(err), flag(err, "final"), flag(err, "reconnect")]).catch(() => undefined);
    }
    return true;
  }

  async runOnce(): Promise<boolean> {
    return (await this.listOnce()) || (await this.importOnce());
  }
}

