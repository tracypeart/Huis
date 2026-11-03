import { generateKeyPairSync } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createLocalJWKSet, exportJWK, SignJWT } from "jose";

// ---------------------------------------------------------------------------
// A stand-in for Google's sign-in and Gmail API (no real mail).
// ---------------------------------------------------------------------------
export interface FakeGmailMessage {
  id: string; threadId: string; labels: string[]; subject: string; from: string; to: string[]; cc?: string[];
  received: string; body: string; html?: boolean; mime: string; attachment?: boolean;
}

export const GOOGLE_CLIENT_ID = "1234-huis.apps.googleusercontent.com";
export const GOOGLE_SUB = "109876543210987654321";

export class FakeGoogle {
  server!: http.Server;
  base = "";
  labels = [
    { id: "INBOX", name: "INBOX", type: "system" }, { id: "SENT", name: "SENT", type: "system" },
    { id: "SPAM", name: "SPAM", type: "system" }, { id: "TRASH", name: "TRASH", type: "system" },
    { id: "DRAFT", name: "DRAFT", type: "system" }, { id: "UNREAD", name: "UNREAD", type: "system" },
    { id: "STARRED", name: "STARRED", type: "system" }, { id: "IMPORTANT", name: "IMPORTANT", type: "system" },
    { id: "CATEGORY_UPDATES", name: "CATEGORY_UPDATES", type: "system" },
    { id: "Label_1", name: "Clients", type: "user" }, { id: "Label_2", name: "Clients/Smith", type: "user" },
  ];
  messages: FakeGmailMessage[] = [];
  /** History: each change gets the next id. */
  historyId = 1000;
  events: { h: number; kind: "added" | "deleted" | "labels"; id: string }[] = [];
  /** History before this id is "expired" (Gmail keeps about a week). */
  expiredBefore = 0;
  grantedScope = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/gmail.readonly";
  refreshError: string | null = null;
  idAudience = GOOGLE_CLIENT_ID;
  idIssuer = "https://accounts.google.com";
  idNonce = "";
  /** A page token to return instead of the real one (to test checks). */
  pageTokenOverride: string | null = null;
  calls: string[] = [];
  privateKey!: import("node:crypto").KeyObject;
  jwks!: ReturnType<typeof createLocalJWKSet>;

  async start() {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.privateKey = privateKey;
    const jwk = await exportJWK(publicKey);
    this.jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: "g1", alg: "RS256", use: "sig" }] });
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  reset() {
    this.messages = []; this.events = []; this.historyId = 1000; this.expiredBefore = 0; this.refreshError = null;
    this.idAudience = GOOGLE_CLIENT_ID; this.idIssuer = "https://accounts.google.com"; this.pageTokenOverride = null; this.calls = [];
    this.grantedScope = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/gmail.readonly";
  }

  add(m: FakeGmailMessage) { this.messages.push(m); this.events.push({ h: ++this.historyId, kind: "added", id: m.id }); }
  remove(id: string) { this.messages = this.messages.filter((m) => m.id !== id); this.events.push({ h: ++this.historyId, kind: "deleted", id }); }
  relabel(id: string, labels: string[]) { this.messages.find((m) => m.id === id)!.labels = labels; this.events.push({ h: ++this.historyId, kind: "labels", id }); }

  private json(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url!, this.base);
    if (url.pathname === "/token") {
      const body = new URLSearchParams(await new Promise<string>((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d)); }));
      if (body.get("grant_type") === "refresh_token") {
        if (this.refreshError) return this.json(res, 400, { error: this.refreshError });
        return this.json(res, 200, { access_token: "GAT-good", expires_in: 3600, scope: this.grantedScope });
      }
      const idToken = await new SignJWT({ nonce: this.idNonce, email: "avery@gmail-firm.example", email_verified: true, name: "Avery Attorney" })
        .setProtectedHeader({ alg: "RS256", kid: "g1" }).setAudience(this.idAudience).setIssuer(this.idIssuer).setSubject(GOOGLE_SUB)
        .setIssuedAt().setExpirationTime("10m").sign(this.privateKey);
      return this.json(res, 200, { access_token: "GAT-good", refresh_token: "GRT-1", id_token: idToken, expires_in: 3600, scope: this.grantedScope });
    }
    if (req.headers.authorization !== "Bearer GAT-good") return this.json(res, 401, { error: "unauthorized" });
    this.calls.push(url.pathname + url.search);
    const p = url.pathname.replace(/^\/gmail\/v1\/users\/me/, "");
    if (p === "/profile") return this.json(res, 200, { emailAddress: "Avery@Gmail-Firm.example", historyId: String(this.historyId) });
    if (p === "/labels") return this.json(res, 200, { labels: this.labels });
    if (p === "/messages") {
      const all = this.messages.filter((m) => url.searchParams.get("includeSpamTrash") === "true" || !m.labels.some((l) => l === "SPAM" || l === "TRASH"));
      const start = Number((url.searchParams.get("pageToken") ?? "p0").slice(1));
      const page = all.slice(start, start + 2);
      const more = start + 2 < all.length;
      return this.json(res, 200, { messages: page.map((m) => ({ id: m.id, threadId: m.threadId })),
        ...(more ? { nextPageToken: this.pageTokenOverride ?? `p${start + 2}` } : {}) });
    }
    const one = /^\/messages\/([^/]+)$/.exec(p);
    if (one) {
      const m = this.messages.find((x) => x.id === decodeURIComponent(one[1]!));
      if (!m) return this.json(res, 404, { error: { code: 404 } });
      if (url.searchParams.get("format") === "raw") return this.json(res, 200, { id: m.id, raw: Buffer.from(m.mime).toString("base64url") });
      return this.json(res, 200, this.full(m));
    }
    if (p === "/history") {
      const start = Number(url.searchParams.get("startHistoryId"));
      if (start < this.expiredBefore) return this.json(res, 404, { error: { code: 404, message: "Requested entity was not found." } });
      const all = this.events.filter((e) => e.h > start);
      const off = Number((url.searchParams.get("pageToken") ?? "h0").slice(1));
      const page = all.slice(off, off + 2);
      const more = off + 2 < all.length;
      const msg = (id: string) => ({ message: { id, threadId: "t" } });
      return this.json(res, 200, {
        history: page.map((e) => ({ id: String(e.h),
          ...(e.kind === "added" ? { messagesAdded: [msg(e.id)] } : e.kind === "deleted" ? { messagesDeleted: [msg(e.id)] } : { labelsAdded: [{ ...msg(e.id), labelIds: [] }] }) })),
        historyId: String(this.historyId),
        ...(more ? { nextPageToken: this.pageTokenOverride ?? `h${off + 2}` } : {}),
      });
    }
    return this.json(res, 404, { error: "unknown" });
  }

  private full(m: FakeGmailMessage) {
    const b64 = (s: string) => Buffer.from(s).toString("base64url");
    const headers = [
      { name: "From", value: m.from }, { name: "To", value: m.to.join(", ") }, ...(m.cc ? [{ name: "Cc", value: m.cc.join(", ") }] : []),
      { name: "Subject", value: m.subject }, { name: "Date", value: new Date(m.received).toUTCString() },
      { name: "Message-ID", value: `<${m.id}@mail.gmail.example>` },
    ];
    const text = m.html
      ? { mimeType: "text/html", body: { data: b64(`<html><body><p>${m.body}</p><script>alert(1)</script></body></html>`) } }
      : { mimeType: "text/plain", body: { data: b64(m.body) } };
    const parts = [text, ...(m.attachment ? [{ mimeType: "application/pdf", filename: "notice.pdf", body: { attachmentId: "A1", size: 100 } }] : [])];
    return {
      id: m.id, threadId: m.threadId, labelIds: m.labels, snippet: m.body.slice(0, 100), internalDate: String(Date.parse(m.received)),
      payload: { mimeType: "multipart/mixed", headers, parts },
    };
  }
}
