import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chunkText } from "../src/brain/chunk";
import { BrainWorker } from "../src/brain/worker";
import { fingerprint } from "../src/ai/local";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import {
  addNote, askMatter, brainStatus, deleteNote, getAiProviderSetting, getAnswer, listMyQuestions, listNotes, setAiProviderSetting, updateNote,
} from "../src/services/brain";
import { createClient } from "../src/services/clients";
import {
  assembleOriginal, getUploadSession, markChunkReceived, newEvidenceId, recordEvidence, startUpload, storeChunk,
} from "../src/services/evidence";
import { addMatterMember, createMatter, listMatterFolders, removeMatterMember } from "../src/services/matters";
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
  vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-brain-vault-"));
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

const LETTER = `Termination letter.

Dear Ms. Smith, your employment with Acme Corporation is terminated effective April 18, 2026. This decision follows your request for FMLA leave on April 2, 2026 for surgery.

Signed, Cindy Manager, Human Resources.`;
const HANDBOOK = `Acme Employee Handbook. Section 4: Parking. Employees may park in lot B. Section 5: Holidays. The office closes on Thanksgiving and Christmas.`;
const WALLED = `Confidential settlement memo. The defendant offered 900000 dollars to settle the retaliation claim.`;

async function setup() {
  const f = await newFirm(db);
  const x = await db.withFirm(f.owner, async (s) => {
    const client = await createClient(s, { kind: "person", displayName: "Pat Smith" });
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

describe("splitting and meaning fingerprints", () => {
  it("splits long text into overlapping passages that keep their positions", () => {
    const text = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} about the March meeting and the FMLA request.`).join(" ");
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(4000);
      expect(text.slice(c.start, c.end).trim()).toBe(c.content);
    }
    expect(chunks.at(-1)!.end).toBe(text.length);
    expect(chunkText("")).toEqual([]);
  });

  it("related wording scores closer than unrelated wording", () => {
    const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
    const q = fingerprint("Why was the employee terminated after requesting FMLA leave?");
    expect(cos(q, fingerprint(LETTER))).toBeGreaterThan(cos(q, fingerprint(HANDBOOK)));
  });
});

describe("Matter Brain", () => {
  it("indexes readable evidence and notes, and answers with cited passages from this Matter", async () => {
    const x = await setup();
    const letter = await upload(x.owner, x.matter.id, "termination.txt", LETTER);
    await upload(x.owner, x.matter.id, "handbook.txt", HANDBOOK);
    await db.withFirm(x.paraCtx, (s) => addNote(s, x.matter.id, { title: "Call with client", body: "Client says the manager joked about her surgery at the March meeting." }));
    await process();
    expect(await db.withFirm(x.owner, (s) => brainStatus(s, x.matter.id))).toMatchObject({ documents: 2, documentsReady: 2, notes: 1, waiting: 0, failed: 0 });

    const id = await db.withFirm(x.paraCtx, (s) => askMatter(s, x.matter.id, "When was she terminated after the FMLA request?"));
    const a = await db.withFirm(x.paraCtx, (s) => getAnswer(s, id));
    expect(a.withheld).toBe(false);
    expect(a.answer).toMatch(/April 18/);
    const cited = a.citations.find((c) => c.evidenceId === letter.id)!;
    expect(cited).toMatchObject({ sourceTitle: "termination.txt" });
    expect(a.answer).toContain(`[${cited.n}]`);
    // Notes are part of the Brain too.
    const id2 = await db.withFirm(x.owner, (s) => askMatter(s, x.matter.id, "What did the manager say about her surgery?"));
    expect((await db.withFirm(x.owner, (s) => getAnswer(s, id2))).citations.some((c) => c.sourceTitle === "Call with client")).toBe(true);
  });

  it("never uses another Matter's evidence, and walled Matters stay walled", async () => {
    const x = await setup();
    await upload(x.owner, x.walled.id, "memo.txt", WALLED);
    await upload(x.owner, x.matter.id, "termination.txt", LETTER);
    await process();
    const id = await db.withFirm(x.owner, (s) => askMatter(s, x.matter.id, "What did the defendant offer to settle?"));
    const a = await db.withFirm(x.owner, (s) => getAnswer(s, id));
    expect(a.answer).not.toMatch(/900000/);
    // A paralegal outside the wall can't ask it or read its passages, even directly.
    await expect(db.withFirm(x.paraCtx, (s) => askMatter(s, x.walled.id, "settlement offer"))).rejects.toThrow();
    const rows = await db.withFirm(x.paraCtx, (s) => s.client.query("SELECT content FROM huis.brain_chunks WHERE content ILIKE '%900000%'"));
    expect(rows.rowCount).toBe(0);
    // Inside the wall it works.
    await db.withFirm(x.owner, (s) => addMatterMember(s, { matterId: x.walled.id, userId: x.para.id, access: "edit" }));
    const id2 = await db.withFirm(x.paraCtx, (s) => askMatter(s, x.walled.id, "What did the defendant offer to settle?"));
    expect((await db.withFirm(x.paraCtx, (s) => getAnswer(s, id2))).answer).toMatch(/900000/);
    // Once removed, their earlier answer is gone with their access.
    await db.withFirm(x.owner, (s) => removeMatterMember(s, x.walled.id, x.para.id));
    await expect(db.withFirm(x.paraCtx, (s) => getAnswer(s, id2))).rejects.toThrow();
  });

  it("clients and other outside users never see the Brain, notes or AI answers, even for documents shared with them", async () => {
    const x = await setup();
    const shared = (await db.withFirm(x.owner, (s) => listMatterFolders(s, x.matter.id))).find((f) => f.classification === "client_accessible")!;
    await upload(x.portalCtx, x.matter.id, "my-timeline.txt", LETTER, shared.id);
    await db.withFirm(x.owner, (s) => addNote(s, x.matter.id, { title: "Strategy", body: "Our theory: retaliation." }));
    await process();
    await expect(db.withFirm(x.portalCtx, (s) => askMatter(s, x.matter.id, "When was she terminated?"))).rejects.toThrow(/permission/i);
    await expect(db.withFirm(x.portalCtx, (s) => listNotes(s, x.matter.id))).rejects.toThrow(/permission/i);
    for (const table of ["brain_chunks", "brain_sources", "matter_notes", "brain_answers"]) {
      const r = await db.withFirm(x.portalCtx, (s) => s.client.query(`SELECT 1 FROM huis.${table}`));
      expect(r.rowCount).toBe(0);
    }
    // But the firm's staff can use the client's upload in the Brain.
    const id = await db.withFirm(x.owner, (s) => askMatter(s, x.matter.id, "When was she terminated?"));
    expect((await db.withFirm(x.owner, (s) => getAnswer(s, id))).answer).toMatch(/April 18/);
  });

  it("answers are private to the person who asked, and withheld if a source later becomes unavailable", async () => {
    const x = await setup();
    const noteId = await db.withFirm(x.owner, (s) => addNote(s, x.matter.id, { title: "Damages", body: "Back pay estimate is 85000 dollars through trial." }));
    await process();
    const id = await db.withFirm(x.paraCtx, (s) => askMatter(s, x.matter.id, "What is the back pay estimate?"));
    expect((await db.withFirm(x.paraCtx, (s) => getAnswer(s, id))).answer).toMatch(/85000/);
    await expect(db.withFirm(x.owner, (s) => getAnswer(s, id))).rejects.toThrow();
    expect(await db.withFirm(x.owner, (s) => listMyQuestions(s, x.matter.id))).toEqual([]);
    await db.withFirm(x.owner, (s) => deleteNote(s, noteId));
    const after = await db.withFirm(x.paraCtx, (s) => getAnswer(s, id));
    expect(after).toMatchObject({ withheld: true, answer: "", citations: [] });
  });

  it("evidence that stops being clean leaves the Brain at once", async () => {
    const x = await setup();
    const letter = await upload(x.owner, x.matter.id, "termination.txt", LETTER);
    await process();
    // (Simulates a later scan verdict; the guard that blocks direct edits is bypassed for the test.)
    await t.admin.query(`SET session_replication_role = replica; UPDATE huis.evidence_items SET status = 'infected' WHERE id = '${letter.id}'; SET session_replication_role = origin;`);
    const r = await db.withFirm(x.owner, (s) => s.client.query("SELECT 1 FROM huis.brain_chunks WHERE evidence_id = $1", [letter.id]));
    expect(r.rowCount).toBe(0);
  });

  it("notes: firm staff write them, only the author changes them, read-only staff can't add them", async () => {
    const x = await setup();
    const id = await db.withFirm(x.paraCtx, (s) => addNote(s, x.matter.id, { title: "Witness", body: "Jordan saw the meeting." }));
    await expect(db.withFirm(x.readerCtx, (s) => addNote(s, x.matter.id, { title: "x", body: "y" }))).rejects.toThrow(/permission/i);
    expect((await db.withFirm(x.readerCtx, (s) => listNotes(s, x.matter.id))).map((n) => n.title)).toEqual(["Witness"]);
    await expect(db.withFirm(x.owner, (s) => updateNote(s, id, { title: "Changed", body: "by someone else" }))).rejects.toThrow();
    await expect(db.withFirm(x.owner, (s) => deleteNote(s, id))).rejects.toThrow();
    await db.withFirm(x.paraCtx, (s) => updateNote(s, id, { title: "Witness", body: "Jordan and Lee saw the meeting." }));
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query("UPDATE huis.matter_notes SET matter_id = $2 WHERE id = $1", [id, x.walled.id]))).rejects.toThrow();
  });

  it("with AI turned off, nothing is indexed and questions are refused; only administrators change it", async () => {
    const x = await setup();
    await expect(db.withFirm(x.paraCtx, (s) => setAiProviderSetting(s, "off"))).rejects.toThrow();
    await db.withFirm(x.owner, (s) => setAiProviderSetting(s, "off"));
    expect(await db.withFirm(x.paraCtx, (s) => getAiProviderSetting(s))).toBe("off");
    await upload(x.owner, x.matter.id, "termination.txt", LETTER);
    await process();
    expect((await db.withFirm(x.owner, (s) => brainStatus(s, x.matter.id))).documentsReady).toBe(0);
    await expect(db.withFirm(x.owner, (s) => askMatter(s, x.matter.id, "When was she terminated?"))).rejects.toThrow(/turned off/);
    await db.withFirm(x.owner, (s) => setAiProviderSetting(s, "local"));
    await process();
    expect((await db.withFirm(x.owner, (s) => brainStatus(s, x.matter.id))).documentsReady).toBe(1);
  });

  it("the audit log and AI usage log never contain questions, answers or document text", async () => {
    const x = await setup();
    await upload(x.owner, x.matter.id, "termination.txt", LETTER);
    await process();
    await db.withFirm(x.paraCtx, (s) => askMatter(s, x.matter.id, "Was the termination retaliation for the FMLA request?"));
    const audit = await t.admin.query("SELECT metadata::text AS m FROM huis.audit_events WHERE firm_id = $1", [x.firmId]);
    expect(audit.rows.map((r) => r.m).join(" ")).not.toMatch(/retaliation|FMLA|April/i);
    const usage = await t.admin.query("SELECT * FROM huis.ai_requests WHERE firm_id = $1", [x.firmId]);
    expect(usage.rows.map((r) => r.purpose).sort()).toEqual(["ask", "index"]);
    expect(JSON.stringify(usage.rows)).not.toMatch(/retaliation|FMLA|April/i);
    // Administrators can see usage; other staff can't.
    expect((await db.withFirm(x.owner, (s) => s.client.query("SELECT 1 FROM huis.ai_requests"))).rowCount).toBe(2);
    expect((await db.withFirm(x.paraCtx, (s) => s.client.query("SELECT 1 FROM huis.ai_requests"))).rowCount).toBe(0);
  });

  it("the app can't write passages or index state itself, and question text can't inject into the search", async () => {
    const x = await setup();
    await upload(x.owner, x.matter.id, "termination.txt", LETTER);
    await process();
    await expect(db.withFirm(x.owner, (s) => s.client.query(
      "INSERT INTO huis.brain_chunks (firm_id, matter_id, source_id, chunk_no, content, char_start, char_end, model) SELECT firm_id, matter_id, id, 99, 'planted', 0, 1, 'x' FROM huis.brain_sources LIMIT 1"))).rejects.toThrow(/permission/);
    await expect(db.withFirm(x.owner, (s) => s.client.query("SELECT * FROM huis.worker_claim_brain_source()"))).rejects.toThrow(/permission/);
    for (const q of ["'); DROP TABLE huis.brain_chunks; --", "a & b | !c <-> (d)", "x:* & y"]) {
      await db.withFirm(x.owner, (s) => askMatter(s, x.matter.id, q));
    }
    await expect(db.withFirm(x.owner, (s) => askMatter(s, x.matter.id, "x".repeat(2001)))).rejects.toThrow();
  });
});
