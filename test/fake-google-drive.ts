import { generateKeyPairSync } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createLocalJWKSet, exportJWK, SignJWT } from "jose";

// ---------------------------------------------------------------------------
// A stand-in for Google's sign-in, userinfo and the Drive API (no real files).
// Like drive.file, Huis's token sees only the files marked as chosen for it.
// ---------------------------------------------------------------------------
export interface FakeDriveFile {
  id: string; name: string; mime?: string; content?: string; rev?: string; revisions?: Record<string, string>;
  /** Chosen for Huis in the picker (drive.file shows nothing else). */
  chosen?: boolean; trashed?: boolean; modified?: string;
}

export const DRIVE_CLIENT_ID = "5678-huis.apps.googleusercontent.com";
export const DRIVE_SUB = "104857600000000000001";
export const DRIVE_SCOPE = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file";

export class FakeGoogleDrive {
  server!: http.Server;
  base = "";
  files: FakeDriveFile[] = [];
  grantedScope = DRIVE_SCOPE;
  /** Scope reported when a refresh token is used (null: the same as at sign-in). */
  refreshScope: string | null = null;
  refreshError: string | null = null;
  /** The account the sign-in's ID token names, and the one userinfo reports for the default token. */
  idSub = DRIVE_SUB;
  sub = DRIVE_SUB;
  idNonce = "";
  pageSize = 200;
  /** Answer downloads with a redirect to this address (to test where Huis follows them). */
  redirectDownloadTo: string | null = null;
  /** Called before a download is served (to change the file mid-copy). */
  beforeDownload: (() => void) | null = null;
  /** Extra sign-ins (another person's own Google account): refresh token -> access token -> sub. */
  refreshTokens: Record<string, string> = {};
  accessSubs: Record<string, string> = {};
  calls: { path: string; query: string; auth: string | undefined; body: string }[] = [];
  privateKey!: import("node:crypto").KeyObject;
  jwks!: ReturnType<typeof createLocalJWKSet>;

  async start() {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.privateKey = privateKey;
    const jwk = await exportJWK(publicKey);
    this.jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: "d1", alg: "RS256", use: "sig" }] });
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  reset() {
    this.files = []; this.grantedScope = DRIVE_SCOPE; this.refreshScope = null; this.refreshError = null; this.idSub = DRIVE_SUB; this.sub = DRIVE_SUB;
    this.idNonce = ""; this.pageSize = 200; this.redirectDownloadTo = null; this.beforeDownload = null; this.refreshTokens = {}; this.accessSubs = {}; this.calls = [];
  }

  private json(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private meta(f: FakeDriveFile) {
    return { id: f.id, name: f.name, mimeType: f.mime ?? "text/plain", size: f.mime?.startsWith("application/vnd.google-apps.") ? undefined : String(Buffer.byteLength(f.content ?? "")),
      modifiedTime: f.modified ?? "2026-10-02T09:30:00.000Z", headRevisionId: f.mime?.startsWith("application/vnd.google-apps.") ? undefined : (f.rev ?? "0B1revAAAA"), trashed: Boolean(f.trashed) };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url!, this.base);
    const body = await new Promise<string>((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d)); });
    this.calls.push({ path: url.pathname, query: url.search, auth: req.headers.authorization, body });
    if (url.pathname === "/token") {
      const p = new URLSearchParams(body);
      if (p.get("grant_type") === "refresh_token") {
        if (this.refreshError) return this.json(res, 400, { error: this.refreshError });
        const at = this.refreshTokens[p.get("refresh_token") ?? ""] ?? "GDA-good";
        return this.json(res, 200, { access_token: at, expires_in: 3600, scope: this.refreshScope ?? this.grantedScope });
      }
      const idToken = await new SignJWT({ nonce: this.idNonce, email: "Avery@Drive-Firm.example", email_verified: true, name: "Avery Attorney" })
        .setProtectedHeader({ alg: "RS256", kid: "d1" }).setAudience(DRIVE_CLIENT_ID).setIssuer("https://accounts.google.com").setSubject(this.idSub)
        .setIssuedAt().setExpirationTime("10m").sign(this.privateKey);
      return this.json(res, 200, { access_token: "GDA-good", refresh_token: "GDRT-1", id_token: idToken, expires_in: 3600, scope: this.grantedScope });
    }
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (url.pathname === "/content") {
      // Google's content host: never given the token.
      if (req.headers.authorization) return this.json(res, 400, { error: "token sent to the content host" });
      const f = this.files.find((x) => x.id === url.searchParams.get("id"));
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(f?.content ?? "");
    }
    if (bearer !== "GDA-good" && !(bearer in this.accessSubs)) return this.json(res, 401, { error: { code: 401 } });
    if (url.pathname === "/userinfo") return this.json(res, 200, { sub: this.accessSubs[bearer] ?? this.sub, email: "avery@drive-firm.example" });
    // drive.file: only files chosen for Huis by this account exist, as far as Huis's token can tell.
    const mine = this.files.filter((f) => f.chosen && !(bearer in this.accessSubs));
    if (url.pathname === "/drive/v3/files") {
      const live = mine.filter((f) => !f.trashed);
      const start = Number(url.searchParams.get("pageToken") ?? "0");
      const page = live.slice(start, start + this.pageSize);
      const more = start + this.pageSize < live.length;
      return this.json(res, 200, { files: page.map((f) => this.meta(f)), ...(more ? { nextPageToken: String(start + this.pageSize) } : {}) });
    }
    const rev = /^\/drive\/v3\/files\/([^/]+)\/revisions\/([^/]+)$/.exec(url.pathname);
    if (rev) {
      this.beforeDownload?.();
      const f = mine.find((x) => x.id === decodeURIComponent(rev[1]!));
      const r = decodeURIComponent(rev[2]!);
      const content = f ? ((f.rev ?? "0B1revAAAA") === r ? f.content : f.revisions?.[r]) : undefined;
      if (content === undefined || url.searchParams.get("alt") !== "media") return this.json(res, 404, { error: { code: 404 } });
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(content);
    }
    const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (one) {
      const f = mine.find((x) => x.id === decodeURIComponent(one[1]!));
      if (!f) return this.json(res, 404, { error: { code: 404, message: "File not found." } });
      if (url.searchParams.get("alt") === "media") {
        this.beforeDownload?.();
        if (this.redirectDownloadTo) { res.writeHead(302, { location: this.redirectDownloadTo }); return res.end(); }
        res.writeHead(200, { "content-type": "application/octet-stream" });
        return res.end(f.content ?? "");
      }
      return this.json(res, 200, this.meta(f));
    }
    return this.json(res, 404, { error: "unknown" });
  }
}
