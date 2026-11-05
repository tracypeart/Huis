import { Readable } from "node:stream";
import type { JWTVerifyGetKey } from "jose";
import { pkceChallenge } from "../auth/microsoft";
import { UserFacingError } from "../errors";
import { googleAuthBase, googleTokenRequest, verifyGoogleIdToken } from "../mail/google";
import type { FileSource, ListedItem, Listing, RemoteFile } from "./types";
import { apiTotalMs, fetchDownload } from "../net/http";

/**
 * Google Drive through the Drive API (v3), with Google's own file picker.
 *
 * Permissions requested (the signed-in person's own consent):
 *   openid email https://www.googleapis.com/auth/drive.file
 * drive.file is Google's narrowest file permission: Huis can open only the files the person
 * chooses for it in Google's file picker, never the rest of their Drive, and can't change,
 * move, share or delete them (Huis never asks Drive to).
 *
 * Ids Huis uses: "root" (the files chosen for Huis) and "gdrive:<file id>" for a file.
 *
 * Google Docs, Sheets and Slides have no stored file to copy, so they are left out until Huis
 * can record an export of them as evidence; the person downloads them as a file first.
 *
 * The token is only ever sent to Google's own API hosts configured here.
 */
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const GOOGLE_DRIVE_SCOPES = ["openid", "email", DRIVE_FILE_SCOPE];
/** What a Drive sign-in may carry (Google reports "email" as userinfo.email). Anything else isn't kept. */
const ALLOWED_GRANTS = new Set(["openid", "email", "https://www.googleapis.com/auth/userinfo.email", DRIVE_FILE_SCOPE]);
export const MAX_LISTED = 1000;

export function driveApiBase(): string { return (process.env.HUIS_GOOGLE_DRIVE_BASE ?? "https://www.googleapis.com/drive/v3").replace(/\/$/, ""); }
export function googleUserinfoUrl(): string { return process.env.HUIS_GOOGLE_USERINFO_URL ?? "https://openidconnect.googleapis.com/v1/userinfo"; }

const GDRIVE = /^gdrive:([A-Za-z0-9_-]{1,200})$/;
/** The Drive file id inside a "gdrive:…" id, or null for anything else. */
export function driveFileId(id: string): string | null {
  return GDRIVE.exec(id)?.[1] ?? null;
}
/** Google's own types (Docs, Sheets, Slides, folders, shortcuts…): nothing stored to copy. */
const isGoogleType = (mime: string | undefined) => (mime ?? "").startsWith("application/vnd.google-apps.");
/** Drive revision ids: letters, digits and a few marks. */
const REVISION = /^[A-Za-z0-9_-]{1,200}$/;

export function googleDriveAuthorizeUrl(p: { clientId: string; redirectUri: string; state: string; nonce: string; verifier: string; loginHint?: string | null }): string {
  const url = new URL(`${googleAuthBase()}/o/oauth2/v2/auth`);
  url.search = new URLSearchParams({
    client_id: p.clientId, response_type: "code", redirect_uri: p.redirectUri, scope: GOOGLE_DRIVE_SCOPES.join(" "),
    state: p.state, nonce: p.nonce, code_challenge: pkceChallenge(p.verifier), code_challenge_method: "S256",
    // A refresh token is only issued with offline access and fresh consent. No include_granted_scopes:
    // a Drive sign-in must not pick up other permissions given to the firm's Google app (such as Gmail).
    access_type: "offline", prompt: "consent select_account",
    ...(p.loginHint ? { login_hint: p.loginHint } : {}),
  }).toString();
  return url.toString();
}

const reconnect = (msg: string) => Object.assign(new Error(msg), { reconnect: true });
const final = (msg: string) => Object.assign(new Error(msg), { final: true });

function checkGrants(scope: string | undefined): void {
  const granted = new Set((scope ?? "").split(" ").filter(Boolean));
  if (!granted.has(DRIVE_FILE_SCOPE)) throw reconnect("Google did not grant access to the files you choose");
  // Read-only and narrow means just that: a sign-in that carries any other permission isn't kept.
  if ([...granted].some((s) => !ALLOWED_GRANTS.has(s))) throw reconnect("Google granted more access than Huis asked for; connect again");
}

export interface ConnectedDrive { subject: string; address: string | null; displayName: string; refreshToken: string }

/** Completes the connect flow: exchanges the code, verifies who signed in and checks what was granted. */
export async function completeGoogleDriveConnect(p: {
  clientId: string; clientSecret: string; redirectUri: string; code: string; verifier: string; nonce: string; keys?: JWTVerifyGetKey;
}): Promise<ConnectedDrive> {
  const t = await googleTokenRequest({
    client_id: p.clientId, client_secret: p.clientSecret, grant_type: "authorization_code", code: p.code,
    redirect_uri: p.redirectUri, code_verifier: p.verifier,
  });
  if (!t.id_token || !t.refresh_token) throw new Error("Google did not grant offline access");
  // Google lets people untick permissions on the consent screen.
  try { checkGrants(t.scope); } catch (err) {
    throw new UserFacingError(`${(err as Error).message}. Please connect again and allow Huis to open the Google Drive files you choose.`);
  }
  const identity = await verifyGoogleIdToken(t.id_token, { clientId: p.clientId, nonce: p.nonce, keys: p.keys });
  // The token must belong to the person whose sign-in was verified.
  if ((await googleAccountSub(t.access_token!)) !== identity.subject) throw new Error("Google did not identify the account");
  const address = identity.email?.toLowerCase().slice(0, 320) ?? null;
  return { subject: identity.subject, address, displayName: identity.name ?? address ?? "Google user", refreshToken: t.refresh_token };
}

export async function refreshGoogleDriveAccess(p: { clientId: string; clientSecret: string; refreshToken: string }): Promise<{ accessToken: string; refreshToken: string }> {
  const t = await googleTokenRequest({ client_id: p.clientId, client_secret: p.clientSecret, grant_type: "refresh_token", refresh_token: p.refreshToken });
  checkGrants(t.scope);
  return { accessToken: t.access_token!, refreshToken: t.refresh_token ?? p.refreshToken };
}

/** One Drive call. Security review 22, R22-2: the answer must start within the time limit and keep flowing. */
async function googleFetch(token: string, url: string, accept = "application/json"): Promise<{ res: Response; stream: () => Readable }> {
  for (let attempt = 0; ; attempt++) {
    const call = await fetchDownload(url, { headers: { authorization: `Bearer ${token}`, accept }, redirect: "manual" },
      accept === "application/json" ? { totalMs: apiTotalMs() } : {});
    const res = call.res;
    if ((res.status === 429 || res.status === 500 || res.status === 503) && attempt < 3) {
      const wait = Math.min(30, Number(res.headers.get("retry-after") ?? "3") || 3);
      await res.body?.cancel().catch(() => undefined);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    return call;
  }
}

function failed(res: Response, what: string): Error {
  const err = new Error(`${what} (${res.status})`);
  (err as Error & { reconnect?: boolean }).reconnect = res.status === 401;
  // 404: the file is gone, or no longer shared with Huis.
  (err as Error & { final?: boolean }).final = res.status === 404;
  return err;
}

async function googleJson<T>(token: string, url: string): Promise<T> {
  const { res, stream } = await googleFetch(token, url);
  if (res.status >= 300 && res.status < 400) { await res.body?.cancel().catch(() => undefined); throw new Error("Google sent an unexpected redirect"); }
  if (!res.ok) { await res.body?.cancel().catch(() => undefined); throw failed(res, "Google Drive request failed"); }
  // Security review 22, R22-4: stop reading as soon as the response passes the limit.
  const parts: Buffer[] = [];
  let size = 0;
  if (res.body) {
    const s = stream();
    for await (const chunk of s) {
      size += (chunk as Buffer).length;
      if (size > 20 * 1024 * 1024) { s.destroy(); throw new Error("Google response too large"); }
      parts.push(chunk as Buffer);
    }
  }
  const body = Buffer.concat(parts).toString("utf8");
  try { return JSON.parse(body) as T; } catch { throw new Error("Google sent an unreadable response"); }
}

/** The Google account a token belongs to (its stable "sub"). Security review 20, R20-1: checked against the connection's account. */
export async function googleAccountSub(accessToken: string): Promise<string | null> {
  const me = await googleJson<{ sub?: string }>(accessToken, googleUserinfoUrl());
  return typeof me.sub === "string" && /^[0-9]{1,64}$/.test(me.sub) ? me.sub : null;
}

/** Where Drive may send a download: Google's own content hosts, over HTTPS (the token is never sent there). */
export function driveDownloadHostAllowed(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
  return /(^|\.)googleusercontent\.com$/i.test(u.hostname);
}

interface DriveFile {
  id?: string; name?: string; mimeType?: string; size?: string; modifiedTime?: string; headRevisionId?: string; trashed?: boolean;
}
const FIELDS = "id,name,mimeType,size,modifiedTime,headRevisionId,trashed";
const text = (v: string | undefined | null, max: number) => (v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);
const bytes = (v: string | undefined) => (v && /^[0-9]{1,15}$/.test(v) ? Number(v) : null);

export class GoogleDriveSource implements FileSource {
  constructor(private readonly accessToken: string) {}

  private item(f: DriveFile): ListedItem | null {
    if (!f.id || f.trashed || isGoogleType(f.mimeType)) return null;
    const id = `gdrive:${f.id}`;
    if (!driveFileId(id)) return null;
    return {
      id, kind: "file", name: text(f.name, 300) || "(no name)", size: bytes(f.size), modified: f.modifiedTime ?? null,
      version: f.headRevisionId && REVISION.test(f.headRevisionId) ? f.headRevisionId : null,
      mime: f.mimeType ? text(f.mimeType, 200) : null,
    };
  }

  /** The files the person has chosen for Huis (drive.file shows Huis nothing else). */
  async list(location: string): Promise<Listing> {
    if (location !== "root") throw final("unknown folder");
    const items: ListedItem[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    let more = false;
    for (;;) {
      const q = new URLSearchParams({
        q: "trashed = false", fields: `nextPageToken,files(${FIELDS})`, pageSize: "200", orderBy: "name",
        supportsAllDrives: "true", includeItemsFromAllDrives: "true", spaces: "drive",
        ...(pageToken ? { pageToken } : {}),
      });
      const page = await googleJson<{ files?: DriveFile[]; nextPageToken?: string }>(this.accessToken, `${driveApiBase()}/files?${q}`);
      for (const f of page.files ?? []) {
        const it = this.item(f);
        if (it) items.push(it);
      }
      more = Boolean(page.nextPageToken);
      if (items.length >= MAX_LISTED || !page.nextPageToken) break;
      if (++pages >= 20) throw new Error("the file listing did not finish");
      // Google's page tokens are opaque, but only ever go back to the same listing URL.
      if (page.nextPageToken.length > 2000) throw new Error("Google sent an unexpected page token");
      pageToken = page.nextPageToken;
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    return { title: "Files you've chosen for Huis", parent: null, items: items.slice(0, MAX_LISTED), truncated: items.length > MAX_LISTED || (items.length >= MAX_LISTED && more) };
  }

  private async get(id: string): Promise<DriveFile & { id: string }> {
    const d = driveFileId(id);
    if (!d) throw final("unknown file");
    const f = await googleJson<DriveFile>(this.accessToken,
      `${driveApiBase()}/files/${encodeURIComponent(d)}?${new URLSearchParams({ fields: FIELDS, supportsAllDrives: "true" })}`);
    if (f.id !== d) throw new Error("Google Drive returned a different file");
    if (f.trashed) throw final("the file is in the Google Drive trash");
    if (isGoogleType(f.mimeType)) throw final("Google Docs, Sheets and Slides can't be imported yet; download it as a file (such as PDF or Word) and import that");
    return f as DriveFile & { id: string };
  }

  async describe(id: string): Promise<RemoteFile> {
    const f = await this.get(id);
    return {
      name: text(f.name, 300) || "(no name)", size: bytes(f.size),
      version: f.headRevisionId && REVISION.test(f.headRevisionId) ? f.headRevisionId : null,
      modified: f.modifiedTime ?? null, mime: f.mimeType ? text(f.mimeType, 200) : null,
      // drive.file can't see the folders around a chosen file, so there is no path to record.
      path: null,
    };
  }

  /**
   * The file exactly as stored. When Huis has read the file's revision, it downloads that exact
   * revision, so the bytes always match the version recorded.
   */
  async download(id: string, version?: string | null): Promise<Readable> {
    const d = driveFileId(id);
    if (!d) throw final("unknown file");
    const url = version && REVISION.test(version)
      ? `${driveApiBase()}/files/${encodeURIComponent(d)}/revisions/${encodeURIComponent(version)}?alt=media`
      : `${driveApiBase()}/files/${encodeURIComponent(d)}?alt=media&supportsAllDrives=true`;
    let call = await googleFetch(this.accessToken, url, "*/*");
    let res = call.res;
    if (res.status >= 300 && res.status < 400) {
      // Google may hand the bytes over from its content hosts: followed only there, and never with the token.
      const to = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      const next = to ? new URL(to, url).toString() : "";
      if (!driveDownloadHostAllowed(next)) throw new Error("Google sent the download somewhere unexpected");
      call = await fetchDownload(next, { redirect: "error" });
      res = call.res;
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw failed(res, "the file download failed");
    }
    return call.stream();
  }
}
