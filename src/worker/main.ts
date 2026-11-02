import pg from "pg";
import { scannerFromEnv } from "../storage/scanner";
import { evidenceVault } from "../storage/store";
import { EvidenceProcessor } from "./processor";

/**
 * Evidence worker process. Run alongside the web app:
 *   HUIS_WORKER_DATABASE_URL=... HUIS_CLAMAV_HOST=... npm run worker
 *
 * Fails closed: without a malware scanner it refuses to start, and uploaded
 * files stay held ("security scan pending") and cannot be opened.
 */
async function main() {
  const url = process.env.HUIS_WORKER_DATABASE_URL;
  if (!url) throw new Error("HUIS_WORKER_DATABASE_URL is not set");
  const scanner = scannerFromEnv();
  if (!scanner) throw new Error("No malware scanner configured (set HUIS_CLAMAV_HOST). Refusing to process evidence.");

  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const processor = new EvidenceProcessor(pool, evidenceVault(), scanner);
  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { stopping = true; });

  console.log(`[huis-worker] started with ${scanner.name}`);
  while (!stopping) {
    const did = await processor.runOnce().catch((e) => {
      console.error("[huis-worker] error:", e instanceof Error ? e.message : e);
      return false;
    });
    if (!did) await new Promise((r) => setTimeout(r, 2000));
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
