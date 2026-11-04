import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrainWorker } from "../src/brain/worker";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { createClient } from "../src/services/clients";
import { addNode, decideNode, linkNodes, listNodes, setCategories } from "../src/services/dna";
import { assembleOriginal, getUploadSession, markChunkReceived, newEvidenceId, recordEvidence, startUpload, storeChunk } from "../src/services/evidence";
import { addMatterMember, createMatter } from "../src/services/matters";
import { getTimeline, timelineCsv } from "../src/services/timeline";
import { inviteUser } from "../src/services/users";
import { MasterKeyProvider } from "../src/storage/encryption";
import type { MalwareScanner } from "../src/storage/scanner";
import { EvidenceVault, LocalObjectStore } from "../src/storage/store";
import { suggestCategories } from "../src/timeline/categories";
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
  vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-timeline-vault-"));
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

const LETTER = `Termination letter.

Dear Ms. Smith, your employment with Acme Corporation is terminated effective April 18, 2026.

On April 12, 2026 your doctor confirmed the surgery date.`;
// Sent late in the evening in Utah: already the next day in UTC, still April 17 for the firm.
const EMAIL = [
  "From: Cindy Manager <cindy@acme.example>", "To: Pat Smith <pat.smith@example.com>",
  "Subject: Re: FMLA paperwork", "Date: Fri, 17 Apr 2026 22:30:00 -0600", "MIME-Version: 1.0", "Content-Type: text/plain", "",
  "Pat, HR received your FMLA paperwork.", "",
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
    return { para, reader, portal, matter, walled };
  });
  await db.withFirm(f.owner, (s) => addMatterMember(s, { matterId: x.matter.id, userId: x.portal.id, access: "view", acknowledgePrivilegeWaiverRisk: true }));
  const ctx = (id: string): RequestContext => ({ firmId: f.firmId, userId: id });
  return { ...f, ...x, paraCtx: ctx(x.para.id), readerCtx: ctx(x.reader.id), portalCtx: ctx(x.portal.id) };
}

describe("timeline categories (fixed rules)", () => {
  it("suggests categories from an item's own words and its links, the same way every time", () => {
    expect(suggestCategories("Doctor confirmed the surgery date.")).toEqual(["medical"]);
    expect(suggestCategories("Employment terminated after FMLA leave request.")).toEqual(["employment"]);
    expect(suggestCategories("Hearing on the motion to compel in district court.")).toEqual(["court"]);
    expect(suggestCategories("Deposition of Cindy Manager.")).toEqual(["discovery"]);
    expect(suggestCategories("Final paycheck of $2,400 paid by wire.")).toEqual(["financial"]);
    expect(suggestCategories("Lost wages since termination.", { isDamage: true })).toEqual(["financial", "employment", "damages"]);
    expect(suggestCategories("Meeting", { linkedRoles: ["client"], hasWitness: true })).toEqual(["plaintiff", "communications", "witness"]);
    expect(suggestCategories("Lunch", { linkedRoles: ["opposing party"] })).toEqual(["defendant"]);
    // Words match at their start only: "therapy" is medical, "the rapport" isn't; "unpaid" isn't "paid".
    expect(suggestCategories("We had good rapport. Account unpaid.")).toEqual([]);
    expect(suggestCategories("x".repeat(1_000_000) + " surgery")).toEqual([]); // bounded input
  });
});

describe("Master Timeline", () => {
  it("puts Case DNA's dated items and filed email in date order, each with its sources and categories", async () => {
    const x = await setup();
    const letter = await upload(x.owner, x.matter.id, "termination.txt", LETTER);
    const email = await upload(x.owner, x.matter.id, "fmla.eml", EMAIL);
    await process();
    // The same email filed twice appears once.
    await upload(x.owner, x.matter.id, "fmla (copy).eml", EMAIL);
    await process();
    const tl = await db.withFirm(x.paraCtx, (s) => getTimeline(s, x.matter.id));
    expect(tl.entries.filter((e) => e.kind === "email").length).toBe(1);
    const dates = tl.entries.map((e) => e.date);
    expect(dates).toEqual([...dates].sort());
    const surgery = tl.entries.find((e) => e.kind === "event" && /surgery/.test(e.label))!;
    expect(surgery).toMatchObject({ date: "2026-04-12", status: "suggested", origin: "huis", categoriesBy: "huis" });
    expect(surgery.categories).toContain("medical");
    expect(surgery.sources[0]).toMatchObject({ evidenceId: letter.id, sourceTitle: "termination.txt" });
    const fired = tl.entries.find((e) => e.kind === "event" && e.date === "2026-04-18")!;
    expect(fired.categories).toContain("employment");
    // The email is dated in the firm's time zone (America/Denver), not UTC.
    const mail = tl.entries.find((e) => e.kind === "email")!;
    expect(mail).toMatchObject({ date: "2026-04-17", evidenceId: email.id, label: "Re: FMLA paperwork", from: "Cindy Manager <cindy@acme.example>" });
    expect(mail.categories).toEqual(expect.arrayContaining(["communications", "employment"]));
    // The email's own Date: header isn't suggested as a separate event.
    expect(tl.entries.filter((e) => e.kind === "event" && e.sources.some((c) => c.evidenceId === email.id))).toEqual([]);
    expect(tl.categoryCounts.medical).toBeGreaterThanOrEqual(1);

    // Rejected suggestions leave the timeline; confirmed ones stay.
    await db.withFirm(x.paraCtx, (s) => decideNode(s, surgery.nodeId!, "rejected"));
    await db.withFirm(x.paraCtx, (s) => decideNode(s, fired.nodeId!, "confirmed"));
    const after = await db.withFirm(x.paraCtx, (s) => getTimeline(s, x.matter.id));
    expect(after.entries.some((e) => e.key === surgery.key)).toBe(false);
    expect(after.entries.find((e) => e.key === fired.key)!.status).toBe("confirmed");
  });

  it("filters by category, dates, person, words, confirmed only and source", async () => {
    const x = await setup();
    await upload(x.owner, x.matter.id, "termination.txt", LETTER);
    await upload(x.owner, x.matter.id, "fmla.eml", EMAIL);
    await process();
    const { pat, hearing, damages } = await db.withFirm(x.owner, async (s) => {
      const pat = await addNode(s, x.matter.id, { kind: "person", label: "Pat Smith", email: "pat.smith@example.com", role: "client" });
      const hearing = await addNode(s, x.matter.id, { kind: "event", label: "Scheduling conference", eventDate: "2026-09-01", categories: ["court"] });
      const damages = await addNode(s, x.matter.id, { kind: "damage", label: "Back pay since termination", eventDate: "2026-10-01", amount: 48000 });
      await linkNodes(s, hearing, pat, "involves");
      return { pat, hearing, damages };
    });
    const get = (f: Record<string, string>) => db.withFirm(x.paraCtx, (s) => getTimeline(s, x.matter.id, f));

    const court = await get({ category: "court" });
    expect(court.entries.map((e) => e.key)).toEqual([hearing]);
    expect((await get({ category: "damages" })).entries.map((e) => e.key)).toEqual([damages]);
    // The email to the client is on the plaintiff's side; the hearing is linked to the client too,
    // but its attorney-chosen categories are kept exactly.
    expect((await get({ category: "plaintiff" })).entries.map((e) => e.kind)).toEqual(["email"]);
    // The person filter finds items linked to them and the email they're on.
    const patOnly = await get({ person: pat });
    expect(patOnly.entries.map((e) => e.kind).sort()).toEqual(["email", "event"]);
    expect((await get({ from: "2026-04-15", to: "2026-04-30" })).entries.every((e) => e.date >= "2026-04-15" && e.date <= "2026-04-30")).toBe(true);
    expect((await get({ q: "fmla paperwork" })).entries.map((e) => e.kind)).toEqual(["email"]);
    expect((await get({ show: "confirmed", emails: "no" })).entries.map((e) => e.key).sort()).toEqual([hearing, damages].sort());
    expect((await get({ source: "none", emails: "no" })).entries.map((e) => e.key).sort()).toEqual([hearing, damages].sort());
    expect((await get({ source: "evidence" })).entries.every((e) => e.kind === "email" || e.sources.length > 0)).toBe(true);
    // Nonsense filters are ignored rather than failing the page.
    expect((await get({ category: "secret", from: "yesterday", person: "x" })).entries.length).toBe((await get({})).entries.length);
  });

  it("lets attorneys choose an item's categories (after confirming a suggestion), and go back to Huis's", async () => {
    const x = await setup();
    await upload(x.owner, x.matter.id, "termination.txt", LETTER);
    await process();
    const event = (await db.withFirm(x.owner, (s) => listNodes(s, x.matter.id))).find((n) => n.kind === "event" && n.eventDate === "2026-04-12")!;
    await expect(db.withFirm(x.paraCtx, (s) => setCategories(s, event.id, ["court"]))).rejects.toThrow(/Confirm/);
    // Directly in the database, too.
    await expect(db.withFirm(x.owner, (s) => s.client.query("UPDATE huis.dna_nodes SET categories = '{court}' WHERE id = $1", [event.id]))).rejects.toThrow(/Confirm/);
    await db.withFirm(x.paraCtx, (s) => decideNode(s, event.id, "confirmed"));
    await db.withFirm(x.paraCtx, (s) => setCategories(s, event.id, ["plaintiff", "medical", "medical"]));
    let e = (await db.withFirm(x.paraCtx, (s) => getTimeline(s, x.matter.id))).entries.find((y) => y.nodeId === event.id)!;
    expect(e).toMatchObject({ categories: ["plaintiff", "medical"], categoriesBy: "attorney" });
    await db.withFirm(x.paraCtx, (s) => setCategories(s, event.id, []));
    e = (await db.withFirm(x.paraCtx, (s) => getTimeline(s, x.matter.id))).entries.find((y) => y.nodeId === event.id)!;
    expect(e).toMatchObject({ categories: [], categoriesBy: "attorney" });
    await db.withFirm(x.paraCtx, (s) => setCategories(s, event.id, null));
    e = (await db.withFirm(x.paraCtx, (s) => getTimeline(s, x.matter.id))).entries.find((y) => y.nodeId === event.id)!;
    expect(e).toMatchObject({ categoriesBy: "huis" });
    expect(e.categories).toContain("medical");

    await expect(db.withFirm(x.paraCtx, (s) => setCategories(s, event.id, ["secret"]))).rejects.toThrow();
    await expect(db.withFirm(x.owner, (s) => s.client.query("UPDATE huis.dna_nodes SET categories = '{secret}' WHERE id = $1", [event.id]))).rejects.toThrow(/check/);
    await expect(db.withFirm(x.owner, (s) => s.client.query("UPDATE huis.dna_nodes SET categories = ARRAY[NULL]::text[] WHERE id = $1", [event.id]))).rejects.toThrow(/check/);
    // Huis's own suggestions never carry categories.
    await expect(t.admin.query(
      `INSERT INTO huis.dna_nodes (firm_id, matter_id, kind, label, event_date, status, origin, origin_key, categories)
       VALUES ($1, $2, 'event', 'planted', '2026-01-01', 'suggested', 'huis', 'event:planted', '{court}')`, [x.firmId, x.matter.id])).rejects.toThrow(/categories/);
    // Read-only staff can read the timeline but not change it.
    await expect(db.withFirm(x.readerCtx, (s) => setCategories(s, event.id, ["court"]))).rejects.toThrow(/permission/i);
    expect((await db.withFirm(x.readerCtx, (s) => getTimeline(s, x.matter.id))).entries.length).toBeGreaterThan(0);
    // The audit log records the kind of change, never the categories or wording.
    const audit = await t.admin.query("SELECT metadata::text AS m FROM huis.audit_events WHERE firm_id = $1 AND action = 'dna.categories_changed'", [x.firmId]);
    expect(audit.rows.length).toBe(3);
    expect(audit.rows.every((r) => !/medical|plaintiff|surgery/.test(r.m))).toBe(true);
  });

  it("is firm staff only, respects ethical walls and other firms, and drops evidence that stops being clean", async () => {
    const x = await setup();
    const letter = await upload(x.owner, x.matter.id, "termination.txt", LETTER);
    const email = await upload(x.owner, x.matter.id, "fmla.eml", EMAIL);
    await upload(x.owner, x.walled.id, "walled.txt", "Settlement offer made on May 1, 2026 by the defendant.");
    await process();
    // Clients (even with access to the Matter and its documents) never see it.
    await expect(db.withFirm(x.portalCtx, (s) => getTimeline(s, x.matter.id))).rejects.toThrow(/permission/i);
    // Outside a wall it's as if the Matter didn't exist; inside, it works.
    await expect(db.withFirm(x.paraCtx, (s) => getTimeline(s, x.walled.id))).rejects.toThrow(/not found/i);
    expect((await db.withFirm(x.owner, (s) => getTimeline(s, x.walled.id))).entries.length).toBe(1);
    // Another firm can't read it either.
    const other = await newFirm(db, "Other Owner");
    await expect(db.withFirm(other.owner, (s) => getTimeline(s, x.matter.id))).rejects.toThrow(/not found/i);

    // Evidence later found infected: its events and the email leave the timeline at once.
    const before = await db.withFirm(x.paraCtx, (s) => getTimeline(s, x.matter.id));
    expect(before.entries.some((e) => e.evidenceId === email.id)).toBe(true);
    await infect(letter.id);
    await infect(email.id);
    const after = await db.withFirm(x.paraCtx, (s) => getTimeline(s, x.matter.id));
    expect(after.entries.some((e) => e.evidenceId === email.id || e.sources.some((c) => c.evidenceId === letter.id))).toBe(false);
  });

  it("downloads as a formula-safe chronology for staff who confirm it, recorded without content", async () => {
    const x = await setup();
    await upload(x.owner, x.matter.id, "fmla.eml", EMAIL);
    await process();
    await db.withFirm(x.owner, (s) => addNode(s, x.matter.id, { kind: "event", label: '=HYPERLINK("http://evil.example","click")', eventDate: "2026-05-06" }));
    await expect(db.withFirm(x.paraCtx, (s) => timelineCsv(s, x.matter.id, {}, false))).rejects.toThrow(/confirm/i);
    await expect(db.withFirm(x.readerCtx, (s) => timelineCsv(s, x.matter.id, {}, true))).rejects.toThrow(/permission/i);
    await expect(db.withFirm(x.portalCtx, (s) => timelineCsv(s, x.matter.id, {}, true))).rejects.toThrow(/permission/i);
    const out = await db.withFirm(x.paraCtx, (s) => timelineCsv(s, x.matter.id, { emails: "no" }, true));
    expect(out.filename).toMatch(/^[A-Za-z0-9_-]+-timeline\.csv$/);
    const lines = out.body.split("\r\n");
    expect(lines[0]).toBe('﻿"Privileged & Confidential — Attorney Work Product"');
    expect(out.body).toContain(`"'=HYPERLINK(""http://evil.example"",""click"")"`);
    expect(out.body).not.toContain("FMLA paperwork");
    const audit = await t.admin.query("SELECT metadata::text AS m FROM huis.audit_events WHERE firm_id = $1 AND action = 'timeline.downloaded'", [x.firmId]);
    expect(audit.rows.map((r) => JSON.parse(r.m))).toEqual([{ rows: "1" }]);
  });
});
