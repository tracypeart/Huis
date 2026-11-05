import { createHash } from "node:crypto";
import pg from "pg";
import { aiProvider } from "../ai/gateway";
import { NOTICE_READERS } from "../court/connectors";
import { toCharPositions } from "../services/cite";
import { findEvents } from "../dna/extract";
import { chunkText, MAX_CHUNKS } from "./chunk";

const MAX_ATTEMPTS = 5;
/** Passages embedded per request (keeps any one call to a provider small). */
const BATCH = 64;

interface Claimed { source_id: string; lock_token: string; firm_id: string; matter_id: string; kind: string; content: string; full_length: number; ai_provider: string; attempts: number }

/**
 * Builds each Matter's Brain: splits newly readable evidence and notes into
 * passages, adds meaning fingerprints with the firm's AI provider, and saves
 * them. Runs in the worker, whose database role can only call worker_* functions.
 */
export class BrainWorker {
  constructor(private readonly pool: pg.Pool) {}

  /** Indexes one waiting source. Returns false when none is waiting. */
  async indexOnce(): Promise<boolean> {
    const job = (await this.pool.query<Claimed>("SELECT * FROM huis.worker_claim_brain_source()")).rows[0];
    if (!job) return false;
    try {
      const provider = aiProvider(job.ai_provider);
      const chunks = chunkText(job.content);
      const started = Date.now();
      const vectors: number[][] = [];
      for (let i = 0; i < chunks.length; i += BATCH) {
        const batch = chunks.slice(i, i + BATCH);
        const v = await provider.embed(batch.map((c) => c.content));
        if (v.length !== batch.length) throw new Error("AI provider returned the wrong number of results");
        vectors.push(...v);
      }
      await this.pool.query("SELECT huis.worker_log_ai($1, $2, $3, $4, $5, $6, $7)",
        [job.source_id, job.lock_token, provider.name, provider.model, job.content.length, 0, Date.now() - started]);
      // Case DNA suggestions from documents: dated events, and the people on filed email.
      if (job.kind === "evidence") {
        await this.pool.query("SELECT huis.worker_save_dna_suggestions($1, $2, $3)",
          [job.source_id, job.lock_token, JSON.stringify(findEvents(job.content))]);
        // Court dates from a court notice filed into the Matter (proposals only), through the CourtConnector
        // readers. The database checks the sender for each reader (federal: a uscourts.gov address; Utah: a
        // utcourts.gov address or the firm's registered e-filing provider), so the worker just offers what it read.
        for (const reader of NOTICE_READERS) {
          const notice = reader.read(job.content);
          if (!notice?.events.length) continue;
          // Positions as the database counts them (characters, not UTF-16 units: security review 17, F2),
          // and the filing each date belongs to, so the same notice in another mailbox isn't proposed twice (F3).
          const events = notice.events.map((e) => ({
            ...e, ...toCharPositions(job.content, e.start, e.end), caseNumber: notice.caseNumber, documentNumber: notice.documentNumber,
          }));
          await this.pool.query("SELECT huis.worker_save_court_proposals($1, $2, $3, $4)",
            [job.source_id, job.lock_token, reader.id, JSON.stringify(events)]);
          break;
        }
      }
      const hash = createHash("sha256").update(job.content).digest("hex");
      // Very large documents: only the first part fits; the Brain says so.
      const partial = job.full_length > job.content.length || chunks.length >= MAX_CHUNKS;
      await this.pool.query("SELECT huis.worker_save_brain_chunks($1, $2, $3, $4, $5, $6, $7)", [
        job.source_id, job.lock_token, provider.name, provider.model, hash,
        JSON.stringify(chunks.map((c, i) => ({ ...c, embedding: vectors[i] }))), partial,
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 200) : "indexing error";
      await this.pool.query("SELECT huis.worker_fail_brain_source($1, $2, $3, $4)",
        [job.source_id, job.lock_token, message, job.attempts >= MAX_ATTEMPTS]).catch(() => undefined);
    }
    return true;
  }
}
