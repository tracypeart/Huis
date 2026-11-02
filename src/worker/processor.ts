import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import pg from "pg";
import { extractInSandbox, produceInSandbox } from "../extract/sandbox";
import type { ProduceInput, ProduceResult } from "../extract/produce";
import { fingerprint, nameStem } from "../similarity/fingerprint";
import type { ExtractInput, ExtractResult } from "../extract/types";
import { detectFileType, type DetectedType } from "../storage/filetype";
import type { MalwareScanner } from "../storage/scanner";
import { storageKeys, type EvidenceVault } from "../storage/store";

const MAX_ATTEMPTS = 5;
/** How often a running extract job renews its 6-hour lease. */
export const LEASE_RENEW_MS = 10 * 60_000;
/** Database errors that mean "a safety limit was reached" (anything else is a real failure). */
const LIMIT_ERRORS = /quota|nested too deeply|too many items/;

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
export type Producer = (input: Omit<ProduceInput, "mode">) => Promise<ProduceResult>;

interface ClaimedCopy {
  request_id: string;
  lock_token: string;
  firm_id: string;
  matter_id: string;
  source_id: string;
  source_key: string;
  source_filename: string;
  redact: boolean;
  exhibit_label: string | null;
  bates_prefix: string | null;
  bates_start: string | null;
  page_count: number;
  redactions: { page: number; x: number; y: number; w: number; h: number }[];
  attempts: number;
}

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
    private readonly leaseRenewMs: number = LEASE_RENEW_MS,
    private readonly producer: Producer = produceInSandbox,
  ) {}

  /** Processes one job. Returns false when the queue is empty. */
  async runOnce(): Promise<boolean> {
    const { rows } = await this.pool.query<ClaimedJob>("SELECT * FROM huis.worker_claim_job()");
    const job = rows[0];
    if (!job) return this.runCopyOnce();
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
    // Keep the job (and its working folder) alive while a long file is processed.
    let leaseLost = false;
    const renew = setInterval(() => {
      this.pool.query("SELECT huis.worker_renew_lease($1, $2) AS ok", [job.job_id, job.lock_token])
        .then((r) => { if (!r.rows[0]?.ok) leaseLost = true; }, () => undefined);
      const now = new Date();
      utimes(workDir, now, now).catch(() => undefined);
    }, this.leaseRenewMs);
    renew.unref();
    try {
      // Give the working copy its type's extension: some systems' security
      // profiles (e.g. Ubuntu's AppArmor profile for qpdf) only let tools
      // open files named like their type.
      const inputPath = path.join(workDir, `input${workingExtension(job.original_filename, job.detected_content_type)}`);
      const outDir = path.join(workDir, "out");
      await mkdir(outDir, { mode: 0o700 });
      // Decrypting also re-verifies the stored file has not been altered.
      await pipeline(await this.vault.get(job.firm_id, job.storage_key), createWriteStream(inputPath, { mode: 0o600 }));

      const result = await this.extractor({
        inputPath, outDir, filename: job.original_filename, detectedType: job.detected_content_type, depth: job.depth,
      }, workDir);

      if (leaseLost) throw new Error("job lease lost");

      // Only store what the upload's unpacking budget still allows.
      const budget = (await this.pool.query<{ items: string; bytes: string }>(
        "SELECT items, bytes FROM huis.worker_unpack_remaining($1, $2)", [job.job_id, job.lock_token])).rows[0]!;
      let itemsLeft = Number(budget.items);
      let bytesLeft = Number(budget.bytes);
      let overBudget = 0;

      // Store contained files (encrypted) first, then record everything in one transaction.
      const stored: { id: string; key: string; size: number; sha256: string; filename: string; containerPath: string; declaredType: string | null }[] = [];
      try {
      for (const child of result.children) {
        const onDisk = (await stat(child.path)).size;
        if (itemsLeft <= 0 || onDisk > bytesLeft) { overBudget += 1; continue; }
        itemsLeft -= 1;
        bytesLeft -= onDisk;
        if (leaseLost) throw new Error("job lease lost");
        const id = randomUUID();
        const key = storageKeys.original(job.firm_id, job.matter_id, id);
        // O_NOFOLLOW: never follow a link the extractor might have planted.
        const { size, sha256 } = await this.vault.put(job.firm_id, key, createReadStream(child.path, { flags: (constants.O_RDONLY | constants.O_NOFOLLOW) as unknown as string }));
        stored.push({ id, key, size, sha256, filename: child.filename, containerPath: child.containerPath, declaredType: child.declaredType });
      }
      } catch (err) {
        // Don't leave encrypted copies of files that were never recorded.
        for (const c of stored) await this.vault.delete(c.key).catch(() => undefined);
        throw err;
      }

      // The PDF viewing copy (Office files, photos), encrypted like everything else.
      let rendition: { key: string; size: number; sha256: string; pages: number | null } | null = null;
      if (result.rendition) {
        const key = storageKeys.rendition(job.firm_id, job.matter_id, job.evidence_id);
        const put = await this.vault.put(job.firm_id, key, createReadStream(result.rendition.path, { flags: (constants.O_RDONLY | constants.O_NOFOLLOW) as unknown as string }));
        rendition = { key, size: put.size, sha256: put.sha256, pages: result.rendition.pages };
      }

      const client = await this.pool.connect();
      let added = 0;
      try {
        await client.query("BEGIN");
        let status = result.status;
        let detail = result.detail;
        if (overBudget) {
          status = "partial";
          detail = `${detail} ${overBudget} contained file(s) were not unpacked because this upload's unpacking limit was reached.`.trim();
        }
        for (const c of stored) {
          await client.query("SAVEPOINT child");
          try {
            await client.query("SELECT huis.worker_add_derived($1, $2, $3, $4, $5, $6, $7, $8, $9)", [
              job.job_id, job.lock_token, c.id, c.filename, c.containerPath, c.declaredType, c.size, c.sha256, c.key,
            ]);
            await client.query("RELEASE SAVEPOINT child");
            added += 1;
          } catch (err) {
            // A safety limit was reached: keep what fits, report partial.
            // Anything else (e.g. the job was taken over) is a real failure.
            if (!LIMIT_ERRORS.test(err instanceof Error ? err.message : "")) throw err;
            await client.query("ROLLBACK TO SAVEPOINT child");
            await this.vault.delete(c.key).catch(() => undefined);
            status = "partial";
            detail = `${detail} Some contained files were not unpacked because a safety limit was reached.`.trim();
          }
        }
        if (rendition) {
          await client.query("SAVEPOINT rendition");
          try {
            await client.query("SELECT huis.worker_save_rendition($1, $2, $3, $4, $5, $6)", [
              job.job_id, job.lock_token, rendition.key, rendition.size, rendition.sha256, rendition.pages,
            ]);
            await client.query("RELEASE SAVEPOINT rendition");
          } catch (err) {
            if (/not held/.test(err instanceof Error ? err.message : "")) throw err;
            await client.query("ROLLBACK TO SAVEPOINT rendition");
            await this.vault.delete(rendition.key).catch(() => undefined);
          }
        }
        // Near-duplicates and versions (never blocks saving the text).
        if (result.text.trim() && !/\.(ics|vcf)$/i.test(job.original_filename)) {
          const fp = fingerprint(result.text);
          await client.query("SAVEPOINT similarity");
          try {
            await client.query("SELECT huis.worker_save_similarity($1, $2, $3, $4, $5, $6)", [
              job.job_id, job.lock_token, fp.minhash, nameStem(job.original_filename), result.email !== null, fp.phraseCount,
            ]);
            await client.query("RELEASE SAVEPOINT similarity");
          } catch {
            await client.query("ROLLBACK TO SAVEPOINT similarity");
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
        if (rendition) await this.vault.delete(rendition.key).catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    } finally {
      clearInterval(renew);
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /** Produces one requested redacted / exhibit copy. Returns false when none is waiting. */
  async runCopyOnce(): Promise<boolean> {
    const { rows } = await this.pool.query<ClaimedCopy>("SELECT * FROM huis.worker_claim_copy()");
    const req = rows[0];
    if (!req) return false;
    const workDir = await mkdtemp(path.join(os.tmpdir(), "huis-x-"));
    const newId = randomUUID();
    const key = storageKeys.original(req.firm_id, req.matter_id, newId);
    let stored = false;
    try {
      const inputPath = path.join(workDir, "input.pdf");
      const outDir = path.join(workDir, "out");
      await mkdir(outDir, { mode: 0o700 });
      await pipeline(await this.vault.get(req.firm_id, req.source_key), createWriteStream(inputPath, { mode: 0o600 }));
      const made = await this.producer({
        inputPath, outPath: path.join(outDir, "copy.pdf"), workDir, pageCount: req.page_count,
        redactions: req.redactions, exhibitLabel: req.exhibit_label, batesPrefix: req.bates_prefix,
        batesStart: req.bates_start === null ? null : Number(req.bates_start),
      });
      const { size, sha256 } = await this.vault.put(req.firm_id, key,
        createReadStream(made.path, { flags: (constants.O_RDONLY | constants.O_NOFOLLOW) as unknown as string }));
      stored = true;
      await this.pool.query("SELECT huis.worker_complete_copy($1, $2, $3, $4, $5, $6, $7, $8)", [
        req.request_id, req.lock_token, newId, copyFilename(req), size, sha256, key, made.pages,
      ]);
    } catch (err) {
      if (stored) await this.vault.delete(key).catch(() => undefined);
      const message = err instanceof Error ? err.message : "copy failed";
      await this.pool.query("SELECT huis.worker_fail_copy($1, $2, $3, $4)", [req.request_id, req.lock_token, message, req.attempts >= MAX_ATTEMPTS]);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
    return true;
  }

  /**
   * Deletes decrypted working folders left behind if a worker was killed
   * mid-job. Run at worker start-up.
   */
  static async sweepStaleWorkDirs(maxAgeMs = 7 * 60 * 60_000): Promise<number> {
    let removed = 0;
    const tmp = os.tmpdir();
    for (const name of await readdir(tmp).catch(() => [] as string[])) {
      if (!name.startsWith("huis-x-")) continue;
      const full = path.join(tmp, name);
      const st = await stat(full).catch(() => null);
      if (st && Date.now() - st.mtimeMs > maxAgeMs) {
        await rm(full, { recursive: true, force: true });
        removed += 1;
      }
    }
    return removed;
  }

  /** Processes until the queue is empty. */
  async drain(): Promise<number> {
    let n = 0;
    while (await this.runOnce()) n += 1;
    return n;
  }
}

/** "Contract (REDACTED, EXHIBIT 12, ABC-000101–000110).pdf" */
function copyFilename(req: ClaimedCopy): string {
  const stem = req.source_filename.replace(/\.[A-Za-z0-9]{1,8}$/, "").slice(0, 150);
  const tags: string[] = [];
  if (req.redact) tags.push("REDACTED");
  if (req.exhibit_label) tags.push(`EXHIBIT ${req.exhibit_label}`);
  if (req.bates_prefix && req.bates_start !== null) {
    const start = Number(req.bates_start);
    const end = start + req.page_count - 1;
    tags.push(`${req.bates_prefix}-${String(start).padStart(6, "0")}${end > start ? `–${String(end).padStart(6, "0")}` : ""}`);
  }
  return `${stem} (${tags.join(", ")}).pdf`;
}

/** A safe extension for the decrypted working copy (".pdf" for PDFs, else the original's, if simple). */
function workingExtension(filename: string, detected: string | null): string {
  if (detected === "PDF") return ".pdf";
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(filename);
  return m ? `.${m[1]!.toLowerCase()}` : "";
}
