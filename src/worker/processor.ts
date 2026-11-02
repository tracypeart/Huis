import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import pg from "pg";
import { detectFileType, type DetectedType } from "../storage/filetype";
import type { MalwareScanner } from "../storage/scanner";
import type { EvidenceVault } from "../storage/store";

const MAX_ATTEMPTS = 5;

/**
 * Background processing for newly received evidence:
 *  1. re-reads the stored original and verifies it still matches its SHA-256
 *  2. malware-scans it (files stay held until this passes)
 *  3. identifies the real file type from its contents
 *  4. the database links exact duplicates within the matter
 *
 * The worker's database role can only call the huis.worker_* functions.
 */
export class EvidenceProcessor {
  constructor(
    private readonly pool: pg.Pool,
    private readonly vault: EvidenceVault,
    private readonly scanner: MalwareScanner,
  ) {}

  /** Processes one job. Returns false when the queue is empty. */
  async runOnce(): Promise<boolean> {
    const { rows } = await this.pool.query<{
      job_id: string; lock_token: string; firm_id: string; evidence_id: string; storage_key: string; sha256: string; attempts: number;
    }>("SELECT * FROM huis.worker_claim_job()");
    const job = rows[0];
    if (!job) return false;

    try {
      const plain = await this.vault.get(job.firm_id, job.storage_key);
      // Track completion before any data flows so an early error is never missed.
      const readAll = finished(plain).then(() => true, () => false);
      const hash = createHash("sha256");
      let head = Buffer.alloc(0);
      const toScanner = new PassThrough();
      plain.on("data", (chunk: Buffer) => {
        hash.update(chunk);
        if (head.length < 4096) head = Buffer.concat([head, chunk.subarray(0, 4096 - head.length)]);
      });
      plain.on("error", (e) => toScanner.destroy(e));
      plain.pipe(toScanner);

      const scan = await this.scanner.scan(toScanner);
      // The scanner may stop reading early (e.g. on detection); finish reading
      // so the integrity fingerprint covers the whole file.
      plain.resume();
      const intact = await readAll;
      const verified = intact ? hash.digest("hex") : null;
      if (!intact) throw new Error("Stored file could not be read or failed its integrity check");
      const type: DetectedType = detectFileType(head);

      if (scan.status === "error") {
        throw new Error(scan.detail);
      }
      const detail = scan.status === "clean" && type.executable
        ? `${scan.detail}. Warning: this file is a program (${type.label}), not a document.`
        : scan.detail;
      await this.pool.query("SELECT huis.worker_complete($1, $2, $3, $4, $5, $6)", [
        job.job_id, job.lock_token, scan.status, `${this.scanner.name}: ${detail}`, type.label, verified ?? "unverified",
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : "processing error";
      await this.pool.query("SELECT huis.worker_fail($1, $2, $3, $4)", [job.job_id, job.lock_token, message, job.attempts >= MAX_ATTEMPTS]);
    }
    return true;
  }

  /** Processes until the queue is empty. */
  async drain(): Promise<number> {
    let n = 0;
    while (await this.runOnce()) n += 1;
    return n;
  }
}
