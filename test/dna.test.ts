import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrainWorker } from "../src/brain/worker";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { findEvents } from "../src/dna/extract";
import { createClient } from "../src/services/clients";
import { createContact } from "../src/services/contacts";
import {
  addClaimFromTemplate, addElement, addFactFromPassage, addNode, claimView, decideNode, deleteNode, findEvidenceFor, getNode,
  importMatterPeople, linkNodes, listNodes, updateNode,
} from "../src/services/dna";
import { assembleOriginal, getUploadSession, markChunkReceived, newEvidenceId, recordEvidence, startUpload, storeChunk } from "../src/services/evidence";
import { addMatterMember, createMatter, linkContactToMatter } from "../src/services/matters";
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
  vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-dna-vault-"));
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

Dear Ms. Smith, your employment with Acme Corporation is terminated effective April 18, 2026. This decision follows your request for FMLA leave on April 2, 2026 for surgery.

Signed, Cindy Manager, Human Resources.`;
const EMAIL = [
  "From: Cindy Manager <cindy@acme.example>", "To: Pat Smith <pat.smith@example.com>, Jordan Lee <jordan@acme.example>",
  "Subject: Your leave request", "Date: Thu, 02 Apr 2026 09:00:00 -0600", "MIME-Version: 1.0", "Content-Type: text/plain", "",
  "Pat, I received your request for FMLA leave for your surgery. Honestly the team can't afford anyone out for weeks.", "",
].join("\r\n");

async function setup() {
  const f = await newFirm(db);
  const x = await db.withFirm(f.owner, async (s) => {
    const client = await createClient(s, { kind: "person", displayName: "Pat Smith", email: "pat.smith@example.com" });
    const para = await inviteUser(s, { email: `p@${f.slug}.example`, fullName: "Pat Para", role: "paralegal", locationId: f.locationId });
    const reader = await inviteUser(s, { email: `r@${f.slug}.example`, fullName: "Rae Reader", role: "read_only", locationId: f.locationId });
    const portal = await inviteUser(s, { email: `c@${f.slug}.example`, fullName: "Casey Client", role: "client", locationId: f.locationId });
    const matter = await createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
    const walled = await createMatter(s, { title: "Walled", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT", restricted: true });
    const opp = await createContact(s, { kind: "opposing_counsel", fullName: "Olivia Opposing", email: "olivia@biglaw.example" });
    await linkContactToMatter(s, matter.id, opp.id, "opposing counsel");
    return { para, reader, portal, matter, walled };
  });
  await db.withFirm(f.owner, (s) => addMatterMember(s, { matterId: x.matter.id, userId: x.portal.id, access: "view", acknowledgePrivilegeWaiverRisk: true }));
  const ctx = (id: string): RequestContext => ({ firmId: f.firmId, userId: id });
  return { ...f, ...x, paraCtx: ctx(x.para.id), readerCtx: ctx(x.reader.id), portalCtx: ctx(x.portal.id) };
}

describe("finding dated events", () => {
  it("finds dates in common formats, with the sentence around them, and skips impossible dates", () => {
    const ev = findEvents("Hired on 3/1/2019. Promoted Dec. 5, 2024. Fired April 18, 2026 after FMLA. Not a date: February 30, 2026 is wrong. Logged 2026-04-19 by HR.");
    expect(ev.map((e) => e.date)).toEqual(["2019-03-01", "2024-12-05", "2026-04-18", "2026-04-19"]);
    expect(ev[2]!.label).toBe("Fired April 18, 2026 after FMLA.");
    expect(findEvents("Dear Ms. Smith, you were terminated on April 18, 2026.")[0]!.label).toBe("Dear Ms. Smith, you were terminated on April 18, 2026.");
  });

  it("stays fast and bounded on hostile text", () => {
    const started = Date.now();
    const ev = findEvents(`${"1/1/2020 ".repeat(100_000)}${"9".repeat(500_000)}${"April ".repeat(100_000)}`);
    expect(ev.length).toBeLessThanOrEqual(40);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("Case DNA", () => {
  it("Huis suggests dated events from documents and people from filed email; attorneys confirm or reject, and rejections stick", async () => {
    const x = await setup();
    const letter = await upload(x.owner, x.matter.id, "termination.txt", LETTER);
    await upload(x.owner, x.matter.id, "leave-request.eml", EMAIL);
    await process();
    const nodes = await db.withFirm(x.paraCtx, (s) => listNodes(s, x.matter.id));
    const events = nodes.filter((n) => n.kind === "event");
    expect(events.map((e) => e.eventDate)).toEqual(expect.arrayContaining(["2026-04-18", "2026-04-02"]));
    expect(events.every((e) => e.status === "suggested" && e.origin === "huis")).toBe(true);
    const people = nodes.filter((n) => n.kind === "person");
    expect(people.map((p) => p.email).sort()).toEqual(["cindy@acme.example", "jordan@acme.example", "pat.smith@example.com"]);
    // Named by address; the name each email gives is kept with that email.
    const cindyNode = people.find((p) => p.email === "cindy@acme.example")!;
    expect(cindyNode.label).toBe("cindy@acme.example");
    expect((await db.withFirm(x.paraCtx, (s) => getNode(s, cindyNode.id))).citations[0]!.quote).toContain("Cindy Manager");
    // The cited source comes with the suggestion.
    const fired = events.find((e) => e.eventDate === "2026-04-18")!;
    expect((await db.withFirm(x.paraCtx, (s) => getNode(s, fired.id))).citations[0]).toMatchObject({ evidenceId: letter.id, sourceTitle: "termination.txt" });

    const jordan = people.find((p) => p.email === "jordan@acme.example")!;
    await db.withFirm(x.paraCtx, (s) => decideNode(s, fired.id, "confirmed"));
    await db.withFirm(x.paraCtx, (s) => decideNode(s, jordan.id, "rejected"));
    const decided = (await t.admin.query("SELECT decided_by FROM huis.dna_nodes WHERE id = $1", [fired.id])).rows[0];
    expect(decided.decided_by).toBe(x.para.id);
    // Reading the documents again doesn't bring a rejected suggestion back or duplicate anything.
    await t.admin.query("UPDATE huis.brain_sources SET status = 'queued' WHERE matter_id = $1", [x.matter.id]);
    await process();
    const again = await db.withFirm(x.paraCtx, (s) => listNodes(s, x.matter.id, { includeRejected: true }));
    expect(again.filter((n) => n.email === "jordan@acme.example").map((n) => n.status)).toEqual(["rejected"]);
    expect(again.filter((n) => n.kind === "event").length).toBe(events.length);
    // Huis's suggestions are rejected, not deleted.
    await expect(db.withFirm(x.paraCtx, (s) => deleteNode(s, jordan.id))).rejects.toThrow(/reject/);
  });

  it("claim view: elements, supporting facts with their evidence, witnesses and emails", async () => {
    const x = await setup();
    await upload(x.owner, x.matter.id, "termination.txt", LETTER);
    await upload(x.owner, x.matter.id, "leave-request.eml", EMAIL);
    await process();
    const claimId = await db.withFirm(x.paraCtx, (s) => addClaimFromTemplate(s, x.matter.id, "fmla_retaliation"));
    let view = await db.withFirm(x.paraCtx, (s) => claimView(s, claimId));
    expect(view.elements.map((e) => e.element.label)).toEqual(["Protected activity", "Adverse action", "Causal connection"]);
    const protectedActivity = view.elements[0]!.element;
    const found = await db.withFirm(x.paraCtx, (s) => findEvidenceFor(s, protectedActivity.id));
    expect(found.length).toBeGreaterThan(0);
    const fromEmail = found.find((p) => p.sourceTitle === "leave-request.eml")!;
    const factId = await db.withFirm(x.paraCtx, (s) => addFactFromPassage(s, protectedActivity.id, { chunkId: fromEmail.chunkId, relation: "supports", label: "Pat requested FMLA leave for surgery (Apr 2)" }));
    const adverse = view.elements[1]!.element;
    const fromLetter = (await db.withFirm(x.paraCtx, (s) => findEvidenceFor(s, adverse.id))).find((p) => p.sourceTitle === "termination.txt")!;
    const adverseFact = await db.withFirm(x.paraCtx, (s) => addFactFromPassage(s, adverse.id, { chunkId: fromLetter.chunkId, relation: "supports" }));
    // Without a title, the fact reads as the best-matching sentence of the passage.
    expect((await db.withFirm(x.paraCtx, (s) => getNode(s, adverseFact))).node.label).toMatch(/terminated effective April 18, 2026/);
    const cindy = (await db.withFirm(x.paraCtx, (s) => listNodes(s, x.matter.id))).find((n) => n.email === "cindy@acme.example")!;
    await expect(db.withFirm(x.paraCtx, (s) => updateNode(s, cindy.id, { label: "Cindy Manager" }))).rejects.toThrow(/Confirm/);
    await db.withFirm(x.paraCtx, (s) => decideNode(s, cindy.id, "confirmed"));
    await db.withFirm(x.paraCtx, (s) => updateNode(s, cindy.id, { label: "Cindy Manager", email: "cindy@acme.example", role: "decision maker" }));
    await db.withFirm(x.paraCtx, (s) => linkNodes(s, cindy.id, factId, "witness_to"));
    view = await db.withFirm(x.paraCtx, (s) => claimView(s, claimId));
    expect(view.elements[0]!.supporting.map((f) => f.label)).toEqual(["Pat requested FMLA leave for surgery (Apr 2)"]);
    expect(view.elements[0]!.supporting[0]!.citations[0]!.sourceTitle).toBe("leave-request.eml");
    expect(view.elements[1]!.supporting).toHaveLength(1);
    expect(view.witnesses.map((w) => w.label)).toEqual(["Cindy Manager"]);
    expect(view.emails.map((e) => e.sourceTitle)).toEqual(["leave-request.eml"]);
    expect(view.evidence.map((e) => e.sourceTitle)).toEqual(["termination.txt"]);
    // Custom elements, and links that make no sense are refused.
    await db.withFirm(x.paraCtx, (s) => addElement(s, claimId, { label: "Damages", details: "Lost wages." }));
    expect((await db.withFirm(x.paraCtx, (s) => claimView(s, claimId))).elements).toHaveLength(4);
    await expect(db.withFirm(x.paraCtx, (s) => linkNodes(s, claimId, cindy.id, "element_of"))).rejects.toThrow(/can't be linked/);
  });

  it("the Matter's client and contacts join the map, confirmed", async () => {
    const x = await setup();
    expect(await db.withFirm(x.owner, (s) => importMatterPeople(s, x.matter.id))).toBe(2);
    const people = (await db.withFirm(x.owner, (s) => listNodes(s, x.matter.id))).filter((n) => n.kind === "person");
    expect(people.map((p) => [p.label, p.role, p.status]).sort()).toEqual([["Olivia Opposing", "opposing counsel", "confirmed"], ["Pat Smith", "client", "confirmed"]]);
    expect(await db.withFirm(x.owner, (s) => importMatterPeople(s, x.matter.id))).toBe(0);
  });

  it("clients and other outside users never see Case DNA; read-only staff can read but not change it", async () => {
    const x = await setup();
    const id = await db.withFirm(x.owner, (s) => addNode(s, x.matter.id, { kind: "fact", label: "Strategy: retaliation timeline is strong" }));
    await expect(db.withFirm(x.portalCtx, (s) => listNodes(s, x.matter.id))).rejects.toThrow(/permission/i);
    for (const table of ["dna_nodes", "dna_links", "dna_citations"]) {
      expect((await db.withFirm(x.portalCtx, (s) => s.client.query(`SELECT 1 FROM huis.${table}`))).rowCount).toBe(0);
    }
    expect((await db.withFirm(x.readerCtx, (s) => getNode(s, id))).node.label).toMatch(/Strategy/);
    await expect(db.withFirm(x.readerCtx, (s) => addNode(s, x.matter.id, { kind: "fact", label: "x" }))).rejects.toThrow(/permission/i);
    await expect(db.withFirm(x.readerCtx, (s) => updateNode(s, id, { label: "changed" }))).rejects.toThrow(/permission/i);
    expect((await db.withFirm(x.readerCtx, (s) => s.client.query("UPDATE huis.dna_nodes SET label = 'changed' WHERE id = $1", [id]))).rowCount).toBe(0);
  });

  it("walls hold: no reading, linking or citing across a wall or between Matters", async () => {
    const x = await setup();
    const walledFact = await db.withFirm(x.owner, (s) => addNode(s, x.walled.id, { kind: "fact", label: "Walled secret" }));
    const mine = await db.withFirm(x.paraCtx, (s) => addNode(s, x.matter.id, { kind: "fact", label: "Mine" }));
    await expect(db.withFirm(x.paraCtx, (s) => getNode(s, walledFact))).rejects.toThrow();
    await expect(db.withFirm(x.paraCtx, (s) => linkNodes(s, mine, walledFact, "related_to"))).rejects.toThrow();
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query(
      "INSERT INTO huis.dna_links (firm_id, matter_id, from_id, to_id, relation, status, origin, created_by) VALUES ($1, $2, $3, $4, 'related_to', 'confirmed', 'attorney', $5)",
      [x.firmId, x.matter.id, mine, walledFact, x.para.id]))).rejects.toThrow();
    // Even the owner (inside the wall) can't link across Matters.
    await expect(db.withFirm(x.owner, (s) => linkNodes(s, mine, walledFact, "related_to"))).rejects.toThrow();
    await expect(db.withFirm(x.owner, (s) => s.client.query(
      "INSERT INTO huis.dna_links (firm_id, matter_id, from_id, to_id, relation, status, origin, created_by) VALUES ($1, $2, $3, $4, 'related_to', 'confirmed', 'attorney', $5)",
      [x.firmId, x.matter.id, mine, walledFact, x.ownerUserId]))).rejects.toThrow(/one Matter/);
    // A passage from another Matter can't become a fact here.
    await upload(x.owner, x.walled.id, "memo.txt", "Confidential settlement memo. The defendant offered 900000 dollars to settle.");
    await process();
    const chunk = (await t.admin.query("SELECT c.id FROM huis.brain_chunks c WHERE c.matter_id = $1 LIMIT 1", [x.walled.id])).rows[0].id;
    const claimId = await db.withFirm(x.owner, (s) => addClaimFromTemplate(s, x.matter.id, "fmla_retaliation"));
    const el = (await db.withFirm(x.owner, (s) => claimView(s, claimId))).elements[0]!.element;
    await expect(db.withFirm(x.owner, (s) => addFactFromPassage(s, el.id, { chunkId: String(chunk), relation: "supports" }))).rejects.toThrow();
  });

  it("the app can't plant Huis suggestions or rewrite history, and nodes built on evidence that stops being clean disappear", async () => {
    const x = await setup();
    await expect(db.withFirm(x.owner, (s) => s.client.query(
      "INSERT INTO huis.dna_nodes (firm_id, matter_id, kind, label, status, origin) VALUES ($1, $2, 'fact', 'planted', 'suggested', 'huis')",
      [x.firmId, x.matter.id]))).rejects.toThrow();
    const id = await db.withFirm(x.owner, (s) => addNode(s, x.matter.id, { kind: "fact", label: "Mine" }));
    await expect(db.withFirm(x.owner, (s) => s.client.query("UPDATE huis.dna_nodes SET created_by = $2 WHERE id = $1", [id, x.para.id]))).rejects.toThrow(/history/);
    await expect(db.withFirm(x.owner, (s) => s.client.query("UPDATE huis.dna_nodes SET status = 'suggested' WHERE id = $1", [id]))).rejects.toThrow();
    await expect(db.withFirm(x.owner, (s) => s.client.query("SELECT huis.worker_save_dna_suggestions(gen_random_uuid(), gen_random_uuid(), '[]')"))).rejects.toThrow(/permission/);

    const letter = await upload(x.owner, x.matter.id, "termination.txt", LETTER);
    await process();
    expect((await db.withFirm(x.owner, (s) => listNodes(s, x.matter.id))).some((n) => n.kind === "event")).toBe(true);
    await t.admin.query(`SET session_replication_role = replica; UPDATE huis.evidence_items SET status = 'infected' WHERE id = '${letter.id}'; SET session_replication_role = origin;`);
    expect((await db.withFirm(x.owner, (s) => listNodes(s, x.matter.id))).some((n) => n.kind === "event")).toBe(false);
  });

  it("the audit log records what kind of change, never the wording", async () => {
    const x = await setup();
    await db.withFirm(x.owner, (s) => addNode(s, x.matter.id, { kind: "fact", label: "Manager admitted the retaliation" }));
    const audit = await t.admin.query("SELECT metadata::text AS m FROM huis.audit_events WHERE firm_id = $1 AND action LIKE 'dna.%'", [x.firmId]);
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].m).not.toMatch(/admitted|retaliation/i);
  });

  it("review 9: a change with no conditions can't reach items the person can't see", async () => {
    const x = await setup();
    const letter = await upload(x.owner, x.matter.id, "termination.txt", LETTER);
    await process();
    const event = (await db.withFirm(x.owner, (s) => listNodes(s, x.matter.id))).find((n) => n.kind === "event")!;
    await db.withFirm(x.owner, (s) => decideNode(s, event.id, "confirmed"));
    const mine = await db.withFirm(x.owner, (s) => addNode(s, x.matter.id, { kind: "fact", label: "Mine" }));
    await db.withFirm(x.owner, (s) => linkNodes(s, mine, event.id, "related_to"));
    await t.admin.query(`SET session_replication_role = replica; UPDATE huis.evidence_items SET status = 'infected' WHERE id = '${letter.id}'; SET session_replication_role = origin;`);
    for (const sql of ["DELETE FROM huis.dna_citations", "UPDATE huis.dna_links SET status = 'rejected'", "DELETE FROM huis.dna_links", "DELETE FROM huis.dna_nodes WHERE kind = 'event'"]) {
      await db.withFirm(x.paraCtx, (s) => s.client.query(sql));
    }
    expect((await t.admin.query("SELECT count(*)::int AS n FROM huis.dna_citations WHERE evidence_id = $1", [letter.id])).rows[0].n).toBeGreaterThan(0);
    expect((await t.admin.query("SELECT status FROM huis.dna_links WHERE to_id = $1", [event.id])).rows[0].status).toBe("confirmed");
    expect((await db.withFirm(x.paraCtx, (s) => listNodes(s, x.matter.id))).some((n) => n.kind === "event")).toBe(false);
  });

  it("review 9: a citation's quote always comes from the source itself", async () => {
    const x = await setup();
    const letter = await upload(x.owner, x.matter.id, "termination.txt", LETTER);
    await process();
    const fact = await db.withFirm(x.owner, (s) => addNode(s, x.matter.id, { kind: "fact", label: "Termination" }));
    await db.withFirm(x.owner, (s) => s.client.query(
      "INSERT INTO huis.dna_citations (firm_id, matter_id, node_id, evidence_id, char_start, char_end, quote) VALUES ($1, $2, $3, $4, 0, 19, 'We fired her BECAUSE she asked for FMLA leave. -- Cindy')",
      [x.firmId, x.matter.id, fact, letter.id]));
    expect((await db.withFirm(x.owner, (s) => getNode(s, fact))).citations[0]!.quote).toBe("Termination letter.");
    await expect(db.withFirm(x.owner, (s) => s.client.query(
      "INSERT INTO huis.dna_citations (firm_id, matter_id, node_id, evidence_id, char_start, char_end, quote) VALUES ($1, $2, $3, $4, 900000, 900010, 'made up')",
      [x.firmId, x.matter.id, fact, letter.id]))).rejects.toThrow(/not in the source/);
  });

  it("review 9: people from an email leave the map with it, one email can't flood or name them, and Huis's wording can't be changed before confirming", async () => {
    const x = await setup();
    const many = Array.from({ length: 60 }, (_, i) => `"Partner ${i} (Huis verified)" <p${i}@spam.example>`).join(", ");
    const spam = await upload(x.owner, x.matter.id, "spam.eml", [
      `From: "Judge Reyes chambers" <cindy@acme.example>`, `To: ${many}`, "Subject: hi", "MIME-Version: 1.0", "Content-Type: text/plain", "", "Hello.", "",
    ].join("\r\n"));
    await process();
    const people = (await db.withFirm(x.owner, (s) => listNodes(s, x.matter.id))).filter((n) => n.kind === "person");
    expect(people.length).toBeLessThanOrEqual(20);
    expect(people.find((p) => p.email === "cindy@acme.example")!.label).toBe("cindy@acme.example");
    expect(people.some((p) => /Huis verified|Judge/.test(p.label))).toBe(false);
    await expect(db.withFirm(x.owner, (s) => s.client.query("UPDATE huis.dna_nodes SET label = 'Huis found: CEO ordered it' WHERE origin = 'huis'"))).rejects.toThrow(/Confirm/);
    await t.admin.query(`SET session_replication_role = replica; UPDATE huis.evidence_items SET status = 'infected' WHERE id = '${spam.id}'; SET session_replication_role = origin;`);
    expect((await db.withFirm(x.owner, (s) => listNodes(s, x.matter.id))).filter((n) => n.kind === "person")).toEqual([]);
  });

  it("review 9: other firms learn nothing about whether items exist", async () => {
    const x = await setup();
    const y = await setup();
    const fact = await db.withFirm(x.owner, (s) => addNode(s, x.matter.id, { kind: "fact", label: "Secret" }));
    const other = await db.withFirm(x.owner, (s) => addNode(s, x.matter.id, { kind: "fact", label: "Other" }));
    const real = (await db.withFirm(y.owner, (s) => s.client.query("SELECT huis.dna_node_sources_ok($1) AS ok", [fact]))).rows[0].ok;
    const fake = (await db.withFirm(y.owner, (s) => s.client.query("SELECT huis.dna_node_sources_ok(gen_random_uuid()) AS ok"))).rows[0].ok;
    expect(real).toBe(fake);
    const attempt = (from: string, to: string) => db.withFirm(y.owner, (s) => s.client.query(
      "INSERT INTO huis.dna_links (firm_id, matter_id, from_id, to_id, relation, status, origin, created_by) VALUES ($1, $2, $3, $4, 'related_to', 'confirmed', 'attorney', $5)",
      [x.firmId, x.matter.id, from, to, y.ownerUserId])).then(() => "ok", (e: Error) => e.message);
    expect(await attempt(fact, other)).toBe(await attempt(crypto.randomUUID(), crypto.randomUUID()));
  });

  it("review 9: finding dates in a hostile document stays quick", () => {
    const started = Date.now();
    findEvents("Ms. 1/1/2020 ".repeat(160_000));
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
