import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from "jose";

/**
 * Microsoft sign-in (OpenID Connect authorization-code flow with PKCE).
 *
 * Uses the "common" endpoint so lawyers from any Microsoft 365 organization,
 * or with a personal Microsoft account, can sign in. Because "common" tokens
 * are issued by each user's own tenant, the issuer is checked against the
 * token's tenant id rather than one fixed value.
 *
 * Identity key: "<tenant id>:<object id>". The email shown by Microsoft is
 * used for display only and NEVER to find or link an account.
 */
const AUTHORITY = "https://login.microsoftonline.com/common";
const JWKS_URL = new URL("https://login.microsoftonline.com/common/discovery/v2.0/keys");
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MICROSOFT_SCOPES = ["openid", "profile", "email", "offline_access"];

let remoteJwks: JWTVerifyGetKey | null = null;
function microsoftKeys(): JWTVerifyGetKey {
  remoteJwks ??= createRemoteJWKSet(JWKS_URL);
  return remoteJwks;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function microsoftAuthorizeUrl(p: {
  clientId: string; redirectUri: string; state: string; nonce: string; verifier: string;
}): string {
  const url = new URL(`${AUTHORITY}/oauth2/v2.0/authorize`);
  url.search = new URLSearchParams({
    client_id: p.clientId,
    response_type: "code",
    redirect_uri: p.redirectUri,
    response_mode: "query",
    scope: MICROSOFT_SCOPES.join(" "),
    state: p.state,
    nonce: p.nonce,
    code_challenge: pkceChallenge(p.verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return url.toString();
}

export async function exchangeMicrosoftCode(p: {
  clientId: string; clientSecret: string; redirectUri: string; code: string; verifier: string;
}): Promise<string> {
  const res = await fetch(`${AUTHORITY}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: p.clientId,
      client_secret: p.clientSecret,
      grant_type: "authorization_code",
      code: p.code,
      redirect_uri: p.redirectUri,
      code_verifier: p.verifier,
      scope: MICROSOFT_SCOPES.join(" "),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
  if (!res.ok || !body.id_token) {
    // Never echo Microsoft's raw error text to the browser; it can include detail.
    throw new Error(`Microsoft sign-in failed (${body.error ?? res.status}).`);
  }
  return body.id_token;
}

export interface VerifiedIdentity {
  provider: "microsoft";
  subject: string;
  name: string;
  email: string | null;
  tenantId: string;
}

/** Verifies signature, audience, issuer, nonce and expiry of a Microsoft ID token. */
export async function verifyMicrosoftIdToken(
  idToken: string,
  opts: { clientId: string; nonce: string; keys?: JWTVerifyGetKey },
): Promise<VerifiedIdentity> {
  const unverified = decodeJwt(idToken);
  const tid = typeof unverified.tid === "string" ? unverified.tid : "";
  if (!GUID.test(tid)) throw new Error("Sign-in token has no valid tenant.");

  const { payload } = await jwtVerify(idToken, opts.keys ?? microsoftKeys(), {
    audience: opts.clientId,
    issuer: `https://login.microsoftonline.com/${tid}/v2.0`,
    algorithms: ["RS256"],
    clockTolerance: 60,
  });
  if (payload.tid !== tid) throw new Error("Sign-in token tenant mismatch.");
  if (payload.nonce !== opts.nonce) throw new Error("Sign-in token nonce mismatch.");
  const oid = payload.oid;
  if (typeof oid !== "string" || !GUID.test(oid)) throw new Error("Sign-in token has no user id.");

  const email = typeof payload.email === "string" ? payload.email
    : typeof payload.preferred_username === "string" && payload.preferred_username.includes("@")
      ? payload.preferred_username : null;
  return {
    provider: "microsoft",
    subject: `${tid}:${oid}`,
    name: typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : (email ?? "Microsoft user"),
    email,
    tenantId: tid,
  };
}
