import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { api } from "../../../../../lib/api";
import { setFlash } from "../../../../../lib/server";
import { authConfig } from "../../../../../src/auth/config";
import { UserFacingError } from "../../../../../src/errors";
import { courtCalendarIcs } from "../../../../../src/services/court";

export const dynamic = "force-dynamic";

/**
 * The Matter's confirmed court dates as a calendar file (.ics). POST only,
 * from Huis's own pages (cross-site requests are refused), with the person's
 * confirmation that they will store it securely (as for every export). Huis
 * keeps no copy.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await api(req, async (s) => {
    // Read the form only once the request is known to come from Huis and a signed-in person; it is one checkbox.
    const size = Number(req.headers.get("content-length") ?? NaN);
    if (!Number.isFinite(size) || size > 4 * 1024) throw new UserFacingError("That request is too large.", 413);
    const form = await req.formData().catch(() => null);
    if (form?.get("acknowledge") !== "on") throw new UserFacingError("Confirm that you will store the calendar file securely.");
    const { filename, body } = await courtCalendarIcs(s, id);
    return new Response(body, {
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  });
  if (res.ok) return res;
  if (res.status === 401) return NextResponse.redirect(new URL("/signin?reason=expired", authConfig().baseUrl), 303);
  const body = (await res.clone().json().catch(() => ({}))) as { error?: string };
  const f = await setFlash({ kind: "error", message: body.error ?? "The calendar file couldn't be downloaded." });
  const back = /^[0-9a-f-]{36}$/i.test(id) ? `/matters/${id}/court` : "/matters";
  return NextResponse.redirect(new URL(`${back}?f=${f}`, authConfig().baseUrl), 303);
}
