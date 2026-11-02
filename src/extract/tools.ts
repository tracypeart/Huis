import { spawn, type ChildProcess } from "node:child_process";
import { open } from "node:fs/promises";
import { LIMITS } from "./types";

/**
 * Runs a trusted command-line tool (pdftotext, tesseract, …) on a file.
 * Never uses a shell, so file names can't inject commands. Output and run
 * time are capped, and on timeout the tool and everything it started (for
 * example LibreOffice's helper processes) are killed together.
 */
export function run(cmd: string, args: string[], opts: { timeoutSec?: number; maxBytes?: number } = {}): Promise<string> {
  const max = opts.maxBytes ?? 64 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", OMP_THREAD_LIMIT: "1", LANG: "C.UTF-8", HOME: process.env.HOME ?? "/tmp", TMPDIR: process.env.TMPDIR ?? "/tmp" };
    const child: ChildProcess = spawn(cmd, args, { detached: true, stdio: ["ignore", "pipe", "ignore"], env: env as unknown as NodeJS.ProcessEnv });
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const killGroup = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } };
    const fail = () => { if (!failed) { failed = true; killGroup(); reject(new Error(`${cmd} failed`)); } };
    const timer = setTimeout(fail, (opts.timeoutSec ?? LIMITS.toolTimeoutSec) * 1000);
    child.stdout!.on("data", (d: Buffer) => {
      size += d.length;
      if (size > max) { fail(); return; }
      chunks.push(d);
    });
    child.on("error", () => { clearTimeout(timer); fail(); });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      killGroup();
      if (failed) return;
      if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
      else fail();
    });
  });
}

/** Reads at most `max` bytes from the start of a file. */
export async function readHead(file: string, max: number): Promise<Buffer> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(max);
    const { bytesRead } = await fh.read(buf, 0, max, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Normalizes extracted text: no NUL bytes, tidy whitespace, length cap. */
export function cleanText(s: string): string {
  return s
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .slice(0, LIMITS.maxTextChars + 1);
}

/** Very small HTML → text conversion (no scripts or styles kept). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
    })
    .replace(/[ \t]{2,}/g, " ");
}

/** Decodes text bytes as UTF-8, falling back to Latin-1 for older files. */
export function decodeText(buf: Buffer): string {
  const utf8 = buf.toString("utf8");
  const bad = (utf8.match(/�/g) ?? []).length;
  return bad > utf8.length / 100 ? buf.toString("latin1") : utf8;
}

/** A safe display file name (no folders, no control characters). */
export function safeName(name: string | null | undefined, fallback: string): string {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 255);
  return cleaned || fallback;
}
