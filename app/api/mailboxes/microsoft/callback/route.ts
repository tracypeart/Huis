import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { authConfig } from "../../../../../src/auth/config";
import { unseal } from "../../../../../src/auth/tokens";
import { completeMailboxConnect, MAILBOX_OAUTH_COOKIE } from "../../../../../src/mail/microsoft";
import { connectMailbox } from "../../../../../src/services/inbox";
import { getSession, setFlash, userMessage, withSession } from "../../../../../lib/server";

export const dynamic = "force-dynamic";

const same = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export async function GET(req: NextRequest) {
  const cfg = authConfig();
  const done = async (kind: "success" | "error", message: string) =>
    NextResponse.redirect(new URL(`/inbox?f=${await setFlash({ kind, message })}`, cfg.baseUrl));
  const jar = await cookies();
  const pending = await unseal<{ state: string; nonce: string; verifier: string; firmId: string; userId: string }>(
    jar.get(MAILBOX_OAUTH_COOKIE)?.value, cfg.sessionKey, "mailbox-oauth");
  jar.delete({ name: MAILBOX_OAUTH_COOKIE, path: "/api/mailboxes" });

  const p = req.nextUrl.searchParams;
  if (p.get("error")) return done("error", "The mailbox wasn't connected (permission was not given).");
  const code = p.get("code");
  const state = p.get("state");
  const session = await getSession();
  if (!cfg.microsoft || !pending || !code || !state || !same(state, pending.state)
      || !session || session.userId !== pending.userId || session.firmId !== pending.firmId) {
    return done("error", "The mailbox connection couldn't be verified. Please try again.");
  }
  const masterKey = process.env.HUIS_STORAGE_MASTER_KEY;
  if (!masterKey) return done("error", "Huis storage encryption is not configured.");
  try {
    const mailbox = await completeMailboxConnect({
      clientId: cfg.microsoft.clientId, clientSecret: cfg.microsoft.clientSecret,
      redirectUri: `${cfg.baseUrl}/api/mailboxes/microsoft/callback`, code, verifier: pending.verifier, nonce: pending.nonce,
    });
    await withSession((s) => connectMailbox(s, { provider: "microsoft", ...mailbox, masterKey }));
    return done("success", `Connected ${mailbox.address ?? "your mailbox"}. Huis is importing your mail now; only you (and anyone you choose) can see it.`);
  } catch (err) {
    console.error("[huis] mailbox connect failed:", err instanceof Error ? err.message : "unknown");
    return done("error", userMessage(err));
  }
}
