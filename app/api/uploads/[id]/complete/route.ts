import type { NextRequest } from "next/server";
import { api, apiErrorResponse } from "../../../../../lib/api";
import { assembleOriginal, cleanupStaging, getUploadSession, newEvidenceId, recordEvidence } from "../../../../../src/services/evidence";
import { evidenceVault } from "../../../../../src/storage/store";

export const dynamic = "force-dynamic";
export const maxDuration = 900;

/**
 * Finish an upload: assemble the encrypted original and fingerprint it
 * (outside any database transaction), then record it and queue scanning.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await api(req, async (s) => ({ session: await getUploadSession(s, id) }));
  if (!session.ok) return session;
  const loaded = (await session.json()).session;
  if (loaded.evidenceId) return Response.json({ evidenceId: loaded.evidenceId });

  try {
    const vault = evidenceVault();
    const evidenceId = newEvidenceId();
    const file = await assembleOriginal(vault, loaded, evidenceId);
    const res = await api(req, async (s) => {
      const item = await recordEvidence(s, loaded, evidenceId, file);
      return { evidenceId: item.id, sha256: item.sha256, status: item.status };
    });
    if (res.ok) await cleanupStaging(vault, loaded);
    else await vault.delete(file.storageKey).catch(() => undefined);
    return res;
  } catch (err) {
    return apiErrorResponse(err);
  }
}
