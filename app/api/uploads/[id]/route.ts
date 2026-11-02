import type { NextRequest } from "next/server";
import { api } from "../../../../lib/api";
import { getUploadSession } from "../../../../src/services/evidence";

export const dynamic = "force-dynamic";

/** Upload status, used to resume an interrupted upload. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return api(req, async (s) => {
    const u = await getUploadSession(s, id);
    return { id: u.id, chunkSize: u.chunkSize, chunkCount: u.chunkCount, receivedChunks: u.receivedChunks, evidenceId: u.evidenceId };
  });
}
