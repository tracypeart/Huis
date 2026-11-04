import { randomBytes } from "node:crypto";
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
  vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-analysis-vault-"));
  vault = new EvidenceVault(new LocalObjectStore(vaultDir), new MasterKeyProvider(randomBytes(32).toString("base64")));
  processor = new EvidenceProcessor(t.worker, vault, scanner);
  brain = new BrainWorker(t.worker);
});
afterAll(async () => {
  await t?.drop();
  if (vaultDir) await rm(vaultDir, { recursive: true, force: true });
});

async function upload(ctx: RequestContext, matterId: string, filename: string, text: string, folderId?: string) {
  const content = Buffer.from(text);
  const session = await db.withFirm(ctx, (s) => startUpload(s, { matterId, filename, totalSize: content.length, folderId }));
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
const infect = (id: string) =>
  t.admin.query(`SET session_replication_role = replica; UPDATE huis.evidence_items SET status = 'infected' WHERE id = '${id}'; SET session_replication_role = origin;`);

async function setup() {
  const f = await newFirm(db);
  const x = await db.withFirm(f.owner, async (s) => {
    const client = await createClient(s, { kind: "person", displayName: "Pat Smith", email: "pat.smith@example.com" });
    const para = await inviteUser(s, { email: `p@${f.slug}.example`, fullName: "Pat Para", role: "paralegal", locationId: f.locationId });
    const reader = await inviteUser(s, { email: `r@${f.slug}.example`, fullName: "Rae Reader", role: "read_only", locationId: f.locationId });
    const portal = await inviteUser(s, { email: `c@${f.slug}.example`, fullName: "Casey Client", role: "client", locationId: f.locationId });
    const matter = await createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
    const walled = await createMatter(s, { title: "Walled", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT", restricted: true });
    return { para, reader, portal, matter, walled };
  });
  await db.withFirm(f.owner, (s) => addMatterMember(s, { matterId: x.matter.id, userId: x.portal.id, access: "view", acknowledgePrivilegeWaiverRisk: true }));
  const ctx = (id: string): RequestContext => ({ firmId: f.firmId, userId: id });
  return { ...f, ...x, paraCtx: ctx(x.para.id), readerCtx: ctx(x.reader.id), portalCtx: ctx(x.portal.id) };
}

const LETTER = `Termination letter.

Dear Ms. Smith, your employment with Acme Corporation is terminated effective April 18, 2026.
This decision follows your request for FMLA leave on April 2, 2026 for surgery.`;
const DEPOSITION = "Deposition of Cindy Manager, taken June 3, 2026.\n\nA. I didn't know about her surgery until May.";

describe("Matter analysis", () => {
  it("counts what's there and what's missing by fixed rules, and lists next steps that link to where to act", async () => {
    const x = await setup();
    await upload(x.owner, x.matter.id, "termination.txt", LETTER);
    await upload(x.owner, x.matter.id, "deposition.txt", DEPOSITION);
    await process();
    await db.withFirm(x.owner, async (s) => {
      await addClaimFromTemplate(s, x.matter.id, "fmla_retaliation");
      await addNode(s, x.matter.id, { kind: "event", label: "Call with HR", eventDate: "2026-04-05" });
    });
    const a = await db.withFirm(x.paraCtx, (s) => analyzeMatter(s, x.matter.id));
    expect(a.lastRun).toBeNull();
    expect(a.sinceLast).toEqual({ evidence: 2, notes: 0 });
    expect(a.evidence).toMatchObject({ total: 2, clean: 2, waitingScan: 0, quarantined: 0 });
    expect(a.dna.suggestedEvents).toBeGreaterThan(0);
    expect(a.claims[0]!.unsupported.length).toBe(a.claims[0]!.elements);
    expect(a.timeline).toMatchObject({ withoutSource: 1 });
    expect(a.contradictions.potential).toBeGreaterThan(0);
    const texts = a.steps.map((s) => s.text).join("\n");
    expect(texts).toMatch(/Review \d+ suggestions from Huis/);
    expect(texts).toMatch(/Decide \d+ potential contradiction/);
    expect(texts).toMatch(/FMLA retaliation.*no confirmed supporting fact/);
    expect(texts).toMatch(/1 confirmed timeline item has no source yet/);
    expect(a.steps.every((s) => s.href.startsWith(`/matters/${x.matter.id}`))).toBe(true);
    // Nothing anywhere is a score.
    expect(JSON.stringify(a)).not.toMatch(/score|health|%/i);
  });

  it("Reanalyze retries what the Matter Brain couldn't read, and starts a new period for 'new since'", async () => {
    const x = await setup();
    const letter = await upload(x.owner, x.matter.id, "termination.txt", LETTER);
    await process();
    // The Brain couldn't read it (say, a temporary failure).
    await t.admin.query("UPDATE huis.brain_sources SET status = 'failed', attempts = 5, last_error = 'x' WHERE evidence_id = $1", [letter.id]);
    let a = await db.withFirm(x.paraCtx, (s) => analyzeMatter(s, x.matter.id));
    expect(a.steps.map((s) => s.text).join("\n")).toMatch(/1 item couldn't be added to the Matter Brain/);
    expect(await db.withFirm(x.paraCtx, (s) => reanalyzeMatter(s, x.matter.id))).toEqual({ retried: 1 });
    expect((await t.admin.query("SELECT status, attempts FROM huis.brain_sources WHERE evidence_id = $1", [letter.id])).rows[0]).toEqual({ status: "queued", attempts: 0 });
    await process();
    expect((await t.admin.query("SELECT status FROM huis.brain_sources WHERE evidence_id = $1", [letter.id])).rows[0].status).toBe("indexed");
    a = await db.withFirm(x.paraCtx, (s) => analyzeMatter(s, x.matter.id));
    expect(a.lastRun?.by).toBe("Pat Para");
    expect(a.sinceLast.evidence).toBe(0);
    await upload(x.owner, x.matter.id, "deposition.txt", DEPOSITION);
    expect((await db.withFirm(x.paraCtx, (s) => sinceLastAnalysis(s, x.matter.id))).evidence).toBe(1);
    // Recorded: who and when (by the database), numbers only; audit without content.
    const row = (await t.admin.query("SELECT run_by, counts FROM huis.matter_analyses WHERE matter_id = $1", [x.matter.id])).rows[0];
    expect(row).toEqual({ run_by: x.para.id, counts: { evidence: 1, retried: 1 } });
    const audit = await t.admin.query("SELECT metadata::text AS m FROM huis.audit_events WHERE firm_id = $1 AND action = 'matter.reanalyzed'", [x.firmId]);
    expect(audit.rows.map((r) => JSON.parse(r.m))).toEqual([{ retried: "1" }]);
  });

  it("is firm staff only: read-only staff can look but not reanalyze; clients, walls and other firms get nothing; the database checks it all", async () => {
    const x = await setup();
    await upload(x.owner, x.walled.id, "walled.txt", LETTER);
    await process();
    expect((await db.withFirm(x.readerCtx, (s) => analyzeMatter(s, x.matter.id))).evidence.total).toBe(0);
    await expect(db.withFirm(x.readerCtx, (s) => reanalyzeMatter(s, x.matter.id))).rejects.toThrow(/permission/i);
    await expect(db.withFirm(x.readerCtx, (s) => s.client.query("SELECT huis.brain_retry_failed($1)", [x.matter.id]))).rejects.toThrow(/not permitted|permission/);
    await expect(db.withFirm(x.readerCtx, (s) => s.client.query(
      "INSERT INTO huis.matter_analyses (firm_id, matter_id, run_by) VALUES ($1, $2, $3)", [x.firmId, x.matter.id, x.reader.id]))).rejects.toThrow();
    await expect(db.withFirm(x.portalCtx, (s) => analyzeMatter(s, x.matter.id))).rejects.toThrow(/permission/i);
    expect((await db.withFirm(x.portalCtx, (s) => s.client.query("SELECT 1 FROM huis.matter_analyses"))).rowCount).toBe(0);
    await expect(db.withFirm(x.paraCtx, (s) => analyzeMatter(s, x.walled.id))).rejects.toThrow(/not found/i);
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query("SELECT huis.brain_retry_failed($1)", [x.walled.id]))).rejects.toThrow(/not permitted|permission/);
    const other = await newFirm(db, "Other Owner");
    await expect(db.withFirm(other.owner, (s) => analyzeMatter(s, x.matter.id))).rejects.toThrow(/not found/i);
    // Who ran it can't be faked; only numbers are recorded; records can't be changed or removed.
    await db.withFirm(x.paraCtx, (s) => s.client.query(
      "INSERT INTO huis.matter_analyses (firm_id, matter_id, run_by, run_at, counts) VALUES ($1, $2, $3, '2001-01-01', '{\"evidence\": 3}')",
      [x.firmId, x.matter.id, x.ownerUserId]));
    const row = (await t.admin.query("SELECT run_by, run_at FROM huis.matter_analyses WHERE matter_id = $1", [x.matter.id])).rows[0];
    expect(row.run_by).toBe(x.para.id);
    expect(new Date(row.run_at).getUTCFullYear()).toBeGreaterThan(2001);
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query(
      "INSERT INTO huis.matter_analyses (firm_id, matter_id, run_by, counts) VALUES ($1, $2, $3, '{\"note\": \"Pat admitted it\"}')",
      [x.firmId, x.matter.id, x.para.id]))).rejects.toThrow(/numbers only/);
    await expect(db.withFirm(x.owner, (s) => s.client.query("UPDATE huis.matter_analyses SET counts = '{}'"))).rejects.toThrow(/permission/);
    await expect(db.withFirm(x.owner, (s) => s.client.query("DELETE FROM huis.matter_analyses"))).rejects.toThrow(/permission/);
  });
});
