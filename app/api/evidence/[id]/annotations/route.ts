import type { NextRequest } from "next/server";
import { api, ApiError } from "../../../../../lib/api";
import { addAnnotation, listAnnotations } from "../../../../../src/services/workingCopies";

export const dynamic = "force-dynamic";

/** Highlights, notes and redaction marks on a document (firm staff only). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return api(req, async (s) => ({ annotations: await listAnnotations(s, id) }));
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return api(req, async (s) => {
    // A mark is small; refuse oversized bodies before reading them.
    const length = Number(req.headers.get("content-length") ?? "0");
    if (!Number.isFinite(length) || length > 16 * 1024) throw new ApiError(413, "Request too large.");
    const text = await req.text();
    if (text.length > 16 * 1024) throw new ApiError(413, "Request too large.");
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { body = null; }
    return { id: await addAnnotation(s, id, body) };
  });
}
