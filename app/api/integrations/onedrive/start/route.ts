import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authConfig } from "../../../../../src/auth/config";
import { randomToken } from "../../../../../src/auth/microsoft";
import { seal } from "../../../../../src/auth/tokens";
import { INTEGRATION_OAUTH_COOKIE, ONEDRIVE_SCOPES } from "../../../../../src/integrations/onedrive";
import { mailboxAuthorizeUrl } from "../../../../../src/mail/microsoft";
import { INTERNAL_ROLES } from "../../../../../src/security/permissions";
import { getSession, withSession } from "../../../../../lib/server";

export const dynamic = "force-dynamic";

/**
 * Starts connecting the signed-in staff member's OneDrive (and the SharePoint
 * sites they can open). Bound to this user and firm, so a link can't connect
 * someone's account to another person's Huis login.
 */
export async function GET() {
  const cfg = authConfig();
  if (!cfg.microsoft) return new NextResponse("Microsoft is not configured yet.", { status: 503 });
  const session = await getSession();
  if (!session) return NextResponse.redirect(new URL("/signin", cfg.baseUrl));
  const allowed = await withSession(async (s) => INTERNAL_ROLES.has(s.actor.role) && s.actor.role !== "read_only");
  if (!allowed) return NextResponse.redirect(new URL("/integrations", cfg.baseUrl));

  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken(48);
  const jar = await cookies();
  jar.set(INTEGRATION_OAUTH_COOKIE,
    await seal({ provider: "onedrive", state, nonce, verifier, firmId: session.firmId, userId: session.userId }, cfg.sessionKey, "integration-oauth", 10 * 60),
    { httpOnly: true, secure: cfg.secureCookies, sameSite: "lax", path: "/api/integrations", maxAge: 10 * 60 });
  return NextResponse.redirect(mailboxAuthorizeUrl({
    clientId: cfg.microsoft.clientId, redirectUri: `${cfg.baseUrl}/api/integrations/onedrive/callback`, state, nonce, verifier, scopes: ONEDRIVE_SCOPES,
  }));
}
