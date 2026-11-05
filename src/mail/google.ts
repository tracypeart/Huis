import { Readable } from "node:stream";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { pkceChallenge } from "../auth/microsoft";
import { UserFacingError } from "../errors";
import type { MailboxPage, MailFolderInfo, MailMessageInfo, MailProvider } from "./provider";
import { fetchDownload, fetchWithTimeout } from "../net/http";

/**
 * Gmail / Google Workspace mailboxes through the Gmail API.
 *
 * Permissions requested (the signed-in attorney's own consent):
 *   openid email profile https://www.googleapis.com/auth/gmail.readonly
 * gmail.readonly is read-only: Huis can't send, change or delete mail.
 * It is a Google "restricted" scope: outside Google's test-user list it
 * requires Google's app verification and an annual CASA assessment.
 *
 * Labels are shown as folders. One Gmail message can carry several labels;
 * Huis files it under the first chosen label in a fixed order (Inbox, Sent,
 * Starred, Important, then your own labels), or "No label" for archived mail.
 * Spam, Trash and Drafts are never brought into Huis.
 *
 * Access tokens live only in memory for one sync; the refresh token is
 * encrypted at rest. Tokens are only ever sent to the Google hosts
 * configured here, and every Gmail URL is built by Huis (Gmail's paging
 * tokens are checked and passed as parameters, never followed as links).
 */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GOOGLE_MAIL_SCOPES = ["openid", "email", "profile", GMAIL_SCOPE];
/** Huis's own folder for Gmail mail that has none of the listed labels (archived). */
export const GMAIL_NO_LABEL = "HUIS_NO_LABEL";

/** Never brought into Huis. */
const EXCLUDED = new Set(["SPAM", "TRASH", "DRAFT"]);
/** System labels shown as folders, in the order that decides an email's folder. */
const SYSTEM_FOLDERS: [string, string][] = [["INBOX", "Inbox"], ["SENT", "Sent"], ["STARRED", "Starred"], ["IMPORTANT", "Important"]];

export function googleAuthBase(): string { return (process.env.HUIS_GOOGLE_AUTH_BASE ?? "https://accounts.google.com").replace(/\/$/, ""); }
export function googleTokenBase(): string { return (process.env.HUIS_GOOGLE_TOKEN_BASE ?? "https://oauth2.googleapis.com").replace(/\/$/, ""); }
export function gmailBase(): string { return (process.env.HUIS_GMAIL_BASE ?? "https://gmail.googleapis.com/gmail/v1/users/me").replace(/\/$/, ""); }

const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
let remoteJwks: JWTVerifyGetKey | null = null;
function googleKeys(): JWTVerifyGetKey {
  remoteJwks ??= createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
  return remoteJwks;
}

export function gmailAuthorizeUrl(p: { clientId: string; redirectUri: string; state: string; nonce: string; verifier: string }): string {
  const url = new URL(`${googleAuthBase()}/o/oauth2/v2/auth`);
  url.search = new URLSearchParams({
    client_id: p.clientId,
    response_type: "code",
    redirect_uri: p.redirectUri,
    scope: GOOGLE_MAIL_SCOPES.join(" "),
    state: p.state,
    nonce: p.nonce,
    code_challenge: pkceChallenge(p.verifier),
    code_challenge_method: "S256",
    // A refresh token is only issued with offline access and fresh consent.
    access_type: "offline",
    prompt: "consent select_account",
  }).toString();
  return url.toString();
}

export interface TokenResponse { access_token?: string; refresh_token?: string; id_token?: string; scope?: string; error?: string }

/** Google's token endpoint (shared with the Integration Hub's Google Drive adapter). */
export async function googleTokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  return tokenRequest(params);
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetchWithTimeout(`${googleTokenBase()}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    redirect: "error",
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !body.access_token) {
    // Only Google's short error codes are kept: never raw text from the response.
    const code = typeof body.error === "string" && /^[a-z_]{1,40}$/.test(body.error) ? body.error : String(res.status);
    const err = new Error(`Google token request failed (${code})`);
    (err as Error & { reconnect?: boolean }).reconnect = body.error === "invalid_grant" || body.error === "unauthorized_client";
    throw err;
  }
  return body;
}

/** Verifies signature, audience, issuer, nonce and expiry of a Google ID token. Identity key: Google's stable "sub". */
export async function verifyGoogleIdToken(idToken: string, opts: { clientId: string; nonce: string; keys?: JWTVerifyGetKey }): Promise<{ subject: string; name: string | null; email: string | null }> {
  const { payload } = await jwtVerify(idToken, opts.keys ?? googleKeys(), {
    audience: opts.clientId, issuer: GOOGLE_ISSUERS, algorithms: ["RS256"], clockTolerance: 60,
  });
  if (payload.nonce !== opts.nonce) throw new Error("Google sign-in token nonce mismatch.");
  if (typeof payload.sub !== "string" || !/^[0-9]{1,64}$/.test(payload.sub)) throw new Error("Google sign-in token has no user id.");
  return {
    subject: payload.sub,
    name: typeof payload.name === "string" && payload.name.trim() ? payload.name.trim().slice(0, 300) : null,
    email: typeof payload.email === "string" && payload.email_verified === true ? payload.email : null,
  };
}

export interface ConnectedGmail { subject: string; address: string | null; displayName: string; refreshToken: string }

/** Completes the connect flow: exchanges the code, verifies who signed in, checks Gmail access was granted, reads the address. */
export async function completeGmailConnect(p: {
  clientId: string; clientSecret: string; redirectUri: string; code: string; verifier: string; nonce: string; keys?: JWTVerifyGetKey;
}): Promise<ConnectedGmail> {
  const t = await tokenRequest({
    client_id: p.clientId, client_secret: p.clientSecret, grant_type: "authorization_code", code: p.code,
    redirect_uri: p.redirectUri, code_verifier: p.verifier,
  });
  if (!t.id_token || !t.refresh_token) throw new Error("Google did not grant offline mailbox access");
  // Google lets people untick permissions on the consent screen.
  if (!(t.scope ?? "").split(" ").includes(GMAIL_SCOPE)) {
    throw new UserFacingError("Huis needs permission to read Gmail. Please connect again and allow \"View your email messages and settings\".");
  }
  const identity = await verifyGoogleIdToken(t.id_token, { clientId: p.clientId, nonce: p.nonce, keys: p.keys });
  const profile = await gmailJson<{ emailAddress?: string }>(t.access_token!, `${gmailBase()}/profile`);
  const address = (profile.emailAddress ?? identity.email ?? null)?.toLowerCase().slice(0, 320) ?? null;
  return { subject: identity.subject, address, displayName: identity.name ?? address ?? "Gmail user", refreshToken: t.refresh_token };
}

/** Exchanges a refresh token for an access token. */
export async function refreshGoogleAccess(p: { clientId: string; clientSecret: string; refreshToken: string }): Promise<{ accessToken: string; refreshToken: string }> {
  const t = await tokenRequest({ client_id: p.clientId, client_secret: p.clientSecret, grant_type: "refresh_token", refresh_token: p.refreshToken });
  return { accessToken: t.access_token!, refreshToken: t.refresh_token ?? p.refreshToken };
}

/** Only Gmail API URLs ever receive the access token. */
function checkGmailUrl(url: string): string {
  const base = new URL(gmailBase());
  const u = new URL(url);
  if (u.origin !== base.origin || !(u.pathname === base.pathname || u.pathname.startsWith(`${base.pathname}/`))) throw new Error("unexpected Gmail link");
  return u.toString();
}

/** One Gmail call, with time limits (security review 22): the answer must start in time and keep flowing. */
async function gmailFetch(token: string, url: string): Promise<{ res: Response; stream: () => Readable }> {
  const target = checkGmailUrl(url);
  for (let attempt = 0; ; attempt++) {
    const call = await fetchDownload(target, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, redirect: "error" });
    const res = call.res;
    // Google rate-limits busy mailboxes (429, or 403 with a rate-limit reason): back off a few times.
    if ((res.status === 429 || res.status === 500 || res.status === 503) && attempt < 3) {
      // Short waits only, so one mailbox can't hold the worker (or outlast its lock).
      const wait = Math.min(10, Number(res.headers.get("retry-after") ?? String(2 ** attempt * 2)) || 5);
      await res.body?.cancel().catch(() => undefined);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      const err = new Error(`Gmail request failed (${res.status})`);
      (err as Error & { reconnect?: boolean; status?: number }).reconnect = res.status === 401;
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    return call;
  }
}

/** Largest JSON response read (checked while reading). Raw messages (base64) get more room. */
const MAX_JSON_BYTES = 50 * 1024 * 1024;
// Gmail's largest message is 50 MB, about 68 MB as base64.
const MAX_RAW_JSON_BYTES = 100 * 1024 * 1024;

async function gmailJson<T>(token: string, url: string, max = MAX_JSON_BYTES): Promise<T> {
  const { res, stream } = await gmailFetch(token, url);
  if (!res.body) return {} as T;
  const body = stream();
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += (chunk as Buffer).length;
    if (size > max) { body.destroy(); throw new Error("Gmail response too large"); }
    parts.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8")) as T;
  } catch {
    // Never echo the response: it may be mail content.
    throw new Error("Gmail sent an unreadable response");
  }
}

/** Text from Gmail, minus NUL characters (Postgres can't store them in text). */
const clean = (v: string | null | undefined): string | null => (v == null ? null : v.replace(/\u0000/g, ""));

/** Gmail ids, history ids and page tokens: checked before being stored or sent back. */
const ID = /^[A-Za-z0-9_-]{1,200}$/;
const TOKEN = /^[A-Za-z0-9_\-.~]{1,2000}$/;
const HISTORY = /^[0-9]{1,30}$/;

interface GmailPart {
  mimeType?: string; filename?: string; headers?: { name?: string; value?: string }[];
  body?: { size?: number; data?: string; attachmentId?: string }; parts?: GmailPart[];
}
interface GmailMessage {
  id: string; threadId?: string; labelIds?: string[]; snippet?: string; internalDate?: string; payload?: GmailPart;
}

const MAX_BODY_CHARS = 1_000_000;

function decode(data: unknown): string {
  if (typeof data !== "string" || !data) return "";
  return Buffer.from(data, "base64url").toString("utf8");
}

/** Removes <script>, <style> and <head> blocks with a single forward scan (no regex backtracking). */
function dropBlocks(html: string): string {
  const lower = html.replace(/[A-Z]/g, (c) => c.toLowerCase()); // same length as html
  let out = "";
  let i = 0;
  for (;;) {
    let start = -1;
    let tag = "";
    for (const t of ["script", "style", "head"]) {
      const at = lower.indexOf(`<${t}`, i);
      if (at !== -1 && (start === -1 || at < start)) { start = at; tag = t; }
    }
    if (start === -1) return out + html.slice(i);
    out += html.slice(i, start) + " ";
    const end = lower.indexOf(`</${tag}`, start);
    if (end === -1) return out;
    const close = lower.indexOf(">", end);
    if (close === -1) return out;
    i = close + 1;
  }
}

/** Largest HTML reduced to text (bigger HTML is cut first). */
const MAX_HTML_CHARS = 2_000_000;

function htmlToText(html: string): string {
  return dropBlocks(html.slice(0, MAX_HTML_CHARS))
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    // Linear: a tag can't contain another "<", so nothing is rescanned.
    .replace(/<[^<>]*>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, "\"").replace(/&#39;/gi, "'").replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}

/** Body text (plain text preferred, else HTML reduced to text), and whether there are attachments. Bounded depth. */
function readParts(root: GmailPart | undefined): { text: string; hasAttachments: boolean } {
  let plain = "";
  let html = "";
  let hasAttachments = false;
  let visited = 0;
  const walk = (p: GmailPart, depth: number) => {
    if (depth > 20 || ++visited > 500) return;
    const type = typeof p.mimeType === "string" ? p.mimeType.toLowerCase() : "";
    if (typeof p.filename === "string" && p.filename) hasAttachments = true;
    else if (type === "text/plain" && plain.length < MAX_BODY_CHARS) plain = (plain + decode(p.body?.data)).slice(0, MAX_BODY_CHARS);
    else if (type === "text/html" && html.length < MAX_HTML_CHARS) html = (html + decode(p.body?.data)).slice(0, MAX_HTML_CHARS);
    if (Array.isArray(p.parts)) for (const c of p.parts) if (c && typeof c === "object") walk(c, depth + 1);
  };
  if (root) walk(root, 0);
  return { text: (plain || htmlToText(html)).slice(0, MAX_BODY_CHARS), hasAttachments };
}

/** Address headers: split on separators, then check each piece (linear time; no backtracking). */
const ADDRESS_SEPARATORS = /[\s<>(),;:"']+/;
const ADDRESS = /^[^@]+@[^@]+\.[^@]+$/;
const MAX_HEADER_CHARS = 64_000;
function addresses(header: string | undefined): string[] {
  const out = new Set<string>();
  for (const piece of (header ?? "").slice(0, MAX_HEADER_CHARS).split(ADDRESS_SEPARATORS)) {
    if (piece.length <= 320 && ADDRESS.test(piece)) out.add(piece.toLowerCase());
    if (out.size >= 500) break;
  }
  return [...out];
}
function displayName(header: string | undefined): string | null {
  const h = header ?? "";
  const lt = h.indexOf("<");
  if (lt <= 0) return null;
  const name = h.slice(0, lt).trim().replace(/^"|"$/g, "").trim();
  return name ? name.slice(0, 300) : null;
}

/** Turns a Gmail message into Huis's shape (with its labels, which decide its folder). */
export function toMailMessage(m: GmailMessage): MailMessageInfo & { labels: string[] } {
  const labels = (Array.isArray(m.labelIds) ? m.labelIds : []).filter((l): l is string => typeof l === "string" && ID.test(l));
  try {
    return readMessage(m, labels);
  } catch {
    // Something unexpected in one message: keep it (so it can still be opened and filed), without the unreadable details.
    return { id: m.id, removed: false, labels, internetMessageId: null, conversationId: null, subject: "(message Huis couldn't read)",
      fromAddress: null, fromName: null, to: [], cc: [], receivedAt: null, sentAt: null, hasAttachments: false, importance: null,
      isRead: null, preview: null, body: null };
  }
}

/** A date Huis (and Postgres) can store, or null. */
function safeDate(ms: number): string | null {
  return Number.isFinite(ms) && ms > 0 && ms < 8_640_000_000_000_000 ? new Date(ms).toISOString() : null;
}

function readMessage(m: GmailMessage, labels: string[]): MailMessageInfo & { labels: string[] } {
  if (labels.some((l) => EXCLUDED.has(l))) return { id: m.id, removed: true, labels };
  const h = new Map<string, string>();
  const headers = Array.isArray(m.payload?.headers) ? m.payload!.headers : [];
  for (const x of headers.slice(0, 1000)) {
    if (!x || typeof x !== "object") continue;
    const k = typeof x.name === "string" ? x.name.toLowerCase() : "";
    if (k && !h.has(k) && typeof x.value === "string") h.set(k, x.value.slice(0, 100_000));
  }
  const received = safeDate(Number(m.internalDate));
  const sent = h.get("date") ? safeDate(Date.parse(h.get("date")!.slice(0, 200))) : null;
  const body = readParts(m.payload && typeof m.payload === "object" ? m.payload : undefined);
  return {
    id: m.id, removed: false, labels,
    internetMessageId: clean(h.get("message-id")?.trim().slice(0, 1000) ?? null),
    conversationId: typeof m.threadId === "string" ? clean(m.threadId.slice(0, 1000)) : null,
    subject: clean(h.get("subject")?.slice(0, 1000) ?? null),
    fromAddress: clean(addresses(h.get("from"))[0] ?? null),
    fromName: clean(displayName(h.get("from"))),
    to: addresses(h.get("to")).map((a) => clean(a)!),
    cc: addresses(h.get("cc")).map((a) => clean(a)!),
    receivedAt: received,
    sentAt: sent ?? received,
    hasAttachments: body.hasAttachments,
    importance: labels.includes("IMPORTANT") ? "high" : "normal",
    isRead: !labels.includes("UNREAD"),
    preview: typeof m.snippet === "string" ? clean(m.snippet.slice(0, 1000)) : null,
    body: clean(body.text),
  };
}

/**
 * Where a Gmail sync is up to, stored by the worker between runs:
 *   full:<history id>:<page token>   first import, listing every message
 *   hist:<history id>:<page token>   later syncs: changes since a history id
 */
function parseLink(link: string | null): { kind: "start" } | { kind: "full" | "hist"; history: string; page: string | null } {
  if (!link) return { kind: "start" };
  const [kind, history, page = "", ...rest] = link.split(":");
  if ((kind !== "full" && kind !== "hist") || !HISTORY.test(history ?? "") || rest.length || (page && !TOKEN.test(page))) {
    throw new Error("unreadable Gmail sync position");
  }
  return { kind, history: history!, page: page || null };
}

/** A page token Gmail sent back, checked; a bad one stops the sync rather than silently skipping mail. */
function pageToken(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !TOKEN.test(v)) throw new Error("unexpected Gmail page token");
  return v;
}

/** More changed messages than this in one history page means a fresh import instead. */
const MAX_CHANGES_PER_PAGE = 2000;

/** Gmail messages fetched in parallel per page (well inside Google's per-user quota). */
const CONCURRENCY = 5;

export class GmailMailProvider implements MailProvider {
  constructor(private readonly accessToken: string) {}

  /** Labels as folders: Inbox, Sent, Starred, Important, your own labels, then "No label" (archived mail). */
  async listFolders(): Promise<MailFolderInfo[]> {
    const res = await gmailJson<{ labels?: { id?: string; name?: string; type?: string }[] }>(this.accessToken, `${gmailBase()}/labels`);
    const labels = (Array.isArray(res.labels) ? res.labels : []).filter((l) => l && typeof l === "object");
    const ids = new Set(labels.map((l) => l.id));
    const out: MailFolderInfo[] = SYSTEM_FOLDERS.filter(([id]) => ids.has(id))
      .map(([id, name]) => ({ providerId: id, parentProviderId: null, name, path: name, total: null }));
    const user = labels
      .filter((l) => l.type === "user" && typeof l.id === "string" && ID.test(l.id) && !EXCLUDED.has(l.id))
      .map((l) => ({ id: l.id!, name: (clean(typeof l.name === "string" ? l.name : null) || "(unnamed)").slice(0, 300) }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 2000);
    // Gmail nests labels by name ("Clients/Smith").
    const byName = new Map(user.map((l) => [l.name, l.id]));
    for (const l of user) {
      const slash = l.name.lastIndexOf("/");
      out.push({ providerId: l.id, parentProviderId: slash > 0 ? byName.get(l.name.slice(0, slash)) ?? null : null,
        name: slash > 0 ? l.name.slice(slash + 1) || l.name : l.name, path: l.name, total: null });
    }
    out.push({ providerId: GMAIL_NO_LABEL, parentProviderId: null, name: "No label (archived)", path: "No label (archived)", total: null });
    return out;
  }

  /** Gmail has no per-label change feed; Huis syncs the whole mailbox and sorts by label. */
  async deltaPage(): Promise<never> { throw new Error("Gmail syncs the whole mailbox"); }

  private async fetchMessages(ids: string[]): Promise<(MailMessageInfo & { labels: string[] })[]> {
    const out: (MailMessageInfo & { labels: string[] })[] = [];
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      const batch = await Promise.all(ids.slice(i, i + CONCURRENCY).map(async (id) => {
        try {
          const m = await gmailJson<GmailMessage>(this.accessToken, `${gmailBase()}/messages/${encodeURIComponent(id)}?format=full`);
          if (typeof m.id !== "string" || m.id !== id) throw new Error("unexpected Gmail message");
          return toMailMessage(m);
        } catch (err) {
          // Deleted since it was listed.
          if ((err as { status?: number }).status === 404) return { id, removed: true as const, labels: [] };
          throw err;
        }
      }));
      out.push(...batch);
    }
    return out;
  }

  async mailboxPage(link: string | null): Promise<MailboxPage> {
    let at: ReturnType<typeof parseLink>;
    try { at = parseLink(link); } catch {
      // A saved position Huis can't read: start a fresh import rather than failing every time.
      return { messages: [], nextLink: null, deltaLink: null, restart: true };
    }
    if (at.kind === "start" || at.kind === "full") {
      // Note where history starts before listing, so nothing that arrives during the import is missed.
      let history = at.kind === "full" ? at.history : "";
      if (at.kind === "start") {
        const p = await gmailJson<{ historyId?: string }>(this.accessToken, `${gmailBase()}/profile`);
        if (!HISTORY.test(String(p.historyId ?? ""))) throw new Error("unexpected Gmail profile");
        history = String(p.historyId);
      }
      const q = new URLSearchParams({ maxResults: "100", includeSpamTrash: "false" });
      if (at.kind === "full" && at.page) q.set("pageToken", at.page);
      const list = await gmailJson<{ messages?: { id?: string }[]; nextPageToken?: string }>(this.accessToken, `${gmailBase()}/messages?${q}`);
      const listed = Array.isArray(list.messages) ? list.messages : [];
      const ids = [...new Set(listed.map((m) => m?.id).filter((x): x is string => typeof x === "string" && ID.test(x)))].slice(0, 100);
      const next = pageToken(list.nextPageToken);
      return {
        messages: await this.fetchMessages(ids),
        nextLink: next ? `full:${history}:${next}` : null,
        deltaLink: next ? null : `hist:${history}:`,
        fullImportDone: !next,
      };
    }
    const q = new URLSearchParams({ startHistoryId: at.history, maxResults: "100" });
    for (const t of ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"]) q.append("historyTypes", t);
    if (at.page) q.set("pageToken", at.page);
    let h: { history?: { messagesAdded?: { message?: { id?: string } }[]; messagesDeleted?: { message?: { id?: string } }[];
      labelsAdded?: { message?: { id?: string } }[]; labelsRemoved?: { message?: { id?: string } }[] }[]; nextPageToken?: string; historyId?: string };
    try {
      h = await gmailJson(this.accessToken, `${gmailBase()}/history?${q}`);
    } catch (err) {
      // Gmail keeps history for about a week: if it's gone, import everything again.
      if ((err as { status?: number }).status === 404) return { messages: [], nextLink: null, deltaLink: null, restart: true };
      throw err;
    }
    const deleted = new Set<string>();
    const changed = new Set<string>();
    const records = Array.isArray(h.history) ? h.history : [];
    // Too many changes at once to handle safely in one page: import everything again
    // (a fresh import also marks whatever disappeared), rather than dropping any.
    if (records.length > 1000) return { messages: [], nextLink: null, deltaLink: null, restart: true };
    for (const e of records) {
      const list = (v: unknown) => (Array.isArray(v) ? v : []) as { message?: { id?: unknown } }[];
      const idOf = (x: { message?: { id?: unknown } }) => (x && typeof x.message?.id === "string" && ID.test(x.message.id) ? x.message.id : null);
      for (const x of list(e?.messagesDeleted)) { const id = idOf(x); if (id) deleted.add(id); }
      for (const x of [...list(e?.messagesAdded), ...list(e?.labelsAdded), ...list(e?.labelsRemoved)]) { const id = idOf(x); if (id) changed.add(id); }
    }
    for (const id of deleted) changed.delete(id);
    if (deleted.size + changed.size > MAX_CHANGES_PER_PAGE) return { messages: [], nextLink: null, deltaLink: null, restart: true };
    const messages = [
      ...[...deleted].map((id) => ({ id, removed: true as const, labels: [] as string[] })),
      ...(await this.fetchMessages([...changed])),
    ];
    const next = pageToken(h.nextPageToken);
    const latest = HISTORY.test(String(h.historyId ?? "")) ? String(h.historyId) : at.history;
    return {
      messages,
      nextLink: next ? `hist:${at.history}:${next}` : null,
      deltaLink: next ? null : `hist:${latest}:`,
    };
  }

  /** The original message exactly as Gmail holds it (RFC 822 / MIME). */
  async fetchMime(messageId: string): Promise<Readable> {
    if (!ID.test(messageId)) throw new Error("unexpected Gmail message id");
    const m = await gmailJson<{ id?: string; raw?: string }>(this.accessToken,
      `${gmailBase()}/messages/${encodeURIComponent(messageId)}?format=raw`, MAX_RAW_JSON_BYTES);
    if (m.id !== messageId || typeof m.raw !== "string" || !m.raw) throw new Error("empty message");
    return Readable.from([Buffer.from(m.raw, "base64url")]);
  }
}
