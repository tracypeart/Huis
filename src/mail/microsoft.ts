import { Readable } from "node:stream";
import type { JWTVerifyGetKey } from "jose";
import { pkceChallenge, verifyMicrosoftIdToken } from "../auth/microsoft";
import type { MailFolderInfo, MailMessageInfo, MailProvider, DeltaPage } from "./provider";
import { fetchDownload, fetchWithTimeout } from "../net/http";

/**
 * Outlook / Microsoft 365 mailboxes through Microsoft Graph.
 *
 * Permissions requested (delegated, the signed-in attorney's own consent):
 *   openid profile email offline_access User.Read Mail.Read
 * Mail.Read is read-only: Huis can't send, change or delete mail.
 *
 * Access tokens live only in memory for one sync; the refresh token is
 * encrypted at rest. Tokens are only ever sent to the Graph and login
 * hosts configured here — paging links returned by Graph are checked
 * before the token is attached.
 */
/** Short-lived cookie holding the connect request (state, PKCE verifier, who asked). */
export const MAILBOX_OAUTH_COOKIE = "huis_mailbox_oauth";

export const MAIL_SCOPES = ["openid", "profile", "email", "offline_access", "User.Read", "Mail.Read"];

export function loginBase(): string {
  return (process.env.HUIS_MS_LOGIN_BASE ?? "https://login.microsoftonline.com").replace(/\/$/, "");
}
export function graphBase(): string {
  return (process.env.HUIS_GRAPH_BASE ?? "https://graph.microsoft.com/v1.0").replace(/\/$/, "");
}

export function mailboxAuthorizeUrl(p: { clientId: string; redirectUri: string; state: string; nonce: string; verifier: string; loginHint?: string; scopes?: string[] }): string {
  const url = new URL(`${loginBase()}/common/oauth2/v2.0/authorize`);
  url.search = new URLSearchParams({
    client_id: p.clientId,
    response_type: "code",
    redirect_uri: p.redirectUri,
    response_mode: "query",
    scope: (p.scopes ?? MAIL_SCOPES).join(" "),
    state: p.state,
    nonce: p.nonce,
    code_challenge: pkceChallenge(p.verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
    ...(p.loginHint ? { login_hint: p.loginHint } : {}),
  }).toString();
  return url.toString();
}

interface TokenResponse { access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number; error?: string }

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetchWithTimeout(`${loginBase()}/common/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    redirect: "error",
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !body.access_token) {
    const code = typeof body.error === "string" && /^[a-z_]{1,40}$/.test(body.error) ? body.error : String(res.status);
    const err = new Error(`Microsoft token request failed (${code})`);
    (err as Error & { reconnect?: boolean }).reconnect = body.error === "invalid_grant" || body.error === "interaction_required";
    throw err;
  }
  return body;
}

export interface ConnectedMailbox { subject: string; address: string | null; displayName: string; refreshToken: string }

/** Completes the connect flow: exchanges the code, verifies who signed in, reads their mailbox address. */
export async function completeMailboxConnect(p: {
  clientId: string; clientSecret: string; redirectUri: string; code: string; verifier: string; nonce: string; keys?: JWTVerifyGetKey; scopes?: string[];
}): Promise<ConnectedMailbox & { tenant: string | null }> {
  const t = await tokenRequest({
    client_id: p.clientId, client_secret: p.clientSecret, grant_type: "authorization_code", code: p.code,
    redirect_uri: p.redirectUri, code_verifier: p.verifier, scope: (p.scopes ?? MAIL_SCOPES).join(" "),
  });
  if (!t.id_token || !t.refresh_token) throw new Error("Microsoft did not grant offline mailbox access");
  const identity = await verifyMicrosoftIdToken(t.id_token, { clientId: p.clientId, nonce: p.nonce, keys: p.keys });
  const me = await graphJson<{ mail?: string; userPrincipalName?: string; displayName?: string }>(
    t.access_token!, `${graphBase()}/me?$select=mail,userPrincipalName,displayName`);
  const address = (me.mail ?? me.userPrincipalName ?? identity.email ?? null)?.toLowerCase() ?? null;
  return { subject: identity.subject, address, displayName: me.displayName ?? identity.name, refreshToken: t.refresh_token, tenant: identity.tenantId ?? null };
}

/** Exchanges a refresh token for an access token (Microsoft may rotate the refresh token). */
export async function refreshAccess(p: { clientId: string; clientSecret: string; refreshToken: string; scopes?: string[] }): Promise<{ accessToken: string; refreshToken: string }> {
  const t = await tokenRequest({
    client_id: p.clientId, client_secret: p.clientSecret, grant_type: "refresh_token",
    refresh_token: p.refreshToken, scope: (p.scopes ?? MAIL_SCOPES).join(" "),
  });
  return { accessToken: t.access_token!, refreshToken: t.refresh_token ?? p.refreshToken };
}

/** Only Graph URLs ever receive the access token. */
function checkGraphUrl(url: string): string {
  const base = new URL(graphBase());
  const u = new URL(url);
  if (u.origin !== base.origin || !u.pathname.startsWith(base.pathname)) throw new Error("unexpected Graph link");
  return u.toString();
}

/**
 * One Graph call. Security review 21, R21-2: the answer must start within the request limit,
 * and the body is read through `stream()`, which stops if no data arrives for too long.
 */
export async function graphFetch(token: string, url: string, init: { prefer?: string[]; stream?: boolean } = {}):
  Promise<{ res: Response; stream: () => Readable }> {
  const target = checkGraphUrl(url);
  for (let attempt = 0; ; attempt++) {
    const call = await fetchDownload(target, {
      headers: {
        authorization: `Bearer ${token}`,
        prefer: ['IdType="ImmutableId"', ...(init.prefer ?? [])].join(", "),
        accept: init.stream ? "*/*" : "application/json",
      },
      redirect: "error",
    });
    const res = call.res;
    // Microsoft throttles busy mailboxes: honour Retry-After a few times.
    if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < 3) {
      const wait = Math.min(60, Number(res.headers.get("retry-after") ?? "5") || 5);
      await res.body?.cancel().catch(() => undefined);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      const err = new Error(`Microsoft Graph request failed (${res.status})`);
      (err as Error & { reconnect?: boolean; status?: number }).reconnect = res.status === 401 || res.status === 403;
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    return call;
  }
}

/** Largest JSON response read from Graph (checked while reading, not after). */
const MAX_JSON_BYTES = 50 * 1024 * 1024;

export async function graphJson<T>(token: string, url: string, prefer?: string[]): Promise<T> {
  const { res, stream } = await graphFetch(token, url, { prefer });
  if (!res.body) return {} as T;
  const body = stream();
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += (chunk as Buffer).length;
    if (size > MAX_JSON_BYTES) { body.destroy(); throw new Error("Graph response too large"); }
    parts.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8")) as T;
  } catch {
    // Never echo the response: it may be mail content.
    throw new Error("Microsoft sent an unreadable response");
  }
}

/** Text from Graph, minus NUL characters (Postgres can't store them in text). */
const clean = (v: string | null | undefined): string | null => (v == null ? null : v.replace(/\u0000/g, ""));

type GraphAddress = { emailAddress?: { address?: string; name?: string } };
interface GraphMessage {
  id: string; "@removed"?: unknown; internetMessageId?: string; conversationId?: string; subject?: string;
  from?: GraphAddress; toRecipients?: GraphAddress[]; ccRecipients?: GraphAddress[];
  receivedDateTime?: string; sentDateTime?: string; hasAttachments?: boolean; importance?: string; isRead?: boolean;
  bodyPreview?: string; body?: { contentType?: string; content?: string };
}

const SELECT = "id,internetMessageId,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,hasAttachments,importance,isRead,bodyPreview,body";

export class MicrosoftMailProvider implements MailProvider {
  constructor(private readonly accessToken: string) {}

  async listFolders(): Promise<MailFolderInfo[]> {
    const out: MailFolderInfo[] = [];
    // Bounded however Graph responds: a page cap, and paging must move forward.
    let requests = 0;
    const seen = new Set<string>();
    const walk = async (url: string, parentPath: string, depth: number): Promise<void> => {
      let next: string | undefined = url;
      while (next && out.length < 2000) {
        if (++requests > 500 || seen.has(next)) throw new Error("mail folder listing did not finish");
        seen.add(next);
        const page: { value?: { id: string; displayName?: string; parentFolderId?: string; childFolderCount?: number; totalItemCount?: number }[]; "@odata.nextLink"?: string } =
          await graphJson(this.accessToken, next);
        for (const f of page.value ?? []) {
          const name = (clean(f.displayName) || "(unnamed)").slice(0, 300);
          const path = parentPath ? `${parentPath}/${name}` : name;
          out.push({ providerId: f.id, parentProviderId: f.parentFolderId ?? null, name, path, total: f.totalItemCount ?? null });
          if ((f.childFolderCount ?? 0) > 0 && depth < 10) {
            await walk(`${graphBase()}/me/mailFolders/${encodeURIComponent(f.id)}/childFolders?$top=100`, path, depth + 1);
          }
        }
        next = page["@odata.nextLink"];
      }
    };
    await walk(`${graphBase()}/me/mailFolders?$top=100`, "", 0);
    return out;
  }

  /** One page of changes for a folder: start fresh (no link) or continue from a saved link. */
  async deltaPage(folderProviderId: string, link: string | null): Promise<DeltaPage> {
    const url = link ?? `${graphBase()}/me/mailFolders/${encodeURIComponent(folderProviderId)}/messages/delta?$select=${SELECT}`;
    const page: { value?: GraphMessage[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string } =
      await graphJson(this.accessToken, url, ["odata.maxpagesize=50", 'outlook.body-content-type="text"']);
    const addr = (a?: GraphAddress) => a?.emailAddress?.address?.trim() || null;
    const messages: MailMessageInfo[] = (page.value ?? []).map((m) => m["@removed"] !== undefined
      ? { id: m.id, removed: true }
      : {
          id: m.id, removed: false, internetMessageId: clean(m.internetMessageId), conversationId: clean(m.conversationId),
          subject: clean(m.subject), fromAddress: clean(addr(m.from)), fromName: clean(m.from?.emailAddress?.name),
          to: (m.toRecipients ?? []).map((a) => clean(addr(a))).filter((x): x is string => Boolean(x)),
          cc: (m.ccRecipients ?? []).map((a) => clean(addr(a))).filter((x): x is string => Boolean(x)),
          receivedAt: m.receivedDateTime ?? null, sentAt: m.sentDateTime ?? null, hasAttachments: Boolean(m.hasAttachments),
          importance: clean(m.importance), isRead: m.isRead ?? null, preview: clean(m.bodyPreview),
          body: clean(m.body?.content),
        });
    return { messages, nextLink: page["@odata.nextLink"] ?? null, deltaLink: page["@odata.deltaLink"] ?? null };
  }

  /** The original message exactly as Outlook holds it (RFC 822 / MIME). */
  async fetchMime(messageId: string): Promise<Readable> {
    const { res, stream } = await graphFetch(this.accessToken, `${graphBase()}/me/messages/${encodeURIComponent(messageId)}/$value`, { stream: true });
    if (!res.body) throw new Error("empty message");
    return stream();
  }
}
