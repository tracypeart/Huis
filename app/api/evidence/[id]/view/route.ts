import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { api } from "../../../../../lib/api";
import { openInViewer } from "../../../../../src/services/workingCopies";
import { evidenceVault } from "../../../../../src/storage/store";

export const dynamic = "force-dynamic";

/**
 * The PDF shown in Huis's page viewer (the original PDF, or the viewing copy
 * made from an Office file or photo). Rendered by pdf.js with scripting off;
 * served with a generic type so the browser never runs it itself. Each
 * opening is recorded in the chain of custody.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return api(req, async (s) => {
    const v = await openInViewer(s, id);
    const stream = await evidenceVault().get(s.actor.firmId, v.storageKey);
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": "attachment",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  });
}
