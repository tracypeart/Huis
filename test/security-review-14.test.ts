/**
 * Independent security review 14 — Phase 6 part 2 (specialized agents behind one interface).
 * Made-up data only. "F#" tests demonstrate confirmed problems (they fail on the
 * reviewed code and pass once fixed); "blocked:" tests record attacks that held.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrainWorker } from "../src/brain/worker";
import type { FirmSession, HuisDb, RequestContext } from "../src/db/tenant";
import { createClient } from "../src/services/clients";
import { createConversation, updateConversation } from "../src/services/workspace";
import { agentTurns, askAgent, previewRoute, runAgent } from "../src/services/agents";
import { setAiProviderSetting } from "../src/services/brain";
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
  vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-sr14-vault-"));
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
  const conv = await db.withFirm(ctx(x.para.id), (s) => createConversation(s, x.matter.id, { title: "Agents", category: "strategy" }));
  return { ...f, ...x, conv, paraCtx: ctx(x.para.id), readerCtx: ctx(x.reader.id), portalCtx: ctx(x.portal.id) };
}

const LETTER = `Termination letter.

Dear Ms. Smith, your employment with Acme Corporation is terminated effective April 18, 2026.
This decision follows your request for FMLA leave on April 2, 2026 for surgery.`;
const EMAIL = [
  "From: Cindy Manager <cindy@acme.example>", "To: Pat Smith <pat.smith@example.com>",
  "Subject: Your leave request", "Date: Fri, 03 Apr 2026 09:00:00 -0600", "MIME-Version: 1.0", "Content-Type: text/plain", "",
  "Pat, I received your FMLA request for the surgery. The team can't afford anyone out for weeks.", "",
].join("\r\n");

async function withMatter() {
  const x = await setup();
  const red = (await db.withFirm(x.owner, (s) => s.client.query("SELECT id FROM huis.matter_folders WHERE matter_id = $1 AND is_privileged_area", [x.matter.id]))).rows[0].id;
  const letter = await upload(x.owner, x.matter.id, "termination.txt", LETTER);
  const email = await upload(x.owner, x.matter.id, "leave.eml", EMAIL);
  const memo = await upload(x.owner, x.matter.id, "strategy memo.txt", "Our strategy for the FMLA retaliation claim.", red);
  await process();
  const cindy = await db.withFirm(x.owner, (s) => addNode(s, x.matter.id, { kind: "person", label: "Cindy Manager", email: "cindy@acme.example", role: "HR manager" }));
  return { ...x, letter, email, memo, cindy };
}

/** Plants a turn directly in the database as the conversation's owner (what askAgent itself writes). */
const plantTurn = (s: FirmSession, firmId: string, matterId: string, conv: string, userId: string, question: string, agent: string, params: object = {}) =>
  s.client.query(
    `INSERT INTO huis.ai_agent_turns (firm_id, matter_id, conversation_id, asked_by, question, agent, params, why)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'w')`, [firmId, matterId, conv, userId, question, agent, JSON.stringify(params)]);

/** Counts the database queries a piece of work makes. */
async function queriesFor(s: FirmSession, fn: () => Promise<unknown>): Promise<number> {
  const client = s.client as unknown as { query: (...a: unknown[]) => unknown };
  const orig = client.query.bind(client);
  let n = 0;
  client.query = (...a: unknown[]) => { n++; return orig(...a); };
  try { await fn(); return n; } finally { client.query = orig; }
}

// ---------------------------------------------------------------------------
// Confirmed findings
// ---------------------------------------------------------------------------
describe("review 14: confirmed findings", () => {
  it("F1: a question naming one person's email address is routed to a different person whose address is a substring of it", async () => {
    const x = await setup();
    const { al, sal } = await db.withFirm(x.owner, async (s) => ({
      al: await addNode(s, x.matter.id, { kind: "person", label: "Al Smith", email: "al@acme.example" }),
      sal: await addNode(s, x.matter.id, { kind: "person", label: "Sal Jones", email: "sal@acme.example" }),
    }));
    const r = await db.withFirm(x.paraCtx, (s) => previewRoute(s, x.matter.id, "Find every email from sal@acme.example."));
    // Today: "person Al Smith" — the attorney gets Al's email, labelled as the answer about Sal.
    expect(r.why).not.toMatch(/Al Smith/);
    expect(r.params.personId).toBe(sal);
    expect(r.params.personId).not.toBe(al);
  });

  it("F2: an ordinary word in an organization's name (\"the\") routes every question containing it to that organization", async () => {
    const x = await setup();
    await db.withFirm(x.owner, (s) => addNode(s, x.matter.id, { kind: "organization", label: "The Widget Company" }));
    const r = await db.withFirm(x.paraCtx, (s) => previewRoute(s, x.matter.id, "When was the contract signed?"));
    // Today: personId = The Widget Company, so the timeline is silently narrowed to that organization's items.
    expect(r.params.personId).toBeUndefined();
  });

  it("F3: \"after the <date> hearing\" is read as that single day, not everything after it", async () => {
    const x = await setup();
    const r = await db.withFirm(x.paraCtx, (s) => previewRoute(s, x.matter.id, "What happened after the March 3, 2026 hearing?"));
    expect(r.agent).toBe("timeline");
    // Today: { from: 2026-03-03, to: 2026-03-03 } — only that day's items.
    expect(r.params.from).toBe("2026-03-03");
    expect(r.params.to).toBeUndefined();
  });

  it("F4: a month (\"in March 2026\") is ignored: the whole Matter's timeline is returned as the answer", async () => {
    const x = await setup();
    const r = await db.withFirm(x.paraCtx, (s) => previewRoute(s, x.matter.id, "What happened in March 2026?"));
    expect(r.agent).toBe("timeline");
    expect(r.params).toMatchObject({ from: "2026-03-01", to: "2026-03-31" });
  });

  it("F5: a non-subject word in the question (\"please\") empties the timeline, shown as \"Nothing matches\" with no warning", async () => {
    const x = await withMatter();
    const asked = await db.withFirm(x.paraCtx, (s) => askAgent(s, x.conv, "Give me the timeline of the case please"));
    expect(asked.agent).toBe("timeline");
    const full = await db.withFirm(x.paraCtx, (s) => runAgent(s, x.matter.id, "timeline", {}));
    if (full.kind !== "timeline") throw new Error("kind");
    expect(full.entries.length).toBeGreaterThan(0); // the Matter has a timeline
    const [turn] = await db.withFirm(x.paraCtx, (s) => agentTurns(s, x.conv).then((r) => r.turns));
    const r = turn!.result!;
    if (r.kind !== "timeline") throw new Error("kind");
    // Today: entries = [], notes = [] → the page says "Nothing matches." for a Matter full of dated items.
    expect(r.entries.length > 0 || r.notes.some((n) => /mention|subject|word|narrow/i.test(n))).toBe(true);
  });

  it("F6: on a large Matter the timeline/email agents silently drop everything past the read limit (no truncation note)", async () => {
    const x = await setup();
    // 5,000 dated items in 2020 (made up), then the one that matters, in 2026.
    await t.admin.query(
      `INSERT INTO huis.dna_nodes (firm_id, matter_id, kind, label, event_date, status, origin, created_by)
       SELECT $1, $2, 'event', 'Routine shipment ' || g, DATE '2020-01-01' + (g % 300), 'confirmed', 'attorney', $3
         FROM generate_series(1, 5000) g`, [x.firmId, x.matter.id, x.ownerUserId]);
    await db.withFirm(x.owner, (s) => addNode(s, x.matter.id, { kind: "event", label: "Employee terminated", eventDate: "2026-04-18" }));
    const r = await db.withFirm(x.paraCtx, (s) => runAgent(s, x.matter.id, "timeline", { from: "2026-01-01" }));
    if (r.kind !== "timeline") throw new Error("kind");
    // Today: entries = [] and notes = [] — "Nothing matches." although the termination is in Case DNA.
    expect(r.entries.length > 0 || r.notes.some((n) => /large|part|limit|only/i.test(n))).toBe(true);
  }, 60_000);

  it("F7: after 200 turns, newer questions silently disappear from the conversation", async () => {
    const x = await setup();
    await db.withFirm(x.paraCtx, async (s) => {
      for (let i = 0; i < 200; i++) await plantTurn(s, x.firmId, x.matter.id, x.conv, x.para.id, `Old question ${i}`, "privilege");
    });
    await db.withFirm(x.paraCtx, (s) => askAgent(s, x.conv, "Which documents are privileged now?"));
    const turns = await db.withFirm(x.paraCtx, (s) => agentTurns(s, x.conv).then((r) => r.turns));
    // Today: the 200 oldest are shown; the newest question (just asked) is not there at all.
    expect(turns.map((tt) => tt.question)).toContain("Which documents are privileged now?");
  }, 60_000);

  it("F8: every view re-runs every turn's agent: a conversation of repeated turns costs N full timelines per page load", async () => {
    const x = await withMatter();
    const one = await db.withFirm(x.paraCtx, (s) => createConversation(s, x.matter.id, { title: "One", category: "timeline" }));
    const many = await db.withFirm(x.paraCtx, (s) => createConversation(s, x.matter.id, { title: "Many", category: "timeline" }));
    await db.withFirm(x.paraCtx, async (s) => {
      await plantTurn(s, x.firmId, x.matter.id, one, x.para.id, "Timeline about the surgery", "timeline", { topics: ["surgery"] });
      for (let i = 0; i < 40; i++) await plantTurn(s, x.firmId, x.matter.id, many, x.para.id, "Timeline about the surgery", "timeline", { topics: ["surgery"] });
    });
    await db.withFirm(x.paraCtx, (s) => updateConversation(s, many, { title: "Many", category: "timeline", shared: true }));
    const qOwn1 = await db.withFirm(x.paraCtx, (s) => queriesFor(s, () => agentTurns(s, one).then((r) => r.turns)));
    const qMany = await db.withFirm(x.readerCtx, (s) => queriesFor(s, () => agentTurns(s, many).then((r) => r.turns)));
    // Today: ~40× the work of one turn, for every colleague, on every page load (and up to 200 turns, each a
    // full timeline of up to 10,000 items with email bodies, or a full contradiction scan).
    expect(qMany).toBeLessThan(qOwn1 * 5);
  }, 60_000);

  it("F9: a turn's saved \"why\" keeps a Case DNA person's name after that person's only source is found infected", async () => {
    const x = await withMatter();
    // Cindy's Case DNA entry is drawn from the leave email (citing its From line).
    await t.admin.query(
      `SET session_replication_role = replica;
       INSERT INTO huis.dna_citations (firm_id, matter_id, node_id, evidence_id, char_start, char_end, quote)
       VALUES ('${x.firmId}', '${x.matter.id}', '${x.cindy}', '${x.email.id}', 0, 5, 'From:');
       SET session_replication_role = origin;`);
    await db.withFirm(x.paraCtx, (s) => askAgent(s, x.conv, "Find every email from Cindy Manager."));
    await db.withFirm(x.paraCtx, (s) => updateConversation(s, x.conv, { title: "Agents", category: "strategy", shared: true }));
    await infect(x.email.id);
    // The person is gone from Case DNA for every reader...
    expect((await db.withFirm(x.readerCtx, (s) => s.client.query("SELECT 1 FROM huis.dna_nodes WHERE id = $1", [x.cindy]))).rowCount).toBe(0);
    const [turn] = await db.withFirm(x.readerCtx, (s) => agentTurns(s, x.conv).then((r) => r.turns));
    expect(turn!.result!.notes.join(" ")).toMatch(/no longer in Case DNA/);
    // ...but today the stored reason still prints "person Cindy Manager" to the colleague.
    expect(turn!.why).not.toMatch(/Cindy Manager/);
  }, 60_000);

  it("F10: with AI turned off for the firm, the ask box is hidden but askAgent still answers through every agent but the evidence agent", async () => {
    const x = await withMatter();
    await db.withFirm(x.owner, (s) => setAiProviderSetting(s, "off"));
    await expect(db.withFirm(x.paraCtx, (s) => askAgent(s, x.conv, "Why was she terminated?"))).rejects.toThrow(/turned off/);
    // Today: resolves (a privilege-agent turn is saved and answered) although AI is off.
    await expect(db.withFirm(x.paraCtx, (s) => askAgent(s, x.conv, "Which documents are privileged?"))).rejects.toThrow(/turned off/);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Attacks that held
// ---------------------------------------------------------------------------
describe("review 14: blocked", () => {
  it("blocked: planting, moving, back-dating or changing turns directly in the database", async () => {
    const x = await withMatter();
    const ownerConv = await db.withFirm(x.owner, (s) => createConversation(s, x.matter.id, { title: "Owner's", category: "trial" }));
    // Into another Matter than the conversation's (even one the asker can see).
    await expect(db.withFirm(x.owner, (s) => plantTurn(s, x.firmId, x.walled.id, ownerConv, x.ownerUserId, "q", "privilege"))).rejects.toThrow(/own conversation/);
    // As someone else.
    await expect(db.withFirm(x.owner, (s) => plantTurn(s, x.firmId, x.matter.id, ownerConv, x.para.id, "q", "privilege"))).rejects.toThrow(/own conversation|row-level|policy/);
    // Back-dated: the database sets the time.
    await db.withFirm(x.owner, (s) => s.client.query(
      `INSERT INTO huis.ai_agent_turns (firm_id, matter_id, conversation_id, asked_by, question, agent, why, created_at)
       VALUES ($1, $2, $3, $4, 'q', 'privilege', 'w', '2001-01-01')`, [x.firmId, x.matter.id, ownerConv, x.ownerUserId]));
    const at = (await t.admin.query("SELECT created_at FROM huis.ai_agent_turns WHERE conversation_id = $1", [ownerConv])).rows[0].created_at as Date;
    expect(at.getUTCFullYear()).toBeGreaterThan(2001);
    // No change, no moving the conversation to another Matter.
    await expect(db.withFirm(x.owner, (s) => s.client.query("UPDATE huis.ai_agent_turns SET conversation_id = $1", [x.conv]))).rejects.toThrow(/permission/);
    await expect(db.withFirm(x.owner, (s) => s.client.query("UPDATE huis.ai_conversations SET matter_id = $1 WHERE id = $2", [x.walled.id, ownerConv]))).rejects.toThrow();
    // A paralegal's unconditional DELETE reaches only their own turns.
    expect((await db.withFirm(x.paraCtx, (s) => s.client.query("DELETE FROM huis.ai_agent_turns"))).rowCount).toBe(0);
  }, 60_000);

  it("blocked: stored settings pointing at a walled Matter's person, odd params, and huge/odd-unicode questions", async () => {
    const x = await withMatter();
    const secret = await db.withFirm(x.owner, (s) => addNode(s, x.walled.id, { kind: "person", label: "Secret Witness", email: "secret@walled.example" }));
    await db.withFirm(x.paraCtx, (s) => plantTurn(s, x.firmId, x.matter.id, x.conv, x.para.id, "q", "timeline",
      { personId: secret, from: "2026-13-45", topics: ["x".repeat(500)] }));
    const [planted] = await db.withFirm(x.paraCtx, (s) => agentTurns(s, x.conv).then((r) => r.turns));
    expect(JSON.stringify(planted)).not.toContain("Secret Witness");
    // A 2,000-character question of odd Unicode, long words and many dates is routed and saved quickly.
    const weird = ("ℌ𝔢𝔩𝔩𝔬 İstanbul ﬁle 1/1/2000 2000-01-01 " + "é".repeat(41) + " ‮​ ").repeat(40).slice(0, 2000);
    const started = Date.now();
    await db.withFirm(x.paraCtx, (s) => askAgent(s, x.conv, weird, "timeline"));
    expect(Date.now() - started).toBeLessThan(5000);
    const turns = await db.withFirm(x.paraCtx, (s) => agentTurns(s, x.conv).then((r) => r.turns));
    expect(turns.length).toBe(2);
  }, 60_000);

  it("blocked: the privilege agent lists only clean items of this Matter; clients, other firms and walled readers get nothing", async () => {
    const x = await withMatter();
    const redWalled = (await db.withFirm(x.owner, (s) => s.client.query("SELECT id FROM huis.matter_folders WHERE matter_id = $1 AND is_privileged_area", [x.walled.id]))).rows[0].id;
    const walledMemo = await upload(x.owner, x.walled.id, "walled memo.txt", "Walled privileged memo.", redWalled);
    await process();
    await db.withFirm(x.paraCtx, (s) => askAgent(s, x.conv, "Which documents are privileged?"));
    await db.withFirm(x.paraCtx, (s) => updateConversation(s, x.conv, { title: "Agents", category: "strategy", shared: true }));
    const [turn] = await db.withFirm(x.readerCtx, (s) => agentTurns(s, x.conv).then((r) => r.turns));
    const tr = turn!.result!;
    if (tr.kind !== "privilege") throw new Error("kind");
    expect(tr.items.map((i) => i.id)).toEqual([x.memo.id]);
    expect(JSON.stringify(turn)).not.toContain(walledMemo.id);
    await infect(x.memo.id);
    const [after] = await db.withFirm(x.readerCtx, (s) => agentTurns(s, x.conv).then((r) => r.turns));
    const ar = after!.result!;
    expect(ar.kind === "privilege" && ar.items).toEqual([]);
    // Running an agent directly against a walled Matter as a non-member.
    const walledRun = await db.withFirm(x.paraCtx, (s) => runAgent(s, x.walled.id, "privilege", {}));
    expect(walledRun.kind === "privilege" && walledRun.items).toEqual([]);
    await expect(db.withFirm(x.paraCtx, (s) => runAgent(s, x.walled.id, "timeline", {}))).rejects.toThrow(/not found/i);
    await expect(db.withFirm(x.portalCtx, (s) => runAgent(s, x.matter.id, "privilege", {}))).rejects.toThrow(/permission/i);
    const other = await newFirm(db, "Other Owner");
    expect((await db.withFirm(other.owner, (s) => s.client.query("SELECT 1 FROM huis.ai_agent_turns"))).rowCount).toBe(0);
    await expect(db.withFirm(other.owner, (s) => agentTurns(s, x.conv).then((r) => r.turns))).resolves.toEqual([]);
  }, 60_000);

  it("blocked: the audit log never gets the question, the person, the element or the subject words", async () => {
    const x = await withMatter();
    await db.withFirm(x.owner, (s) => addClaimFromTemplate(s, x.matter.id, "fmla_retaliation"));
    await db.withFirm(x.paraCtx, (s) => askAgent(s, x.conv, "Find every email from Cindy Manager about the zebracorn surgery."));
    await db.withFirm(x.paraCtx, (s) => askAgent(s, x.conv, "Show evidence that the employer took an adverse action against the employee."));
    const audit = await t.admin.query("SELECT metadata::text AS m FROM huis.audit_events WHERE firm_id = $1 AND action = 'ai.agent_asked'", [x.firmId]);
    expect(audit.rowCount).toBe(2);
    expect(audit.rows.every((r) => !/zebracorn|Cindy|adverse|surgery/i.test(r.m))).toBe(true);
  }, 60_000);
});
