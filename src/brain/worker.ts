import { createHash } from "node:crypto";
import pg from "pg";
import { aiProvider } from "../ai/gateway";
import { chunkText } from "./chunk";

const MAX_ATTEMPTS = 5;
/** Passages embedded per request (keeps any one call to a provider small). */
const BATCH = 64;

interface Claimed { source_id: string; lock_token: string; firm_id: string; matter_id: string; kind: string; content: string; ai_provider: string; attempts: number }

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
      const hash = createHash("sha256").update(job.content).digest("hex");
      await this.pool.query("SELECT huis.worker_save_brain_chunks($1, $2, $3, $4, $5, $6)", [
        job.source_id, job.lock_token, provider.name, provider.model, hash,
        JSON.stringify(chunks.map((c, i) => ({ ...c, embedding: vectors[i] }))),
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 200) : "indexing error";
      await this.pool.query("SELECT huis.worker_fail_brain_source($1, $2, $3, $4)",
        [job.source_id, job.lock_token, message, job.attempts >= MAX_ATTEMPTS]).catch(() => undefined);
    }
    return true;
  }
}
