import { NextResponse } from "next/server";
import { authConfig } from "../../../../src/auth/config";
import { clearAuthCookies, db, getSession } from "../../../../lib/server";

export const dynamic = "force-dynamic";

/**
 * Signing out ends the session on every device, not just this browser, so a
 * copied or stolen session cookie stops working too.
 */
export async function POST() {
  const session = await getSession();
  if (session) {
    await db()
      .withFirm({ firmId: session.firmId, userId: session.userId }, async (s) => {
        await s.client.query("SELECT huis.end_my_sessions()");
      })
      .catch(() => undefined);
  }
  await clearAuthCookies();
  return NextResponse.redirect(new URL("/signin?reason=signedout", authConfig().baseUrl), 303);
}
