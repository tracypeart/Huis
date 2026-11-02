import { readFile } from "node:fs/promises";
import path from "node:path";

/** Serves the pdf.js worker script (library code, same origin so the strict CSP still applies). */
let cached: Buffer | null = null;

export async function GET() {
  cached ??= await readFile(path.join(process.cwd(), "node_modules/pdfjs-dist/build/pdf.worker.min.mjs"));
  return new Response(new Uint8Array(cached), {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
    },
  });
}
