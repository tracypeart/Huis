import { Readable } from "node:stream";
import { pkceChallenge } from "../auth/microsoft";
import { fetchDownload, fetchWithTimeout, readTextCapped } from "../net/http";
import type { FileSource, ListedItem, Listing, RemoteFile } from "./types";

/**
 * Dropbox through its HTTP API (v2).
 *
 * Permissions requested (the signed-in person's own consent):
 *   account_info.read files.metadata.read files.content.read
 * All read-only: Huis can't change, move, share or delete anything.
 *
 * Ids Huis uses: "root" (the top of the person's Dropbox) and "dbx:<Dropbox id>"
 * for a folder or file (Dropbox ids look like "id:AbC-12_x", stable across renames).
 *
 * The token is only ever sent to Dropbox's own API hosts configured here.
 */
export const DROPBOX_SCOPES = ["account_info.read", "files.metadata.read", "files.content.read"];
export const MAX_LISTED = 1000;

export function dropboxAuthBase(): string { return (process.env.HUIS_DROPBOX_AUTH_BASE ?? "https://www.dropbox.com").replace(/\/$/, ""); }
export function dropboxApiBase(): string { return (process.env.HUIS_DROPBOX_API_BASE ?? "https://api.dropboxapi.com").replace(/\/$/, ""); }
export function dropboxContentBase(): string { return (process.env.HUIS_DROPBOX_CONTENT_BASE ?? "https://content.dropboxapi.com").replace(/\/$/, ""); }

const DBX = /^dbx:(id:[A-Za-z0-9_-]{1,200})$/;
/** The Dropbox id inside a "dbx:id:…" id, or null for anything else. */
export function dropboxId(id: string): string | null {
  return DBX.exec(id)?.[1] ?? null;
}

export function dropboxAuthorizeUrl(p: { clientId: string; redirectUri: string; state: string; verifier: string }): string {
  const url = new URL(`${dropboxAuthBase()}/oauth2/authorize`);
  url.search = new URLSearchParams({
    client_id: p.clientId, response_type: "code", redirect_uri: p.redirectUri, state: p.state,
    token_access_type: "offline", scope: DROPBOX_SCOPES.join(" "),
    code_challenge: pkceChallenge(p.verifier), code_challenge_method: "S256", force_reapprove: "false",
  }).toString();
  return url.toString();
}

interface TokenResponse { access_token?: string; refresh_token?: string; account_id?: string; scope?: string; error?: string }

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetchWithTimeout(`${dropboxApiBase()}/oauth2/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params), redirect: "error",
  });
  let body: TokenResponse = {};
  try { body = JSON.parse(await readTextCapped(res, 64 * 1024, "Dropbox response too large")) as TokenResponse; } catch { body = {}; }
  if (!res.ok || !body.access_token) {
    // Only Dropbox's short error codes are kept, never raw response text.
    const code = typeof body.error === "string" && /^[a-z_]{1,40}$/.test(body.error) ? body.error : String(res.status);
    const err = new Error(`Dropbox token request failed (${code})`);
    (err as Error & { reconnect?: boolean }).reconnect = body.error === "invalid_grant";
    throw err;
  }
  return body;
}

/** Every Dropbox API call: POST with a JSON body (or none), token only to the configured host. */
async function rpc<T>(token: string, endpoint: string, body: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchWithTimeout(`${dropboxApiBase()}/2/${endpoint}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, ...(body === null ? {} : { "content-type": "application/json" }) },
      body: body === null ? undefined : JSON.stringify(body),
      redirect: "error",
    });
    if ((res.status === 429 || res.status === 503) && attempt < 3) {
      const wait = Math.min(30, Number(res.headers.get("retry-after") ?? "3") || 3);
      await res.body?.cancel().catch(() => undefined);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      const err = new Error(`Dropbox request failed (${res.status})`);
      (err as Error & { reconnect?: boolean }).reconnect = res.status === 401;
      // 409 is Dropbox's "this path/id doesn't exist (any more)".
      (err as Error & { final?: boolean }).final = res.status === 409;
      throw err;
    }
    // Security review 21, R21-4: stop reading as soon as the response passes the limit.
    const text = await readTextCapped(res, 20 * 1024 * 1024, "Dropbox response too large");
    try { return JSON.parse(text) as T; } catch { throw new Error("Dropbox sent an unreadable response"); }
  }
}

export interface ConnectedDropbox { subject: string; address: string | null; displayName: string; refreshToken: string }

/** Completes the connect flow: exchanges the code and checks who signed in and what was granted. */
export async function completeDropboxConnect(p: { clientId: string; clientSecret: string; redirectUri: string; code: string; verifier: string }): Promise<ConnectedDropbox> {
  const t = await tokenRequest({
    client_id: p.clientId, client_secret: p.clientSecret, grant_type: "authorization_code", code: p.code,
    redirect_uri: p.redirectUri, code_verifier: p.verifier,
  });
  if (!t.refresh_token) throw new Error("Dropbox did not grant offline access");
  const granted = new Set((t.scope ?? "").split(" ").filter(Boolean));
  if (!DROPBOX_SCOPES.every((s) => granted.has(s))) throw new Error("Dropbox did not grant read access to files");
  // Read-only means read-only: a sign-in that carries any other permission isn't kept.
  if ([...granted].some((s) => !DROPBOX_SCOPES.includes(s))) throw new Error("Dropbox granted more access than Huis asked for; connect again");
  const me = await rpc<{ account_id?: string; email?: string; email_verified?: boolean; name?: { display_name?: string } }>(
    t.access_token!, "users/get_current_account", null);
  // The account the token belongs to (Dropbox's stable id), as Dropbox itself reports it.
  if (!me.account_id || !/^dbid:[A-Za-z0-9_-]{1,100}$/.test(me.account_id) || (t.account_id && t.account_id !== me.account_id)) {
    throw new Error("Dropbox did not identify the account");
  }
  const address = me.email && me.email_verified !== false ? me.email.toLowerCase().slice(0, 320) : null;
  return { subject: me.account_id, address, displayName: (me.name?.display_name ?? address ?? "Dropbox user").slice(0, 300), refreshToken: t.refresh_token };
}

export async function refreshDropboxAccess(p: { clientId: string; clientSecret: string; refreshToken: string }): Promise<{ accessToken: string; refreshToken: string }> {
  // Each access token is narrowed to the read-only permissions, whatever the app was granted.
  const t = await tokenRequest({ client_id: p.clientId, client_secret: p.clientSecret, grant_type: "refresh_token", refresh_token: p.refreshToken,
    scope: DROPBOX_SCOPES.join(" ") });
  return { accessToken: t.access_token!, refreshToken: t.refresh_token ?? p.refreshToken };
}

/** The Dropbox account a token belongs to (security review 20, R20-1: checked against the connection's account). */
export async function dropboxAccountId(accessToken: string): Promise<string | null> {
  const me = await rpc<{ account_id?: string }>(accessToken, "users/get_current_account", null);
  return me.account_id && /^dbid:[A-Za-z0-9_-]{1,100}$/.test(me.account_id) ? me.account_id : null;
}

interface Entry {
  ".tag"?: string; id?: string; name?: string; path_display?: string; path_lower?: string; size?: number;
  server_modified?: string; client_modified?: string; rev?: string;
}

const text = (v: string | undefined | null, max: number) => (v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);

export class DropboxSource implements FileSource {
  constructor(private readonly accessToken: string) {}

  private item(e: Entry): ListedItem | null {
    const tag = e[".tag"];
    if ((tag !== "file" && tag !== "folder") || !e.id) return null;
    const id = `dbx:${e.id}`;
    if (!dropboxId(id)) return null;
    return {
      id, kind: tag, name: text(e.name, 300) || "(no name)",
      size: tag === "file" && typeof e.size === "number" ? e.size : null,
      modified: tag === "file" ? (e.server_modified ?? null) : null,
      version: tag === "file" ? (e.rev ?? null) : null,
    };
  }

  async list(location: string): Promise<Listing> {
    let path = "";
    let title = "Dropbox";
    let parent: string | null = null;
    if (location !== "root") {
      const id = dropboxId(location);
      if (!id) throw new Error("unknown folder");
      const self = await rpc<Entry>(this.accessToken, "files/get_metadata", { path: id });
      if (self[".tag"] !== "folder") throw Object.assign(new Error("that is not a folder"), { final: true });
      path = id;
      title = text(self.name, 300) || "Folder";
      // "Up": the folder above, by its own id (or the top).
      const above = (self.path_lower ?? "").split("/").slice(0, -1).join("/");
      if (above) {
        const up = await rpc<Entry>(this.accessToken, "files/get_metadata", { path: above }).catch(() => null);
        parent = up?.id && dropboxId(`dbx:${up.id}`) ? `dbx:${up.id}` : "root";
      } else {
        parent = "root";
      }
    }
    const items: ListedItem[] = [];
    let page = await rpc<{ entries?: Entry[]; cursor?: string; has_more?: boolean }>(this.accessToken, "files/list_folder", { path, limit: 500 });
    let pages = 1;
    for (;;) {
      for (const e of page.entries ?? []) {
        const it = this.item(e);
        if (it) items.push(it);
      }
      if (items.length >= MAX_LISTED || !page.has_more || !page.cursor) break;
      if (++pages > 20) throw new Error("the folder listing did not finish");
      page = await rpc(this.accessToken, "files/list_folder/continue", { cursor: page.cursor });
    }
    const truncated = items.length > MAX_LISTED || (items.length >= MAX_LISTED && Boolean(page.has_more));
    const rank = { site: 0, folder: 1, file: 2 } as const;
    items.sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name));
    return { title, parent, items: items.slice(0, MAX_LISTED), truncated };
  }

  async describe(id: string): Promise<RemoteFile> {
    const d = dropboxId(id);
    if (!d) throw new Error("unknown file");
    const e = await rpc<Entry>(this.accessToken, "files/get_metadata", { path: d });
    if (e[".tag"] !== "file") throw Object.assign(new Error("that is not a file"), { final: true });
    return {
      name: text(e.name, 300) || "(no name)", size: typeof e.size === "number" ? e.size : null, version: e.rev ?? null,
      modified: e.server_modified ?? null, mime: null, path: e.path_display ? text(e.path_display, 1000) : null,
    };
  }

  /**
   * The file exactly as stored. When Huis has read the file's revision, it downloads that exact
   * revision ("rev:…"), so the bytes always match the version recorded.
   */
  async download(id: string, version?: string | null): Promise<Readable> {
    const d = dropboxId(id);
    if (!d) throw new Error("unknown file");
    const path = version && /^[0-9a-f]{9,64}$/i.test(version) ? `rev:${version}` : d;
    const { res, stream } = await fetchDownload(`${dropboxContentBase()}/2/files/download`, {
      method: "POST",
      // Dropbox reads the argument from a header, which must be ASCII-only JSON.
      headers: { authorization: `Bearer ${this.accessToken}`, "dropbox-api-arg": JSON.stringify({ path }).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`) },
      redirect: "error",
    });
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      const err = new Error(`the file download failed (${res.status})`);
      (err as Error & { reconnect?: boolean }).reconnect = res.status === 401;
      (err as Error & { final?: boolean }).final = res.status === 409;
      throw err;
    }
    return stream();
  }
}
