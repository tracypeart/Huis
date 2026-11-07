import { Readable } from "node:stream";
import { graphBase, graphJson } from "../mail/microsoft";
import type { FileSource, ListedItem, Listing, RemoteFile } from "./types";
import { fetchDownload } from "../net/http";

/**
 * OneDrive and SharePoint through Microsoft Graph.
 *
 * Permissions requested (delegated, the signed-in person's own consent):
 *   openid profile email offline_access User.Read Files.Read.All
 * Files.Read.All is read-only: it covers the person's OneDrive, files shared
 * with them and the SharePoint sites they can open. Huis can't change, move
 * or delete anything.
 *
 * Ids Huis uses: "root" (My files), "sites" (SharePoint sites the person
 * follows), "site:<siteId>" (a site's document libraries) and
 * "drive:<driveId>:<itemId>" (a folder or file).
 */
export const ONEDRIVE_SCOPES = ["openid", "profile", "email", "offline_access", "User.Read", "Files.Read.All"];
export const INTEGRATION_OAUTH_COOKIE = "huis_integration_oauth";

/** Most entries Huis lists in one folder (the rest: "more than shown"). */
export const MAX_LISTED = 1000;

const PART = "[A-Za-z0-9!._-]{1,200}";
const DRIVE_ITEM = new RegExp(`^drive:(${PART}):(${PART})$`);
const SITE = /^site:([A-Za-z0-9,._-]{1,300})$/;

/** Splits a "drive:<driveId>:<itemId>" id, or null for anything else. */
export function driveItem(id: string): { drive: string; item: string } | null {
  const m = DRIVE_ITEM.exec(id);
  // "." and ".." would turn into other Graph paths once in a URL.
  if (!m || /^\.+$/.test(m[1]!) || /^\.+$/.test(m[2]!)) return null;
  return { drive: m[1]!, item: m[2]! };
}

interface GraphItem {
  id: string; name?: string; size?: number; lastModifiedDateTime?: string; cTag?: string; eTag?: string;
  file?: { mimeType?: string }; folder?: { childCount?: number }; root?: unknown;
  parentReference?: { driveId?: string; id?: string; path?: string };
}
type Page<T> = { value?: T[]; "@odata.nextLink"?: string };

const SELECT = "id,name,size,file,folder,root,lastModifiedDateTime,cTag,eTag,parentReference";
const text = (v: string | undefined | null, max: number) => (v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);

/** Where Microsoft's download links may point: its own file hosts (and, in tests, the configured Graph stand-in). */
export function downloadHostAllowed(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.origin === new URL(graphBase()).origin) return true;
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
  return /(^|\.)(sharepoint\.com|sharepoint-df\.com|files\.1drv\.com|1drv\.com|1drv\.ms|livefilestore\.com|onedrive\.com)$/i.test(u.hostname);
}

/**
 * The Microsoft account a token belongs to (its object id). Security review 20, R20-1: the worker checks it
 * against the account the connection was recorded for, so a token can't be filed under someone else's account.
 */
export async function onedriveAccountOid(accessToken: string): Promise<string | null> {
  const me = await graphJson<{ id?: string }>(accessToken, `${graphBase()}/me?$select=id`);
  return typeof me.id === "string" && /^[0-9a-f-]{36}$/i.test(me.id) ? me.id.toLowerCase() : null;
}

export class OneDriveSource implements FileSource {
  constructor(private readonly accessToken: string) {}

  private item(g: GraphItem, driveFallback: string | null): ListedItem | null {
    const drive = g.parentReference?.driveId ?? driveFallback;
    if (!drive || !g.id) return null;
    const id = `drive:${drive}:${g.id}`;
    if (!driveItem(id)) return null;
    return {
      id, kind: g.folder ? "folder" : "file", name: text(g.name, 300) || "(no name)",
      size: g.folder ? null : (typeof g.size === "number" ? g.size : null), modified: g.lastModifiedDateTime ?? null,
      version: g.folder ? null : (g.cTag ?? g.eTag ?? null), mime: g.file?.mimeType ?? null,
    };
  }

  /** Reads pages until MAX_LISTED; paging links must stay on Graph and move forward. */
  private async collect<T>(first: string, map: (x: T) => ListedItem | null): Promise<{ items: ListedItem[]; truncated: boolean }> {
    const items: ListedItem[] = [];
    const seen = new Set<string>();
    let next: string | undefined = first;
    let pages = 0;
    while (next) {
      if (++pages > 50 || seen.has(next)) throw new Error("the folder listing did not finish");
      seen.add(next);
      const page: Page<T> = await graphJson(this.accessToken, next);
      for (const x of page.value ?? []) {
        const it = map(x);
        if (it) items.push(it);
        if (items.length >= MAX_LISTED) return { items, truncated: Boolean(page["@odata.nextLink"]) || (page.value?.length ?? 0) > 0 };
      }
      next = page["@odata.nextLink"];
    }
    return { items, truncated: false };
  }

  private sortItems(items: ListedItem[]): ListedItem[] {
    const rank = { site: 0, folder: 1, file: 2 } as const;
    return items.sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name));
  }

  async list(location: string): Promise<Listing> {
    const g = graphBase();
    if (location === "root") {
      const r = await this.collect<GraphItem>(`${g}/me/drive/root/children?$top=200&$select=${SELECT}`, (x) => this.item(x, null));
      return {
        title: "My files", parent: null, truncated: r.truncated,
        items: [{ id: "sites", kind: "site", name: "SharePoint sites you follow" }, ...this.sortItems(r.items)],
      };
    }
    if (location === "sites") {
      const r = await this.collect<{ id: string; displayName?: string; name?: string }>(`${g}/me/followedSites`, (x) => {
        const id = `site:${x.id}`;
        return SITE.test(id) ? { id, kind: "site", name: text(x.displayName ?? x.name, 300) || "(unnamed site)" } : null;
      });
      return { title: "SharePoint sites you follow", parent: "root", items: this.sortItems(r.items), truncated: r.truncated };
    }
    const site = SITE.exec(location);
    if (site) {
      const r = await this.collect<{ id: string; name?: string }>(`${g}/sites/${encodeURIComponent(site[1]!)}/drives`, (x) => {
        const id = `drive:${x.id}:root`;
        return driveItem(id) ? { id, kind: "folder", name: text(x.name, 300) || "Documents" } : null;
      });
      return { title: "Document libraries", parent: "sites", items: this.sortItems(r.items), truncated: r.truncated };
    }
    const di = driveItem(location);
    if (!di) throw new Error("unknown folder");
    const base = `${g}/drives/${encodeURIComponent(di.drive)}/items/${encodeURIComponent(di.item)}`;
    const self = await graphJson<GraphItem>(this.accessToken, `${base}?$select=${SELECT}`);
    if (!self.folder && !self.root) throw new Error("that is not a folder");
    const r = await this.collect<GraphItem>(`${base}/children?$top=200&$select=${SELECT}`, (x) => this.item(x, di.drive));
    const parentId = self.parentReference?.id;
    const parent = self.root || !parentId ? "root" : `drive:${di.drive}:${parentId}`;
    return { title: text(self.name, 300) || "Folder", parent: driveItem(parent) || parent === "root" ? parent : "root",
      items: this.sortItems(r.items), truncated: r.truncated };
  }

  async describe(id: string): Promise<RemoteFile> {
    const di = driveItem(id);
    if (!di) throw new Error("unknown file");
    const x = await graphJson<GraphItem>(this.accessToken,
      `${graphBase()}/drives/${encodeURIComponent(di.drive)}/items/${encodeURIComponent(di.item)}?$select=${SELECT}`);
    if (!x.file) throw Object.assign(new Error("that is not a file"), { final: true });
    // "/drive/root:/Documents/Smith" → "/Documents/Smith"
    const where = x.parentReference?.path ? x.parentReference.path.replace(/^[^:]*:/, "") || "/" : null;
    const name = text(x.name, 300) || "(no name)";
    return {
      name, size: typeof x.size === "number" ? x.size : null, version: x.cTag ?? x.eTag ?? null, modified: x.lastModifiedDateTime ?? null,
      mime: x.file.mimeType ?? null, path: where === null ? null : text(`${where.replace(/\/$/, "")}/${name}`, 1000),
    };
  }

  /**
   * The file exactly as stored. Graph answers with a redirect to a short-lived
   * download link; the token is sent only to Graph, never to the download host,
   * and the link must point at Microsoft's own file hosts.
   */
  async download(id: string): Promise<Readable> {
    const di = driveItem(id);
    if (!di) throw new Error("unknown file");
    const url = `${graphBase()}/drives/${encodeURIComponent(di.drive)}/items/${encodeURIComponent(di.item)}/content`;
    // Security review 21, R21-2: every step has a time limit, and the download stops if no data arrives.
    const firstCall = await fetchDownload(url, { headers: { authorization: `Bearer ${this.accessToken}` }, redirect: "manual" });
    const first = firstCall.res;
    // Graph itself refusing the token means the account needs reconnecting.
    if (first.status === 401 || first.status === 403) {
      await first.body?.cancel().catch(() => undefined);
      throw Object.assign(new Error(`Microsoft Graph refused the download (${first.status})`), { reconnect: true });
    }
    let res: Response = first;
    let stream = firstCall.stream;
    let fromLink = false;
    if (first.status >= 300 && first.status < 400) {
      const to = first.headers.get("location");
      await first.body?.cancel().catch(() => undefined);
      if (!to) throw new Error("Microsoft did not give a download link");
      const target = new URL(to, url).toString();
      if (!downloadHostAllowed(target)) throw new Error("unexpected download link");
      const linkCall = await fetchDownload(target, { redirect: "error" });
      res = linkCall.res;
      stream = linkCall.stream;
      fromLink = true;
    }
    // (A file that comes straight back, without a redirect, came from Graph itself.)
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      // Security review 19, R19-4: a refused short-lived link (expired, or downloads blocked on that one
      // file) fails only this import; it says nothing about the account's sign-in.
      const err = new Error(`the file download failed (${res.status})`);
      (err as Error & { final?: boolean }).final = res.status === 404 || (fromLink && res.status === 403);
      throw err;
    }
    return stream();
  }
}
