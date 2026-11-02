import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chown, lstat, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtractInput, ExtractResult } from "./types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CHILD = path.join(ROOT, "src/extract/child.ts");

/** Wall-clock limit for one file. Extraction saves partial OCR before this. */
export const SANDBOX_TIMEOUT_MS = 45 * 60_000;
/** Outlook data files can be tens of gigabytes. */
export const SANDBOX_MAILBOX_TIMEOUT_MS = 4 * 60 * 60_000;
/** Largest result the extractor may hand back (text plus the list of contained items). */
const MAX_RESULT_BYTES = 128 * 1024 * 1024;
/** Unprivileged account the extractor runs as. */
const SANDBOX_UID = 65534;
const SANDBOX_GID = 65534;

export type SandboxMode = "namespaces" | "none";

let detected: SandboxMode | null | undefined;

/**
 * How files are isolated while being read:
 *
 * "namespaces" (production): the extractor runs as an unprivileged user, with
 *   no network, in its own process space — it can't see the worker process,
 *   its secrets, the database or other jobs, and can only write its own
 *   private folder. Requires the worker to run with permission to create
 *   namespaces (as root inside its container).
 *
 * "none": only allowed when HUIS_ALLOW_UNSANDBOXED_EXTRACTION=1, for
 *   development and CI machines that can't create namespaces. Never in production.
 *
 * If neither is available, extraction refuses to run (files stay unread, but
 * remain safely stored and scanned).
 */
export function sandboxMode(): SandboxMode | null {
  if (detected !== undefined) return detected;
  const forced = process.env.HUIS_EXTRACT_SANDBOX;
  if (forced === "none" && process.env.HUIS_ALLOW_UNSANDBOXED_EXTRACTION === "1") return (detected = "none");
  const probe = spawnSync("unshare", [...isolationArgs(), "true"], { timeout: 10_000, stdio: "ignore" });
  if (probe.status === 0) return (detected = "namespaces");
  detected = process.env.HUIS_ALLOW_UNSANDBOXED_EXTRACTION === "1" ? "none" : null;
  return detected;
}

/** Arguments that put a command inside the sandbox (exported for tests). */
export function isolationArgs(): string[] {
  return [
    "--net", "--pid", "--fork", "--mount-proc", "--ipc", "--uts", "--kill-child", "--",
    "setpriv", `--reuid=${SANDBOX_UID}`, `--regid=${SANDBOX_GID}`, "--clear-groups", "--no-new-privs", "--inh-caps=-all", "--",
  ];
}

/**
 * Runs extraction for one file in the sandbox. The process (and everything
 * it starts) is killed as a group on timeout.
 */
export async function extractInSandbox(input: ExtractInput, workDir: string): Promise<ExtractResult> {
  const mode = sandboxMode();
  if (!mode) throw new Error("Extraction sandbox is not available on this machine");

  const jobFile = path.join(workDir, "job.json");
  await writeFile(jobFile, JSON.stringify(input), { mode: 0o600 });
  if (mode === "namespaces") {
    for (const p of [workDir, input.outDir, input.inputPath, jobFile]) await chown(p, SANDBOX_UID, SANDBOX_GID);
  }

  const node = [process.execPath, "--max-old-space-size=2048", "--import", "tsx", CHILD, jobFile];
  const [cmd, ...args] = mode === "namespaces" ? ["unshare", ...isolationArgs(), ...node] : node;
  const stdout = await new Promise<string>((resolve, reject) => {
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: workDir, HOME: workDir, LANG: "C.UTF-8", NODE_ENV: "production" };
    const child: ChildProcess = spawn(cmd!, args, { cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "ignore"], env: env as unknown as NodeJS.ProcessEnv });
    let out = "";
    let size = 0;
    const killGroup = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } };
    const limit = /\.pst/.test(input.detectedType ?? "") ? SANDBOX_MAILBOX_TIMEOUT_MS : SANDBOX_TIMEOUT_MS;
    const timer = setTimeout(() => { killGroup(); reject(new Error("extraction timed out")); }, limit);
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => {
      size += d.length;
      if (size > MAX_RESULT_BYTES) { killGroup(); reject(new Error("extraction output too large")); return; }
      out += d;
    });
    child.on("error", () => { clearTimeout(timer); reject(new Error("extraction process failed")); });
    child.on("close", () => { clearTimeout(timer); killGroup(); resolve(out); });
  });

  const parsed = JSON.parse(stdout || '{"error":"no output"}') as ExtractResult | { error: string };
  if ("error" in parsed) throw new Error("extraction failed");
  await verifyChildren(parsed, input.outDir);
  return parsed;
}

/**
 * Contained files must be plain files directly inside the private output
 * folder — never links pointing somewhere else on the machine.
 */
export async function verifyChildren(result: ExtractResult, outDir: string): Promise<void> {
  const base = await realpath(outDir);
  const listed = new Set(await readdir(base));
  for (const c of result.children) {
    const resolved = path.resolve(c.path);
    if (path.dirname(resolved) !== path.resolve(outDir) || !listed.has(path.basename(resolved))) {
      throw new Error("unexpected file location");
    }
    const st = await lstat(resolved);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink > 1) throw new Error("unexpected file type");
  }
}
