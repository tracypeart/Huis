import { generateKeyPairSync } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createLocalJWKSet, exportJWK, SignJWT } from "jose";

// ---------------------------------------------------------------------------
// A stand-in for Microsoft's login and Graph mail services (no real mail).
// ---------------------------------------------------------------------------
export interface FakeMessage { id: string; folder: string; subject: string; from: string; to: string[]; received: string; body: string; mime: string; attachments?: boolean }

export const TID = "11111111-2222-3333-4444-555555555555";
export const OID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
export const CLIENT_ID = "834e42f3-7b16-4473-bb23-e9990b483139";

export interface FakeDriveItem { id: string; drive: string; name: string; parent: string | null; folder?: boolean; content?: string; mime?: string; ctag?: string; path?: string }

export class FakeMicrosoft {
  server!: http.Server;
  base = "";
  folders = [
    { id: "F-inbox", displayName: "Inbox", parentFolderId: "root", childFolderCount: 1, totalItemCount: 2 },
    { id: "F-sent", displayName: "Sent Items", parentFolderId: "root", childFolderCount: 0, totalItemCount: 1 },
  ];
  children: Record<string, { id: string; displayName: string; parentFolderId: string; childFolderCount: number; totalItemCount: number }[]> = {
    "F-inbox": [{ id: "F-smith", displayName: "Smith matter", parentFolderId: "F-inbox", childFolderCount: 0, totalItemCount: 1 }],
  };
  messages: FakeMessage[] = [];
  removed: string[] = [];
  rotateTo: string | null = null;
  refreshError: string | null = null;
  graphCalls: string[] = [];
  tokenCalls: Record<string, string>[] = [];
  /** A delta link to return instead of the real one (to test link checks). */
  deltaOverride: string | null = null;
  /** Misbehave: empty pages that always point to another page. */
  endlessEmptyPages = false;
  /** Raw JSON subject override (e.g. containing \u0000). */
  rawSubjects: Record<string, string> = {};
  /** OneDrive / SharePoint stand-in: drive "D1" is the person's own; "SP1" is a SharePoint library. */
  drive: Record<string, FakeDriveItem> = {};
  sites = [{ id: "contoso.sharepoint.com,1111,2222", displayName: "Litigation" }];
  siteDrives: Record<string, { id: string; name: string }[]> = { "contoso.sharepoint.com,1111,2222": [{ id: "b!SP1", name: "Documents" }] };
  /** Authorization headers seen by the download host (must stay empty). */
  downloadAuth: string[] = [];
  /** Where /content redirects (to test the download-host check). */
  downloadRedirect: ((d: string, i: string) => string) | null = null;
  privateKey!: CryptoKey | import("node:crypto").KeyObject;
  jwks!: ReturnType<typeof createLocalJWKSet>;
  idNonce = "";

  async start() {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.privateKey = privateKey;
    const jwk = await exportJWK(publicKey);
    this.jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: "k1", alg: "RS256", use: "sig" }] });
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  private json(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url!, this.base);
    if (url.pathname === "/common/oauth2/v2.0/token") {
      const body = new URLSearchParams(await new Promise<string>((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d)); }));
      this.tokenCalls.push(Object.fromEntries(body));
      if (this.refreshError && body.get("grant_type") === "refresh_token") return this.json(res, 400, { error: this.refreshError });
      const idToken = await new SignJWT({ tid: TID, oid: OID, nonce: this.idNonce, name: "Avery Attorney", preferred_username: "avery@lawfirm.example" })
        .setProtectedHeader({ alg: "RS256", kid: "k1" }).setAudience(CLIENT_ID).setIssuer(`https://login.microsoftonline.com/${TID}/v2.0`)
        .setIssuedAt().setExpirationTime("10m").sign(this.privateKey as never);
      return this.json(res, 200, { access_token: "AT-good", refresh_token: this.rotateTo ?? body.get("refresh_token") ?? "RT-1", id_token: idToken, expires_in: 3600 });
    }
    const dl = /^\/download\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (dl) {
      if (req.headers.authorization) this.downloadAuth.push(req.headers.authorization);
      const it = this.drive[decodeURIComponent(dl[2]!)];
      if (!it || it.content === undefined) return this.json(res, 404, { error: "not found" });
      res.writeHead(200, { "content-type": it.mime ?? "application/octet-stream" });
      return res.end(it.content);
    }
    if (req.headers.authorization !== "Bearer AT-good") return this.json(res, 401, { error: "unauthorized" });
    this.graphCalls.push(url.pathname + url.search);
    if (url.pathname === "/v1.0/me") return this.json(res, 200, { mail: "Avery@LawFirm.example", displayName: "Avery Attorney" });
    const driveJson = (it: FakeDriveItem) => ({
      id: it.id, name: it.name, lastModifiedDateTime: "2026-10-01T12:00:00Z",
      ...(it.folder ? { folder: { childCount: Object.values(this.drive).filter((x) => x.parent === it.id).length } }
        : { file: { mimeType: it.mime ?? "application/octet-stream" }, size: Buffer.byteLength(it.content ?? ""), cTag: it.ctag ?? `c-${it.id}-1`, eTag: `e-${it.id}` }),
      ...(it.parent === null ? { root: {} } : {}),
      parentReference: { driveId: it.drive, ...(it.parent ? { id: it.parent } : {}), path: it.path ?? "/drive/root:" },
    });
    if (url.pathname === "/v1.0/me/drive/root/children") {
      return this.json(res, 200, { value: Object.values(this.drive).filter((x) => x.drive === "D1" && x.parent === "D1-root").map(driveJson) });
    }
    if (url.pathname === "/v1.0/me/followedSites") return this.json(res, 200, { value: this.sites });
    const sd = /^\/v1\.0\/sites\/([^/]+)\/drives$/.exec(url.pathname);
    if (sd) return this.json(res, 200, { value: this.siteDrives[decodeURIComponent(sd[1]!)] ?? [] });
    const di = /^\/v1\.0\/drives\/([^/]+)\/items\/([^/]+)(\/children|\/content)?$/.exec(url.pathname);
    if (di) {
      const d = decodeURIComponent(di[1]!);
      let id = decodeURIComponent(di[2]!);
      if (id === "root") id = `${d}-root`;
      const it = this.drive[id];
      if (!it || it.drive !== d) return this.json(res, 404, { error: "itemNotFound" });
      if (di[3] === "/children") return this.json(res, 200, { value: Object.values(this.drive).filter((x) => x.parent === id).map(driveJson) });
      if (di[3] === "/content") {
        res.writeHead(302, { location: this.downloadRedirect ? this.downloadRedirect(d, id) : `${this.base}/download/${encodeURIComponent(d)}/${encodeURIComponent(id)}?tempauth=x` });
        return res.end();
      }
      return this.json(res, 200, driveJson(it));
    }
    if (url.pathname === "/v1.0/me/mailFolders") return this.json(res, 200, { value: this.folders });
    const child = /^\/v1\.0\/me\/mailFolders\/([^/]+)\/childFolders$/.exec(url.pathname);
    if (child) return this.json(res, 200, { value: this.children[decodeURIComponent(child[1]!)] ?? [] });
    const delta = /^\/v1\.0\/me\/mailFolders\/([^/]+)\/messages\/delta$/.exec(url.pathname);
    if (delta) {
      const folder = decodeURIComponent(delta[1]!);
      if (this.endlessEmptyPages) {
        const n = Number(url.searchParams.get("$skiptoken") ?? "0") + 1;
        return this.json(res, 200, { value: [], "@odata.nextLink": `${this.base}/v1.0/me/mailFolders/${encodeURIComponent(folder)}/messages/delta?$skiptoken=${n}` });
      }
      const token = url.searchParams.get("$deltatoken");
      const skip = Number(url.searchParams.get("$skiptoken") ?? "0");
      // A delta round returns changes since the token's moment (here: index into the list).
      const since = token ? Number(token) : 0;
      const all = this.messages.filter((m) => m.folder === folder);
      const changed = all.slice(since);
      const removed = token ? this.removed.map((id) => ({ id, "@removed": { reason: "deleted" } })) : [];
      const pageItems = [...changed.map((m) => this.graphMessage(m)), ...removed];
      const page = pageItems.slice(skip, skip + 2);
      const more = skip + 2 < pageItems.length;
      const nextLink = `${this.base}/v1.0/me/mailFolders/${encodeURIComponent(folder)}/messages/delta?${token ? `$deltatoken=${token}&` : ""}$skiptoken=${skip + 2}`;
      const deltaLink = this.deltaOverride ?? `${this.base}/v1.0/me/mailFolders/${encodeURIComponent(folder)}/messages/delta?$deltatoken=${all.length}`;
      return this.json(res, 200, { value: page, ...(more ? { "@odata.nextLink": nextLink } : { "@odata.deltaLink": deltaLink }) });
    }
    const mime = /^\/v1\.0\/me\/messages\/([^/]+)\/\$value$/.exec(url.pathname);
    if (mime) {
      const m = this.messages.find((x) => x.id === decodeURIComponent(mime[1]!));
      if (!m) return this.json(res, 404, { error: "not found" });
      res.writeHead(200, { "content-type": "message/rfc822" });
      return res.end(m.mime);
    }
    return this.json(res, 404, { error: "unknown" });
  }

  private graphMessage(m: FakeMessage) {
    return {
      id: m.id, internetMessageId: `<${m.id}@lawfirm.example>`, conversationId: `conv-${m.subject.replace(/^(re|fwd): /i, "")}`,
      subject: this.rawSubjects[m.id] ?? m.subject, from: { emailAddress: { address: m.from, name: m.from.split("@")[0] } },
      toRecipients: m.to.map((a) => ({ emailAddress: { address: a } })), ccRecipients: [],
      receivedDateTime: m.received, sentDateTime: m.received, hasAttachments: Boolean(m.attachments), importance: "normal",
      isRead: false, bodyPreview: m.body.slice(0, 100), body: { contentType: "text", content: m.body },
    };
  }
}

export function mimeOf(m: { subject: string; from: string; to: string[]; received: string; body: string; attachment?: { name: string; text: string } }): string {
  const head = [`From: ${m.from}`, `To: ${m.to.join(", ")}`, `Subject: ${m.subject}`, `Date: ${new Date(m.received).toUTCString()}`, "MIME-Version: 1.0"];
  if (!m.attachment) return [...head, "Content-Type: text/plain", "", m.body, ""].join("\r\n");
  return [...head, 'Content-Type: multipart/mixed; boundary="X"', "", "--X", "Content-Type: text/plain", "", m.body, "",
    "--X", `Content-Type: text/plain; name="${m.attachment.name}"`, `Content-Disposition: attachment; filename="${m.attachment.name}"`, "",
    m.attachment.text, "", "--X--", ""].join("\r\n");
}

