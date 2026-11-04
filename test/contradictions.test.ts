import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrainWorker } from "../src/brain/worker";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { createClient } from "../src/services/clients";
import { getNode, listNodes } from "../src/services/dna";
import { assembleOriginal, getUploadSession, markChunkReceived, newEvidenceId, recordEvidence, startUpload, storeChunk } from "../src/services/evidence";
import { addMatterMember, createMatter } from "../src/services/matters";
import { inviteUser } from "../src/services/users";
import { MasterKeyProvider } from "../src/storage/encryption";
import type { MalwareScanner } from "../src/storage/scanner";
import { EvidenceVault, LocalObjectStore } from "../src/storage/store";
import { claimedBefore, findStatements } from "../src/contradictions/detect";
import { confirmContradiction, getContradictions, reconsiderContradiction, rejectContradiction } from "../src/services/contradictions";
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
  vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-contradiction-vault-"));
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

const DEPOSITION = `Deposition of Cindy Manager, taken June 3, 2026.

Q. When did you first hear about the surgery?
A. I didn't know about her surgery until May. Nobody told me about any FMLA leave request.
Q. Anything else?
A. I know the policy well.`;
const EMAIL = [
  "From: Pat Smith <pat.smith@example.com>", "To: Cindy Manager <cindy@acme.example>",
  "Subject: FMLA leave request", "Date: Thu, 02 Apr 2026 09:00:00 -0600", "MIME-Version: 1.0", "Content-Type: text/plain", "",
  "Cindy, I need FMLA leave for my surgery on April 20.", "",
].join("\r\n");
const LETTER = "HR memo. On April 12, 2026 the doctor confirmed the surgery date to HR.";
const LATER = "Update. On May 20, 2026 the surgery was rescheduled.";

async function matterWithEvidence() {
  const x = await setup();
  const deposition = await upload(x.owner, x.matter.id, "deposition-cindy.txt", DEPOSITION);
  const email = await upload(x.owner, x.matter.id, "leave-request.eml", EMAIL);
  const letter = await upload(x.owner, x.matter.id, "hr-memo.txt", LETTER);
  const later = await upload(x.owner, x.matter.id, "update.txt", LATER);
  await process();
  return { ...x, deposition, email, letter, later };
}
const surgeryFlag = (r: Awaited<ReturnType<typeof getContradictions>>) => r.potential.find((f) => f.statement.topics.includes("surgery"))!;

describe("finding statements (fixed rules)", () => {
  it("finds denials of knowledge or notice, what they're about, and any 'not until' date", () => {
    const st = findStatements(`Taken June 3, 2026. I didn't know about her surgery until May. Nobody told me about any FMLA leave request.
I first learned of the complaint on 5/6/2026. We never received the doctor's note before May 1, 2026. She was not aware of the policy.
I know about the surgery now. I don't know. The surgery was in April.`);
    expect(st.map((s) => [s.quote, s.topics, s.before])).toEqual([
      ["I didn't know about her surgery until May.", ["surgery"], "2026-05-01"],
      ["Nobody told me about any FMLA leave request.", ["fmla", "leave", "request"], null],
      ["I first learned of the complaint on 5/6/2026.", ["complaint"], "2026-05-06"],
      ["We never received the doctor's note before May 1, 2026.", ["doctor", "note"], "2026-05-01"],
      ["She was not aware of the policy.", ["policy"], null],
    ]);
    expect(st[0]!.beforeText).toBe("until May (2026)");
    // Without a year anywhere, "until May" can't be dated (and isn't guessed).
    expect(findStatements("I didn't know about the surgery until May.")[0]!.before).toBeNull();
    expect(claimedBefore("not until 31/31/2026", 2026)).toBeNull();
  });

  it("stays fast and bounded on hostile text", () => {
    const started = Date.now();
    const st = findStatements(`${"I did not know ".repeat(50_000)}${"x".repeat(300_000)}${"I didn't know surgery. ".repeat(10_000)}`);
    expect(st.length).toBeLessThanOrEqual(200);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("contradiction engine", () => {
  it("flags a statement against earlier evidence on the same subject from other sources, with its confidence and reasons", async () => {
    const x = await matterWithEvidence();
    const r = await db.withFirm(x.paraCtx, (s) => getContradictions(s, x.matter.id));
    const f = surgeryFlag(r);
    expect(f.statement).toMatchObject({ quote: "I didn't know about her surgery until May.", evidenceId: x.deposition.id, sourceTitle: "deposition-cindy.txt", before: "2026-05-01" });
    // The April email and the April 12 memo; not the May 20 update (after "until May"), and never the deposition itself.
    expect(f.conflicting.map((c) => [c.date, c.kind]).sort()).toEqual([["2026-04-02", "email"], ["2026-04-12", "event"]]);
    expect(f.conflicting.find((c) => c.kind === "email")!.passage?.text).toMatch(/surgery/);
    expect(f.confidence).toBe("medium");
    expect(f.why).toBe("2 earlier items from 2 different sources mention “surgery”, dated before the statement's “until May (2026)”.");
    // "Nobody told me about any FMLA leave request" against the email asking for exactly that (no date given: any date counts).
    const fmla = r.potential.find((p) => p.statement.topics.includes("fmla"))!;
    expect(fmla.conflicting.map((c) => c.evidenceId)).toEqual([x.email.id]);
    expect(fmla.confidence).toBe("low");
    // "I know the policy well" isn't a denial.
    expect(r.potential.some((p) => /policy/.test(p.statement.quote))).toBe(false);
  });

  it("versions of one document count as one source, so a draft doesn't raise the confidence", async () => {
    const x = await setup();
    const memo = (v: string) => `HR memo ${v}. On April 12, 2026 the doctor confirmed the surgery date to HR. The employee asked for leave under the ` +
      "Family and Medical Leave Act and provided a certification from her physician describing the planned procedure, the expected recovery " +
      "period of six weeks, and the follow up appointments. Human Resources acknowledged receipt and placed the certification in her file.";
    await upload(x.owner, x.matter.id, "deposition-cindy.txt", DEPOSITION);
    await upload(x.owner, x.matter.id, "leave-request.eml", EMAIL);
    const draft = await upload(x.owner, x.matter.id, "HR memo DRAFT.txt", memo("draft"));
    const final = await upload(x.owner, x.matter.id, "HR memo FINAL.txt", memo("final"));
    await process();
    const link = await t.admin.query("SELECT kind FROM huis.evidence_similarity WHERE item_a = least($1::uuid, $2::uuid) AND item_b = greatest($1::uuid, $2::uuid)", [draft.id, final.id]);
    expect(link.rows.length).toBe(1);
    const f = surgeryFlag(await db.withFirm(x.paraCtx, (s) => getContradictions(s, x.matter.id)));
    expect(f.conflicting.length).toBe(3); // the email, and the event from each version
    expect(f.confidence).toBe("medium");
    expect(f.why).toMatch(/^3 earlier items from 2 different sources \(versions of one document count once\)/);
  });

  it("confirming records the statement in Case DNA, cited, with the evidence linked as contradicting it", async () => {
    const x = await matterWithEvidence();
    const f = surgeryFlag(await db.withFirm(x.paraCtx, (s) => getContradictions(s, x.matter.id)));
    const statementId = await db.withFirm(x.paraCtx, (s) => confirmContradiction(s, x.matter.id, f.key));
    const node = await db.withFirm(x.paraCtx, (s) => getNode(s, statementId));
    expect(node.node).toMatchObject({ kind: "fact", status: "confirmed", label: "Statement: “I didn't know about her surgery until May.”" });
    // The quote is taken from the deposition itself.
    expect(node.citations).toEqual([expect.objectContaining({ evidenceId: x.deposition.id, quote: "I didn't know about her surgery until May." })]);
    const contradicting = node.links.filter((l) => l.relation === "contradicts" && l.direction === "in");
    expect(contradicting.map((l) => l.other.label).sort()).toEqual([
      "Email of 2026-04-02: FMLA leave request", "On April 12, 2026 the doctor confirmed the surgery date to HR.",
    ]);
    // Huis's suggested event is now confirmed; the email became a fact cited to the passage about the surgery.
    expect(contradicting.every((l) => l.other.status === "confirmed")).toBe(true);
    const emailFact = await db.withFirm(x.paraCtx, (s) => getNode(s, contradicting.find((l) => /^Email/.test(l.other.label))!.other.id));
    expect(emailFact.citations[0]).toMatchObject({ evidenceId: x.email.id });
    expect(emailFact.citations[0]!.quote).toMatch(/surgery/);

    const after = await db.withFirm(x.paraCtx, (s) => getContradictions(s, x.matter.id));
    expect(after.potential.some((p) => p.key === f.key)).toBe(false);
    expect(after.confirmed).toEqual([expect.objectContaining({ key: f.key, statementNodeId: statementId })]);
    await expect(db.withFirm(x.paraCtx, (s) => confirmContradiction(s, x.matter.id, f.key))).rejects.toThrow(/not found/i);
    // The audit log records the decision, never the wording.
    const audit = await t.admin.query("SELECT metadata::text AS m FROM huis.audit_events WHERE firm_id = $1 AND action LIKE 'contradiction.%'", [x.firmId]);
    expect(audit.rows.map((a) => JSON.parse(a.m))).toEqual([{ items: "2", confidence: "medium" }]);
  });

  it("rejections stick until reconsidered; made-up or other Matters' keys are refused", async () => {
    const x = await matterWithEvidence();
    const f = surgeryFlag(await db.withFirm(x.paraCtx, (s) => getContradictions(s, x.matter.id)));
    await db.withFirm(x.paraCtx, (s) => rejectContradiction(s, x.matter.id, f.key));
    let r = await db.withFirm(x.paraCtx, (s) => getContradictions(s, x.matter.id));
    expect(r.potential.some((p) => p.key === f.key)).toBe(false);
    expect(r.rejected.map((p) => p.key)).toEqual([f.key]);
    await expect(db.withFirm(x.paraCtx, (s) => confirmContradiction(s, x.matter.id, f.key))).rejects.toThrow(/not found/i);
    await db.withFirm(x.paraCtx, (s) => reconsiderContradiction(s, x.matter.id, f.key));
    r = await db.withFirm(x.paraCtx, (s) => getContradictions(s, x.matter.id));
    expect(r.potential.some((p) => p.key === f.key)).toBe(true);

    await expect(db.withFirm(x.paraCtx, (s) => confirmContradiction(s, x.matter.id, "0".repeat(64)))).rejects.toThrow(/not found/i);
    await expect(db.withFirm(x.paraCtx, (s) => rejectContradiction(s, x.matter.id, "not-a-key"))).rejects.toThrow(/not found/i);
    // A real key, used on another Matter, means nothing there.
    const other = await db.withFirm(x.owner, (s) => s.client.query("SELECT id FROM huis.matters WHERE title = 'Walled' AND firm_id = $1", [x.firmId]));
    await expect(db.withFirm(x.owner, (s) => confirmContradiction(s, other.rows[0].id, f.key))).rejects.toThrow(/not found/i);
  });

  it("is firm staff only (read-only staff can look but not decide), respects walls, and the database checks every decision", async () => {
    const x = await matterWithEvidence();
    const f = surgeryFlag(await db.withFirm(x.owner, (s) => getContradictions(s, x.matter.id)));
    await expect(db.withFirm(x.portalCtx, (s) => getContradictions(s, x.matter.id))).rejects.toThrow(/permission/i);
    expect((await db.withFirm(x.readerCtx, (s) => getContradictions(s, x.matter.id))).potential.length).toBeGreaterThan(0);
    await expect(db.withFirm(x.readerCtx, (s) => confirmContradiction(s, x.matter.id, f.key))).rejects.toThrow(/permission/i);
    await expect(db.withFirm(x.readerCtx, (s) => rejectContradiction(s, x.matter.id, f.key))).rejects.toThrow(/permission/i);
    await expect(db.withFirm(x.paraCtx, (s) => getContradictions(s, x.walled.id))).rejects.toThrow(/not found/i);
    const other = await newFirm(db, "Other Owner");
    await expect(db.withFirm(other.owner, (s) => getContradictions(s, x.matter.id))).rejects.toThrow(/not found/i);
    // Directly in the database: read-only staff and clients can't record decisions; nobody can record one as someone else.
    const insert = `INSERT INTO huis.contradiction_decisions (firm_id, matter_id, flag_key, decision, decided_by) VALUES ($1, $2, $3, 'rejected', $4)`;
    await expect(db.withFirm(x.readerCtx, (s) => s.client.query(insert, [x.firmId, x.matter.id, "a".repeat(64), x.reader.id]))).rejects.toThrow();
    await expect(db.withFirm(x.portalCtx, (s) => s.client.query(insert, [x.firmId, x.matter.id, "a".repeat(64), x.portal.id]))).rejects.toThrow();
    await db.withFirm(x.paraCtx, (s) => s.client.query(insert, [x.firmId, x.matter.id, "b".repeat(64), x.ownerUserId]));
    expect((await t.admin.query("SELECT decided_by FROM huis.contradiction_decisions WHERE flag_key = $1", ["b".repeat(64)])).rows[0].decided_by).toBe(x.para.id);
    // A confirmed decision must point at a confirmed fact in the same Matter.
    const walledFact = (await t.admin.query(
      `INSERT INTO huis.dna_nodes (firm_id, matter_id, kind, label, status, origin, created_by) VALUES ($1, $2, 'fact', 'x', 'confirmed', 'attorney', $3) RETURNING id`,
      [x.firmId, x.walled.id, x.ownerUserId])).rows[0].id;
    await expect(db.withFirm(x.owner, (s) => s.client.query(
      `INSERT INTO huis.contradiction_decisions (firm_id, matter_id, flag_key, decision, statement_node_id, decided_by) VALUES ($1, $2, $3, 'confirmed', $4, $5)`,
      [x.firmId, x.matter.id, "c".repeat(64), walledFact, x.ownerUserId]))).rejects.toThrow(/same Matter/);
    // Confirmed decisions can't be withdrawn or rewritten from the app.
    await db.withFirm(x.owner, (s) => confirmContradiction(s, x.matter.id, f.key));
    expect((await db.withFirm(x.owner, (s) => s.client.query("DELETE FROM huis.contradiction_decisions WHERE decision = 'confirmed'"))).rowCount).toBe(0);
    await expect(db.withFirm(x.owner, (s) => s.client.query("UPDATE huis.contradiction_decisions SET decision = 'rejected'"))).rejects.toThrow(/permission/);
  });

  it("evidence that stops being clean leaves at once: as a conflicting item, and as the statement itself", async () => {
    const x = await matterWithEvidence();
    await infect(x.email.id);
    let f = surgeryFlag(await db.withFirm(x.paraCtx, (s) => getContradictions(s, x.matter.id)));
    expect(f.conflicting.map((c) => c.kind)).toEqual(["event"]);
    expect(f.confidence).toBe("low");
    await infect(x.deposition.id);
    const r = await db.withFirm(x.paraCtx, (s) => getContradictions(s, x.matter.id));
    // Both statements came from the deposition: nothing is left to flag.
    expect(r.potential).toEqual([]);
  });
});
