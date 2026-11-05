import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrainWorker } from "../src/brain/worker";
import { CourtAlertWorker, type AlertMessage, type AlertSender } from "../src/court/alerts";
import { findCourtDates } from "../src/court/nef";
import { parseUtahNotice } from "../src/court/utah";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { setAlertPreferences } from "../src/services/alerts";
import { createClient } from "../src/services/clients";
import { addCourtEvent, addNoticeSender, courtNotices } from "../src/services/court";
import { assembleOriginal, getUploadSession, markChunkReceived, newEvidenceId, recordEvidence, startUpload, storeChunk } from "../src/services/evidence";
import { createMatter, removeMatterMember } from "../src/services/matters";
import { inviteUser } from "../src/services/users";
import { MasterKeyProvider } from "../src/storage/encryption";
import type { MalwareScanner } from "../src/storage/scanner";
import { EvidenceVault, LocalObjectStore } from "../src/storage/store";
import { EvidenceProcessor } from "../src/worker/processor";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

/**
 * Independent security review 18 — Phase 8 parts 2–3 (Utah court notices,
 * court date reminders, court connections). Each test here fails on the code
 * as reviewed and passes once its finding is fixed.
 */

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
  vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-r18-vault-"));
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

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const plus = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const eml = (from: string, body: string[], subject = "Notice - Case 260900123") => [
  `From: ${from}`, "To: Jane Smith <jane@firm.example>", `Subject: ${subject}`,
  "Date: Mon, 02 Nov 2026 10:00:00 -0700", "MIME-Version: 1.0", "Content-Type: text/plain", "", ...body, "",
].join("\r\n");

class FakeSender implements AlertSender {
  sent: AlertMessage[] = [];
  constructor(readonly channel: "email" | "sms" | "push", readonly name = "fake") {}
  async send(m: AlertMessage) { this.sent.push(m); }
}

async function setup() {
  const f = await newFirm(db);
  const x = await db.withFirm(f.owner, async (s) => {
    const client = await createClient(s, { kind: "person", displayName: "Pat Smith", email: "pat.smith@example.com" });
    const atty = await inviteUser(s, { email: `a@${f.slug}.example`, fullName: "Alex Attorney", role: "attorney", locationId: f.locationId });
    const para = await inviteUser(s, { email: `p@${f.slug}.example`, fullName: "Pat Para", role: "paralegal", locationId: f.locationId });
    const matter = await createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
    return { client, atty, para, matter };
  });
  const ctx = (id: string): RequestContext => ({ firmId: f.firmId, userId: id });
  return { ...f, ...x, attyCtx: ctx(x.atty.id), paraCtx: ctx(x.para.id) };
}

describe("security review 18 — reminders", () => {
  it("R18-1: a lead attorney taken off a walled Matter is not emailed its court dates (walls: members only)", async () => {
    const x = await setup();
    // A walled Matter: the owner creates it with Alex as lead attorney (Alex becomes an owner-member).
    const walled = await db.withFirm(x.owner, (s) => createMatter(s, {
      title: "Project Nightjar (walled)", clientId: x.client.id, leadAttorneyId: x.atty.id, jurisdictionState: "UT", restricted: true,
    }));
    await db.withFirm(x.attyCtx, (s) => setAlertPreferences(s, { channels: ["email"], reminderDays: [7], includeDetails: true }));
    await db.withFirm(x.owner, (s) => addCourtEvent(s, walled.id, { kind: "hearing", title: "Sealed injunction hearing", date: plus(7) }));
    // Alex is walled off (removed from the Matter) but stays its lead attorney.
    await db.withFirm(x.owner, (s) => removeMatterMember(s, walled.id, x.atty.id));
    const seen = await db.withFirm(x.attyCtx, (s) => s.client.query("SELECT 1 FROM huis.matters WHERE id = $1", [walled.id]));
    expect(seen.rowCount).toBe(0); // Alex can no longer see the Matter at all.

    const email = new FakeSender("email");
    const w = new CourtAlertWorker(t.worker, { email }, "https://huis.example/alerts");
    await w.queueDue(true);
    while (await w.deliverOnce()) { /* drain */ }
    const toAlex = email.sent.filter((m) => m.to === `a@${x.slug}.example`);
    // Fails today: Alex is emailed "Court date in 7 days: Hearing: Sealed injunction hearing (Project Nightjar (walled))".
    expect(toAlex).toEqual([]);
  });

  it("R18-2: turning a channel off stops reminders already waiting on it (the person's choice is checked again at sending)", async () => {
    const x = await setup();
    await db.withFirm(x.owner, (s) => addCourtEvent(s, x.matter.id, { kind: "hearing", title: "Hearing", date: plus(3) }));
    await db.withFirm(x.owner, (s) => setAlertPreferences(s, { channels: ["in_app", "email"], reminderDays: [3] }));
    // No sending service yet: the email waits.
    const none = new CourtAlertWorker(t.worker, {}, "https://huis.example/alerts");
    await none.queueDue(true);
    while (await none.deliverOnce()) { /* drain */ }
    // The owner then turns email reminders off (e.g. the mailbox is shared).
    await db.withFirm(x.owner, (s) => setAlertPreferences(s, { channels: ["in_app"], reminderDays: [3] }));
    // Later a sending service is set up.
    const email = new FakeSender("email");
    const w = new CourtAlertWorker(t.worker, { email }, "https://huis.example/alerts");
    await w.queueDue(true);
    while (await w.deliverOnce()) { /* drain */ }
    // Fails today: the waiting email is sent anyway.
    expect(email.sent.filter((m) => m.to.startsWith("owner"))).toEqual([]);
  });

  it("R18-3: one firm's administrator can't stop every firm's reminders by setting an invalid time zone", async () => {
    const a = await setup();
    await db.withFirm(a.owner, (s) => addCourtEvent(s, a.matter.id, { kind: "hearing", title: "Firm A hearing", date: plus(7) }));
    const b = await newFirm(db, "Other Owner");
    // Firm B's own administrator, through the app's connection.
    const bm = await db.withFirm(b.owner, async (s) => {
      const c = await createClient(s, { kind: "person", displayName: "B client" });
      return createMatter(s, { title: "B matter", clientId: c.id, leadAttorneyId: b.ownerUserId, jurisdictionState: "UT" });
    });
    await db.withFirm(b.owner, (s) => addCourtEvent(s, bm.id, { kind: "hearing", title: "Firm B hearing", date: plus(14) }));
    // An unknown time zone is refused outright…
    await expect(db.withFirm(b.owner, (s) => s.client.query("UPDATE huis.firms SET time_zone = 'Mars/Olympus_Mons'"))).rejects.toThrow();
    // …and even one forced in past every check can't stop another firm's reminders (each firm is queued separately).
    await t.admin.query(`SET session_replication_role = replica; UPDATE huis.firms SET time_zone = 'Mars/Olympus_Mons' WHERE id = '${b.firmId}'; SET session_replication_role = origin;`);
    const w = new CourtAlertWorker(t.worker, {}, "https://huis.example/alerts");
    // Fails today: worker_queue_court_alerts raises 'time zone "Mars/Olympus_Mons" not recognized' for every firm.
    await w.queueDue(true).catch(() => undefined);
    const n = await t.admin.query("SELECT count(*)::int AS n FROM huis.court_alerts WHERE firm_id = $1", [a.firmId]);
    expect(n.rows[0].n).toBeGreaterThan(0);
    await t.admin.query("UPDATE huis.firms SET time_zone = 'America/Denver' WHERE id = $1", [b.firmId]);
  });

  it("R18-4: a reminder sent late says when the court date really is, and nothing is sent for a date that has passed", async () => {
    const x = await setup();
    await db.withFirm(x.owner, (s) => setAlertPreferences(s, { channels: ["email"], reminderDays: [] }));
    const tomorrow = await db.withFirm(x.owner, (s) => addCourtEvent(s, x.matter.id, { kind: "hearing", title: "Tomorrow", date: plus(1) }));
    const past = await db.withFirm(x.owner, (s) => addCourtEvent(s, x.matter.id, { kind: "hearing", title: "Yesterday", date: plus(-1) }));
    // State after six days with no sending service (the 7-day reminder waited), and after the worker was down
    // over yesterday's date (its 1-day reminder was still queued).
    await t.admin.query(
      `INSERT INTO huis.court_alerts (firm_id, user_id, matter_id, court_event_id, channel, days_before, event_date, status, created_at)
       VALUES ($1, $2, $3, $4, 'email', 7, $5, 'waiting_for_provider', now() - interval '6 days'),
              ($1, $2, $3, $6, 'email', 1, $7, 'queued', now() - interval '2 days')`,
      [x.firmId, x.ownerUserId, x.matter.id, tomorrow, plus(1), past, plus(-1)]);
    const email = new FakeSender("email");
    const w = new CourtAlertWorker(t.worker, { email }, "https://huis.example/alerts");
    await w.queueDue(true);
    while (await w.deliverOnce()) { /* drain */ }
    // Fails today: "you have a court date in 7 days" for tomorrow's date, and "tomorrow" for yesterday's.
    const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const show = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${M[m! - 1]} ${d}, ${y}`; };
    // Nothing for yesterday's date, and tomorrow's date is called tomorrow.
    const wrong = email.sent.filter((m) => m.text.includes(`(${show(plus(-1))})`)
      || (m.text.includes(`(${show(plus(1))})`) && m.subject !== "Court date tomorrow")).map((m) => m.text);
    expect(wrong).toEqual([]);
  });
});

describe("security review 18 — Utah notices and court connections", () => {
  it("R18-5: a Utah date the same sentence vacates before the date is not proposed (review 17 F4, as the federal reader does)", () => {
    const head = "Third District Court\nCase No. 260900123\n";
    const n = parseUtahNotice(`${head}HEARING VACATED, the Pretrial Conference scheduled for December 1, 2026 at 9:00 AM.`)!;
    // The federal reader skips the same wording.
    expect(findCourtDates("HEARING VACATED, the Motion Hearing set for 12/1/2026 at 9:00 AM.")).toEqual([]);
    // Fails today: proposed as "Pretrial Conference".
    expect(n.events).toEqual([]);
  });

  it("R18-6: registered-sender lookups stay inside the firm (no probing another firm's e-filing provider)", async () => {
    const a = await setup();
    const b = await newFirm(db, "Other Owner");
    await db.withFirm(b.owner, (s) => addNoticeSender(s, { address: "notices@b-efsp.example", label: "B's provider" }));
    // Firm A, through the app's own connection, asks about firm B's registered senders.
    const r = await db.withFirm(a.owner, (s) => s.client.query<{ ok: boolean }>(
      "SELECT huis.is_notice_sender($1, 'utah', 'notices@b-efsp.example') AS ok", [b.firmId]).then((q) => q.rows[0]!.ok).catch(() => false));
    // Fails today: true.
    expect(r).toBe(false);
  });

  it("R18-7: re-reading email is limited to registered notice senders (an administrator can't re-run the AI on any sender's mail)", async () => {
    const x = await setup();
    await upload(x.owner, x.matter.id, "client.eml", eml("Pat Smith <pat.smith@example.com>", ["Privileged: my account of what happened."]));
    await processor.drain();
    while (await brain.indexOnce()) { /* index */ }
    const before = await t.admin.query("SELECT status FROM huis.brain_sources WHERE firm_id = $1", [x.firmId]);
    expect(before.rows.every((r) => r.status === "indexed")).toBe(true);
    // No sender is registered; the administrator calls the function directly with the client's address.
    const n = await db.withFirm(x.owner, (s) => s.client.query<{ n: number }>("SELECT huis.requeue_notices_from('pat.smith@example.com') AS n"))
      .then((q) => q.rows[0]!.n).catch(() => 0);
    // Fails today: the client's email is queued to be read (and embedded by the AI provider) again.
    expect(n).toBe(0);
  });

  it("R18-8: two different Utah notices for the same case with the same provider header are both on the docket", async () => {
    const x = await setup();
    const boiler = "This notification was sent by your electronic filing service provider on behalf of the court. Please do not reply to this "
      + "message. Documents filed are available in your provider account. For questions about this filing contact the clerk of the court at the "
      + "number on the court's website. Case No. 260900123. SMITH vs. ACME CORPORATION.";
    const notice = (what: string) => eml("Utah Courts <noreply@utcourts.gov>", ["Third District Court, Salt Lake County, State of Utah", boiler, "", what]);
    await upload(x.owner, x.matter.id, "n1.eml", notice(`A Motion Hearing is scheduled for ${plus(10)}.`));
    await upload(x.owner, x.matter.id, "n2.eml", notice("ORDER GRANTING MOTION TO COMPEL. The motion is granted."));
    await processor.drain();
    while (await brain.indexOnce()) { /* index */ }
    const docket = await db.withFirm(x.owner, (s) => courtNotices(s, x.matter.id));
    // Fails today: the second filing is folded into the first (same first 300 characters after the court's name).
    expect(docket).toHaveLength(2);
  });
});

describe("security review 18 — hostile text (review 17 F1 class)", () => {
  it("R18-9a: the Utah case-number pattern is bounded (any filed document, read by the worker)", () => {
    const started = Date.now();
    parseUtahNotice(`Third District Court\nCase${" ".repeat(3000)}x`);
    // Fails today: ~3-4 s for 3,000 spaces (cubic: 8,000 spaces take over a minute; 100,000 never finish).
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("R18-9b: the Utah case-name pattern is bounded on 100k characters", () => {
    const started = Date.now();
    parseUtahNotice(`Third District Court Case No. 260900123 ${"A.".repeat(49_000)}`);
    // Fails today: quadratic, several seconds.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("R18-9c: a hostile email from a Utah courts address doesn't stall the worker or every view of the court page", async () => {
    const x = await setup();
    const hostile = eml("Utah Courts <noreply@utcourts.gov>", ["Third District Court", `Case${" ".repeat(3000)}x`], "Notice of hearing");
    await upload(x.owner, x.matter.id, "hostile.eml", hostile);
    // Any document at all reaches the Utah reader in the worker (it reads first; the sender is checked in the database).
    await upload(x.owner, x.matter.id, "notes.txt", `Case${" ".repeat(3000)}x`);
    await processor.drain();
    const content = await t.admin.query("SELECT max(length(content))::int AS n FROM huis.evidence_text t JOIN huis.evidence_items i ON i.id = t.evidence_id WHERE i.matter_id = $1", [x.matter.id]);
    expect(content.rows[0].n).toBeGreaterThan(3000);

    let started = Date.now();
    await db.withFirm(x.owner, (s) => courtNotices(s, x.matter.id));
    const view = Date.now() - started;
    started = Date.now();
    while (await brain.indexOnce()) { /* index */ }
    const worker = Date.now() - started;
    // Fails today: each page view takes seconds (the Node process is blocked), and so does indexing each document.
    expect(view).toBeLessThan(1000);
    expect(worker).toBeLessThan(2000);
  }, 300_000);
});
