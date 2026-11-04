/**
 * Independent security review 12: Phase 5 part 2 (contradiction engine).
 *
 * Tests named "F<n>: ..." demonstrate confirmed problems and FAIL on the code
 * as reviewed; they pass once fixed. Tests named "blocked: ..." demonstrate
 * attacks that were correctly refused. Made-up data only.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrainWorker } from "../src/brain/worker";
import { findStatements } from "../src/contradictions/detect";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { createClient } from "../src/services/clients";
import { addClaimFromTemplate, addElement, addFactFromPassage, addNode, deleteNode, getNode, listNodes } from "../src/services/dna";
import { assembleOriginal, getUploadSession, markChunkReceived, newEvidenceId, recordEvidence, startUpload, storeChunk } from "../src/services/evidence";
import { addMatterMember, createMatter } from "../src/services/matters";
import { confirmContradiction, getContradictions, reconsiderContradiction, rejectContradiction } from "../src/services/contradictions";
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
  vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-sr12-vault-"));
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
  // (A claim that finds its source no longer clean returns no job, so keep going a few rounds.)
  for (let i = 0; i < 3; i++) while (await brain.indexOnce()) { /* index */ }
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
    const other = await createMatter(s, { title: "Jones v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
    const walled = await createMatter(s, { title: "Walled", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT", restricted: true });
    return { para, reader, portal, matter, other, walled };
  });
  await db.withFirm(f.owner, (s) => addMatterMember(s, { matterId: x.matter.id, userId: x.portal.id, access: "view", acknowledgePrivilegeWaiverRisk: true }));
  const ctx = (id: string): RequestContext => ({ firmId: f.firmId, userId: id });
  return { ...f, ...x, paraCtx: ctx(x.para.id), readerCtx: ctx(x.reader.id), portalCtx: ctx(x.portal.id) };
}

const DEPOSITION = `Deposition of Cindy Manager, taken June 3, 2026.

Q. When did you first hear about the surgery?
A. I didn't know about her surgery until May.`;
const LETTER = "HR memo. On April 12, 2026 the doctor confirmed the surgery date to HR.";
const email = (subject: string, body: string, date = "Thu, 02 Apr 2026 09:00:00 -0600") => [
  "From: Pat Smith <pat.smith@example.com>", "To: Cindy Manager <cindy@acme.example>",
  `Subject: ${subject}`, `Date: ${date}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "",
  body, "",
].join("\r\n");
const surgeryFlag = (r: Awaited<ReturnType<typeof getContradictions>>) => r.potential.find((f) => f.statement.topics.includes("surgery"))!;

describe("security review 12: citations Huis writes when a contradiction is confirmed", () => {
  it("F1: a statement in an indented deposition transcript is cited at the wrong position (quote doesn't match the statement)", async () => {
    // Deposition transcripts are line-numbered and indented. The Brain's passages are trimmed but keep the
    // untrimmed start, so a statement found in any passage after the first is cited a few characters off.
    const x = await setup();
    const lines = Array.from({ length: 60 }, (_, i) => `    ${String(i + 1).padStart(2)}      Q. Did you review the attendance records for week ${i}?`);
    lines.push("    61      A. I didn't know about her surgery until May.");
    await upload(x.owner, x.matter.id, "transcript-cindy.txt", `DEPOSITION OF CINDY MANAGER, taken June 3, 2026\n\n${lines.join("\n")}\n`);
    await upload(x.owner, x.matter.id, "hr-memo.txt", LETTER);
    await process();
    const f = surgeryFlag(await db.withFirm(x.paraCtx, (s) => getContradictions(s, x.matter.id)));
    expect(f.statement.quote).toBe("I didn't know about her surgery until May.");
    const id = await db.withFirm(x.paraCtx, (s) => confirmContradiction(s, x.matter.id, f.key, f.version));
    const node = await db.withFirm(x.paraCtx, (s) => getNode(s, id));
    // The citation (the "exact source" an attorney relies on) must quote the statement itself.
    expect(node.citations.map((c) => c.quote)).toEqual(["I didn't know about her surgery until May."]);
  });

  it("F2: text with emoji (or any character outside the BMP) before the statement shifts the citation", async () => {
    // JavaScript string positions count UTF-16 units; the database quotes the source by characters.
    const x = await setup();
    await upload(x.owner, x.matter.id, "witness-texts.txt",
      "Text messages exported June 3, 2026 \u{1F600}\u{1F600}\u{1F600}\u{1F44D}\u{1F44D}\u{1F44D}\nI didn't know about her surgery until May.");
    await upload(x.owner, x.matter.id, "hr-memo.txt", LETTER);
    await process();
    const f = surgeryFlag(await db.withFirm(x.paraCtx, (s) => getContradictions(s, x.matter.id)));
    const id = await db.withFirm(x.paraCtx, (s) => confirmContradiction(s, x.matter.id, f.key, f.version));
    const node = await db.withFirm(x.paraCtx, (s) => getNode(s, id));
    expect(node.citations.map((c) => c.quote)).toEqual([f.statement.quote]);
  });

  it("F3: a conflicting email not (yet) in the Brain becomes an uncited fact, which then survives the email being found infected", async () => {
    const x = await setup();
    await upload(x.owner, x.matter.id, "deposition-cindy.txt", DEPOSITION);
    await process();
    // Filed email that the Brain hasn't indexed yet (extraction done, indexing pending): it is on the timeline.
    const mail = await upload(x.owner, x.matter.id, "surgery.eml", email("Surgery scheduled for April 20", "Please see the attached note."));
    await processor.drain();
    const f = surgeryFlag(await db.withFirm(x.paraCtx, (s) => getContradictions(s, x.matter.id)));
    expect(f.conflicting.map((c) => c.evidenceId)).toEqual([mail.id]);
    expect(f.conflicting[0]!.passage).toBeNull();
    const id = await db.withFirm(x.paraCtx, (s) => confirmContradiction(s, x.matter.id, f.key, f.version));
    const node = await db.withFirm(x.paraCtx, (s) => getNode(s, id));
    const emailFactId = node.links.find((l) => l.relation === "contradicts" && /^Email of/.test(l.other.label))!.other.id;
    const emailFact = await db.withFirm(x.paraCtx, (s) => getNode(s, emailFactId));
    expect(emailFact.node.label).toBe("Email of 2026-04-02: Surgery scheduled for April 20");
    // Every fact links to its exact source…
    const uncited = emailFact.citations.length === 0;
    // …and an item drawn from evidence that is no longer clean leaves Case DNA.
    await infect(mail.id);
    const stillThere = (await db.withFirm(x.paraCtx, (s) => listNodes(s, x.matter.id))).some((n) => n.id === emailFactId);
    expect({ uncited, stillThereAfterInfection: stillThere }).toEqual({ uncited: false, stillThereAfterInfection: false });
  });
});

describe("security review 12: deciding on a flag", () => {
  it("F4: confirming acts on whatever the flag has become, confirming Huis suggestions the attorney never saw", async () => {
    const x = await setup();
    await upload(x.owner, x.matter.id, "deposition-cindy.txt", DEPOSITION);
    await upload(x.owner, x.matter.id, "hr-memo.txt", LETTER);
    await process();
    // The attorney reviews the flag: one item (the HR memo).
    const seen = surgeryFlag(await db.withFirm(x.owner, (s) => getContradictions(s, x.matter.id)));
    expect(seen.conflicting.length).toBe(1);
    // Meanwhile a new document arrives, and Huis suggests an event from it.
    const late = await upload(x.paraCtx, x.matter.id, "clinic-note.txt", "Clinic note. On March 30, 2026 the surgery was booked by the clinic.");
    await process();
    const suggestion = (await db.withFirm(x.owner, (s) => listNodes(s, x.matter.id))).find((n) => n.status === "suggested" && /March 30/.test(n.label))!;
    expect(suggestion).toBeTruthy();
    // The attorney clicks "Confirm contradiction" on what they reviewed (the form sends only the key).
    let refused = false;
    try { await db.withFirm(x.owner, (s) => confirmContradiction(s, x.matter.id, seen.key)); } catch { refused = true; }
    const after = (await db.withFirm(x.owner, (s) => listNodes(s, x.matter.id))).find((n) => n.id === suggestion.id)!;
    // Either the changed flag is refused (shown again), or what the attorney didn't see is left alone.
    expect(refused || after.status === "suggested").toBe(true);
    void late;
  });

  it("F5: a forged 'confirmed' decision (direct SQL as the app role) silently and permanently suppresses a flag", async () => {
    const x = await setup();
    await upload(x.owner, x.matter.id, "deposition-cindy.txt", DEPOSITION);
    await upload(x.owner, x.matter.id, "hr-memo.txt", LETTER);
    await process();
    const f = surgeryFlag(await db.withFirm(x.owner, (s) => getContradictions(s, x.matter.id)));
    // Any confirmed fact in the Matter will do: no statement, no "contradicts" links are created.
    const unrelated = await db.withFirm(x.paraCtx, (s) => addNode(s, x.matter.id, { kind: "fact", label: "Parking was free" }));
    let forged = true;
    try {
      await db.withFirm(x.paraCtx, (s) => s.client.query(
        `INSERT INTO huis.contradiction_decisions (firm_id, matter_id, flag_key, decision, statement_node_id, decided_by)
         VALUES ($1, $2, $3, 'confirmed', $4, $5)`, [x.firmId, x.matter.id, f.key, unrelated, x.para.id]));
    } catch { forged = false; }
    const r = await db.withFirm(x.owner, (s) => getContradictions(s, x.matter.id));
    const gone = !r.potential.some((p) => p.key === f.key);
    // And it can never be put back: confirmed decisions can't be withdrawn.
    await expect(db.withFirm(x.owner, (s) => reconsiderContradiction(s, x.matter.id, f.key))).rejects.toThrow();
    expect({ forged, gone }).toEqual({ forged: false, gone: false });
  });
});

describe("security review 12: dates and confidence (misleading output)", () => {
  it("F6: the claimed date is taken from the first date-like phrase, not the 'until' the denial is about", () => {
    const [st] = findStatements("I never received the email sent on March 3, 2026 until May 4, 2026.");
    // Claimed: no knowledge until May 4. Read as "before March 3", which drops the March 3 email itself.
    expect(st!.before).toBe("2026-05-04");
  });

  it("F7: items with no source at all each count as a 'different source', so three unsourced notes give High confidence", async () => {
    const x = await setup();
    await upload(x.owner, x.matter.id, "deposition-cindy.txt", DEPOSITION);
    await process();
    for (const d of ["2026-04-01", "2026-04-02", "2026-04-03"]) {
      await db.withFirm(x.paraCtx, (s) => addNode(s, x.matter.id, { kind: "event", label: `Heard surgery rumor ${d}`, eventDate: d }));
    }
    const f = surgeryFlag(await db.withFirm(x.paraCtx, (s) => getContradictions(s, x.matter.id)));
    expect(f.conflicting.length).toBe(3);
    // Not one piece of evidence conflicts, yet: "3 earlier items from 3 different sources" and High confidence.
    expect(f.why).not.toMatch(/3 different sources/);
    expect(f.confidence).not.toBe("high");
  });

  it("F8: the statement's own document is counted as a corroborating source when an item also cites it", async () => {
    const x = await setup();
    const dep = await upload(x.owner, x.matter.id, "deposition-cindy.txt",
      `${DEPOSITION}\nQ. And the surgery itself?\nA. On April 20, 2026 the surgery took place.`);
    const memo = await upload(x.owner, x.matter.id, "hr-memo.txt", LETTER);
    await process();
    // An attorney's event cited to the memo and to the deposition (the database allows several citations per item).
    const ev = await db.withFirm(x.paraCtx, (s) => addNode(s, x.matter.id, { kind: "event", label: "Surgery booked", eventDate: "2026-04-10" }));
    await db.withFirm(x.paraCtx, async (s) => {
      for (const [eid, txt] of [[memo.id, LETTER], [dep.id, `${DEPOSITION}\nQ. And the surgery itself?\nA. On April 20, 2026 the surgery took place.`]] as const) {
        const at = txt.indexOf("surgery");
        await s.client.query(
          `INSERT INTO huis.dna_citations (firm_id, matter_id, node_id, evidence_id, char_start, char_end, quote) VALUES ($1, $2, $3, $4, $5, $6, 'x')`,
          [x.firmId, x.matter.id, ev, eid, at, at + 7]);
      }
    });
    const f = surgeryFlag(await db.withFirm(x.paraCtx, (s) => getContradictions(s, x.matter.id)));
    const mine = f.conflicting.filter((c) => c.nodeId === ev || /April 12/.test(c.label));
    expect(mine.length).toBe(2);
    // Only one other source (the memo) contradicts the deposition; the deposition can't corroborate itself.
    expect(f.why).toMatch(/from 1 different source/);
    expect(f.confidence).toBe("low");
  });
});

describe("security review 12: cost", () => {
  it("F9: one long document of short denials and a few long emails make the page (and every decision) take far too long", async () => {
    const x = await setup();
    // ~4,000 distinct denials (a hostile upload, or simply a long deposition full of "I don't recall …").
    const denials = Array.from({ length: 4000 }, (_, i) => `I don't recall memo${i} topic${i}.`).join(" ");
    await upload(x.owner, x.matter.id, "deposition-long.txt", `Deposition taken June 3, 2026.\n${denials}`);
    const filler = Array.from({ length: 900 }, (_, i) => `word${i} policy schedule`).join(" ");
    for (let i = 0; i < 15; i++) await upload(x.owner, x.matter.id, `thread-${i}.eml`, email(`Thread ${i}`, filler));
    await process();
    const started = Date.now();
    const r = await db.withFirm(x.paraCtx, (s) => getContradictions(s, x.matter.id));
    const ms = Date.now() - started;
    expect(r.potential.length).toBe(0);
    expect(ms).toBeLessThan(5000);
  });
});

describe("security review 12: fixes beyond the findings", () => {
  it("a contradiction whose statement was deleted from Case DNA can be decided again (it no longer hides the flag)", async () => {
    const x = await setup();
    await upload(x.owner, x.matter.id, "deposition-cindy.txt", DEPOSITION);
    await upload(x.owner, x.matter.id, "hr-memo.txt", LETTER);
    await process();
    const f = surgeryFlag(await db.withFirm(x.paraCtx, (s) => getContradictions(s, x.matter.id)));
    const statementId = await db.withFirm(x.paraCtx, (s) => confirmContradiction(s, x.matter.id, f.key, f.version));
    expect(surgeryFlag(await db.withFirm(x.paraCtx, (s) => getContradictions(s, x.matter.id)))).toBeUndefined();
    await db.withFirm(x.paraCtx, (s) => deleteNode(s, statementId));
    const again = surgeryFlag(await db.withFirm(x.paraCtx, (s) => getContradictions(s, x.matter.id)));
    expect(again?.key).toBe(f.key);
    await db.withFirm(x.paraCtx, (s) => confirmContradiction(s, x.matter.id, again.key, again.version));
  });

  it("Phase 4's 'add as a fact' also cites the right words after emoji", async () => {
    const x = await setup();
    const filler = Array.from({ length: 300 }, (_, i) => `Message ${i} sent.`).join(" ");
    await upload(x.owner, x.matter.id, "texts.txt",
      `Texts \u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}\n${filler}\n\nThe doctor confirmed the surgery date on April 12, 2026.`);
    await process();
    const { claimId, elementId } = await db.withFirm(x.paraCtx, async (s) => {
      const claimId = await addClaimFromTemplate(s, x.matter.id, "fmla_retaliation");
      return { claimId, elementId: await addElement(s, claimId, { label: "Notice of surgery" }) };
    });
    void claimId;
    // The last passage: it starts after the emoji.
    const { id: chunk, content } = (await t.admin.query("SELECT id, content FROM huis.brain_chunks WHERE matter_id = $1 ORDER BY chunk_no DESC LIMIT 1", [x.matter.id])).rows[0];
    const factId = await db.withFirm(x.paraCtx, (s) => addFactFromPassage(s, elementId, { chunkId: String(chunk), relation: "supports" }));
    const fact = await db.withFirm(x.paraCtx, (s) => getNode(s, factId));
    expect(fact.citations[0]!.quote).toBe(String(content).replace(/\s+/g, " ").trim().slice(0, 1500));
    expect(fact.citations[0]!.quote).toMatch(/April 12, 2026\.$/);
  });
});

describe("security review 12: attacks that were correctly stopped", () => {
  it("blocked: clients, read-only staff, other firms and walled-out staff can't see or decide; keys don't travel between Matters", async () => {
    const x = await setup();
    await upload(x.owner, x.matter.id, "deposition-cindy.txt", DEPOSITION);
    await upload(x.owner, x.matter.id, "hr-memo.txt", LETTER);
    await upload(x.owner, x.other.id, "deposition-cindy.txt", DEPOSITION);
    await upload(x.owner, x.other.id, "hr-memo.txt", LETTER);
    await process();
    const f = surgeryFlag(await db.withFirm(x.owner, (s) => getContradictions(s, x.matter.id)));
    await expect(db.withFirm(x.portalCtx, (s) => getContradictions(s, x.matter.id))).rejects.toThrow(/permission/i);
    await expect(db.withFirm(x.portalCtx, (s) => confirmContradiction(s, x.matter.id, f.key, f.version))).rejects.toThrow(/permission/i);
    // Direct SQL as the client: no decisions, no passages.
    expect((await db.withFirm(x.portalCtx, (s) => s.client.query("SELECT * FROM huis.contradiction_decisions"))).rowCount).toBe(0);
    expect((await db.withFirm(x.portalCtx, (s) => s.client.query("SELECT * FROM huis.brain_chunks"))).rowCount).toBe(0);
    await expect(db.withFirm(x.readerCtx, (s) => reconsiderContradiction(s, x.matter.id, f.key))).rejects.toThrow(/permission/i);
    const otherFirm = await newFirm(db, "Other Owner");
    await expect(db.withFirm(otherFirm.owner, (s) => rejectContradiction(s, x.matter.id, f.key))).rejects.toThrow(/not found/i);
    await expect(db.withFirm(x.paraCtx, (s) => confirmContradiction(s, x.walled.id, f.key))).rejects.toThrow(/not found/i);
    // Same document text in another Matter: different key; this Matter's key means nothing there.
    const g = surgeryFlag(await db.withFirm(x.owner, (s) => getContradictions(s, x.other.id)));
    expect(g.key).not.toBe(f.key);
    await expect(db.withFirm(x.owner, (s) => rejectContradiction(s, x.other.id, f.key))).rejects.toThrow(/not found/i);
    // A rejection recorded against another Matter (direct SQL) with this Matter's key doesn't hide it here.
    await db.withFirm(x.paraCtx, (s) => s.client.query(
      "INSERT INTO huis.contradiction_decisions (firm_id, matter_id, flag_key, decision, decided_by) VALUES ($1, $2, $3, 'rejected', $4)",
      [x.firmId, x.other.id, f.key, x.para.id]));
    expect(surgeryFlag(await db.withFirm(x.owner, (s) => getContradictions(s, x.matter.id))).key).toBe(f.key);
    // Walled-out staff can't record a decision on the walled Matter directly, nor see its decisions.
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query(
      "INSERT INTO huis.contradiction_decisions (firm_id, matter_id, flag_key, decision, decided_by) VALUES ($1, $2, $3, 'rejected', $4)",
      [x.firmId, x.walled.id, "d".repeat(64), x.para.id]))).rejects.toThrow();
    // Another firm can't record a decision against this firm's Matter.
    await expect(db.withFirm(otherFirm.owner, (s) => s.client.query(
      "INSERT INTO huis.contradiction_decisions (firm_id, matter_id, flag_key, decision, decided_by) VALUES ($1, $2, $3, 'rejected', $4)",
      [x.firmId, x.matter.id, "e".repeat(64), otherFirm.ownerUserId]))).rejects.toThrow();
  });

  it("blocked: decided_at can't be backdated and decided_by can't be spoofed; confirmed decisions can't be updated or deleted", async () => {
    const x = await setup();
    await db.withFirm(x.paraCtx, (s) => s.client.query(
      "INSERT INTO huis.contradiction_decisions (firm_id, matter_id, flag_key, decision, decided_by, decided_at) VALUES ($1, $2, $3, 'rejected', $4, '2001-01-01')",
      [x.firmId, x.matter.id, "f".repeat(64), x.ownerUserId]));
    const row = (await t.admin.query("SELECT decided_by, decided_at FROM huis.contradiction_decisions WHERE flag_key = $1", ["f".repeat(64)])).rows[0];
    expect(row.decided_by).toBe(x.para.id);
    expect(new Date(row.decided_at).getUTCFullYear()).toBeGreaterThan(2001);
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query("UPDATE huis.contradiction_decisions SET decided_at = now()"))).rejects.toThrow(/permission/);
  });

  it("blocked: a planted denial in the statement's own document or its exact duplicate never corroborates itself; infected statements leave", async () => {
    const x = await setup();
    const dep = await upload(x.owner, x.matter.id, "deposition-cindy.txt", `${DEPOSITION}\nOn April 12, 2026 the surgery was discussed.`);
    await upload(x.owner, x.matter.id, "deposition-cindy-copy.txt", `${DEPOSITION}\nOn April 12, 2026 the surgery was discussed.`);
    await process();
    const r = await db.withFirm(x.paraCtx, (s) => getContradictions(s, x.matter.id));
    expect(r.potential.filter((p) => p.statement.topics.includes("surgery"))).toEqual([]);
    await infect(dep.id);
    expect((await db.withFirm(x.paraCtx, (s) => getContradictions(s, x.matter.id))).potential).toEqual([]);
  });

  it("blocked: hostile text in a passage stays fast in the statement rules", () => {
    const started = Date.now();
    findStatements(`${"I did not not not not ".repeat(30)}${"until May ".repeat(60)}`.repeat(300));
    findStatements(`${"the employee never ".repeat(40)}know.`.repeat(500));
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
