import { NextResponse, type NextRequest } from "next/server";
import { authConfig } from "../../../../src/auth/config";
import { NotFoundError, PermissionDeniedError } from "../../../../src/errors";
import { pickerPage } from "../../../../src/integrations/google-picker-page";
import { browse, getConnection, type IntegrationConnection } from "../../../../src/services/integrations";
import { getSession, setFlash, withSession } from "../../../../lib/server";

export const dynamic = "force-dynamic";

/**
 * Google Drive's file picker (security review 21, R21-2). A document of its own rather than a page of the
 * app, so its relaxed security policy (next.config.ts) applies to it alone: it is entered, left and
 * finished with full page loads. Only the person who connected the account can open it.
 */
async function ownDrive(id: string): Promise<IntegrationConnection | null> {
  return withSession(async (s) => {
    try {
      const c = await getConnection(s, id);
      return c.provider === "google_drive" ? c : null;
    } catch (err) {
      if (err instanceof NotFoundError || err instanceof PermissionDeniedError) return null;
      throw err;
    }
  });
}

const html = (body: string, status = 200) =>
  new NextResponse(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const cfg = authConfig();
  if (!(await getSession())) return NextResponse.redirect(new URL("/signin", cfg.baseUrl));
  const { id } = await params;
  const c = await ownDrive(id);
  if (!c) return html("<!doctype html><title>Not found</title><p>Not found.</p>", 404);
  const ready = c.status !== "needs_reconnect" && cfg.google && cfg.googlePicker;
  return html(pickerPage({
    connectionId: c.id, accountLabel: c.accountLabel,
    picker: ready ? { clientId: cfg.google!.clientId, apiKey: cfg.googlePicker!.apiKey, appId: cfg.googlePicker!.appId } : null,
    message: c.status === "needs_reconnect" ? "This account needs reconnecting first (on the Integrations page)."
      : "Google's file picker isn't set up for this firm yet (it needs a browser key and the Google Cloud project number).",
  }));
}

/** Files were chosen: ask the worker to list them again, then go back with a full page load. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const cfg = authConfig();
  // Only this site's own picker page can post here.
  if (req.headers.get("origin") !== new URL(cfg.baseUrl).origin) return new NextResponse("Forbidden", { status: 403 });
  if (!(await getSession())) return NextResponse.redirect(new URL("/signin", cfg.baseUrl), 303);
  const { id } = await params;
  const c = await ownDrive(id);
  if (!c) return html("<!doctype html><title>Not found</title><p>Not found.</p>", 404);
  await withSession((s) => browse(s, c.id, "root", true));
  const f = await setFlash({ kind: "success", message: "Huis is listing the files you chose. Tick the ones to import into a Matter." });
  return NextResponse.redirect(new URL(`/integrations/${c.id}?f=${f}`, cfg.baseUrl), 303);
}
