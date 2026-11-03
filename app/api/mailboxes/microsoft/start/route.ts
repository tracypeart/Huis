import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authConfig } from "../../../../../src/auth/config";
import { randomToken } from "../../../../../src/auth/microsoft";
import { seal } from "../../../../../src/auth/tokens";
import { INTERNAL_ROLES } from "../../../../../src/security/permissions";
import { MAILBOX_OAUTH_COOKIE, mailboxAuthorizeUrl } from "../../../../../src/mail/microsoft";
import { getSession, withSession } from "../../../../../lib/server";

export const dynamic = "force-dynamic";

/**
 * Starts connecting the signed-in staff member's Outlook mailbox. The
 * request is bound to this user and firm, so a link can't be used to
 * connect someone else's account to another person's Huis login.
 */
export async function GET() {
  const cfg = authConfig();
  if (!cfg.microsoft) return new NextResponse("Microsoft is not configured yet.", { status: 503 });
  const session = await getSession();
  if (!session) return NextResponse.redirect(new URL("/signin", cfg.baseUrl));
  const allowed = await withSession(async (s) => INTERNAL_ROLES.has(s.actor.role) && s.actor.role !== "read_only");
  if (!allowed) return NextResponse.redirect(new URL("/inbox", cfg.baseUrl));

  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken(48);
  const jar = await cookies();
  jar.set(MAILBOX_OAUTH_COOKIE,
    await seal({ state, nonce, verifier, firmId: session.firmId, userId: session.userId }, cfg.sessionKey, "mailbox-oauth", 10 * 60),
    { httpOnly: true, secure: cfg.secureCookies, sameSite: "lax", path: "/api/mailboxes", maxAge: 10 * 60 });
  return NextResponse.redirect(mailboxAuthorizeUrl({
    clientId: cfg.microsoft.clientId, redirectUri: `${cfg.baseUrl}/api/mailboxes/microsoft/callback`, state, nonce, verifier,
  }));
}
