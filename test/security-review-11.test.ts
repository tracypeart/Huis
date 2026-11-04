/**
 * Independent security review 11: Phase 5 part 1 (Master Timeline).
 *
 * Tests named "F<n>: ..." demonstrate confirmed problems and FAIL on the code
 * as reviewed; they pass once fixed. Tests named "blocked: ..." demonstrate
 * attacks that were correctly refused. Made-up data only.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrainWorker } from "../src/brain/worker";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { createClient } from "../src/services/clients";
import { addNode, decideNode, listNodes } from "../src/services/dna";
import { assembleOriginal, getUploadSession, markChunkReceived, newEvidenceId, recordEvidence, startUpload, storeChunk } from "../src/services/evidence";
import { addMatterMember, createMatter } from "../src/services/matters";
import { address, getTimeline, suggestedCategoriesFor, timelineCsv } from "../src/services/timeline";
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
  vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-sr11-vault-"));
  vault = new EvidenceVault(new LocalObjectStore(vaultDir), new MasterKeyProvider(randomBytes(32).toString("base64")));
  processor = new EvidenceProcessor(t.worker, vault, scanner);
  brain = new BrainWorker(t.worker);
});
afterAll(async () => {
  await t?.drop();
  if (vaultDir) await rm(vaultDir, { recursive: true, force: true });
});

async function upload(ctx: RequestContext, matterId: string, filename: string, content: Buffer | string) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const session = await db.withFirm(ctx, (s) => startUpload(s, { matterId, filename, totalSize: buf.length }));
  for (let i = 0; i < session.chunkCount; i++) {
    await storeChunk(vault, session, i, buf.subarray(i * session.chunkSize, (i + 1) * session.chunkSize));
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

const eml = (headers: string[], body: string) => [...headers, "MIME-Version: 1.0", "Content-Type: text/plain", "", body, ""].join("\r\n");

// ---------------------------------------------------------------------------
// Confirmed findings
// ---------------------------------------------------------------------------
describe("Review 11 findings", () => {
  it("F1: a filed mailbox with long malformed addresses can't make the timeline take seconds (quadratic address parsing in timeline.ts address())", async () => {
    const x = await setup();
    // One mailbox from the other side: N messages, each with 100 recipients whose "address" is a long
    // run of letters ending in "@" (the mail parser keeps it as the address; 990 chars, under the 1,000 stored).
    const N = 40;
    const bad = (c: string) => `${c.repeat(989)}@`;
    const to = Array.from({ length: 100 }, (_, i) => bad(String.fromCharCode(65 + (i % 26)))).join(",\r\n ");
    const mbox = Array.from({ length: N }, (_, i) => [
      "From sender@other.example Fri Apr 17 10:00:00 2026",
      eml([`From: ${bad("Z")}`, `To: ${to}`, `Subject: Production batch ${i}`, `Date: Fri, 17 Apr 2026 10:${String(i % 60).padStart(2, "0")}:00 -0600`],
        `Message ${i}.`),
    ].join("\r\n")).join("\r\n");
    await upload(x.owner, x.matter.id, "production.mbox", mbox);
    await process();
    const stored = (await t.admin.query("SELECT length(from_addr) AS f, cardinality(to_addrs) AS n FROM huis.evidence_email LIMIT 1")).rows[0];
    expect(stored).toEqual({ f: 990, n: 100 });

    const started = performance.now();
    const tl = await db.withFirm(x.paraCtx, (s) => getTimeline(s, x.matter.id));
    const ms = performance.now() - started;
    expect(tl.entries.filter((e) => e.kind === "email").length).toBe(N);
    // 40 emails is a tiny Matter (a normal timeline of this size reads in a few tens of ms). Here each email
    // costs ~101 x 0.5-0.6 ms of regex backtracking in address(), so 5,000 such emails (the timeline's own
    // limit) take minutes of CPU per page view and per download, blocking the Node event loop for everyone.
    expect(ms).toBeLessThan(1000);
  });

  it("F2: an email whose display name contains someone else's address is attributed to that person (person filter, plaintiff category)", async () => {
    const x = await setup();
    const pat = await db.withFirm(x.owner, (s) =>
      addNode(s, x.matter.id, { kind: "person", label: "Pat Smith", email: "pat.smith@example.com", role: "client" }));
    // Sent by mallory@evil.example to cindy@acme.example; Pat is in neither header, only quoted inside a display name.
    const spoof = eml([
      `From: "Pat Smith <pat.smith@example.com>" <mallory@evil.example>`, "To: Cindy Manager <cindy@acme.example>",
      "Subject: I withdraw my complaint", "Date: Mon, 04 May 2026 09:00:00 -0600",
    ], "Please disregard everything.");
    const filed = await upload(x.owner, x.matter.id, "withdrawal.eml", spoof);
    await process();

    const tl = await db.withFirm(x.paraCtx, (s) => getTimeline(s, x.matter.id, { person: pat }));
    const mail = (await db.withFirm(x.paraCtx, (s) => getTimeline(s, x.matter.id))).entries.find((e) => e.evidenceId === filed.id)!;
    expect(mail.from).toBe("Pat Smith <pat.smith@example.com> <mallory@evil.example>");
    // The actual sender is mallory@evil.example: Pat must not be listed as a person on it,
    // nor must the email appear when filtering the chronology by Pat, nor be filed under "Plaintiff".
    expect(mail.people.map((p) => p.id)).not.toContain(pat);
    expect(tl.entries.map((e) => e.evidenceId)).not.toContain(filed.id);
    expect(mail.categories).not.toContain("plaintiff");
  });
});

// ---------------------------------------------------------------------------
// Attacks that were correctly blocked
// ---------------------------------------------------------------------------
describe("Review 11 fixes", () => {
  it("F1/F2: an address is the one that ends the header, or a bare address that is the whole value, in linear time", () => {
    expect(address("Pat Smith <Pat.Smith@Example.com>")).toBe("pat.smith@example.com");
    expect(address("pat@example.com")).toBe("pat@example.com");
    expect(address("Pat Smith <pat.smith@example.com> <mallory@evil.example>")).toBe("mallory@evil.example");
    expect(address("<pat@example.com> said hello")).toBeNull();
    expect(address("Undisclosed recipients")).toBeNull();
    const started = performance.now();
    for (let i = 0; i < 5000; i++) address(`${"A".repeat(989)}@`);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("F2b: Huis suggests the person who actually sent the email, not one quoted inside its display name", async () => {
    const x = await setup();
    await upload(x.owner, x.matter.id, "withdrawal.eml", eml([
      `From: "Pat Smith <pat.smith@example.com>" <mallory@evil.example>`, "To: Cindy Manager <cindy@acme.example>",
      "Subject: I withdraw my complaint", "Date: Mon, 04 May 2026 09:00:00 -0600",
    ], "Please disregard everything."));
    await process();
    const people = (await db.withFirm(x.owner, (s) => listNodes(s, x.matter.id))).filter((n) => n.kind === "person").map((n) => n.email).sort();
    expect(people).toEqual(["cindy@acme.example", "mallory@evil.example"]);
  });

  it("a very long cell in the download is shortened below the spreadsheet limit, so nothing spills past the formula guard", async () => {
    const x = await setup();
    const words = Array.from({ length: 6000 }, (_, i) => `word${i}`).join(" ");
    const doc = await upload(x.owner, x.matter.id, "long.txt", words);
    await process();
    await db.withFirm(x.owner, async (s) => {
      const id = await addNode(s, x.matter.id, { kind: "event", label: "Many quotes", eventDate: "2026-01-02" });
      // 25 citations of 1,500 characters each: the Sources cell would be ~38,000 characters.
      for (let i = 0; i < 25; i++) {
        await s.client.query(
          `INSERT INTO huis.dna_citations (firm_id, matter_id, node_id, evidence_id, char_start, char_end, quote)
           VALUES ($1, $2, $3, $4, $5, $6, 'x')`, [x.firmId, x.matter.id, id, doc.id, i * 1500, i * 1500 + 1600]);
      }
    });
    const out = await db.withFirm(x.owner, (s) => timelineCsv(s, x.matter.id, { q: "many quotes" }, true));
    const cells = out.body.match(/"(?:[^"]|"")*"/g) ?? [];
    const longest = Math.max(...cells.map((c) => c.length));
    expect(longest).toBeGreaterThan(30_000);
    expect(longest).toBeLessThan(32_767);
    expect(out.body).toContain("(shortened)");
  });
});

describe("Review 11: blocked attacks", () => {
  it("blocked: categories can't be planted on a Huis suggestion by the worker role, the app role in one UPDATE with the decision, or read-only staff", async () => {
    const x = await setup();
    await upload(x.owner, x.matter.id, "letter.txt", "On April 12, 2026 the doctor confirmed the surgery date.");
    await process();
    const sug = (await db.withFirm(x.owner, (s) => listNodes(s, x.matter.id))).find((n) => n.kind === "event" && n.origin === "huis")!;
    expect(sug.status).toBe("suggested");
    // Worker role: no direct table rights.
    await expect(t.worker.query("UPDATE huis.dna_nodes SET categories = '{court}' WHERE id = $1", [sug.id])).rejects.toThrow(/permission denied/);
    await expect(t.worker.query("SELECT categories FROM huis.dna_nodes LIMIT 1")).rejects.toThrow(/permission denied/);
    // App role: confirming and setting categories in a single statement is still refused.
    await expect(db.withFirm(x.owner, (s) =>
      s.client.query("UPDATE huis.dna_nodes SET status = 'confirmed', categories = '{court}' WHERE id = $1", [sug.id]))).rejects.toThrow(/Confirm/);
    // Read-only staff (and clients) change nothing, even with no WHERE clause.
    await db.withFirm(x.owner, (s) => decideNode(s, sug.id, "confirmed"));
    const ro = await db.withFirm(x.readerCtx, (s) => s.client.query("UPDATE huis.dna_nodes SET categories = '{court}'"));
    const cl = await db.withFirm(x.portalCtx, (s) => s.client.query("UPDATE huis.dna_nodes SET categories = '{court}'"));
    expect([ro.rowCount, cl.rowCount]).toEqual([0, 0]);
    expect((await db.withFirm(x.owner, (s) => listNodes(s, x.matter.id))).find((n) => n.id === sug.id)!.categories).toBeNull();
  });

  it("blocked: clients, people outside a wall and other firms get nothing from the timeline service, suggestions or direct SQL", async () => {
    const x = await setup();
    const walledEvent = await db.withFirm(x.owner, (s) => addNode(s, x.walled.id, { kind: "event", label: "Secret settlement talk", eventDate: "2026-05-01", categories: ["court"] }));
    await upload(x.owner, x.matter.id, "fmla.eml", eml([
      "From: Cindy Manager <cindy@acme.example>", "To: Pat Smith <pat.smith@example.com>", "Subject: Re: FMLA", "Date: Fri, 17 Apr 2026 10:00:00 -0600",
    ], "HR received it."));
    await process();
    const other = await newFirm(db, "Other Owner");
    // Client: service refused; direct SQL sees no Case DNA rows and the email query's dna_readable is false.
    await expect(db.withFirm(x.portalCtx, (s) => getTimeline(s, x.matter.id))).rejects.toThrow(/permission/i);
    await expect(db.withFirm(x.portalCtx, (s) => suggestedCategoriesFor(s, walledEvent))).rejects.toThrow(/permission/i);
    await expect(db.withFirm(x.portalCtx, (s) => timelineCsv(s, x.matter.id, {}, true))).rejects.toThrow(/permission/i);
    const portalRows = await db.withFirm(x.portalCtx, (s) => s.client.query("SELECT huis.dna_readable($1) AS r, (SELECT count(*) FROM huis.dna_nodes)::int AS n", [x.matter.id]));
    expect(portalRows.rows[0]).toEqual({ r: false, n: 0 });
    // Outside the wall / other firm: nothing, including the walled item's suggested categories.
    await expect(db.withFirm(x.paraCtx, (s) => timelineCsv(s, x.walled.id, {}, true))).rejects.toThrow(/not found/i);
    expect(await db.withFirm(x.paraCtx, (s) => suggestedCategoriesFor(s, walledEvent))).toEqual([]);
    expect(await db.withFirm(other.owner, (s) => suggestedCategoriesFor(s, walledEvent))).toEqual([]);
    await expect(db.withFirm(other.owner, (s) => getTimeline(s, x.matter.id))).rejects.toThrow(/not found/i);
    // Read-only staff can read but not download.
    await expect(db.withFirm(x.readerCtx, (s) => timelineCsv(s, x.matter.id, {}, true))).rejects.toThrow(/permission/i);
  });

  it("blocked: formula and control-character tricks in every CSV column are neutralised", async () => {
    const x = await setup();
    const pat = await db.withFirm(x.owner, (s) => addNode(s, x.matter.id, { kind: "person", label: "\t@SUM(1+1)*cmd|' /C calc'!A0", email: "pat.smith@example.com", role: "client" }));
    const ev = await db.withFirm(x.owner, (s) => addNode(s, x.matter.id, { kind: "event", label: "​=1+1", eventDate: "2026-05-06" }));
    await db.withFirm(x.owner, async (s) => {
      const { linkNodes } = await import("../src/services/dna");
      await linkNodes(s, ev, pat, "involves");
    });
    await upload(x.owner, x.matter.id, "x.eml", eml([
      "From: \"-2+3\" <a@other.example>", "To: b@other.example", "Subject: +cmd|' /C calc'!A0", "Date: Fri, 17 Apr 2026 10:00:00 -0600",
    ], "x"));
    await process();
    const out = await db.withFirm(x.owner, (s) => timelineCsv(s, x.matter.id, {}, true));
    const cells = out.body.replace(/^﻿/, "").split(/,(?=")|\r\n/).map((c) => c.replace(/^"|"$/g, ""));
    expect(cells.filter((c) => /^[\s\p{Cc}\p{Cf}]*[=+\-@]/u.test(c))).toEqual([]);
  });
});
