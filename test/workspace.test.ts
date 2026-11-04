import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrainWorker } from "../src/brain/worker";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { createClient } from "../src/services/clients";
import { listMyQuestions } from "../src/services/brain";
import { prepareMatterExport } from "../src/services/matterExport";
import {
  askInConversation, createConversation, createPrompt, deleteConversation, deletePrompt, getConversation, getPrompt, listConversations,
  listPrompts, updateConversation, updatePrompt,
} from "../src/services/workspace";
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
  vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-workspace-vault-"));
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

const LETTER = `Termination letter.

Dear Ms. Smith, your employment with Acme Corporation is terminated effective April 18, 2026.
This decision follows your request for FMLA leave on April 2, 2026 for surgery.`;

async function withDocs() {
  const x = await setup();
  const admin = await db.withFirm(x.owner, (s) => inviteUser(s, { email: `a@${x.slug}.example`, fullName: "Ada Admin", role: "firm_admin", locationId: x.locationId }));
  const letter = await upload(x.owner, x.matter.id, "termination.txt", LETTER);
  await process();
  return { ...x, letter, admin, adminCtx: { firmId: x.firmId, userId: admin.id } as RequestContext };
}

describe("AI Workspace", () => {
  it("saves a conversation's questions and cited answers, in order, under a category", async () => {
    const x = await withDocs();
    const id = await db.withFirm(x.paraCtx, (s) => createConversation(s, x.matter.id, { title: "Termination timeline", category: "timeline" }));
    await db.withFirm(x.paraCtx, (s) => askInConversation(s, id, "When was she terminated?"));
    await db.withFirm(x.paraCtx, (s) => askInConversation(s, id, "Why did she request leave?"));
    const v = await db.withFirm(x.paraCtx, (s) => getConversation(s, id));
    expect(v.conversation).toMatchObject({ title: "Termination timeline", category: "timeline", shared: false, mine: true });
    expect(v.answers.map((a) => a.question)).toEqual(["When was she terminated?", "Why did she request leave?"]);
    expect(v.answers[0]!.citations[0]).toMatchObject({ evidenceId: x.letter.id, sourceTitle: "termination.txt" });
    expect(v.hidden).toBe(0);
    expect((await db.withFirm(x.paraCtx, (s) => listConversations(s, x.matter.id))).map((c) => [c.title, c.answers])).toEqual([["Termination timeline", 2]]);
    expect(await db.withFirm(x.paraCtx, (s) => listConversations(s, x.matter.id, "damages"))).toEqual([]);
    await expect(db.withFirm(x.paraCtx, (s) => createConversation(s, x.matter.id, { title: "x", category: "gossip" }))).rejects.toThrow();
    // The audit log records the kind of change, never titles, questions or answers.
    const audit = await t.admin.query("SELECT action, metadata::text AS m FROM huis.audit_events WHERE firm_id = $1 AND action LIKE 'ai.%'", [x.firmId]);
    expect(audit.rows.map((r) => r.action)).toEqual(["ai.conversation_created"]);
    expect(audit.rows.every((r) => !/termination|terminated|leave/i.test(r.m))).toBe(true);
  });

  it("is private until its owner shares it; colleagues can then read it but not change it, and it isn't 'theirs'", async () => {
    const x = await withDocs();
    const id = await db.withFirm(x.paraCtx, (s) => createConversation(s, x.matter.id, { title: "Strategy", category: "strategy" }));
    const answerId = await db.withFirm(x.paraCtx, (s) => askInConversation(s, id, "When was she terminated?"));
    // Private: not listed, not readable, even directly in the database.
    expect(await db.withFirm(x.owner, (s) => listConversations(s, x.matter.id))).toEqual([]);
    await expect(db.withFirm(x.owner, (s) => getConversation(s, id))).rejects.toThrow(/not found/i);
    expect((await db.withFirm(x.owner, (s) => s.client.query("SELECT 1 FROM huis.brain_answers WHERE id = $1", [answerId]))).rowCount).toBe(0);

    await db.withFirm(x.paraCtx, (s) => updateConversation(s, id, { title: "Strategy", category: "strategy", shared: true }));
    const seen = await db.withFirm(x.owner, (s) => getConversation(s, id));
    expect(seen.conversation).toMatchObject({ shared: true, mine: false, ownerName: "Pat Para" });
    expect(seen.answers.map((a) => [a.question, a.mine])).toEqual([["When was she terminated?", false]]);
    // Read-only staff can read a shared conversation too.
    expect((await db.withFirm(x.readerCtx, (s) => getConversation(s, id))).answers.length).toBe(1);
    // …but nobody but the owner can add to, change or delete it.
    await expect(db.withFirm(x.owner, (s) => askInConversation(s, id, "Anything else?"))).rejects.toThrow(/not found/i);
    await expect(db.withFirm(x.owner, (s) => updateConversation(s, id, { title: "Mine now", category: "trial", shared: true }))).rejects.toThrow(/not found/i);
    await expect(db.withFirm(x.owner, (s) => deleteConversation(s, id))).rejects.toThrow(/not found/i);
    expect((await db.withFirm(x.owner, (s) => s.client.query("UPDATE huis.ai_conversations SET title = 'x' WHERE id = $1", [id]))).rowCount).toBe(0);
    expect((await db.withFirm(x.owner, (s) => s.client.query("DELETE FROM huis.brain_answers WHERE id = $1", [answerId]))).rowCount).toBe(0);
    await expect(db.withFirm(x.owner, (s) => s.client.query(
      `INSERT INTO huis.brain_answers (firm_id, matter_id, asked_by, question, answer, provider, model, conversation_id)
       VALUES ($1, $2, $3, 'planted', 'planted', 'local', 'x', $4)`, [x.firmId, x.matter.id, x.ownerUserId, id]))).rejects.toThrow(/own conversation/);
    // A shared answer isn't the reader's: not in their "My questions", not in their export.
    expect(await db.withFirm(x.owner, (s) => listMyQuestions(s, x.matter.id))).toEqual([]);
    await db.withFirm(x.adminCtx, async (s) => askInConversation(s, await createConversation(s, x.matter.id, { title: "Mine", category: "trial" }), "Why did she request leave?"));
    const plan = await db.withFirm(x.adminCtx, (s) => prepareMatterExport(s, x.matter.id, true));
    // The exporter's own question is in it (so the check below means something); the colleague's isn't.
    expect(JSON.stringify(plan)).toContain("Why did she request leave?");
    expect(JSON.stringify(plan)).not.toContain("When was she terminated?");

    await db.withFirm(x.paraCtx, (s) => updateConversation(s, id, { title: "Strategy", category: "strategy", shared: false }));
    await expect(db.withFirm(x.owner, (s) => getConversation(s, id))).rejects.toThrow(/not found/i);
    const audit = await t.admin.query("SELECT action FROM huis.audit_events WHERE firm_id = $1 AND actor_user_id = $2 AND action LIKE 'ai.conversation_%' ORDER BY id", [x.firmId, x.para.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(["ai.conversation_created", "ai.conversation_shared", "ai.conversation_unshared"]);
  });

  it("is firm staff only, respects walls, and withholds answers whose sources become unavailable", async () => {
    const x = await withDocs();
    const id = await db.withFirm(x.owner, (s) => createConversation(s, x.walled.id, { title: "Walled", category: "strategy" }));
    await expect(db.withFirm(x.paraCtx, (s) => createConversation(s, x.walled.id, { title: "x", category: "strategy" }))).rejects.toThrow(/not found/i);
    await db.withFirm(x.owner, (s) => updateConversation(s, id, { title: "Walled", category: "strategy", shared: true }));
    await expect(db.withFirm(x.paraCtx, (s) => getConversation(s, id))).rejects.toThrow(/not found/i);
    await expect(db.withFirm(x.portalCtx, (s) => listConversations(s, x.matter.id))).rejects.toThrow(/permission/i);
    await expect(db.withFirm(x.portalCtx, (s) => getConversation(s, id))).rejects.toThrow(/permission/i);
    expect((await db.withFirm(x.portalCtx, (s) => s.client.query("SELECT 1 FROM huis.ai_conversations"))).rowCount).toBe(0);
    const other = await newFirm(db, "Other Owner");
    await expect(db.withFirm(other.owner, (s) => getConversation(s, id))).rejects.toThrow(/not found/i);
    // Can't plant a conversation as someone else, or in another firm.
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query(
      "INSERT INTO huis.ai_conversations (firm_id, matter_id, owner_id, title, category) VALUES ($1, $2, $3, 'x', 'trial')", [x.firmId, x.matter.id, x.ownerUserId]))).rejects.toThrow();

    // Shared answer, then its source is found infected: withheld from everyone, and counted (only) as withheld.
    const conv = await db.withFirm(x.paraCtx, (s) => createConversation(s, x.matter.id, { title: "Shared", category: "trial" }));
    await db.withFirm(x.paraCtx, (s) => askInConversation(s, conv, "When was she terminated?"));
    await db.withFirm(x.paraCtx, (s) => updateConversation(s, conv, { title: "Shared", category: "trial", shared: true }));
    await infect(x.letter.id);
    const v = await db.withFirm(x.owner, (s) => getConversation(s, conv));
    expect(v.answers).toEqual([]);
    expect(v.hidden).toBe(1);
    // The count function says nothing about conversations the caller can't see.
    expect((await db.withFirm(x.portalCtx, (s) => s.client.query("SELECT huis.ai_conversation_answer_count($1) AS n", [conv]))).rows[0].n).toBe(0);
    // Deleting a conversation deletes its answers.
    await db.withFirm(x.paraCtx, (s) => deleteConversation(s, conv));
    expect((await t.admin.query("SELECT count(*)::int AS n FROM huis.brain_answers WHERE conversation_id = $1", [conv])).rows[0].n).toBe(0);
  });
});

describe("answers list only the sources they quote", () => {
  it("an answer that found nothing lists no sources; every source listed is quoted in the answer", async () => {
    const x = await withDocs();
    // The database's word search matches "dates" to this "Date:" line; the built-in AI's own word matching
    // doesn't, so it quotes nothing from it (and must then not list it as a source).
    await upload(x.owner, x.matter.id, "calendar.txt", "Date: 2026-04-02 meeting with Human Resources about scheduling.");
    await process();
    const id = await db.withFirm(x.paraCtx, (s) => createConversation(s, x.matter.id, { title: "Dates", category: "timeline" }));
    await db.withFirm(x.paraCtx, (s) => askInConversation(s, id, "What are the key dates in this matter, and what happened on each?"));
    await db.withFirm(x.paraCtx, (s) => askInConversation(s, id, "When was she terminated?"));
    const [none, some] = (await db.withFirm(x.paraCtx, (s) => getConversation(s, id))).answers;
    expect(none!.answer).toMatch(/didn't find/);
    expect(none!.citations).toEqual([]);
    expect(some!.citations.length).toBeGreaterThan(0);
    for (const c of some!.citations) expect(some!.answer).toContain(`[${c.n}]`);
  });
});

describe("Prompt Library", () => {
  it("offers built-in, firm and personal prompts; only administrators manage firm prompts; personal ones stay personal", async () => {
    const x = await withDocs();
    const builtIn = (await db.withFirm(x.paraCtx, (s) => listPrompts(s))).filter((p) => p.scope === "huis");
    expect(builtIn.length).toBeGreaterThan(5);
    expect(await db.withFirm(x.paraCtx, (s) => getPrompt(s, "huis:key-dates"))).toMatchObject({ title: "Key dates", category: "timeline", canEdit: false });

    const mine = await db.withFirm(x.paraCtx, (s) => createPrompt(s, { scope: "personal", title: "My check", body: "What did HR know?", category: "strategy" }));
    await expect(db.withFirm(x.paraCtx, (s) => createPrompt(s, { scope: "firm", title: "x", body: "y", category: "trial" }))).rejects.toThrow(/permission/i);
    const firm = await db.withFirm(x.adminCtx, (s) => createPrompt(s, { scope: "firm", title: "Firm FMLA check", body: "Was notice given?", category: "research" }));
    // Directly in the database, too.
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query(
      "INSERT INTO huis.ai_prompts (firm_id, scope, created_by, title, body, category) VALUES ($1, 'firm', $2, 'x', 'y', 'trial')", [x.firmId, x.para.id]))).rejects.toThrow();
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query(
      "INSERT INTO huis.ai_prompts (firm_id, scope, owner_id, created_by, title, body, category) VALUES ($1, 'personal', $2, $3, 'x', 'y', 'trial')",
      [x.firmId, x.ownerUserId, x.para.id]))).rejects.toThrow();

    const ownerSees = await db.withFirm(x.owner, (s) => listPrompts(s));
    expect(ownerSees.some((p) => p.id === firm && p.canEdit)).toBe(true);
    expect(ownerSees.some((p) => p.id === mine)).toBe(false);
    expect(await db.withFirm(x.owner, (s) => getPrompt(s, mine))).toBeNull();
    const paraSees = await db.withFirm(x.paraCtx, (s) => listPrompts(s));
    expect(paraSees.find((p) => p.id === firm)).toMatchObject({ scope: "firm", canEdit: false });
    await expect(db.withFirm(x.paraCtx, (s) => updatePrompt(s, firm, { title: "Hijacked", body: "z", category: "trial" }))).rejects.toThrow(/not found/i);
    expect((await db.withFirm(x.paraCtx, (s) => s.client.query("UPDATE huis.ai_prompts SET title = 'x' WHERE id = $1", [firm]))).rowCount).toBe(0);
    await expect(db.withFirm(x.owner, (s) => deletePrompt(s, mine))).rejects.toThrow(/not found/i);
    await db.withFirm(x.paraCtx, (s) => updatePrompt(s, mine, { title: "My check", body: "What did HR know, and when?", category: "strategy" }));
    await db.withFirm(x.adminCtx, (s) => deletePrompt(s, firm));
    await expect(db.withFirm(x.paraCtx, (s) => updatePrompt(s, "huis:key-dates", { title: "x", body: "y", category: "trial" }))).rejects.toThrow(/not found/i);
    await expect(db.withFirm(x.portalCtx, (s) => listPrompts(s))).rejects.toThrow(/permission/i);
    expect((await db.withFirm(x.portalCtx, (s) => s.client.query("SELECT 1 FROM huis.ai_prompts"))).rowCount).toBe(0);
    const audit = await t.admin.query("SELECT metadata::text AS m FROM huis.audit_events WHERE firm_id = $1 AND action LIKE 'ai.prompt_%'", [x.firmId]);
    expect(audit.rows.length).toBe(4);
    expect(audit.rows.every((r) => !/HR|FMLA|notice|check/i.test(r.m))).toBe(true);
  });
});
