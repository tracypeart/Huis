import { createHash, randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import pg from "pg";
import { storageKeys, type EvidenceVault } from "../storage/store";
import { openCredential, sealCredential } from "./credentials";
import { GmailMailProvider, GMAIL_NO_LABEL, refreshGoogleAccess } from "./google";
import { MicrosoftMailProvider, refreshAccess } from "./microsoft";
import type { MailFolderInfo, MailMessageInfo, MailProvider } from "./provider";

/** Messages imported per mailbox per run, so one huge mailbox can't hog the worker. */
export const SYNC_BUDGET = 1000;
/** Largest message Huis files (Outlook's own limit is 150 MB). */
export const MAX_MIME_BYTES = 200 * 1024 * 1024;
const MAX_ATTEMPTS = 5;

export interface MailConfig {
  masterKey: string;
  microsoft: { clientId: string; clientSecret: string } | null;
  google?: { clientId: string; clientSecret: string } | null;
  /** For tests: build the provider from an access token. */
  providerFor?: (provider: string, accessToken: string) => MailProvider;
}

interface Mailbox { connection_id: string; lock_token: string; firm_id: string; provider: string; account_subject: string; scope: string; sync_since: string | null; ciphertext: Buffer | null }
interface Filing { filing_id: string; lock_token: string; firm_id: string; matter_id: string; connection_id: string; provider: string; account_subject: string; provider_message_id: string; ciphertext: Buffer | null; attempts: number }

/** With a "mail since" date set, mail older than it (or with no date at all) stays out of Huis. */
function beforeCutoff(m: { receivedAt: string | null; sentAt: string | null }, since: number | null): boolean {
  if (since === null) return false;
  const when = Date.parse(m.receivedAt ?? m.sentAt ?? "");
  return Number.isNaN(when) || when < since;
}

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
    const id = { firmId: m.firm_id, provider: m.provider, subject: m.account_subject };
    let access: { accessToken: string; refreshToken: string };
    let refreshToken: string;
    if (m.provider === "microsoft") {
      if (!this.cfg.microsoft) throw new Error("Microsoft is not configured");
      refreshToken = openCredential(this.cfg.masterKey, id, m.ciphertext);
      access = await refreshAccess({ ...this.cfg.microsoft, refreshToken });
    } else if (m.provider === "google") {
      if (!this.cfg.google) throw new Error("Google is not configured");
      refreshToken = openCredential(this.cfg.masterKey, id, m.ciphertext);
      access = await refreshGoogleAccess({ ...this.cfg.google, refreshToken });
    } else {
      throw new Error("unsupported mailbox provider");
    }
    if (access.refreshToken !== refreshToken) await saveRotated(sealCredential(this.cfg.masterKey, id, access.refreshToken));
    if (this.cfg.providerFor) return this.cfg.providerFor(m.provider, access.accessToken);
    return m.provider === "google" ? new GmailMailProvider(access.accessToken) : new MicrosoftMailProvider(access.accessToken);
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
      if (provider.mailboxPage) {
        more = await this.syncMailbox(provider, args, since, m.scope);
        await this.pool.query("SELECT huis.worker_auto_file($1, $2)", args);
        await this.pool.query("SELECT huis.worker_finish_mailbox($1, $2, NULL, false, $3)", [...args, more]);
        return true;
      }
      for (const f of await provider.listFolders()) {
        const row = (await this.pool.query<{ folder_id: string; included: boolean; delta_link: string | null }>(
          "SELECT * FROM huis.worker_upsert_mail_folder($1, $2, $3, $4, $5, $6, $7, $8)",
          [...args, f.providerId, f.parentProviderId, f.name, f.path, null, f.total])).rows[0]!;
        if (!row.included) continue;
        if (budget <= 0) { more = true; continue; }
        let link = row.delta_link;
        const seen = new Set<string>();
        let emptyInARow = 0;
        for (;;) {
          const page = await provider.deltaPage(f.providerId, link);
          // Optional "only mail since" setting is applied here (Graph's own date filter caps results).
          const keep = page.messages.filter((x) => x.removed || !beforeCutoff(x, since));
          for (let i = 0; i < keep.length; i += 500) {
            await this.pool.query("SELECT huis.worker_save_mail_messages($1, $2, $3, $4)",
              [...args, row.folder_id, JSON.stringify(keep.slice(i, i + 500))]);
          }
          // Every page costs at least 1, so empty pages can't loop forever.
          budget -= Math.max(1, page.messages.length);
          if (page.nextLink && seen.has(page.nextLink)) throw new Error("mail sync did not move forward");
          // Microsoft occasionally sends an empty page; a long run of them means something is wrong.
          emptyInARow = page.messages.length === 0 && page.nextLink ? emptyInARow + 1 : 0;
          if (emptyInARow > 20) throw new Error("mail service kept returning empty pages");
          if (page.nextLink) seen.add(page.nextLink);
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

  /**
   * Whole-mailbox sync (Gmail). Labels are folders; each message goes under
   * the first chosen label in the provider's order, and a message with no
   * chosen label is treated as not in Huis (removed). The position is kept on
   * the "No label" folder together with a fingerprint of the chosen labels,
   * so choosing different labels starts a fresh import.
   */
  private async syncMailbox(provider: MailProvider, args: string[], since: number | null, scope: string): Promise<boolean> {
    const folders: MailFolderInfo[] = await provider.listFolders();
    const rows = new Map<string, { folder_id: string; included: boolean; delta_link: string | null }>();
    for (const f of folders) {
      const row = (await this.pool.query<{ folder_id: string; included: boolean; delta_link: string | null }>(
        "SELECT * FROM huis.worker_upsert_mail_folder($1, $2, $3, $4, $5, $6, $7, $8)",
        [...args, f.providerId, f.parentProviderId, f.name, f.path, null, f.total])).rows[0]!;
      rows.set(f.providerId, row);
    }
    const home = rows.get(GMAIL_NO_LABEL);
    if (!home) throw new Error("mailbox has no home folder");
    const order = folders.map((f) => f.providerId).filter((id) => id !== GMAIL_NO_LABEL);
    // Whole mailbox: everything is already imported, so a new label needs no re-import.
    const chosen = scope === "all" ? ["*all*"] : [...rows].filter(([, r]) => r.included).map(([id]) => id).sort();
    const fp = createHash("sha256").update(chosen.join("\n")).digest("hex").slice(0, 16);
    // Saved as "<labels fingerprint>|<when the current fresh import started, if one is running>|<position>".
    const parts = home.delta_link?.split("|") ?? [];
    const valid = parts.length === 3 && parts[0] === fp;
    let link: string | null = valid ? parts[2] || null : null;
    const dbNow = async () => (await this.pool.query<{ now: string }>("SELECT now()::text AS now")).rows[0]!.now;
    let importStarted: string | null = valid ? parts[1] || null : null;
    if (!link) importStarted = await dbNow();
    let budget = SYNC_BUDGET;
    let restarts = 0;
    let emptyInARow = 0;
    const seen = new Set<string>();
    const folderFor = (labels: string[]): string | null => {
      for (const id of order) if (labels.includes(id) && rows.get(id)!.included) return rows.get(id)!.folder_id;
      // Archived mail (none of the listed labels) belongs to "No label".
      if (!labels.some((l) => order.includes(l)) && home.included) return home.folder_id;
      return null;
    };
    const save = (position: string | null) => this.pool.query("SELECT huis.worker_save_mail_folder_state($1, $2, $3, $4)",
      [...args, home.folder_id, position ? `${fp}|${importStarted ?? ""}|${position}` : null]);
    for (;;) {
      const page = await provider.mailboxPage!(link);
      if (page.restart) {
        if (++restarts > 1) throw new Error("mail sync could not restart");
        link = null;
        importStarted = await dbNow();
        continue;
      }
      const groups = new Map<string, MailMessageInfo[]>();
      const add = (folderId: string, m: MailMessageInfo) => { const g = groups.get(folderId) ?? []; g.push(m); groups.set(folderId, g); };
      for (const m of page.messages) {
        const folderId = m.removed ? null : folderFor(m.labels);
        if (m.removed || !folderId || beforeCutoff(m, since)) add(home.folder_id, { id: m.id, removed: true });
        else { const { labels: _l, ...rest } = m; add(folderId, rest); }
      }
      for (const [folderId, list] of groups) {
        for (let i = 0; i < list.length; i += 500) {
          await this.pool.query("SELECT huis.worker_save_mail_messages($1, $2, $3, $4)", [...args, folderId, JSON.stringify(list.slice(i, i + 500))]);
        }
      }
      // A finished fresh import: whatever it didn't see was trashed or deleted meanwhile.
      if (page.fullImportDone && importStarted) {
        await this.pool.query("SELECT huis.worker_sweep_unseen_mail($1, $2, $3)", [...args, importStarted]);
        importStarted = null;
      }
      budget -= Math.max(1, page.messages.length);
      if (page.nextLink && seen.has(page.nextLink)) throw new Error("mail sync did not move forward");
      emptyInARow = page.messages.length === 0 && page.nextLink ? emptyInARow + 1 : 0;
      if (emptyInARow > 20) throw new Error("mail service kept returning empty pages");
      if (page.nextLink) seen.add(page.nextLink);
      link = page.nextLink ?? page.deltaLink ?? link;
      await save(link);
      if (!page.nextLink) return false;
      if (budget <= 0) return true;
    }
  }

  /** Files one requested email into its Matter. Returns false when none is waiting. */
  async fileOnce(): Promise<boolean> {
    const f = (await this.pool.query<Filing>("SELECT * FROM huis.worker_claim_mail_filing()")).rows[0];
    if (!f) return false;
    const evidenceId = randomUUID();
    const key = storageKeys.original(f.firm_id, f.matter_id, evidenceId);
    let stored = false;
    try {
      const provider = await this.open(f, (sealed) =>
        this.pool.query("SELECT huis.worker_save_filing_credentials($1, $2, $3)", [f.filing_id, f.lock_token, sealed]).then(() => undefined));
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
      const done = (await this.pool.query<{ ok: boolean }>("SELECT huis.worker_complete_mail_filing($1, $2, $3, $4, $5, $6) AS ok",
        [f.filing_id, f.lock_token, evidenceId, put.size, put.sha256, key])).rows[0]?.ok;
      // The requester lost access before it finished: the filing was cancelled, so remove the stored copy.
      if (!done) await this.vault.delete(key).catch(() => undefined);
    } catch (err) {
      if (stored) await this.vault.delete(key).catch(() => undefined);
      await this.pool.query("SELECT huis.worker_fail_mail_filing($1, $2, $3, $4)",
        [f.filing_id, f.lock_token, errText(err), f.attempts >= MAX_ATTEMPTS || needsReconnect(err)]).catch(() => undefined);
    }
    return true;
  }
}
