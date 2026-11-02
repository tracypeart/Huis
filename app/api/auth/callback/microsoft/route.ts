import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { authConfig } from "../../../../../src/auth/config";
import { exchangeMicrosoftCode, verifyMicrosoftIdToken } from "../../../../../src/auth/microsoft";
import { COOKIE, unseal, type OAuthPayload } from "../../../../../src/auth/tokens";
import { acceptInvitation, resolveIdentity } from "../../../../../src/services/firms";
import { db, setPendingCookie, setSessionCookie } from "../../../../../lib/server";

export const dynamic = "force-dynamic";

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function GET(req: NextRequest) {
  const cfg = authConfig();
  const go = (path: string) => NextResponse.redirect(new URL(path, cfg.baseUrl));
  const jar = await cookies();
  const oauth = await unseal<OAuthPayload>(jar.get(COOKIE.oauth)?.value, cfg.sessionKey, "oauth");
  jar.delete({ name: COOKIE.oauth, path: "/api/auth" });

  const params = req.nextUrl.searchParams;
  if (params.get("error")) return go("/signin?reason=cancelled");
  const code = params.get("code");
  const state = params.get("state");
  if (!cfg.microsoft || !oauth || !code || !state || !safeEqual(state, oauth.state)) {
    return go("/signin?reason=invalid");
  }

  try {
    const idToken = await exchangeMicrosoftCode({
      clientId: cfg.microsoft.clientId, clientSecret: cfg.microsoft.clientSecret,
      redirectUri: `${cfg.baseUrl}/api/auth/callback/microsoft`, code, verifier: oauth.verifier,
    });
    const identity = await verifyMicrosoftIdToken(idToken, { clientId: cfg.microsoft.clientId, nonce: oauth.nonce });

    if (oauth.invite) {
      const linked = await acceptInvitation(db(), oauth.invite, identity.provider, identity.subject);
      if (!linked) return go("/signin?reason=invite");
      await setSessionCookie({ ...linked, provider: identity.provider, subject: identity.subject });
      return go("/dashboard");
    }

    const accounts = await resolveIdentity(db(), identity.provider, identity.subject);
    if (accounts.length === 1) {
      const a = accounts[0]!;
      await setSessionCookie({ firmId: a.firmId, userId: a.userId, provider: identity.provider, subject: identity.subject });
      return go("/dashboard");
    }
    await setPendingCookie({ provider: identity.provider, subject: identity.subject, name: identity.name, email: identity.email });
    return go(accounts.length === 0 ? "/onboarding" : "/select-firm");
  } catch (err) {
    console.error("[huis] sign-in failed:", err instanceof Error ? err.message : "unknown");
    return go("/signin?reason=failed");
  }
}
