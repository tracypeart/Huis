import { EncryptJWT, jwtDecrypt } from "jose";

/**
 * Encrypted, tamper-proof cookie payloads (JWE, AES-256-GCM). The browser can
 * hold them but cannot read or change them.
 */
export async function seal(payload: Record<string, unknown>, key: Uint8Array, purpose: string, ttlSeconds: number): Promise<string> {
  return new EncryptJWT({ ...payload, pur: purpose })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .encrypt(key);
}

export async function unseal<T extends Record<string, unknown>>(token: string | undefined, key: Uint8Array, purpose: string): Promise<T | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtDecrypt(token, key);
    if (payload.pur !== purpose) return null;
    return payload as unknown as T;
  } catch {
    return null;
  }
}

export const COOKIE = {
  session: "huis_session",
  oauth: "huis_oauth",
  pending: "huis_pending",
  flash: "huis_flash",
} as const;

/** A signed-in user inside one firm. */
export interface SessionPayload extends Record<string, unknown> {
  firmId: string;
  userId: string;
  provider: string;
  subject: string;
}

/** Sign-in in progress (between leaving for Microsoft and returning). */
export interface OAuthPayload extends Record<string, unknown> {
  state: string;
  nonce: string;
  verifier: string;
  invite?: string;
}

/** Verified identity that has not yet picked or created a firm. */
export interface PendingPayload extends Record<string, unknown> {
  provider: string;
  subject: string;
  name: string;
  email: string | null;
}

export const SESSION_TTL_SECONDS = 8 * 60 * 60; // one working day; then sign in again
export const OAUTH_TTL_SECONDS = 10 * 60;
export const PENDING_TTL_SECONDS = 15 * 60;
export const FLASH_TTL_SECONDS = 2 * 60;
