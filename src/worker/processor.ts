import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import pg from "pg";
import { extractInSandbox } from "../extract/sandbox";
import type { ExtractInput, ExtractResult } from "../extract/types";
import { detectFileType, type DetectedType } from "../storage/filetype";
import type { MalwareScanner } from "../storage/scanner";
import { storageKeys, type EvidenceVault } from "../storage/store";

const MAX_ATTEMPTS = 5;

interface ClaimedJob {
  job_id: string;
  lock_token: string;
  kind: "evidence.process" | "evidence.extract";
  firm_id: string;
  evidence_id: string;
  storage_key: string;
  sha256: string;
  matter_id: string;
  attempts: number;
  original_filename: string;
  detected_content_type: string | null;
  depth: number;
}

export type Extractor = (input: ExtractInput, workDir: string) => Promise<ExtractResult>;

/**
 * Background processing for evidence. Two job kinds:
 *
 * evidence.process — re-reads the stored original and verifies its SHA-256,
 *   malware-scans it (files stay held until this passes), identifies the real
 *   file type, links exact duplicates. A clean result queues extraction.
 *
 * evidence.extract — decrypts the file into a private temporary folder,
 *   extracts text (OCR for scans) in an isolated process, splits emails and
 *   archives into their own evidence items (each then scanned), and records
 *   the text for search. The temporary copy is always deleted.
 *
 * The worker's database role can only call the huis.worker_* functions.
 */
export class EvidenceProcessor {
  constructor(
    private readonly pool: pg.Pool,
    private readonly vault: EvidenceVault,
    private readonly scanner: MalwareScanner,
    private readonly extractor: Extractor = extractInSandbox,
  ) {}

  /** Processes one job. Returns false when the queue is empty. */
  async runOnce(): Promise<boolean> {
    const { rows } = await this.pool.query<ClaimedJob>("SELECT * FROM huis.worker_claim_job()");
    const job = rows[0];
    if (!job) return false;
    try {
      if (job.kind === "evidence.extract") await this.extract(job);
      else await this.scan(job);
    } catch (err) {
      const message = err instanceof Error ? err.message : "processing error";
      await this.pool.query("SELECT huis.worker_fail($1, $2, $3, $4)", [job.job_id, job.lock_token, message, job.attempts >= MAX_ATTEMPTS]);
    }
    return true;
  }

  private async scan(job: ClaimedJob): Promise<void> {
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

    if (scan.status === "error") throw new Error(scan.detail);
    const detail = scan.status === "clean" && type.executable
      ? `${scan.detail}. Warning: this file is a program (${type.label}), not a document.`
      : scan.detail;
    await this.pool.query("SELECT huis.worker_complete($1, $2, $3, $4, $5, $6)", [
      job.job_id, job.lock_token, scan.status, `${this.scanner.name}: ${detail}`, type.label, verified ?? "unverified",
    ]);
  }

  private async extract(job: ClaimedJob): Promise<void> {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "huis-x-"));
    try {
      const inputPath = path.join(workDir, "input");
      const outDir = path.join(workDir, "out");
      await mkdir(outDir, { mode: 0o700 });
      // Decrypting also re-verifies the stored file has not been altered.
      await pipeline(await this.vault.get(job.firm_id, job.storage_key), createWriteStream(inputPath, { mode: 0o600 }));

      const result = await this.extractor({
        inputPath, outDir, filename: job.original_filename, detectedType: job.detected_content_type, depth: job.depth,
      }, workDir);

      // Store contained files (encrypted) first, then record everything in one transaction.
      const stored: { id: string; key: string; size: number; sha256: string; filename: string; containerPath: string; declaredType: string | null }[] = [];
      for (const child of result.children) {
        const id = randomUUID();
        const key = storageKeys.original(job.firm_id, job.matter_id, id);
        const { size, sha256 } = await this.vault.put(job.firm_id, key, createReadStream(child.path));
        stored.push({ id, key, size, sha256, filename: child.filename, containerPath: child.containerPath, declaredType: child.declaredType });
      }

      const client = await this.pool.connect();
      let added = 0;
      try {
        await client.query("BEGIN");
        let status = result.status;
        let detail = result.detail;
        for (const c of stored) {
          await client.query("SAVEPOINT child");
          try {
            await client.query("SELECT huis.worker_add_derived($1, $2, $3, $4, $5, $6, $7, $8, $9)", [
              job.job_id, job.lock_token, c.id, c.filename, c.containerPath, c.declaredType, c.size, c.sha256, c.key,
            ]);
            await client.query("RELEASE SAVEPOINT child");
            added += 1;
          } catch {
            // A limit was reached (nesting, count): keep what fits, report partial.
            await client.query("ROLLBACK TO SAVEPOINT child");
            await this.vault.delete(c.key).catch(() => undefined);
            status = "partial";
            detail = `${detail} Some contained files were not unpacked because a safety limit was reached.`.trim();
          }
        }
        await client.query("SELECT huis.worker_save_extraction($1, $2, $3, $4, $5, $6, $7, $8, $9)", [
          job.job_id, job.lock_token, status, detail, result.text, result.method, result.pages,
          result.email ? JSON.stringify(result.email) : null, added,
        ]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        for (const c of stored) await this.vault.delete(c.key).catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /** Processes until the queue is empty. */
  async drain(): Promise<number> {
    let n = 0;
    while (await this.runOnce()) n += 1;
    return n;
  }
}
