import type { NextRequest } from "next/server";
import { api, readBody } from "../../../../../../lib/api";
import { CHUNK_SIZE, getUploadSession, markChunkReceived, storeChunk } from "../../../../../../src/services/evidence";
import { evidenceVault } from "../../../../../../src/storage/store";

export const dynamic = "force-dynamic";

/** Upload one part of a file. Safe to retry. */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string; index: string }> }) {
  const { id, index } = await params;
  const n = Number(index);
  return api(req, async (s) => {
    const session = await getUploadSession(s, id);
    const body = await readBody(req, CHUNK_SIZE);
    await storeChunk(evidenceVault(), session, n, body);
    const received = await markChunkReceived(s, id, n);
    return { received: received.length, of: session.chunkCount };
  });
}
