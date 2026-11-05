import pg from "pg";
import { BrainWorker } from "../brain/worker";
import { CourtAlertWorker } from "../court/alerts";
import { scannerFromEnv } from "../storage/scanner";
import { evidenceVault } from "../storage/store";
import { EvidenceProcessor } from "./processor";
import { sandboxMode } from "../extract/sandbox";
import { MailWorker } from "../mail/worker";

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

  const mode = sandboxMode();
  if (!mode) throw new Error("No extraction sandbox available (needs namespaces). Refusing to open evidence files.");
  if (mode === "none") console.warn("[huis-worker] WARNING: extraction is NOT sandboxed (development only).");
  await EvidenceProcessor.sweepStaleWorkDirs();

  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const processor = new EvidenceProcessor(pool, evidenceVault(), scanner);
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  const mail = new MailWorker(pool, evidenceVault(), {
    masterKey: process.env.HUIS_STORAGE_MASTER_KEY!,
    microsoft: clientId && clientSecret ? { clientId, clientSecret } : null,
    google: process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET } : null,
  });
  const brain = new BrainWorker(pool);
  // Court date reminders. Email, SMS and push senders are set up with production hosting (O-2);
  // until then those reminders wait, visibly, and are sent once a sender exists.
  const alerts = new CourtAlertWorker(pool, {}, `${(process.env.HUIS_BASE_URL ?? "").replace(/\/$/, "")}/alerts`);
  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { stopping = true; });

  console.log(`[huis-worker] started with ${scanner.name}`);
  while (!stopping) {
    // Evidence first (scans and reading), then filing requests, then mailbox sync, then the Matter Brain (so indexing never holds up mail).
    const did = await (async () => (await processor.runOnce()) || (await mail.fileOnce()) || (await mail.syncOnce()) || (await alerts.runOnce()) || (await brain.indexOnce()))().catch((e) => {
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
