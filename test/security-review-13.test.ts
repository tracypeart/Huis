/**
 * Independent security review 13 — Phase 6 part 1 (AI Workspace and Prompt Library).
 * Made-up data only. "F#" tests demonstrate confirmed problems (they fail on the
 * reviewed code and pass once fixed); "blocked:" tests record attacks that held.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrainWorker } from "../src/brain/worker";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { createClient } from "../src/services/clients";
import {
  askInConversation, createConversation, createPrompt, getConversation, getPrompt, listConversations, updateConversation,
} from "../src/services/workspace";
import { assembleOriginal, getUploadSession, markChunkReceived, newEvidenceId, recordEvidence, startUpload, storeChunk } from "../src/services/evidence";
import { addMatterMember, createMatter, removeMatterMember } from "../src/services/matters";
import { disableUser, inviteUser } from "../src/services/users";
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
  vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-sr13-vault-"));
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

const LETTER = `Termination letter.

Dear Ms. Smith, your employment with Acme Corporation is terminated effective April 18, 2026.
This decision follows your request for FMLA leave on April 2, 2026 for surgery.`;

async function setup() {
  const f = await newFirm(db);
  const x = await db.withFirm(f.owner, async (s) => {
    const client = await createClient(s, { kind: "person", displayName: "Pat Smith", email: "pat.smith@example.com" });
    const para = await inviteUser(s, { email: `p@${f.slug}.example`, fullName: "Pat Para", role: "paralegal", locationId: f.locationId });
    const atty = await inviteUser(s, { email: `a@${f.slug}.example`, fullName: "Avery Attorney", role: "attorney", locationId: f.locationId });
    const admin = await inviteUser(s, { email: `ad@${f.slug}.example`, fullName: "Ada Admin", role: "firm_admin", locationId: f.locationId });
    const matter = await createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
    const other = await createMatter(s, { title: "Jones v. Beta", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
    const walled = await createMatter(s, { title: "Walled", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT", restricted: true });
    return { para, atty, admin, matter, other, walled };
  });
  const ctx = (id: string): RequestContext => ({ firmId: f.firmId, userId: id });
  return { ...f, ...x, paraCtx: ctx(x.para.id), attyCtx: ctx(x.atty.id), adminCtx: ctx(x.admin.id) };
}

describe("security review 13 — confirmed findings", () => {
  it("F1: someone walled out of a Matter can still destroy the team's shared conversation there (unconditional DELETE skips the visibility rule)", async () => {
    const x = await setup();
    // Para and the attorney both work the walled Matter.
    await db.withFirm(x.owner, async (s) => {
      await addMatterMember(s, { matterId: x.walled.id, userId: x.para.id, access: "edit" });
      await addMatterMember(s, { matterId: x.walled.id, userId: x.atty.id, access: "edit" });
    });
    await upload(x.owner, x.walled.id, "termination.txt", LETTER);
    await process();
    const conv = await db.withFirm(x.paraCtx, (s) => createConversation(s, x.walled.id, { title: "Team strategy", category: "strategy" }));
    await db.withFirm(x.paraCtx, (s) => askInConversation(s, conv, "When was she terminated?"));
    await db.withFirm(x.paraCtx, (s) => updateConversation(s, conv, { title: "Team strategy", category: "strategy", shared: true }));
    expect((await db.withFirm(x.attyCtx, (s) => getConversation(s, conv))).answers.length).toBe(1);

    // The paralegal is walled out (e.g. a conflict is discovered).
    await db.withFirm(x.owner, (s) => removeMatterMember(s, x.walled.id, x.para.id));
    // They can no longer see it (so a targeted delete does nothing)...
    expect((await db.withFirm(x.paraCtx, (s) => s.client.query("DELETE FROM huis.ai_conversations WHERE id = $1", [conv]))).rowCount).toBe(0);
    // ...but a DELETE with no conditions is checked only against "is the owner", not "can see the Matter".
    const wiped = await db.withFirm(x.paraCtx, (s) => s.client.query("DELETE FROM huis.ai_conversations"));
    expect(wiped.rowCount).toBe(0);
    // The team on the walled Matter must still have its shared work product.
    expect((await db.withFirm(x.attyCtx, (s) => getConversation(s, conv))).answers.length).toBe(1);
  });

  it("F1b: same for the answers themselves: a walled-out asker can wipe answers in the team's shared conversation", async () => {
    const x = await setup();
    await db.withFirm(x.owner, async (s) => {
      await addMatterMember(s, { matterId: x.walled.id, userId: x.para.id, access: "edit" });
      await addMatterMember(s, { matterId: x.walled.id, userId: x.atty.id, access: "edit" });
    });
    await upload(x.owner, x.walled.id, "termination.txt", LETTER);
    await process();
    const conv = await db.withFirm(x.paraCtx, (s) => createConversation(s, x.walled.id, { title: "Team strategy", category: "strategy" }));
    await db.withFirm(x.paraCtx, (s) => askInConversation(s, conv, "When was she terminated?"));
    await db.withFirm(x.paraCtx, (s) => updateConversation(s, conv, { title: "Team strategy", category: "strategy", shared: true }));
    await db.withFirm(x.owner, (s) => removeMatterMember(s, x.walled.id, x.para.id));
    const wiped = await db.withFirm(x.paraCtx, (s) => s.client.query("DELETE FROM huis.brain_answers"));
    expect(wiped.rowCount).toBe(0);
    expect((await db.withFirm(x.attyCtx, (s) => getConversation(s, conv))).answers.length).toBe(1);
  });

  it("F2: a conversation owner can plant a made-up 'Matter Brain' answer, quoting words the cited document never says, and colleagues read it as Huis's", async () => {
    const x = await setup();
    const letter = await upload(x.owner, x.matter.id, "termination.txt", LETTER);
    await process();
    const conv = await db.withFirm(x.paraCtx, (s) => createConversation(s, x.matter.id, { title: "Strategy", category: "strategy" }));
    await db.withFirm(x.paraCtx, (s) => updateConversation(s, conv, { title: "Strategy", category: "strategy", shared: true }));
    const chunk = (await db.withFirm(x.paraCtx, (s) => s.client.query<{ id: string }>(
      "SELECT id::text FROM huis.brain_chunks WHERE evidence_id = $1 ORDER BY chunk_no LIMIT 1", [letter.id]))).rows[0]!.id;
    const fake = "The most relevant passages in this Matter:\n\n• “Ms. Smith admitted she never needed surgery.” [1]";
    let planted = true;
    try {
      await db.withFirm(x.paraCtx, (s) => s.client.query(
        `INSERT INTO huis.brain_answers (firm_id, matter_id, asked_by, question, answer, citations, source_evidence, provider, model, conversation_id, created_at)
         VALUES ($1, $2, $3, 'Did she need surgery?', $4, $5, ARRAY[$6]::uuid[], 'local', 'huis-local-1', $7, now() - interval '30 days')`,
        [x.firmId, x.matter.id, x.para.id, fake,
          JSON.stringify([{ n: 1, chunkId: chunk, evidenceId: letter.id, noteId: null, start: 0, end: 20 }]), letter.id, conv]));
    } catch { planted = false; }
    const seen = await db.withFirm(x.attyCtx, (s) => getConversation(s, conv));
    const forged = seen.answers.find((a) => a.answer.includes("never needed surgery"));
    // What the colleague sees: a Huis-looking answer citing termination.txt for a quote that isn't in it.
    if (forged) expect(forged.citations[0]).toMatchObject({ sourceTitle: "termination.txt" });
    expect(LETTER).not.toContain("never needed surgery");
    expect({ planted, shownToColleague: !!forged }).toEqual({ planted: false, shownToColleague: false });
  });
});

describe("security review 13 — fixes beyond the findings", () => {
  it("genuine answers still save (including quotes with curly quotation marks); forged quotes, other Matters' passages, backdating and unknown providers don't", async () => {
    const x = await setup();
    await upload(x.owner, x.matter.id, "memo.txt", "HR memo. Cindy wrote “we can’t afford anyone out” about the surgery leave on April 2, 2026.");
    await upload(x.owner, x.other.id, "other.txt", "Jones memo. A different matter entirely about surgery.");
    await process();
    const conv = await db.withFirm(x.paraCtx, (s) => createConversation(s, x.matter.id, { title: "Leave", category: "strategy" }));
    const real = await db.withFirm(x.paraCtx, (s) => askInConversation(s, conv, "What did Cindy write about the surgery leave?"));
    const saved = (await t.admin.query("SELECT answer, citations, created_at FROM huis.brain_answers WHERE id = $1", [real])).rows[0];
    expect(saved.answer).toMatch(/^The most relevant passages in this Matter:/);
    expect(saved.citations.length).toBeGreaterThan(0);

    const mine = (await t.admin.query("SELECT id FROM huis.brain_chunks WHERE matter_id = $1 LIMIT 1", [x.matter.id])).rows[0].id;
    const theirs = (await t.admin.query("SELECT id FROM huis.brain_chunks WHERE matter_id = $1 LIMIT 1", [x.other.id])).rows[0].id;
    const insert = (answer: string, chunk: string, provider = "local", createdAt: string | null = null) => db.withFirm(x.paraCtx, (s) => s.client.query(
      `INSERT INTO huis.brain_answers (firm_id, matter_id, asked_by, question, answer, citations, provider, model, conversation_id, created_at)
       VALUES ($1, $2, $3, 'q', $4, $5, $6, 'huis-local-1', $7, coalesce($8::timestamptz, now())) RETURNING created_at`,
      [x.firmId, x.matter.id, x.para.id, answer, JSON.stringify([{ n: 1, chunkId: String(chunk) }]), provider, conv, createdAt]));
    const quote = (q: string) => `The most relevant passages in this Matter:\n\n• “${q}” [1]`;
    // A quote the passage doesn't contain.
    await expect(insert(quote("Pat admitted she never needed surgery."), mine)).rejects.toThrow(/words from the passage/);
    // A passage from another Matter.
    await expect(insert(quote("A different matter entirely about surgery."), theirs)).rejects.toThrow(/own Matter/);
    // An unknown provider.
    await expect(insert(quote("HR memo."), mine, "openai")).rejects.toThrow(/unknown AI provider/);
    // A real quote, but backdated: saved, with the database's own time.
    const r = await insert(quote("HR memo."), mine, "local", "2020-01-01T00:00:00Z");
    expect(new Date(r.rows[0].created_at).getUTCFullYear()).toBeGreaterThan(2025);
  });
});

describe("security review 13 — attacks that were blocked", () => {
  it("blocked: an answer can't be moved into (or planted in) a shared conversation, in another Matter or by someone else", async () => {
    const x = await setup();
    await upload(x.owner, x.matter.id, "termination.txt", LETTER);
    await process();
    const conv = await db.withFirm(x.paraCtx, (s) => createConversation(s, x.matter.id, { title: "S", category: "strategy" }));
    const a = await db.withFirm(x.paraCtx, (s) => askInConversation(s, conv, "When was she terminated?"));
    await db.withFirm(x.paraCtx, (s) => updateConversation(s, conv, { title: "S", category: "strategy", shared: true }));
    // No UPDATE on brain_answers at all (conversation_id can't be re-pointed).
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query("UPDATE huis.brain_answers SET conversation_id = NULL WHERE id = $1", [a])))
      .rejects.toThrow(/permission/i);
    // An answer in another Matter pointing at the shared conversation is refused (even by its owner).
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query(
      `INSERT INTO huis.brain_answers (firm_id, matter_id, asked_by, question, answer, provider, model, conversation_id)
       VALUES ($1, $2, $3, 'q', $5, 'local', 'x', $4)`, [x.firmId, x.other.id, x.para.id, conv,
        "Huis didn't find passages in this Matter that match the question. Try other words, or check that the documents have finished being read."]))).rejects.toThrow(/own conversation/);
    // The conversation can't be moved to another Matter or owner.
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query("UPDATE huis.ai_conversations SET matter_id = $2 WHERE id = $1", [conv, x.other.id])))
      .rejects.toThrow(/stays with its owner/);
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query("UPDATE huis.ai_conversations SET owner_id = $2 WHERE id = $1", [conv, x.atty.id])))
      .rejects.toThrow(/stays with its owner/);
    // A colleague can't unshare / rename / delete it with unconditional statements either.
    expect((await db.withFirm(x.attyCtx, (s) => s.client.query("UPDATE huis.ai_conversations SET shared = false"))).rowCount).toBe(0);
    expect((await db.withFirm(x.attyCtx, (s) => s.client.query("DELETE FROM huis.ai_conversations"))).rowCount).toBe(0);
    expect((await db.withFirm(x.attyCtx, (s) => s.client.query("DELETE FROM huis.brain_answers"))).rowCount).toBe(0);
    expect((await db.withFirm(x.attyCtx, (s) => getConversation(s, conv))).answers.length).toBe(1);
  });

  it("blocked: walls added after sharing, disabled readers, other firms and the count function", async () => {
    const x = await setup();
    await upload(x.owner, x.matter.id, "termination.txt", LETTER);
    await process();
    const conv = await db.withFirm(x.paraCtx, (s) => createConversation(s, x.matter.id, { title: "S", category: "strategy" }));
    const a = await db.withFirm(x.paraCtx, (s) => askInConversation(s, conv, "When was she terminated?"));
    const priv = await db.withFirm(x.paraCtx, (s) => createConversation(s, x.matter.id, { title: "Private", category: "trial" }));
    await db.withFirm(x.paraCtx, (s) => askInConversation(s, priv, "Why did she request leave?"));
    await db.withFirm(x.paraCtx, (s) => updateConversation(s, conv, { title: "S", category: "strategy", shared: true }));
    // Count function: colleague's private conversation and another firm's say 0, same as a made-up id.
    const count = (ctx: RequestContext, id: string) => db.withFirm(ctx, async (s) =>
      (await s.client.query("SELECT huis.ai_conversation_answer_count($1) AS n", [id])).rows[0].n);
    expect(await count(x.attyCtx, priv)).toBe(0);
    expect(await count(x.attyCtx, conv)).toBe(1);
    const other = await newFirm(db, "Other Owner");
    expect(await count(other.owner, conv)).toBe(0);
    expect((await db.withFirm(other.owner, (s) => s.client.query("SELECT 1 FROM huis.brain_answers WHERE id = $1", [a]))).rowCount).toBe(0);
    // A wall put up after sharing hides it from non-members at once (directly in the database too).
    await db.withFirm(x.owner, (s) => s.client.query("UPDATE huis.matters SET restricted = true WHERE id = $1", [x.matter.id]));
    await expect(db.withFirm(x.attyCtx, (s) => getConversation(s, conv))).rejects.toThrow(/not found/i);
    expect((await db.withFirm(x.attyCtx, (s) => s.client.query("SELECT 1 FROM huis.brain_answers WHERE id = $1", [a]))).rowCount).toBe(0);
    expect(await count(x.attyCtx, conv)).toBe(0);
    await db.withFirm(x.owner, (s) => s.client.query("UPDATE huis.matters SET restricted = false WHERE id = $1", [x.matter.id]));
    // A disabled reader sees nothing.
    expect((await db.withFirm(x.attyCtx, (s) => listConversations(s, x.matter.id))).length).toBe(1);
    await db.withFirm(x.owner, (s) => disableUser(s, x.atty.id));
    // The app refuses the session outright...
    await expect(db.withFirm(x.attyCtx, (s) => getConversation(s, conv))).rejects.toThrow(/session is not valid/i);
    // ...and the database itself gives a disabled user's context nothing (role lookup requires an active user).
    const c = await t.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.firm_id', $1, true), set_config('app.user_id', $2, true)", [x.firmId, x.atty.id]);
      await c.query("SET LOCAL ROLE huis_app");
      expect((await c.query("SELECT 1 FROM huis.ai_conversations")).rowCount).toBe(0);
      expect((await c.query("SELECT 1 FROM huis.brain_answers")).rowCount).toBe(0);
    } finally { await c.query("ROLLBACK"); c.release(); }
  });

  it("blocked: prompts keep their scope and owner; other people's personal prompts can't be prefilled", async () => {
    const x = await setup();
    const mine = await db.withFirm(x.paraCtx, (s) => createPrompt(s, { scope: "personal", title: "Mine", body: "Private idea about Pat Smith", category: "strategy" }));
    const firm = await db.withFirm(x.adminCtx, (s) => createPrompt(s, { scope: "firm", title: "Firm", body: "Approved", category: "strategy" }));
    // Promote a personal prompt to firm-wide / take it over: refused.
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query("UPDATE huis.ai_prompts SET scope = 'firm', owner_id = NULL WHERE id = $1", [mine])))
      .rejects.toThrow(/keeps its owner/);
    await expect(db.withFirm(x.adminCtx, (s) => s.client.query("UPDATE huis.ai_prompts SET scope = 'personal', owner_id = $2 WHERE id = $1", [firm, x.admin.id])))
      .rejects.toThrow(/keeps its owner/);
    // Unconditional writes by a non-admin reach only their own personal prompts.
    expect((await db.withFirm(x.attyCtx, (s) => s.client.query("UPDATE huis.ai_prompts SET body = 'hijacked'"))).rowCount).toBe(0);
    expect((await db.withFirm(x.attyCtx, (s) => s.client.query("DELETE FROM huis.ai_prompts"))).rowCount).toBe(0);
    // An admin can't read (prefill) someone's personal prompt, nor another firm the firm prompt.
    expect(await db.withFirm(x.adminCtx, (s) => getPrompt(s, mine))).toBeNull();
    const other = await newFirm(db, "Other Owner");
    expect(await db.withFirm(other.owner, (s) => getPrompt(s, firm))).toBeNull();
  });
});
