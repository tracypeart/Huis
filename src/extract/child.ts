/**
 * Isolated extraction process. Started by the worker for each file with a
 * minimal environment (no database address, no encryption keys), strict
 * memory and time limits, and access only to one private temporary folder.
 * If a malicious file crashes or hijacks a parser, it can't reach anything else.
 */
import { readFile } from "node:fs/promises";
import { extract } from "./formats";
import type { ExtractInput } from "./types";

async function main() {
  const jobFile = process.argv[2];
  if (!jobFile) throw new Error("missing job file");
  const input = JSON.parse(await readFile(jobFile, "utf8")) as ExtractInput;
  const result = await extract(input, null);
  process.stdout.write(JSON.stringify(result));
}

main().catch(() => {
  process.stdout.write(JSON.stringify({ error: "extraction failed" }));
  process.exitCode = 2;
});
