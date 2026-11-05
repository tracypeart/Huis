import type { Readable } from "node:stream";
import type { JWTVerifyGetKey } from "jose";
import { pkceChallenge } from "../auth/microsoft";
import { UserFacingError } from "../errors";
import { googleAuthBase, googleTokenBase, verifyGoogleIdToken } from "../mail/google";
import { fetchDownload, fetchWithTimeout, readTextCapped } from "../net/http";
import type { FileSource, ListedItem, Listing, RemoteFile } from "./types";

/**
 * Google Drive through the Drive API (v3), with the narrowest file permission Google offers.
 *
 * Permissions requested (the signed-in person's own consent):
 *   openid email profile https://www.googleapis.com/auth/drive.file
 * drive.file lets Huis open only the files the person chooses in Google's own
 * file picker. It can't list, open, change or delete anything else in their
 * Drive. (Browsing the whole Drive needs a restricted scope and Google's CASA
 * assessment, the same one Gmail needs; that comes later.)
 *
 * How choosing works: the picker runs in the person's browser with a short-lived
 * token limited to drive.file, which never reaches Huis's servers. The picker
 * hands back file ids; the worker then checks each one with the connection's own
 * sealed sign-in, so only files the connected account itself can open are listed.
 *
 * Ids Huis uses: "picked" (the files the person last chose) and "gdrive:<file id>".
 * Google Docs, Sheets, Slides and Drawings have no file of their own; Huis imports
 * them converted to Word, Excel, PowerPoint and PDF.
 */
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const GOOGLE_DRIVE_SCOPES = ["openid", "email", "profile", DRIVE_FILE_SCOPE];
/** Scopes a Google sign-in for Drive may carry; anything else (e.g. full Drive or Gmail access) isn't kept. */
const ALLOWED_SCOPES = new Set([...GOOGLE_DRIVE_SCOPES,
  "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile"]);
export const MAX_PICKED = 200;

export function driveApiBase(): string { return (process.env.HUIS_GDRIVE_API_BASE ?? "https://www.googleapis.com").replace(/\/$/, ""); }
export function googleUserinfoBase(): string { return (process.env.HUIS_GOOGLE_USERINFO_BASE ?? "https://openidconnect.googleapis.com").replace(/\/$/, ""); }

/** A Google Drive file id: letters, digits, "-" and "_". */
const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;
const GDRIVE = /^gdrive:([A-Za-z0-9_-]{10,200})$/;
export const isDriveFileId = (v: string) => FILE_ID.test(v);
/** The Drive file id inside "gdrive:…", or null. */
export function driveFileId(id: string): string | null {
  return GDRIVE.exec(id)?.[1] ?? null;
}

/** Google's own formats, and what Huis imports them as. Anything else of Google's (forms, sites, maps…) isn't importable. */
const EXPORTS: Record<string, { mime: string; ext: string }> = {
  "application/vnd.google-apps.document": { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: ".docx" },
  "application/vnd.google-apps.spreadsheet": { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: ".xlsx" },
  "application/vnd.google-apps.presentation": { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: ".pptx" },
  "application/vnd.google-apps.drawing": { mime: "application/pdf", ext: ".pdf" },
};
const GOOGLE_NATIVE = "application/vnd.google-apps.";

export function googleDriveAuthorizeUrl(p: { clientId: string; redirectUri: string; state: string; nonce: string; verifier: string }): string {
  const url = new URL(`${googleAuthBase()}/o/oauth2/v2/auth`);
  url.search = new URLSearchParams({
    client_id: p.clientId, response_type: "code", redirect_uri: p.redirectUri, scope: GOOGLE_DRIVE_SCOPES.join(" "),
    state: p.state, nonce: p.nonce, code_challenge: pkceChallenge(p.verifier), code_challenge_method: "S256",
    access_type: "offline", prompt: "consent select_account",
    // Never fold in other permissions this person gave Huis earlier (e.g. Gmail): this sign-in carries drive.file only.
    include_granted_scopes: "false",
  }).toString();
  return url.toString();
}

interface TokenResponse { access_token?: string; refresh_token?: string; id_token?: string; scope?: string; error?: string }

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetchWithTimeout(`${googleTokenBase()}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params), redirect: "error",
  });
  let body: TokenResponse = {};
  try { body = JSON.parse(await readTextCapped(res, 64 * 1024, "Google response too large")) as TokenResponse; } catch { body = {}; }
  if (!res.ok || !body.access_token) {
    // Only Google's short error codes are kept, never raw response text.
    const code = typeof body.error === "string" && /^[a-z_]{1,40}$/.test(body.error) ? body.error : String(res.status);
    const err = new Error(`Google token request failed (${code})`);
    (err as Error & { reconnect?: boolean }).reconnect = body.error === "invalid_grant" || body.error === "unauthorized_client";
    throw err;
  }
  return body;
}

/** Checks a granted scope list: drive.file must be there, and nothing broader may be. */
export function checkDriveScopes(scope: string | undefined): void {
  const granted = new Set((scope ?? "").split(" ").filter(Boolean));
  if (!granted.has(DRIVE_FILE_SCOPE)) {
    throw new UserFacingError("Huis needs permission to open the Google Drive files you choose. Please connect again and allow it.");
  }
  if ([...granted].some((s) => !ALLOWED_SCOPES.has(s))) {
    throw new UserFacingError("Google granted more access than Huis asked for. Please connect again.");
  }
}

export interface ConnectedGoogleDrive { subject: string; address: string | null; displayName: string; refreshToken: string }

/** Completes the connect flow: exchanges the code, verifies who signed in and what was granted. */
export async function completeGoogleDriveConnect(p: {
  clientId: string; clientSecret: string; redirectUri: string; code: string; verifier: string; nonce: string; keys?: JWTVerifyGetKey;
}): Promise<ConnectedGoogleDrive> {
  const t = await tokenRequest({
    client_id: p.clientId, client_secret: p.clientSecret, grant_type: "authorization_code", code: p.code,
    redirect_uri: p.redirectUri, code_verifier: p.verifier,
  });
  if (!t.id_token || !t.refresh_token) throw new Error("Google did not grant offline access");
  checkDriveScopes(t.scope);
  const identity = await verifyGoogleIdToken(t.id_token, { clientId: p.clientId, nonce: p.nonce, keys: p.keys });
  const address = identity.email?.toLowerCase().slice(0, 320) ?? null;
  return { subject: identity.subject, address, displayName: identity.name ?? address ?? "Google user", refreshToken: t.refresh_token };
}

export async function refreshGoogleDriveAccess(p: { clientId: string; clientSecret: string; refreshToken: string }): Promise<{ accessToken: string; refreshToken: string }> {
  const t = await tokenRequest({ client_id: p.clientId, client_secret: p.clientSecret, grant_type: "refresh_token", refresh_token: p.refreshToken });
  // A token that somehow carries more than drive.file is never used.
  if (t.scope !== undefined) checkDriveScopes(t.scope);
  return { accessToken: t.access_token!, refreshToken: t.refresh_token ?? p.refreshToken };
}

/** The Google account a token belongs to (its stable "sub"), as Google reports it (security review 20, R20-1). */
export async function googleAccountId(accessToken: string): Promise<string | null> {
  const res = await fetchWithTimeout(`${googleUserinfoBase()}/v1/userinfo`, { headers: { authorization: `Bearer ${accessToken}` }, redirect: "error" });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw Object.assign(new Error(`Google refused the sign-in (${res.status})`), { reconnect: res.status === 401 });
  }
  let me: { sub?: unknown } = {};
  try { me = JSON.parse(await readTextCapped(res, 64 * 1024, "Google response too large")) as { sub?: unknown }; } catch { me = {}; }
  return typeof me.sub === "string" && /^[0-9]{1,64}$/.test(me.sub) ? me.sub : null;
}

interface DriveFile {
  id?: string; name?: string; mimeType?: string; size?: string; version?: string; headRevisionId?: string;
  modifiedTime?: string; trashed?: boolean; capabilities?: { canDownload?: boolean };
}

const FIELDS = "id,name,mimeType,size,version,headRevisionId,modifiedTime,trashed,capabilities(canDownload)";
const clean = (v: string | undefined | null, max: number) => (v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);

/** Drive API errors: a refused sign-in needs reconnecting; a missing or unavailable file fails just that file. */
function driveError(status: number, what: string): Error {
  const err = new Error(`${what} (${status})`);
  (err as Error & { reconnect?: boolean }).reconnect = status === 401;
  (err as Error & { final?: boolean }).final = status === 403 || status === 404;
  return err;
}

export class GoogleDriveSource implements FileSource {
  constructor(private readonly accessToken: string) {}

  private async get(fileId: string): Promise<DriveFile> {
    const url = `${driveApiBase()}/drive/v3/files/${encodeURIComponent(fileId)}?${new URLSearchParams({ fields: FIELDS, supportsAllDrives: "true" })}`;
    for (let attempt = 0; ; attempt++) {
      const res = await fetchWithTimeout(url, { headers: { authorization: `Bearer ${this.accessToken}`, accept: "application/json" }, redirect: "error" });
      if ((res.status === 429 || res.status === 503) && attempt < 3) {
        const wait = Math.min(10, Number(res.headers.get("retry-after") ?? "2") || 2);
        await res.body?.cancel().catch(() => undefined);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw driveError(res.status, "Google Drive request failed");
      }
      try { return JSON.parse(await readTextCapped(res, 1024 * 1024, "Google Drive response too large")) as DriveFile; } catch (e) {
        if ((e as Error).message === "Google Drive response too large") throw e;
        throw new Error("Google Drive sent an unreadable response");
      }
    }
  }

  /** What Huis records for a Drive file, or null when it can't be imported (a folder, trashed, Google's own non-document types…). */
  private describeFile(f: DriveFile, fileId: string): RemoteFile & { id: string } | null {
    if (f.id !== fileId || f.trashed || !f.mimeType || f.mimeType === "application/vnd.google-apps.folder") return null;
    if (f.capabilities?.canDownload === false) return null;
    const exported = EXPORTS[f.mimeType];
    if (f.mimeType.startsWith(GOOGLE_NATIVE) && !exported) return null;
    const base = clean(f.name, 290) || "(no name)";
    const name = exported && !base.toLowerCase().endsWith(exported.ext) ? `${base}${exported.ext}` : base;
    // Files of their own have a revision id (Huis downloads exactly that revision). Google's own documents
    // don't, so their version number ("v12") is used: it changes whenever the document changes.
    const version = !exported && f.headRevisionId && /^[A-Za-z0-9_-]{1,190}$/.test(f.headRevisionId)
      ? f.headRevisionId : f.version && /^[0-9]{1,19}$/.test(f.version) ? `v${f.version}` : null;
    return {
      id: `gdrive:${fileId}`, name, size: !exported && f.size && /^[0-9]{1,15}$/.test(f.size) ? Number(f.size) : null, version,
      modified: f.modifiedTime ?? null, mime: exported ? exported.mime : clean(f.mimeType, 200) || null, path: `Google Drive/${name}`,
    };
  }

  /**
   * "picked": the files the person chose in the picker, each checked with this connection's own sign-in.
   * Files the account can't open (picked while signed in as someone else, deleted since, or not importable) are left out.
   */
  async list(location: string, picked: readonly string[] = []): Promise<Listing> {
    if (location !== "picked") throw Object.assign(new Error("unknown folder"), { final: true });
    const items: ListedItem[] = [];
    let skipped = 0;
    for (const fileId of [...new Set(picked)].slice(0, MAX_PICKED)) {
      if (!isDriveFileId(fileId)) { skipped++; continue; }
      let f: DriveFile;
      try { f = await this.get(fileId); } catch (e) {
        if ((e as { final?: boolean }).final) { skipped++; continue; }
        throw e;
      }
      const d = this.describeFile(f, fileId);
      if (!d) { skipped++; continue; }
      items.push({ id: d.id, kind: "file", name: d.name, size: d.size, modified: d.modified, version: d.version, mime: d.mime });
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    // "truncated" tells the person some of their choices couldn't be listed.
    return { title: "Files you chose", parent: null, items, truncated: skipped > 0 };
  }

  async describe(id: string): Promise<RemoteFile> {
    const fileId = driveFileId(id);
    if (!fileId) throw new Error("unknown file");
    const d = this.describeFile(await this.get(fileId), fileId);
    if (!d) throw Object.assign(new Error("that file can't be imported from Google Drive"), { final: true });
    const { id: _id, ...file } = d;
    return file;
  }

  /**
   * The file's bytes. A file of its own comes as the exact revision Huis recorded; a Google document is
   * converted (Word, Excel, PowerPoint or PDF). Google converts documents of up to 10 MB.
   */
  async download(id: string, version?: string | null): Promise<Readable> {
    const fileId = driveFileId(id);
    if (!fileId) throw new Error("unknown file");
    const f = await this.get(fileId);
    const exported = f.mimeType ? EXPORTS[f.mimeType] : undefined;
    const enc = encodeURIComponent(fileId);
    const url = exported
      ? `${driveApiBase()}/drive/v3/files/${enc}/export?${new URLSearchParams({ mimeType: exported.mime })}`
      : version && !version.startsWith("v") && /^[A-Za-z0-9_-]{1,190}$/.test(version)
        ? `${driveApiBase()}/drive/v3/files/${enc}/revisions/${encodeURIComponent(version)}?alt=media`
        : `${driveApiBase()}/drive/v3/files/${enc}?alt=media&supportsAllDrives=true`;
    const { res, stream } = await fetchDownload(url, { headers: { authorization: `Bearer ${this.accessToken}` }, redirect: "error" });
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      const err = driveError(res.status, "the file download failed");
      if (exported && res.status === 403) err.message = "Google couldn't convert this document (it may be over Google's 10 MB conversion limit)";
      throw err;
    }
    return stream();
  }
}
