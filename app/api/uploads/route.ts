import type { NextRequest } from "next/server";
import { api } from "../../../lib/api";
import { startUpload } from "../../../src/services/evidence";

export const dynamic = "force-dynamic";

/** Start an upload: returns the session id and how to split the file. */
export async function POST(req: NextRequest) {
  const input = await req.json().catch(() => ({}));
  return api(req, async (s) => {
    const u = await startUpload(s, input);
    return { id: u.id, chunkSize: u.chunkSize, chunkCount: u.chunkCount, receivedChunks: u.receivedChunks };
  });
}
