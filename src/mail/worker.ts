import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import pg from "pg";
import { storageKeys, type EvidenceVault } from "../storage/store";
import { openCredential, sealCredential } from "./credentials";
import { MicrosoftMailProvider, refreshAccess } from "./microsoft";
import type { MailProvider } from "./provider";

/** Messages imported per mailbox per run, so one huge mailbox can't hog the worker. */
export const SYNC_BUDGET = 1000;
/** Largest message Huis files (Outlook's own limit is 150 MB). */
export const MAX_MIME_BYTES = 200 * 1024 * 1024;
const MAX_ATTEMPTS = 5;

export interface MailConfig {
  masterKey: string;
  microsoft: { clientId: string; clientSecret: string } | null;
  /** For tests: build the provider from an access token. */
  providerFor?: (provider: string, accessToken: string) => MailProvider;
}

interface Mailbox { connection_id: string; lock_token: string; firm_id: string; provider: string; account_subject: string; scope: string; sync_since: string | null; ciphertext: Buffer | null }
interface Filing { filing_id: string; lock_token: string; firm_id: string; matter_id: string; connection_id: string; provider: string; account_subject: string; provider_message_id: string; ciphertext: Buffer | null; attempts: number }

const errText = (e: unknown) => (e instanceof Error ? e.message : "mailbox error");
const needsReconnect = (e: unknown) => Boolean((e as { reconnect?: boolean })?.reconnect);

/**
 * Keeps connected mailboxes in sync and files emails into Matters.
 * Runs inside the worker, whose database role can only call worker_* functions.
 */
export class MailWorker {
  constructor(private readonly pool: pg.Pool, private readonly vault: EvidenceVault, private readonly cfg: MailConfig) {}

  /** Opens the mailbox: refreshes access and saves any rotated refresh token. */
  private async open(m: { firm_id: string; provider: string; account_subject: string; ciphertext: Buffer | null },
    saveRotated: (sealed: Buffer) => Promise<void>): Promise<MailProvider> {
    if (!m.ciphertext) throw Object.assign(new Error("mailbox credentials missing"), { reconnect: true });
    if (m.provider !== "microsoft") throw new Error(`${m.provider} mailboxes are not supported yet`);
    if (!this.cfg.microsoft) throw new Error("Microsoft is not configured");
    const id = { firmId: m.firm_id, provider: m.provider, subject: m.account_subject };
    const refreshToken = openCredential(this.cfg.masterKey, id, m.ciphertext);
    const access = await refreshAccess({ ...this.cfg.microsoft, refreshToken });
    if (access.refreshToken !== refreshToken) await saveRotated(sealCredential(this.cfg.masterKey, id, access.refreshToken));
    return this.cfg.providerFor ? this.cfg.providerFor(m.provider, access.accessToken) : new MicrosoftMailProvider(access.accessToken);
  }

  /** Syncs one due mailbox. Returns false when none is due. */
  async syncOnce(): Promise<boolean> {
    const m = (await this.pool.query<Mailbox>(
      "SELECT connection_id, lock_token, firm_id, provider, account_subject, scope, sync_since::text AS sync_since, ciphertext FROM huis.worker_claim_mailbox()")).rows[0];
    if (!m) return false;
    const args = [m.connection_id, m.lock_token];
    let more = false;
    try {
      const provider = await this.open(m, (sealed) =>
        this.pool.query("SELECT huis.worker_save_credentials($1, $2, $3)", [...args, sealed]).then(() => undefined));
      const since = m.sync_since ? Date.parse(`${m.sync_since}T00:00:00Z`) : null;
      if (since !== null && Number.isNaN(since)) throw new Error("invalid 'mail since' date");
      let budget = SYNC_BUDGET;
      for (const f of await provider.listFolders()) {
        const row = (await this.pool.query<{ folder_id: string; included: boolean; delta_link: string | null }>(
          "SELECT * FROM huis.worker_upsert_mail_folder($1, $2, $3, $4, $5, $6, $7, $8)",
          [...args, f.providerId, f.parentProviderId, f.name, f.path, null, f.total])).rows[0]!;
        if (!row.included) continue;
        if (budget <= 0) { more = true; continue; }
        let link = row.delta_link;
        for (;;) {
          const page = await provider.deltaPage(f.providerId, link);
          // Optional "only mail since" setting is applied here (Graph's own date filter caps results).
          const keep = page.messages.filter((x) => x.removed || since === null || !x.receivedAt || Date.parse(x.receivedAt) >= since);
          for (let i = 0; i < keep.length; i += 500) {
            await this.pool.query("SELECT huis.worker_save_mail_messages($1, $2, $3, $4)",
              [...args, row.folder_id, JSON.stringify(keep.slice(i, i + 500))]);
          }
          budget -= page.messages.length;
          link = page.nextLink ?? page.deltaLink ?? link;
          // Save where to resume after every page, so progress is never lost.
          await this.pool.query("SELECT huis.worker_save_mail_folder_state($1, $2, $3, $4)", [...args, row.folder_id, link]);
          if (!page.nextLink) break;
          if (budget <= 0) { more = true; break; }
        }
      }
      // Automatic filing (only acts when the firm and the mailbox owner have both turned it on).
      await this.pool.query("SELECT huis.worker_auto_file($1, $2)", args);
      await this.pool.query("SELECT huis.worker_finish_mailbox($1, $2, NULL, false, $3)", [...args, more]);
    } catch (err) {
      await this.pool.query("SELECT huis.worker_finish_mailbox($1, $2, $3, $4, false)", [...args, errText(err), needsReconnect(err)])
        .catch(() => undefined);
    }
    return true;
  }

  /** Files one requested email into its Matter. Returns false when none is waiting. */
  async fileOnce(): Promise<boolean> {
    const f = (await this.pool.query<Filing>("SELECT * FROM huis.worker_claim_mail_filing()")).rows[0];
    if (!f) return false;
    const evidenceId = randomUUID();
    const key = storageKeys.original(f.firm_id, f.matter_id, evidenceId);
    let stored = false;
    try {
      // Rotated tokens during filing are saved on the next sync (filing doesn't hold the mailbox).
      const provider = await this.open(f, async () => undefined);
      let size = 0;
      const cap = new Transform({
        transform(chunk: Buffer, _e, cb) {
          size += chunk.length;
          if (size > MAX_MIME_BYTES) cb(new Error("message too large to file"));
          else cb(null, chunk);
        },
      });
      const mime = await provider.fetchMime(f.provider_message_id);
      mime.on("error", (e) => cap.destroy(e));
      const put = await this.vault.put(f.firm_id, key, mime.pipe(cap));
      stored = true;
      if (put.size === 0) throw new Error("empty message");
      await this.pool.query("SELECT huis.worker_complete_mail_filing($1, $2, $3, $4, $5, $6)",
        [f.filing_id, f.lock_token, evidenceId, put.size, put.sha256, key]);
    } catch (err) {
      if (stored) await this.vault.delete(key).catch(() => undefined);
      await this.pool.query("SELECT huis.worker_fail_mail_filing($1, $2, $3, $4)",
        [f.filing_id, f.lock_token, errText(err), f.attempts >= MAX_ATTEMPTS || needsReconnect(err)]).catch(() => undefined);
    }
    return true;
  }
}
