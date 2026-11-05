import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { authConfig } from "../../../../../src/auth/config";
import { unseal } from "../../../../../src/auth/tokens";
import { completeDropboxConnect } from "../../../../../src/integrations/dropbox";
import { INTEGRATION_OAUTH_COOKIE } from "../../../../../src/integrations/onedrive";
import { connectIntegration } from "../../../../../src/services/integrations";
import { getSession, setFlash, userMessage, withSession } from "../../../../../lib/server";

export const dynamic = "force-dynamic";

const same = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export async function GET(req: NextRequest) {
  const cfg = authConfig();
  const done = async (kind: "success" | "error", message: string, to = "/integrations") =>
    NextResponse.redirect(new URL(`${to}?f=${await setFlash({ kind, message })}`, cfg.baseUrl));
  const jar = await cookies();
  const pending = await unseal<{ provider?: string; state: string; verifier: string; firmId: string; userId: string }>(
    jar.get(INTEGRATION_OAUTH_COOKIE)?.value, cfg.sessionKey, "integration-oauth");
  jar.delete({ name: INTEGRATION_OAUTH_COOKIE, path: "/api/integrations" });

  const p = req.nextUrl.searchParams;
  if (p.get("error")) return done("error", "Dropbox wasn't connected (permission was not given).");
  const code = p.get("code");
  const state = p.get("state");
  const session = await getSession();
  if (!cfg.dropbox || !pending || pending.provider !== "dropbox" || !code || !state || !same(state, pending.state)
      || !session || session.userId !== pending.userId || session.firmId !== pending.firmId) {
    return done("error", "The Dropbox connection couldn't be verified. Please try again.");
  }
  const masterKey = process.env.HUIS_STORAGE_MASTER_KEY;
  if (!masterKey) return done("error", "Huis storage encryption is not configured.");
  try {
    const account = await completeDropboxConnect({
      clientId: cfg.dropbox.clientId, clientSecret: cfg.dropbox.clientSecret,
      redirectUri: `${cfg.baseUrl}/api/integrations/dropbox/callback`, code, verifier: pending.verifier,
    });
    const id = await withSession((s) => connectIntegration(s, {
      provider: "dropbox", subject: account.subject, tenant: null, label: account.address ?? account.displayName,
      refreshToken: account.refreshToken, masterKey,
    }));
    return done("success", `Connected ${account.address ?? "your Dropbox"}. Only you can browse it; choose files to import into a Matter.`, `/integrations/${id}`);
  } catch (err) {
    console.error("[huis] Dropbox connect failed:", err instanceof Error ? err.message : "unknown");
    return done("error", userMessage(err));
  }
}
