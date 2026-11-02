import "server-only";
import { randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { authConfig } from "../src/auth/config";
import {
  COOKIE, FLASH_TTL_SECONDS, PENDING_TTL_SECONDS, seal, SESSION_TTL_SECONDS, unseal,
  type PendingPayload, type SessionPayload,
} from "../src/auth/tokens";
import { HuisDb, type FirmSession } from "../src/db/tenant";
import { NotFoundError, PermissionDeniedError, UnauthenticatedError } from "../src/errors";

const globalForDb = globalThis as unknown as { huisDb?: HuisDb };

export function db(): HuisDb {
  if (!globalForDb.huisDb) {
    const url = process.env.HUIS_DATABASE_URL;
    if (!url) throw new Error("HUIS_DATABASE_URL is not set");
    globalForDb.huisDb = HuisDb.fromUrl(url);
  }
  return globalForDb.huisDb;
}

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: authConfig().secureCookies,
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

export async function setSessionCookie(p: SessionPayload): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE.session, await seal(p, authConfig().sessionKey, "session", SESSION_TTL_SECONDS), cookieOptions(SESSION_TTL_SECONDS));
  jar.delete(COOKIE.pending);
}

export async function setPendingCookie(p: PendingPayload): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE.pending, await seal(p, authConfig().sessionKey, "pending", PENDING_TTL_SECONDS), cookieOptions(PENDING_TTL_SECONDS));
}

export async function getPending(): Promise<PendingPayload | null> {
  const jar = await cookies();
  return unseal<PendingPayload>(jar.get(COOKIE.pending)?.value, authConfig().sessionKey, "pending");
}

export async function getSession(): Promise<SessionPayload | null> {
  const jar = await cookies();
  return unseal<SessionPayload>(jar.get(COOKIE.session)?.value, authConfig().sessionKey, "session");
}

export async function clearAuthCookies(): Promise<void> {
  const jar = await cookies();
  for (const name of Object.values(COOKIE)) jar.delete(name);
}

/**
 * Runs code as the signed-in user inside their firm's security context.
 * Anyone without a valid session is sent to the sign-in page.
 */
export async function withSession<T>(fn: (s: FirmSession) => Promise<T>): Promise<T> {
  const session = await getSession();
  if (!session) redirect("/signin");
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || undefined;
  try {
    return await db().withFirm(
      { firmId: session.firmId, userId: session.userId, ipAddress: ip, userAgent: h.get("user-agent") ?? undefined },
      fn,
    );
  } catch (err) {
    if (err instanceof UnauthenticatedError) redirect("/signin?reason=expired");
    throw err;
  }
}

// ---- One-time messages after a form submission -----------------------------

export interface Flash extends Record<string, unknown> {
  id: string;
  kind: "success" | "error";
  message: string;
  /** e.g. a one-time invitation link to show once */
  secretLink?: string;
}

export async function setFlash(f: Omit<Flash, "id">): Promise<string> {
  const id = randomBytes(6).toString("hex");
  const jar = await cookies();
  jar.set(COOKIE.flash, await seal({ ...f, id }, authConfig().sessionKey, "flash", FLASH_TTL_SECONDS), cookieOptions(FLASH_TTL_SECONDS));
  return id;
}

/** Shows the flash only on the page the form redirected to (?f=<id>). */
export async function getFlash(flashId: string | undefined): Promise<Flash | null> {
  if (!flashId) return null;
  const jar = await cookies();
  const f = await unseal<Flash>(jar.get(COOKIE.flash)?.value, authConfig().sessionKey, "flash");
  return f && f.id === flashId ? f : null;
}

/** Turns errors into messages that are safe to show (no SQL or internal detail). */
export function userMessage(err: unknown): string {
  if (err instanceof PermissionDeniedError || err instanceof NotFoundError) return err.message;
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    return issue ? `Please check ${issue.path.join(".") || "the form"}: ${issue.message}` : "Please check the form.";
  }
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: string }).code;
    if (code === "23505") return "That already exists. Please use a different value.";
    if (code === "23503") return "A related record was not found.";
    return "Something went wrong. Please try again.";
  }
  if (err instanceof Error && err.name !== "Error") return err.message;
  if (err instanceof Error && err.message.length < 200) return err.message;
  return "Something went wrong. Please try again.";
}

/** Runs a form action, then redirects back with a one-time success or error message. */
export interface ActResult {
  redirectTo?: string;
  message?: string;
  secretLink?: string;
}

export async function act(path: string, success: string, fn: () => Promise<ActResult | void>): Promise<never> {
  let target = path;
  let flash: Omit<Flash, "id">;
  try {
    const result = (await fn()) ?? {};
    if (result.redirectTo?.startsWith("/")) target = result.redirectTo;
    flash = { kind: "success", message: result.message ?? success, secretLink: result.secretLink };
  } catch (err) {
    if (isRedirect(err)) throw err;
    console.error("[huis] action failed:", err instanceof Error ? err.name : "unknown");
    flash = { kind: "error", message: userMessage(err) };
  }
  const id = await setFlash(flash);
  redirect(`${target}${target.includes("?") ? "&" : "?"}f=${id}`);
}

function isRedirect(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "digest" in err && String((err as { digest?: unknown }).digest).startsWith("NEXT_REDIRECT"));
}
