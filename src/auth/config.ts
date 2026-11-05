/**
 * Reads and validates the settings sign-in needs. Secrets come only from the
 * environment (Replit Secrets or the cloud secret vault), never from code.
 */
export interface AuthConfig {
  baseUrl: string;
  sessionKey: Uint8Array;
  microsoft: { clientId: string; clientSecret: string } | null;
  /** Gmail connection (Google OAuth client). */
  google: { clientId: string; clientSecret: string } | null;
  /** Dropbox app for the Integration Hub (not a sign-in method). */
  dropbox: { clientId: string; clientSecret: string } | null;
  secureCookies: boolean;
}

let cached: AuthConfig | null = null;

export function authConfig(): AuthConfig {
  if (cached) return cached;
  const baseUrl = (process.env.HUIS_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const secret = process.env.HUIS_SESSION_SECRET;
  if (!secret) {
    throw new Error("HUIS_SESSION_SECRET is not set. Generate one with: openssl rand -base64 32");
  }
  const sessionKey = new Uint8Array(Buffer.from(secret, "base64"));
  if (sessionKey.length !== 32) {
    throw new Error("HUIS_SESSION_SECRET must be 32 random bytes, base64-encoded.");
  }
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  cached = {
    baseUrl,
    sessionKey,
    microsoft: clientId && clientSecret ? { clientId, clientSecret } : null,
    google: process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET } : null,
    dropbox: process.env.DROPBOX_APP_KEY && process.env.DROPBOX_APP_SECRET
      ? { clientId: process.env.DROPBOX_APP_KEY, clientSecret: process.env.DROPBOX_APP_SECRET } : null,
    secureCookies: baseUrl.startsWith("https://"),
  };
  return cached;
}

/** For tests. */
export function resetAuthConfig(): void {
  cached = null;
}
