import { Readable, Transform } from "node:stream";

/**
 * Time limits for calls to outside services (security review 22, R22-2).
 *
 * The worker handles one task at a time, so a connection that hangs without ever
 * answering would otherwise stop evidence scanning, mail and everything else for
 * every firm. Every call to an outside service therefore has a time limit, and
 * downloads are stopped when no data arrives for too long.
 */
export const requestTimeoutMs = (): number => Number(process.env.HUIS_HTTP_TIMEOUT_MS ?? 60_000);
export const downloadIdleMs = (): number => Number(process.env.HUIS_DOWNLOAD_IDLE_MS ?? 120_000);

const timedOut = () => Object.assign(new Error("the outside service did not answer in time"), { timeout: true });

/** fetch with a limit on the whole call (headers and body). For small API requests. */
export async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = requestTimeoutMs()): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (e) {
    if ((e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError") throw timedOut();
    throw e;
  }
}

/**
 * Reads a response body as text, stopping as soon as it passes `max` bytes
 * (security review 22, R22-4: never read the whole body before checking its size).
 */
export async function readTextCapped(res: Response, max: number, tooLarge: string): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(tooLarge);
  }
  const reader = res.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error(tooLarge);
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

/**
 * A download whose headers must arrive within the request limit, and whose data
 * must keep flowing: if nothing arrives for `idleMs`, the download is stopped and
 * the stream fails.
 */
export async function fetchDownload(url: string, init: RequestInit = {}, opts: { headerMs?: number; idleMs?: number } = {}):
  Promise<{ res: Response; stream: () => Readable }> {
  const controller = new AbortController();
  const headerTimer = setTimeout(() => controller.abort(), opts.headerMs ?? requestTimeoutMs());
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (controller.signal.aborted) throw timedOut();
    throw e;
  } finally {
    clearTimeout(headerTimer);
  }
  const idleMs = opts.idleMs ?? downloadIdleMs();
  const stream = (): Readable => {
    if (!res.body) throw new Error("the outside service sent no file");
    let idle: NodeJS.Timeout | undefined;
    const guard = new Transform({
      transform(chunk, _e, cb) { arm(); cb(null, chunk); },
      flush(cb) { if (idle) clearTimeout(idle); cb(); },
      // A consumer that gives up (e.g. the file is too large) also stops the download.
      destroy(err, cb) { if (idle) clearTimeout(idle); if (err) controller.abort(); cb(err); },
    });
    const arm = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        controller.abort();
        guard.destroy(timedOut());
      }, idleMs);
      idle.unref?.();
    };
    arm();
    const src = Readable.fromWeb(res.body as never);
    src.on("error", (e) => guard.destroy(controller.signal.aborted ? timedOut() : e));
    return src.pipe(guard);
  };
  return { res, stream };
}
