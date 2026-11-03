import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authConfig } from "../../../../../src/auth/config";
import { randomToken } from "../../../../../src/auth/microsoft";
import { seal } from "../../../../../src/auth/tokens";
import { INTERNAL_ROLES } from "../../../../../src/security/permissions";
import { gmailAuthorizeUrl } from "../../../../../src/mail/google";
import { MAILBOX_OAUTH_COOKIE } from "../../../../../src/mail/microsoft";
import { getSession, withSession } from "../../../../../lib/server";

export const dynamic = "force-dynamic";

/**
 * Starts connecting the signed-in staff member's Gmail mailbox. The
 * request is bound to this user and firm, so a link can't be used to
 * connect someone else's account to another person's Huis login.
 */
export async function GET() {
  const cfg = authConfig();
  if (!cfg.google) return new NextResponse("Google is not configured yet.", { status: 503 });
  const session = await getSession();
  if (!session) return NextResponse.redirect(new URL("/signin", cfg.baseUrl));
  const allowed = await withSession(async (s) => INTERNAL_ROLES.has(s.actor.role) && s.actor.role !== "read_only");
  if (!allowed) return NextResponse.redirect(new URL("/inbox", cfg.baseUrl));

  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken(48);
  const jar = await cookies();
  jar.set(MAILBOX_OAUTH_COOKIE,
    await seal({ provider: "google", state, nonce, verifier, firmId: session.firmId, userId: session.userId }, cfg.sessionKey, "mailbox-oauth", 10 * 60),
    { httpOnly: true, secure: cfg.secureCookies, sameSite: "lax", path: "/api/mailboxes", maxAge: 10 * 60 });
  return NextResponse.redirect(gmailAuthorizeUrl({
    clientId: cfg.google.clientId, redirectUri: `${cfg.baseUrl}/api/mailboxes/google/callback`, state, nonce, verifier,
  }));
}
