/**
 * Independent security review 15 — Phase 6 part 3 (Matter analysis and Reanalyze Matter).
 *
 * "F" tests demonstrate confirmed problems: each FAILS on the reviewed code and should pass once fixed.
 * "blocked" tests record attacks that were correctly refused.
 * Made-up data only.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrainWorker } from "../src/brain/worker";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { createClient } from "../src/services/clients";
import { analyzeMatter, reanalyzeMatter, sinceLastAnalysis } from "../src/services/analysis";
import { addClaimFromTemplate, addNode } from "../src/services/dna";
import { assembleOriginal, getUploadSession, markChunkReceived, newEvidenceId, recordEvidence, startUpload, storeChunk } from "../src/services/evidence";
import { addMatterMember, createMatter } from "../src/services/matters";
import { inviteUser } from "../src/services/users";
import { MasterKeyProvider } from "../src/storage/encryption";
import type { MalwareScanner } from "../src/storage/scanner";
import { EvidenceVault, LocalObjectStore } from "../src/storage/store";
import { EvidenceProcessor } from "../src/worker/processor";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

let t: TestDatabase;
let db: HuisDb;
let vault: EvidenceVault;
let vaultDir: string;
let processor: EvidenceProcessor;
let brain: BrainWorker;
const scanner: MalwareScanner = {
  name: "test",
  async scan(stream) { for await (const _ of stream) { /* drain */ } return { status: "clean", detail: "No threats found" }; },
};

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-sr15-vault-"));
  vault = new EvidenceVault(new LocalObjectStore(vaultDir), new MasterKeyProvider(randomBytes(32).toString("base64")));
  processor = new EvidenceProcessor(t.worker, vault, scanner);
  brain = new BrainWorker(t.worker);
});
afterAll(async () => {
  await t?.drop();
  if (vaultDir) await rm(vaultDir, { recursive: true, force: true });
});

async function upload(ctx: RequestContext, matterId: string, filename: string, text: string) {
  const content = Buffer.from(text);
  const session = await db.withFirm(ctx, (s) => startUpload(s, { matterId, filename, totalSize: content.length }));
  for (let i = 0; i < session.chunkCount; i++) {
    await storeChunk(vault, session, i, content.subarray(i * session.chunkSize, (i + 1) * session.chunkSize));
    await db.withFirm(ctx, (s) => markChunkReceived(s, session.id, i));
  }
  const fresh = await db.withFirm(ctx, (s) => getUploadSession(s, session.id));
  const id = newEvidenceId();
  const stored = await assembleOriginal(vault, fresh, id);
  return db.withFirm(ctx, (s) => recordEvidence(s, fresh, id, stored));
}
async function process() {
  await processor.drain();
  while (await brain.indexOnce()) { /* index */ }
}
const asReplica = (sql: string) =>
  t.admin.query(`SET session_replication_role = replica; ${sql}; SET session_replication_role = origin;`);

async function setup() {
  const f = await newFirm(db);
  const x = await db.withFirm(f.owner, async (s) => {
    const client = await createClient(s, { kind: "person", displayName: "Pat Smith", email: "pat.smith@example.com" });
    const para = await inviteUser(s, { email: `p@${f.slug}.example`, fullName: "Pat Para", role: "paralegal", locationId: f.locationId });
    const reader = await inviteUser(s, { email: `r@${f.slug}.example`, fullName: "Rae Reader", role: "read_only", locationId: f.locationId });
    const portal = await inviteUser(s, { email: `c@${f.slug}.example`, fullName: "Casey Client", role: "client", locationId: f.locationId });
    const admin2 = await inviteUser(s, { email: `a@${f.slug}.example`, fullName: "Ari Admin", role: "firm_admin", locationId: f.locationId });
    const matter = await createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
    const walled = await createMatter(s, { title: "Walled", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT", restricted: true });
    return { para, reader, portal, admin2, matter, walled };
  });
  await db.withFirm(f.owner, (s) => addMatterMember(s, { matterId: x.matter.id, userId: x.portal.id, access: "view", acknowledgePrivilegeWaiverRisk: true }));
  const ctx = (id: string): RequestContext => ({ firmId: f.firmId, userId: id });
  return { ...f, ...x, paraCtx: ctx(x.para.id), readerCtx: ctx(x.reader.id), portalCtx: ctx(x.portal.id), admin2Ctx: ctx(x.admin2.id) };
}

const LETTER = `Termination letter.

Dear Ms. Smith, your employment with Acme Corporation is terminated effective April 18, 2026.
This decision follows your request for FMLA leave on April 2, 2026 for surgery.`;
const MEMO = "Memo to file, May 1, 2026. Acme's HR director called about the leave paperwork.";

describe("security review 15 — confirmed findings", () => {
  it("F1: a document the Brain worker died on five times stays 'Being added' forever: no next step, and Reanalyze can't retry it", async () => {
    const x = await setup();
    const doc = await upload(x.owner, x.matter.id, "poison.txt", LETTER);
    await process();
    // The worker claimed it for the 5th time (attempts = 5, running) and then crashed (OOM, killed); its lock has expired.
    await t.admin.query(
      "UPDATE huis.brain_sources SET status = 'running', attempts = 5, lock_token = gen_random_uuid(), locked_until = now() - interval '1 minute' WHERE evidence_id = $1",
      [doc.id]);
    // The worker never picks it up again (attempts < 5 is required to claim)...
    expect(await brain.indexOnce()).toBe(false);
    const a = await db.withFirm(x.paraCtx, (s) => analyzeMatter(s, x.matter.id));
    // ...yet the analysis reports it as still being added, and no next step says anything is wrong.
    // (Today: a.brain.waiting === 1, a.brain.failed === 0, and no step mentions it.)
    const retried = await db.withFirm(x.paraCtx, (s) => reanalyzeMatter(s, x.matter.id));
    const after = (await t.admin.query("SELECT status, attempts FROM huis.brain_sources WHERE evidence_id = $1", [doc.id])).rows[0];
    // Expected once fixed: it's reported as couldn't-be-added (a next step), and Reanalyze retries it.
    expect(a.steps.some((st) => /Matter Brain/.test(st.text))).toBe(true);
    expect(retried.retried).toBe(1);
    expect(after.status).toBe("queued");
  });

  it("F2: brain_retry_failed (SECURITY DEFINER) retries and counts sources the caller can't see — items no longer clean — so 'retried' disagrees with the analysis", async () => {
    const x = await setup();
    const a1 = await upload(x.owner, x.matter.id, "letter.txt", LETTER);
    const a2 = await upload(x.owner, x.matter.id, "memo.txt", MEMO);
    await process();
    await t.admin.query("UPDATE huis.brain_sources SET status = 'failed', attempts = 5, last_error = 'x' WHERE evidence_id = ANY($1::uuid[])", [[a1.id, a2.id]]);
    // The memo is then found infected: the Brain row is invisible to everyone in the app (RLS requires clean evidence).
    await asReplica(`UPDATE huis.evidence_items SET status = 'infected' WHERE id = '${a2.id}'`);
    const a = await db.withFirm(x.paraCtx, (s) => analyzeMatter(s, x.matter.id));
    expect(a.brain.failed).toBe(1);
    expect(a.steps.map((st) => st.text).join("\n")).toMatch(/1 item couldn't be added to the Matter Brain/);
    const r = await db.withFirm(x.paraCtx, (s) => reanalyzeMatter(s, x.matter.id));
    const quarantinedSource = (await t.admin.query("SELECT status FROM huis.brain_sources WHERE evidence_id = $1", [a2.id])).rows[0];
    // Expected: only what the caller can see (and that can be read: clean evidence, notes) is retried and counted.
    expect(r.retried).toBe(1);
    expect(quarantinedSource.status).toBe("failed");
  });

  it("F3: Reanalyze resets attempts on poison documents without any limit, so a loop of clicks keeps the worker retrying forever", async () => {
    const x = await setup();
    const doc = await upload(x.owner, x.matter.id, "poison.txt", LETTER);
    await process();
    const retried: number[] = [];
    for (let cycle = 0; cycle < 6; cycle++) {
      // The document fails all 5 attempts again (simulated), then someone clicks Reanalyze.
      await t.admin.query("UPDATE huis.brain_sources SET status = 'failed', attempts = 5, last_error = 'worker crashed' WHERE evidence_id = $1", [doc.id]);
      retried.push((await db.withFirm(x.paraCtx, (s) => reanalyzeMatter(s, x.matter.id))).retried);
    }
    const runs = (await t.admin.query("SELECT count(*)::int AS n FROM huis.matter_analyses WHERE matter_id = $1", [x.matter.id])).rows[0].n;
    expect(runs).toBe(6);
    // Every click granted 5 more full attempts (30 so far). Expected once fixed: a lifetime cap or a cooldown,
    // so the same failing document is not handed back to the worker indefinitely.
    expect(retried.at(-1)).toBe(0);
  });

  it("F4: items whose virus scan failed get no next step — the analysis can say 'nothing needs attention' about evidence that was never scanned or read", async () => {
    const x = await setup();
    const doc = await upload(x.owner, x.matter.id, "letter.txt", LETTER);
    await asReplica(`UPDATE huis.evidence_items SET status = 'scan_failed', scan_detail = 'scanner error' WHERE id = '${doc.id}'`);
    await db.withFirm(x.owner, (s) => addNode(s, x.matter.id, { kind: "claim", label: "Breach of contract" }));
    const a = await db.withFirm(x.paraCtx, (s) => analyzeMatter(s, x.matter.id));
    expect(a.evidence.scanFailed).toBe(1);
    // Nothing reads it, it's not in the Brain or timeline — but no step mentions it.
    expect(a.steps.map((st) => st.text).join("\n")).toMatch(/scan/i);
  });

  it("F5: claims after the 50th are silently left out of the analysis and its next steps", async () => {
    const x = await setup();
    await db.withFirm(x.owner, async (s) => {
      for (let i = 1; i <= 50; i++) await addNode(s, x.matter.id, { kind: "claim", label: `A claim ${String(i).padStart(2, "0")}` });
      await addClaimFromTemplate(s, x.matter.id, "fmla_retaliation");
    });
    const a = await db.withFirm(x.paraCtx, (s) => analyzeMatter(s, x.matter.id));
    expect(a.dna.claims).toBe(51);
    // The FMLA claim (sorted 51st) has elements with no supporting fact, but it isn't analyzed and no step mentions it,
    // and nothing says the list was cut off.
    expect(a.claims.length).toBe(51);
    expect(a.steps.map((st) => st.text).join("\n")).toMatch(/FMLA retaliation.*no confirmed supporting fact/);
  });

  it("F6: the 'numbers only' analysis record accepts arbitrary text as its keys (content smuggled into a record staff can read)", async () => {
    const x = await setup();
    const planted = db.withFirm(x.paraCtx, (s) => s.client.query(
      "INSERT INTO huis.matter_analyses (firm_id, matter_id, run_by, counts) VALUES ($1, $2, $3, $4)",
      [x.firmId, x.matter.id, x.para.id, JSON.stringify({ "Client admitted she backdated the FMLA form": 1 })]));
    await expect(planted).rejects.toThrow();
    // (If it got in, any firm staff member on the Matter can read it.)
    const seen = await db.withFirm(x.readerCtx, (s) => s.client.query("SELECT counts::text AS c FROM huis.matter_analyses WHERE matter_id = $1", [x.matter.id]));
    expect(seen.rows.map((r) => r.c).join("")).not.toMatch(/backdated/);
  });

  it("F7: an item added while Reanalyze runs is never counted as new: 'since last analysis' compares the upload's transaction-start time", async () => {
    const x = await setup();
    await upload(x.owner, x.matter.id, "letter.txt", LETTER);
    await process();
    const lateId = randomUUID();
    // The upload's transaction starts (as with a large mail filing or a slow upload), Reanalyze runs and commits, then the upload commits.
    await db.withFirm(x.owner, async (s) => {
      const folder = (await s.client.query("SELECT id FROM huis.matter_folders WHERE matter_id = $1 AND NOT is_privileged_area LIMIT 1", [x.matter.id])).rows[0].id;
      await s.client.query(
        `INSERT INTO huis.evidence_items (id, firm_id, matter_id, folder_id, original_filename, size_bytes, sha256, storage_key, source, uploaded_by)
         VALUES ($1, $2, $3, $4, 'late.txt', 10, $5, $6, 'upload', $7)`,
        [lateId, x.firmId, x.matter.id, folder, "a".repeat(64), `sr15/${lateId}`, x.ownerUserId]);
      await db.withFirm(x.paraCtx, (s2) => reanalyzeMatter(s2, x.matter.id));
    });
    const recorded = (await t.admin.query("SELECT counts FROM huis.matter_analyses WHERE matter_id = $1", [x.matter.id])).rows[0].counts;
    expect(recorded.evidence).toBe(1); // the analysis didn't see the late item...
    const since = await db.withFirm(x.paraCtx, (s) => sinceLastAnalysis(s, x.matter.id));
    expect(since.evidence).toBe(1); // ...and it must then count as new. Currently 0: the Matter page never mentions it.
  });

  it("F8: on a large Matter the counts are silently capped at 5,000 (timeline and Case DNA reads are cut off; 'truncated' is dropped)", async () => {
    const x = await setup();
    await t.admin.query(
      `INSERT INTO huis.dna_nodes (firm_id, matter_id, kind, label, event_date, status, origin, created_by)
       SELECT $1, $2, 'event', 'Meeting ' || g, date '2020-01-01' + (g % 2000), 'confirmed', 'attorney', $3 FROM generate_series(1, 5001) g`,
      [x.firmId, x.matter.id, x.ownerUserId]);
    const a = await db.withFirm(x.paraCtx, (s) => analyzeMatter(s, x.matter.id));
    expect({ events: a.dna.events, dated: a.timeline.dated, withoutSource: a.timeline.withoutSource }).toEqual({ events: 5001, dated: 5001, withoutSource: 5001 });
  }, 60_000);
});

describe("security review 15 — attacks correctly blocked", () => {
  it("blocked: clients, other firms and walled-out administrators can't call brain_retry_failed, see analysis records, or get counts", async () => {
    const x = await setup();
    const w = await upload(x.owner, x.walled.id, "walled.txt", LETTER);
    await process();
    await t.admin.query("UPDATE huis.brain_sources SET status = 'failed', attempts = 5 WHERE evidence_id = $1", [w.id]);
    await db.withFirm(x.owner, (s) => reanalyzeMatter(s, x.walled.id)).then(() =>
      t.admin.query("UPDATE huis.brain_sources SET status = 'failed', attempts = 5 WHERE evidence_id = $1", [w.id]));
    await expect(db.withFirm(x.portalCtx, (s) => s.client.query("SELECT huis.brain_retry_failed($1)", [x.matter.id]))).rejects.toThrow(/not permitted|permission/);
    await expect(db.withFirm(x.portalCtx, (s) => sinceLastAnalysis(s, x.matter.id))).rejects.toThrow(/permission/i);
    await expect(db.withFirm(x.admin2Ctx, (s) => s.client.query("SELECT huis.brain_retry_failed($1)", [x.walled.id]))).rejects.toThrow(/not permitted|permission/);
    expect((await db.withFirm(x.admin2Ctx, (s) => s.client.query("SELECT 1 FROM huis.matter_analyses WHERE matter_id = $1", [x.walled.id]))).rowCount).toBe(0);
    const other = await newFirm(db, "Olive Other");
    await expect(db.withFirm(other.owner, (s) => s.client.query("SELECT huis.brain_retry_failed($1)", [x.walled.id]))).rejects.toThrow(/not permitted|permission/);
    await expect(db.withFirm(other.owner, (s) => s.client.query(
      "INSERT INTO huis.matter_analyses (firm_id, matter_id, run_by) VALUES ($1, $2, $3)", [x.firmId, x.matter.id, other.ownerUserId]))).rejects.toThrow();
    expect((await t.admin.query("SELECT status FROM huis.brain_sources WHERE evidence_id = $1", [w.id])).rows[0].status).toBe("failed");
  });

  it("blocked: read-only staff can't start a new period directly; records can't be backdated, re-attributed or moved to an unseen Matter", async () => {
    const x = await setup();
    await expect(db.withFirm(x.readerCtx, (s) => s.client.query("SELECT huis.brain_retry_failed($1)", [x.matter.id]))).rejects.toThrow(/not permitted|permission/);
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query(
      "INSERT INTO huis.matter_analyses (firm_id, matter_id, run_by) VALUES ($1, $2, $3)", [x.firmId, x.walled.id, x.para.id]))).rejects.toThrow();
    // (After the F6 fix the app can't write a record at all: only Reanalyze does, with its own who and when.)
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query(
      "INSERT INTO huis.matter_analyses (firm_id, matter_id, run_by, run_at) VALUES ($1, $2, $3, now() + interval '10 years')", [x.firmId, x.matter.id, x.ownerUserId]))).rejects.toThrow(/permission/);
    await db.withFirm(x.paraCtx, (s) => reanalyzeMatter(s, x.matter.id));
    const row = (await t.admin.query("SELECT run_by, run_at FROM huis.matter_analyses WHERE matter_id = $1", [x.matter.id])).rows[0];
    expect(row.run_by).toBe(x.para.id);
    expect(new Date(row.run_at).getTime()).toBeLessThan(Date.now() + 60_000);
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query("UPDATE huis.matter_analyses SET run_at = run_at - interval '1 year'"))).rejects.toThrow(/permission/);
  });
});
