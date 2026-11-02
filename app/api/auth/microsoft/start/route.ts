import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { authConfig } from "../../../../../src/auth/config";
import { microsoftAuthorizeUrl, randomToken } from "../../../../../src/auth/microsoft";
import { COOKIE, OAUTH_TTL_SECONDS, seal } from "../../../../../src/auth/tokens";

export const dynamic = "force-dynamic";

const INVITE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export async function GET(req: NextRequest) {
  const cfg = authConfig();
  if (!cfg.microsoft) {
    return new NextResponse("Microsoft sign-in is not configured yet.", { status: 503 });
  }
  const invite = req.nextUrl.searchParams.get("invite");
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken(48);

  const jar = await cookies();
  jar.set(
    COOKIE.oauth,
    await seal({ state, nonce, verifier, ...(invite && INVITE_TOKEN.test(invite) ? { invite } : {}) },
      cfg.sessionKey, "oauth", OAUTH_TTL_SECONDS),
    { httpOnly: true, secure: cfg.secureCookies, sameSite: "lax", path: "/api/auth", maxAge: OAUTH_TTL_SECONDS },
  );

  return NextResponse.redirect(microsoftAuthorizeUrl({
    clientId: cfg.microsoft.clientId,
    redirectUri: `${cfg.baseUrl}/api/auth/callback/microsoft`,
    state, nonce, verifier,
  }));
}
