import { NextResponse } from "next/server";
import { authConfig } from "../../../../src/auth/config";
import { clearAuthCookies } from "../../../../lib/server";

export const dynamic = "force-dynamic";

export async function POST() {
  await clearAuthCookies();
  return NextResponse.redirect(new URL("/signin?reason=signedout", authConfig().baseUrl), 303);
}
