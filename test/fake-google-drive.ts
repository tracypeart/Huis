import { generateKeyPairSync } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createLocalJWKSet, exportJWK, SignJWT } from "jose";

// ---------------------------------------------------------------------------
// A stand-in for Google's sign-in, userinfo and the Drive API (no real files).
// ---------------------------------------------------------------------------
export const GDRIVE_CLIENT_ID = "5678-huis.apps.googleusercontent.com";
export const GDRIVE_SUB = "118877665544332211009";
export const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";

export interface FakeDriveFile {
  id: string; name: string; mimeType: string; content?: string;
  /** Binary files: the current revision id (and older ones, for downloads of an exact revision). */
  rev?: string; revisions?: Record<string, string>;
  /** Drive's version number (changes on every change). */
  version?: number;
  trashed?: boolean; canDownload?: boolean;
  /** False: the connected account can't open it (e.g. picked while signed in as someone else). */
  accessible?: boolean;
  /** Exported (converted) bytes for Google's own documents. */
  exported?: string;
}

export class FakeGoogleDrive {
  server!: http.Server;
  base = "";
  files: FakeDriveFile[] = [];
  grantedScope = `openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile ${DRIVE_FILE}`;
  refreshScope: string | null = null;
  refreshError: string | null = null;
  /** The account the token belongs to, as userinfo reports it. */
  tokenSub = GDRIVE_SUB;
  idNonce = "";
  calls: { path: string; auth: string | undefined }[] = [];
  exportStatus = 200;
  beforeDownload: (() => void) | null = null;
  privateKey!: import("node:crypto").KeyObject;
  jwks!: ReturnType<typeof createLocalJWKSet>;

  async start() {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.privateKey = privateKey;
    const jwk = await exportJWK(publicKey);
    this.jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: "gd1", alg: "RS256", use: "sig" }] });
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  private json(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private meta(f: FakeDriveFile) {
    const native = f.mimeType.startsWith("application/vnd.google-apps.");
    return {
      id: f.id, name: f.name, mimeType: f.mimeType, version: String(f.version ?? 1), modifiedTime: "2026-10-02T09:30:00.000Z",
      trashed: Boolean(f.trashed), capabilities: { canDownload: f.canDownload !== false },
      ...(native ? {} : { size: String(Buffer.byteLength(f.content ?? "")), headRevisionId: f.rev ?? "0Bx-rev-1" }),
    };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url!, this.base);
    if (url.pathname === "/token") {
      const body = new URLSearchParams(await new Promise<string>((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d)); }));
      if (body.get("grant_type") === "refresh_token") {
        if (this.refreshError) return this.json(res, 400, { error: this.refreshError });
        return this.json(res, 200, { access_token: "GDAT-good", expires_in: 3600, scope: this.refreshScope ?? this.grantedScope });
      }
      const idToken = await new SignJWT({ nonce: this.idNonce, email: "Avery@Drive-Firm.example", email_verified: true, name: "Avery Attorney" })
        .setProtectedHeader({ alg: "RS256", kid: "gd1" }).setAudience(GDRIVE_CLIENT_ID).setIssuer("https://accounts.google.com").setSubject(GDRIVE_SUB)
        .setIssuedAt().setExpirationTime("10m").sign(this.privateKey);
      return this.json(res, 200, { access_token: "GDAT-good", refresh_token: "GDRT-1", id_token: idToken, expires_in: 3600, scope: this.grantedScope });
    }
    this.calls.push({ path: url.pathname + url.search, auth: req.headers.authorization });
    if (req.headers.authorization !== "Bearer GDAT-good") return this.json(res, 401, { error: { code: 401 } });
    if (url.pathname === "/v1/userinfo") return this.json(res, 200, { sub: this.tokenSub, email: "avery@drive-firm.example" });
    const m = /^\/drive\/v3\/files\/([^/]+)(\/export|\/revisions\/([^/]+))?$/.exec(url.pathname);
    if (!m) return this.json(res, 404, { error: { code: 404 } });
    const f = this.files.find((x) => x.id === decodeURIComponent(m[1]!));
    if (!f || f.accessible === false) return this.json(res, 404, { error: { code: 404, message: "File not found" } });
    if (m[2] === "/export") {
      if (this.exportStatus !== 200) return this.json(res, this.exportStatus, { error: { code: this.exportStatus } });
      this.beforeDownload?.();
      res.writeHead(200, { "content-type": url.searchParams.get("mimeType") ?? "application/octet-stream" });
      return res.end(f.exported ?? "");
    }
    if (m[3]) {
      const rev = decodeURIComponent(m[3]);
      this.beforeDownload?.();
      const content = f.rev === rev ? f.content : f.revisions?.[rev];
      if (content === undefined) return this.json(res, 404, { error: { code: 404 } });
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(content);
    }
    if (url.searchParams.get("alt") === "media") {
      this.beforeDownload?.();
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(f.content ?? "");
    }
    return this.json(res, 200, this.meta(f));
  }
}
