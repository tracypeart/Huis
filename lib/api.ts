import "server-only";
import { headers } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { authConfig } from "../src/auth/config";
import type { FirmSession } from "../src/db/tenant";
import { NotFoundError, PermissionDeniedError, UnauthenticatedError, UserFacingError } from "../src/errors";
import { clientIp, db, getSession, userMessage } from "./server";

/** JSON error that is safe to show the user. */
export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

/**
 * Wraps an API route: rejects cross-site requests, requires a signed-in
 * user, runs inside the firm's security context, and turns errors into safe
 * JSON responses.
 */
export async function api(
  req: NextRequest,
  fn: (s: FirmSession) => Promise<Response | Record<string, unknown>>,
): Promise<Response> {
  try {
    // Block other websites from making requests in the user's name. Browsers
    // label cross-site requests; state-changing ones must also carry our Origin.
    if (req.headers.get("sec-fetch-site") === "cross-site") throw new ApiError(403, "Request blocked.");
    if (req.method !== "GET" && req.method !== "HEAD") {
      const origin = req.headers.get("origin");
      if (!origin || origin !== new URL(authConfig().baseUrl).origin) throw new ApiError(403, "Request blocked.");
    }
    const session = await getSession();
    if (!session) throw new ApiError(401, "Please sign in again.");
    const h = await headers();
    const out = await db().withFirm(
      {
        firmId: session.firmId, userId: session.userId, sessionVersion: session.sessionVersion,
        ipAddress: clientIp(h), userAgent: h.get("user-agent") ?? undefined,
      },
      fn,
    );
    return out instanceof Response ? out : NextResponse.json(out);
  } catch (err) {
    return apiErrorResponse(err);
  }
}

export function apiErrorResponse(err: unknown): Response {
  let status = 500;
  let message = "Something went wrong. Please try again.";
  if (err instanceof ApiError) { status = err.status; message = err.message; }
  else if (err instanceof UnauthenticatedError) { status = 401; message = err.message; }
  else if (err instanceof PermissionDeniedError) { status = 403; message = err.message; }
  else if (err instanceof NotFoundError) { status = 404; message = err.message; }
  else if (err instanceof UserFacingError) { status = err.status; message = err.message; }
  else if (err instanceof ZodError) { status = 400; message = err.issues[0]?.message ?? "Invalid request."; }
  else {
    message = userMessage(err);
    if (message.startsWith("Something went wrong")) console.error("[huis] api error:", err instanceof Error ? err.name : "unknown");
    else status = 400;
  }
  return NextResponse.json({ error: message }, { status, headers: { "cache-control": "no-store" } });
}

/** Reads a request body with a hard size limit. */
export async function readBody(req: NextRequest, maxBytes: number): Promise<Buffer> {
  if (!req.body) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  let total = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ApiError(413, "Chunk too large.");
    }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}
