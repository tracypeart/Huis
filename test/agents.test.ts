import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrainWorker } from "../src/brain/worker";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { createClient } from "../src/services/clients";
import { createConversation, getConversation, listConversations, updateConversation } from "../src/services/workspace";
import { agentTurns, askAgent } from "../src/services/agents";
import { route } from "../src/ai/router";
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
  vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-agents-vault-"));
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
const EMAIL = [
  "From: Cindy Manager <cindy@acme.example>", "To: Pat Smith <pat.smith@example.com>",
  "Subject: Your leave request", "Date: Fri, 03 Apr 2026 09:00:00 -0600", "MIME-Version: 1.0", "Content-Type: text/plain", "",
  "Pat, I received your FMLA request for the surgery. The team can't afford anyone out for weeks.", "",
].join("\r\n");
const OTHER_EMAIL = [
  "From: Jordan Lee <jordan@acme.example>", "To: Pat Smith <pat.smith@example.com>",
  "Subject: Parking", "Date: Mon, 06 Apr 2026 09:00:00 -0600", "MIME-Version: 1.0", "Content-Type: text/plain", "",
  "Your parking pass is ready.", "",
].join("\r\n");
const DEPOSITION = "Deposition of Cindy Manager, taken June 3, 2026.\n\nA. I didn't know about her surgery until May.";

async function withMatter() {
  const x = await setup();
  const red = (await db.withFirm(x.owner, (s) => s.client.query("SELECT id FROM huis.matter_folders WHERE matter_id = $1 AND is_privileged_area", [x.matter.id]))).rows[0].id;
  const letter = await upload(x.owner, x.matter.id, "termination.txt", LETTER);
  const email = await upload(x.owner, x.matter.id, "leave.eml", EMAIL);
  await upload(x.owner, x.matter.id, "parking.eml", OTHER_EMAIL);
  await upload(x.owner, x.matter.id, "deposition-cindy.txt", DEPOSITION);
  const memo = await upload(x.owner, x.matter.id, "strategy memo.txt", "Our strategy for the FMLA retaliation claim.", red);
  await process();
  const { cindy, claim } = await db.withFirm(x.owner, async (s) => ({
    cindy: await addNode(s, x.matter.id, { kind: "person", label: "Cindy Manager", email: "cindy@acme.example", role: "HR manager" }),
    claim: await addClaimFromTemplate(s, x.matter.id, "fmla_retaliation"),
  }));
  const conv = await db.withFirm(x.paraCtx, (s) => createConversation(s, x.matter.id, { title: "Agents", category: "strategy" }));
  return { ...x, letter, email, memo, cindy, claim, conv };
}

describe("the router (fixed rules)", () => {
  const ctx = {
    people: [{ id: "p1", label: "Cindy Manager", email: "cindy@acme.example" }, { id: "p2", label: "Pat Smith", email: null }],
    elements: [{ id: "e1", label: "The employer knew of the protected activity", claim: "FMLA retaliation" }],
  };
  it("sends each question to the agent that fits, with its dates, person and subject, and says why", () => {
    expect(route("Build a timeline of events between April 1, 2026 and May 10, 2026.", ctx)).toMatchObject({ agent: "timeline", params: { from: "2026-04-01", to: "2026-05-10" } });
    expect(route("Find every email from Cindy discussing the medical leave.", ctx)).toMatchObject({ agent: "email", params: { personId: "p1", topics: ["medical", "leave"] } });
    expect(route("Find contradictions between Cindy's deposition and the emails.", ctx).agent).toBe("contradictions");
    expect(route("Show evidence that the employer knew of the protected activity.", ctx)).toMatchObject({ agent: "evidence", params: { elementId: "e1" } });
    expect(route("Which documents are privileged?", ctx).agent).toBe("privilege");
    expect(route("Why was she terminated?", ctx).agent).toBe("matter");
    expect(route("What happened after April 18, 2026?", ctx).params).toMatchObject({ from: "2026-04-18" });
    // The attorney's own choice wins, and the reason says so.
    const chosen = route("Why was she terminated?", ctx, "timeline");
    expect(chosen.agent).toBe("timeline");
    expect(chosen.why).toMatch(/you chose this agent/);
    // A name shared by two people picks no one (rather than guessing).
    expect(route("What did Pat say?", { ...ctx, people: [...ctx.people, { id: "p3", label: "Pat Jones", email: null }] }, "email").params.personId).toBeUndefined();
  });
});

describe("specialized agents", () => {
  it("each agent answers from the Matter, with sources, and the Matter Brain still answers everything else", async () => {
    const x = await withMatter();
    const ask = (q: string, choice = "auto") => db.withFirm(x.paraCtx, (s) => askAgent(s, x.conv, q, choice));
    expect((await ask("Build a timeline between April 1, 2026 and April 30, 2026.")).agent).toBe("timeline");
    expect((await ask("Find every email from Cindy about the surgery.")).agent).toBe("email");
    expect((await ask("Are there contradictions?")).agent).toBe("contradictions");
    expect((await ask("Which documents are privileged?")).agent).toBe("privilege");
    expect((await ask("Show evidence that the employer took an adverse action against the employee.")).agent).toBe("evidence");
    expect((await ask("Why was she terminated?")).agent).toBe("matter");

    const turns = await db.withFirm(x.paraCtx, (s) => agentTurns(s, x.conv));
    const [timeline, email, contra, priv, evidence] = [0, 1, 2, 3, 4].map((i) => turns[i]!.result);
    if (!timeline || !email || !contra || !priv || !evidence) throw new Error("turns");
    if (timeline.kind !== "timeline" || email!.kind !== "email" || contra!.kind !== "contradictions" || priv!.kind !== "privilege" || evidence!.kind !== "evidence") throw new Error("kinds");
    expect(timeline.entries.length).toBeGreaterThan(0);
    expect(timeline.entries.every((e) => e.date >= "2026-04-01" && e.date <= "2026-04-30")).toBe(true);
    // Email from Cindy about the surgery: the leave email, not the parking one.
    expect(email.entries.map((e) => e.evidenceId)).toEqual([x.email.id]);
    expect(contra.potentialCount).toBeGreaterThan(0);
    expect(contra.potential[0]!.quote).toMatch(/didn't know about her surgery/);
    expect(priv.items.map((i) => i.id)).toEqual([x.memo.id]);
    expect(evidence.element?.label).toMatch(/adverse/i);
    expect(evidence.passages.length).toBeGreaterThan(0);
    expect(turns[0]!.why).toMatch(/^Timeline agent: .*dates 2026-04-01 to 2026-04-30/);
    // The Matter Brain answer is a normal saved answer in the conversation.
    expect((await db.withFirm(x.paraCtx, (s) => getConversation(s, x.conv))).answers.map((a) => a.question)).toEqual(["Why was she terminated?"]);
    expect((await db.withFirm(x.paraCtx, (s) => listConversations(s, x.matter.id)))[0]!.answers).toBe(6);
    // The audit log records which agent, never the question.
    const audit = await t.admin.query("SELECT metadata::text AS m FROM huis.audit_events WHERE firm_id = $1 AND action = 'ai.agent_asked'", [x.firmId]);
    expect(audit.rows.map((r) => JSON.parse(r.m).agent).sort()).toEqual(["contradictions", "email", "evidence", "privilege", "timeline"]);
    expect(audit.rows.every((r) => !/surgery|Cindy|privileged/i.test(r.m))).toBe(true);
  });

  it("stores only the question and settings: answers are worked out as the reader, so they stay current and can't be planted", async () => {
    const x = await withMatter();
    await db.withFirm(x.paraCtx, (s) => askAgent(s, x.conv, "Find every email from Cindy about the surgery."));
    const row = (await t.admin.query("SELECT * FROM huis.ai_agent_turns WHERE conversation_id = $1", [x.conv])).rows[0];
    expect(Object.keys(row).sort()).toEqual(["agent", "asked_by", "conversation_id", "created_at", "firm_id", "id", "matter_id", "params", "question", "why"]);
    // Evidence later found infected leaves the answer at once.
    await infect(x.email.id);
    const [turn] = await db.withFirm(x.paraCtx, (s) => agentTurns(s, x.conv));
    expect(turn!.result.kind === "email" && turn!.result.entries).toEqual([]);
    // Settings that point outside the Matter, or extra fields, change nothing: a walled element or another Matter's person isn't found.
    const walledEl = await db.withFirm(x.owner, async (s) => {
      const c = await addClaimFromTemplate(s, x.walled.id, "fmla_retaliation");
      return (await s.client.query("SELECT from_id FROM huis.dna_links WHERE to_id = $1 LIMIT 1", [c])).rows[0].from_id as string;
    });
    const mineConv = await db.withFirm(x.owner, (s) => createConversation(s, x.matter.id, { title: "Mine", category: "trial" }));
    await db.withFirm(x.owner, (s) => s.client.query(
      `INSERT INTO huis.ai_agent_turns (firm_id, matter_id, conversation_id, asked_by, question, agent, params, why)
       VALUES ($1, $2, $3, $4, 'q', 'evidence', $5, 'w')`, [x.firmId, x.matter.id, mineConv, x.ownerUserId,
        JSON.stringify({ elementId: walledEl, answer: "Pat admitted everything" })]));
    const own = await db.withFirm(x.owner, (s) => listConversations(s, x.matter.id));
    const planted = (await db.withFirm(x.owner, (s) => agentTurns(s, own.find((c) => c.title === "Mine")!.id)))[0]!;
    expect(planted.result).toMatchObject({ kind: "evidence", element: null, passages: [] });
    expect(JSON.stringify(planted)).not.toContain("Pat admitted everything");
    // No turn in someone else's conversation, no Matter Brain "agent" turn, no changing a turn.
    await expect(db.withFirm(x.owner, (s) => s.client.query(
      `INSERT INTO huis.ai_agent_turns (firm_id, matter_id, conversation_id, asked_by, question, agent, why) VALUES ($1, $2, $3, $4, 'q', 'timeline', 'w')`,
      [x.firmId, x.matter.id, x.conv, x.ownerUserId]))).rejects.toThrow(/own conversation/);
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query(
      `INSERT INTO huis.ai_agent_turns (firm_id, matter_id, conversation_id, asked_by, question, agent, why) VALUES ($1, $2, $3, $4, 'q', 'matter', 'w')`,
      [x.firmId, x.matter.id, x.conv, x.para.id]))).rejects.toThrow(/check/);
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query("UPDATE huis.ai_agent_turns SET question = 'x'"))).rejects.toThrow(/permission/);
    // Only the conversation's owner asks in it.
    await expect(db.withFirm(x.owner, (s) => askAgent(s, x.conv, "Which documents are privileged?"))).rejects.toThrow(/not found/i);
  });

  it("shared conversations are answered for each reader as that reader; clients, walls and other firms get nothing", async () => {
    const x = await withMatter();
    await db.withFirm(x.paraCtx, (s) => askAgent(s, x.conv, "Which documents are privileged?"));
    await expect(db.withFirm(x.owner, (s) => agentTurns(s, x.conv))).resolves.toEqual([]); // private: invisible
    await db.withFirm(x.paraCtx, (s) => updateConversation(s, x.conv, { title: "Agents", category: "strategy", shared: true }));
    const forReader = await db.withFirm(x.readerCtx, (s) => agentTurns(s, x.conv));
    expect(forReader[0]!.result.kind === "privilege" && forReader[0]!.result.items.length).toBe(1);
    await expect(db.withFirm(x.portalCtx, (s) => agentTurns(s, x.conv))).rejects.toThrow(/permission/i);
    expect((await db.withFirm(x.portalCtx, (s) => s.client.query("SELECT 1 FROM huis.ai_agent_turns"))).rowCount).toBe(0);
    const other = await newFirm(db, "Other Owner");
    expect((await db.withFirm(other.owner, (s) => s.client.query("SELECT 1 FROM huis.ai_agent_turns"))).rowCount).toBe(0);
    // A colleague's unconditional DELETE reaches nothing; the asker can't delete once walled out.
    expect((await db.withFirm(x.owner, (s) => s.client.query("DELETE FROM huis.ai_agent_turns"))).rowCount).toBe(0);
  });
});
