import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { api } from "../../../../../lib/api";
import { authorizeDownload } from "../../../../../src/services/evidence";
import { evidenceVault, storageKeys } from "../../../../../src/storage/store";

export const dynamic = "force-dynamic";

/**
 * Downloads an original exactly as received. Always served as an attachment
 * with a generic type so a malicious file can never run inside Huis.
 * Each download is written to the chain of custody.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return api(req, async (s) => {
    const item = await authorizeDownload(s, id);
    const stream = await evidenceVault().get(s.actor.firmId, storageKeys.original(s.actor.firmId, item.matterId, item.id));
    const ascii = item.originalFilename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(item.originalFilename)}`,
        "content-length": String(item.sizeBytes),
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  });
}
