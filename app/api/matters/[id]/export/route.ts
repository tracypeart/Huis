import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { api } from "../../../../../lib/api";
import { NextResponse } from "next/server";
import { authConfig } from "../../../../../src/auth/config";
import { db, getSession, setFlash } from "../../../../../lib/server";
import { prepareMatterExport, streamMatterExport, type ExportPlan } from "../../../../../src/services/matterExport";
import { evidenceVault } from "../../../../../src/storage/store";

export const dynamic = "force-dynamic";

/**
 * Full export of a Matter as a ZIP, built as it downloads (Huis keeps no copy).
 * POST only, from Huis's own pages (cross-site requests are refused), with the
 * person's confirmation that they will store it securely.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let plan: ExportPlan | null = null;
  const form = await req.formData().catch(() => null);
  const acknowledged = form?.get("acknowledge") === "on";
  const res = await api(req, async (s) => {
    plan = await prepareMatterExport(s, id, acknowledged);
    return new Response(null, { status: 204 });
  });
  if (!plan) {
    // Back to the Matter with the reason (the form posts here directly).
    if (res.status === 401) return NextResponse.redirect(new URL("/signin?reason=expired", authConfig().baseUrl), 303);
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const f = await setFlash({ kind: "error", message: body.error ?? "The export couldn't be prepared." });
    return NextResponse.redirect(new URL(`/matters/${encodeURIComponent(id)}?f=${f}`, authConfig().baseUrl), 303);
  }
  const p = plan as ExportPlan;
  const session = await getSession();
  const ctx = { ...p.ctx, sessionVersion: session?.sessionVersion };
  const stream = streamMatterExport(p, { db: db(), vault: evidenceVault(), ctx });
  const ascii = p.zipName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(p.zipName)}`,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}
