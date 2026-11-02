import type { NextRequest } from "next/server";
import { api } from "../../../../../../lib/api";
import { deleteAnnotation } from "../../../../../../src/services/workingCopies";

export const dynamic = "force-dynamic";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string; annotationId: string }> }) {
  const { id, annotationId } = await params;
  return api(req, async (s) => {
    await deleteAnnotation(s, id, annotationId);
    return { ok: true };
  });
}
