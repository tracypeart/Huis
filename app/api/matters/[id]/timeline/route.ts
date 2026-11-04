import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { api } from "../../../../../lib/api";
import { setFlash } from "../../../../../lib/server";
import { authConfig } from "../../../../../src/auth/config";
import { UserFacingError } from "../../../../../src/errors";
import { timelineCsv } from "../../../../../src/services/timeline";

export const dynamic = "force-dynamic";

/**
 * The Matter's timeline (with the filters on screen) as a chronology
 * spreadsheet. POST only, from Huis's own pages (cross-site requests are
 * refused), with the person's confirmation that they will store it securely.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await api(req, async (s) => {
    // Read the form only once the request is known to come from Huis and a signed-in person (security review 11).
    // The form is a handful of short filters: anything large (or of unknown size) is refused unread.
    const size = Number(req.headers.get("content-length") ?? NaN);
    if (!Number.isFinite(size) || size > 64 * 1024) throw new UserFacingError("That request is too large.", 413);
    const form = await req.formData().catch(() => null);
    const filters = Object.fromEntries(
      ["category", "from", "to", "person", "q", "show", "source", "emails"].map((k) => [k, typeof form?.get(k) === "string" ? (form!.get(k) as string) : undefined]),
    );
    const out = await timelineCsv(s, id, filters, form?.get("acknowledge") === "on");
    const ascii = out.filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    return new Response(out.body, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${ascii}"`,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  });
  if (res.ok) return res;
  // Back to the timeline with the reason (the form posts here directly).
  if (res.status === 401) return NextResponse.redirect(new URL("/signin?reason=expired", authConfig().baseUrl), 303);
  const body = (await res.clone().json().catch(() => ({}))) as { error?: string };
  const f = await setFlash({ kind: "error", message: body.error ?? "The timeline couldn't be downloaded." });
  const back = /^[0-9a-f-]{36}$/i.test(id) ? `/matters/${id}/timeline` : "/matters";
  return NextResponse.redirect(new URL(`${back}?f=${f}`, authConfig().baseUrl), 303);
}
