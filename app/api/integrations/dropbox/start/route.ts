import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authConfig } from "../../../../../src/auth/config";
import { randomToken } from "../../../../../src/auth/microsoft";
import { seal } from "../../../../../src/auth/tokens";
import { dropboxAuthorizeUrl } from "../../../../../src/integrations/dropbox";
import { INTEGRATION_OAUTH_COOKIE } from "../../../../../src/integrations/onedrive";
import { INTERNAL_ROLES } from "../../../../../src/security/permissions";
import { getSession, withSession } from "../../../../../lib/server";

export const dynamic = "force-dynamic";

/** Starts connecting the signed-in staff member's own Dropbox (read-only), bound to this user and firm. */
export async function GET() {
  const cfg = authConfig();
  if (!cfg.dropbox) return new NextResponse("Dropbox is not configured yet.", { status: 503 });
  const session = await getSession();
  if (!session) return NextResponse.redirect(new URL("/signin", cfg.baseUrl));
  const allowed = await withSession(async (s) => INTERNAL_ROLES.has(s.actor.role) && s.actor.role !== "read_only");
  if (!allowed) return NextResponse.redirect(new URL("/integrations", cfg.baseUrl));

  const state = randomToken();
  const verifier = randomToken(48);
  const jar = await cookies();
  jar.set(INTEGRATION_OAUTH_COOKIE,
    await seal({ provider: "dropbox", state, nonce: "", verifier, firmId: session.firmId, userId: session.userId }, cfg.sessionKey, "integration-oauth", 10 * 60),
    { httpOnly: true, secure: cfg.secureCookies, sameSite: "lax", path: "/api/integrations", maxAge: 10 * 60 });
  return NextResponse.redirect(dropboxAuthorizeUrl({
    clientId: cfg.dropbox.clientId, redirectUri: `${cfg.baseUrl}/api/integrations/dropbox/callback`, state, verifier,
  }));
}
