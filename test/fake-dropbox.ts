import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// A stand-in for Dropbox's OAuth, API and content hosts (no real files).
// ---------------------------------------------------------------------------
export interface FakeDbxEntry { id: string; name: string; path: string; folder?: boolean; content?: string; rev?: string; revisions?: Record<string, string> }

export const DBX_ACCOUNT = "dbid:AAH4f99T0taONIb-OurWxbNQ6ywGRopQngc";

export class FakeDropbox {
  server!: http.Server;
  base = "";
  entries: FakeDbxEntry[] = [];
  /** Scopes granted at sign-in (to test a person unticking permissions). */
  grantedScope = "account_info.read files.metadata.read files.content.read";
  accountId = DBX_ACCOUNT;
  tokenAccountId: string | null = null;
  refreshError: string | null = null;
  calls: { host: string; path: string; auth: string | undefined; arg: string | undefined; body: string }[] = [];
  /** Called before a download is served (to change the file mid-copy). */
  beforeDownload: (() => void) | null = null;
  pageSize = 500;
  /** Extra sign-ins (another person's own Dropbox): refresh token -> access token -> account id. */
  refreshTokens: Record<string, string> = {};
  accessAccounts: Record<string, string> = {};

  async start() {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  private json(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private meta(e: FakeDbxEntry) {
    return e.folder
      ? { ".tag": "folder", id: e.id, name: e.name, path_display: e.path, path_lower: e.path.toLowerCase() }
      : { ".tag": "file", id: e.id, name: e.name, path_display: e.path, path_lower: e.path.toLowerCase(), size: Buffer.byteLength(e.content ?? ""),
          rev: e.rev ?? "015f0e1a2b3c4d5e6f0001", server_modified: "2026-10-02T09:30:00Z", client_modified: "2026-10-02T09:30:00Z" };
  }

  private find(path: string): FakeDbxEntry | undefined {
    return path.startsWith("id:") ? this.entries.find((e) => e.id === path) : this.entries.find((e) => e.path.toLowerCase() === path.toLowerCase());
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url!, this.base);
    const body = await new Promise<string>((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d)); });
    this.calls.push({ host: url.host, path: url.pathname, auth: req.headers.authorization, arg: req.headers["dropbox-api-arg"] as string | undefined, body });
    if (url.pathname === "/oauth2/token") {
      const p = new URLSearchParams(body);
      if (this.refreshError && p.get("grant_type") === "refresh_token") return this.json(res, 400, { error: this.refreshError });
      const at = (p.get("grant_type") === "refresh_token" && this.refreshTokens[p.get("refresh_token") ?? ""]) || "DBX-AT";
      return this.json(res, 200, {
        access_token: at, token_type: "bearer", expires_in: 14400, scope: this.grantedScope,
        account_id: this.accessAccounts[at] ?? this.tokenAccountId ?? this.accountId,
        ...(p.get("grant_type") === "authorization_code" ? { refresh_token: "DBX-RT-1" } : {}),
      });
    }
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (bearer !== "DBX-AT" && !(bearer in this.accessAccounts)) return this.json(res, 401, { error_summary: "invalid_access_token/" });
    if (url.pathname === "/2/users/get_current_account") {
      return this.json(res, 200, { account_id: this.accessAccounts[bearer] ?? this.accountId, email: "Avery@LawFirm.example", email_verified: true, name: { display_name: "Avery Attorney" } });
    }
    const arg = (() => { try { return JSON.parse(body || "{}"); } catch { return {}; } })() as { path?: string; cursor?: string };
    if (url.pathname === "/2/files/get_metadata") {
      const e = this.find(arg.path ?? "");
      return e ? this.json(res, 200, this.meta(e)) : this.json(res, 409, { error_summary: "path/not_found/" });
    }
    if (url.pathname === "/2/files/list_folder" || url.pathname === "/2/files/list_folder/continue") {
      let dir: string;
      let offset = 0;
      if (url.pathname.endsWith("continue")) {
        const [d, o] = (arg.cursor ?? "").split("|");
        dir = d!; offset = Number(o);
      } else {
        const f = arg.path ? this.find(arg.path) : { path: "" } as FakeDbxEntry;
        if (!f) return this.json(res, 409, { error_summary: "path/not_found/" });
        dir = f.path;
      }
      const kids = this.entries.filter((e) => e.path.slice(0, e.path.lastIndexOf("/")).toLowerCase() === dir.toLowerCase());
      const page = kids.slice(offset, offset + this.pageSize);
      const more = offset + this.pageSize < kids.length;
      return this.json(res, 200, { entries: page.map((e) => this.meta(e)), cursor: `${dir}|${offset + this.pageSize}`, has_more: more });
    }
    if (url.pathname === "/2/files/download") {
      this.beforeDownload?.();
      const a = JSON.parse((req.headers["dropbox-api-arg"] as string) ?? "{}") as { path?: string };
      let content: string | undefined;
      if (a.path?.startsWith("rev:")) {
        const rev = a.path.slice(4);
        const e = this.entries.find((x) => x.rev === rev || (x.revisions && rev in x.revisions));
        content = e ? (e.rev === rev ? e.content : e.revisions![rev]) : undefined;
      } else {
        content = this.find(a.path ?? "")?.content;
      }
      if (content === undefined) return this.json(res, 409, { error_summary: "path/not_found/" });
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(content);
    }
    return this.json(res, 404, { error: "unknown" });
  }
}
