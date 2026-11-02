import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtractInput, ExtractResult } from "./types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CHILD = path.join(ROOT, "src/extract/child.ts");

/** Wall-clock limit for one file (large OCR jobs can take a while). */
const TIMEOUT_MS = 45 * 60_000;

/**
 * Runs extraction for one file in a separate, locked-down process.
 * The child gets no secrets: only PATH and a private temp folder.
 */
export async function extractInSandbox(input: ExtractInput, workDir: string): Promise<ExtractResult> {
  const jobFile = path.join(workDir, "job.json");
  await writeFile(jobFile, JSON.stringify(input), { mode: 0o600 });
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, ["--max-old-space-size=2048", "--import", "tsx", CHILD, jobFile], {
      cwd: ROOT,
      timeout: TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: workDir, HOME: workDir, LANG: "C.UTF-8", NODE_ENV: "production" } as NodeJS.ProcessEnv,
    }, (err: Error | null, out: string) => (err && !out ? reject(new Error("extraction process failed")) : resolve(out)));
  });
  const parsed = JSON.parse(stdout) as ExtractResult | { error: string };
  if ("error" in parsed) throw new Error("extraction failed");
  // Contained files must be inside the private output folder.
  for (const c of parsed.children) {
    const resolved = path.resolve(c.path);
    if (!resolved.startsWith(path.resolve(input.outDir) + path.sep)) throw new Error("unexpected file location");
  }
  return parsed;
}
