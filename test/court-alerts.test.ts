import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrainWorker } from "../src/brain/worker";
import { alertMessage, CourtAlertWorker, type AlertMessage, type AlertSender } from "../src/court/alerts";
import { DATA_VENDORS, NOTICE_READERS, readCourtNotice } from "../src/court/connectors";
import { isUtahCourtSender, parseUtahNotice } from "../src/court/utah";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { getAlertPreferences, listMyAlerts, markAlertsRead, setAlertPreferences, unreadAlertCount } from "../src/services/alerts";
import { createClient } from "../src/services/clients";
import {
  addCourtEvent, addNoticeSender, courtNotices, decideCourtEvent, listCourtEvents, listNoticeSenders, removeNoticeSender, setCourtEventDone,
} from "../src/services/court";
import { assembleOriginal, getUploadSession, markChunkReceived, newEvidenceId, recordEvidence, startUpload, storeChunk } from "../src/services/evidence";
import { addMatterMember, createMatter, removeMatterMember } from "../src/services/matters";
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
  vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-alerts-vault-"));
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

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const plus = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const long = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${MONTHS[m! - 1]} ${d}, ${y}`; };
const us = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${m}/${d}/${y}`; };

const utahNotice = (from: string, hearing: string, pretrial: string) => [
  `From: ${from}`, "To: Jane Smith <jane@firm.example>", "Subject: Notice of Hearing - Case 260900123",
  "Date: Mon, 02 Nov 2026 10:00:00 -0700", "MIME-Version: 1.0", "Content-Type: text/plain", "",
  "THIRD DISTRICT COURT - SALT LAKE", "", "Third District Court, Salt Lake County, State of Utah", "",
  "SMITH vs. ACME CORPORATION", "Case No. 260900123", "", "NOTICE OF HEARING", "",
  `A Pretrial Conference is scheduled for ${long(pretrial)} at 9:00 AM in Courtroom W43.`,
  "", "Hearing Type: Motion Hearing", "Judge: Hon. Example", `Date: ${us(hearing)}`, "Time: 2:30 PM", "",
  "Please contact the court if you need an interpreter.", "",
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
    const para = await inviteUser(s, { email: `p@${f.slug}.example`, fullName: "Pat Para", role: "paralegal", locationId: f.locationId });
    const reader = await inviteUser(s, { email: `r@${f.slug}.example`, fullName: "Rae Reader", role: "read_only", locationId: f.locationId });
    const portal = await inviteUser(s, { email: `c@${f.slug}.example`, fullName: "Casey Client", role: "client", locationId: f.locationId });
    const matter = await createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
    const walled = await createMatter(s, { title: "Walled", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT", restricted: true });
    return { para, reader, portal, matter, walled };
  });
  await db.withFirm(f.owner, async (s) => {
    await addMatterMember(s, { matterId: x.matter.id, userId: x.para.id, access: "edit" });
    await addMatterMember(s, { matterId: x.matter.id, userId: x.portal.id, access: "view", acknowledgePrivilegeWaiverRisk: true });
  });
  const ctx = (id: string): RequestContext => ({ firmId: f.firmId, userId: id });
  return { ...f, ...x, paraCtx: ctx(x.para.id), readerCtx: ctx(x.reader.id), portalCtx: ctx(x.portal.id) };
}

describe("Utah court notices (8.2)", () => {
  it("reads a Utah notice conservatively: a Utah court and a case number required, dates set or scheduled, cancelled ones skipped", () => {
    const text = utahNotice("noreply@utcourts.gov", "2026-12-08", "2026-12-01");
    const n = parseUtahNotice(text)!;
    expect(n).toMatchObject({ court: "Third District Court", caseNumber: "260900123" });
    expect(n.events.map((e) => [e.kind, e.title, e.date, e.time, e.location])).toEqual([
      ["conference", "Pretrial Conference", "2026-12-01", "09:00", "Courtroom W43"],
      ["hearing", "Motion Hearing", "2026-12-08", "14:30", null],
    ]);
    expect(text.slice(n.events[0]!.start, n.events[0]!.end)).toBe("A Pretrial Conference is scheduled for December 1, 2026 at 9:00 AM in Courtroom W43".replace(/^A /, "A "));
    expect(parseUtahNotice("Lunch is scheduled for December 1, 2026.")).toBeNull();
    expect(parseUtahNotice("Third District Court. The Pretrial Conference is scheduled for December 1, 2026.")).toBeNull();
    const vacated = parseUtahNotice("Third District Court\nCase No. 260900123\nThe Pretrial Conference scheduled for December 1, 2026 is VACATED. A Status Conference is scheduled for December 3, 2026.")!;
    expect(vacated.events.map((e) => e.title)).toEqual(["Status Conference"]);
    expect(isUtahCourtSender("Court <noreply@utcourts.gov>")).toBe(true);
    expect(isUtahCourtSender("x@utcourts.gov.evil.example")).toBe(false);
    // The Utah reader is labelled unverified until checked against real notices; vendors need agreements.
    expect(NOTICE_READERS.map((r) => [r.id, r.verified])).toEqual([["federal", true], ["utah", false]]);
    expect(DATA_VENDORS.every((v) => v.status === "needs_agreement")).toBe(true);
    // Sender rules per reader.
    expect(readCourtNotice(text, "mallory@evil.example")).toBeNull();
    expect(readCourtNotice(text, "notify@efsp.example", ["notify@efsp.example"])!.connector).toBe("utah");
    const started = Date.now();
    parseUtahNotice(`Third District Court Case No. 260900123 ${"Hearing Type: x\n".repeat(5000)}${"A Hearing is scheduled for ".repeat(5000)}${" ".repeat(50_000)}`);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("proposes dates from Utah court email and from the firm's registered e-filing provider only; administrators register senders", async () => {
    const x = await setup();
    const court = await upload(x.owner, x.matter.id, "utah-notice.eml", utahNotice("Utah Courts <noreply@utcourts.gov>", plus(14), plus(7)));
    await upload(x.owner, x.matter.id, "efsp-notice.eml", utahNotice("eFiling <notify@efsp.example>", plus(21), plus(20)));
    await upload(x.owner, x.matter.id, "fake.eml", utahNotice("Opposing <mallory@evil.example>", plus(2), plus(3)));
    await process();
    let events = await db.withFirm(x.paraCtx, (s) => listCourtEvents(s, x.matter.id));
    expect(events.map((e) => [e.title, e.date, e.reader, e.readerVerified, e.status])).toEqual([
      ["Pretrial Conference", plus(7), "utah", false, "suggested"],
      ["Motion Hearing", plus(14), "utah", false, "suggested"],
    ]);
    expect(events[0]!.sourceEvidenceId).toBe(court.id);
    expect((await db.withFirm(x.paraCtx, (s) => courtNotices(s, x.matter.id))).map((n) => [n.reader, n.readerVerified, n.caseNumber])).toEqual([["utah", false, "260900123"]]);

    // Only administrators register senders; personal email services are refused.
    await expect(db.withFirm(x.paraCtx, (s) => addNoticeSender(s, { address: "notify@efsp.example", label: "Our EFSP" }))).rejects.toThrow(/permission/i);
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query(
      "INSERT INTO huis.court_notice_senders (firm_id, address, label, added_by) VALUES ($1, 'x@efsp.example', 'x', $2)", [x.firmId, x.para.id]))).rejects.toThrow();
    await expect(db.withFirm(x.owner, (s) => addNoticeSender(s, { address: "someone@gmail.com", label: "No" }))).rejects.toThrow(/personal email/);
    const id = await db.withFirm(x.owner, (s) => addNoticeSender(s, { address: "Notify@EFSP.example", label: "Our EFSP" }));
    expect((await db.withFirm(x.paraCtx, (s) => listNoticeSenders(s))).map((v) => v.address)).toEqual(["notify@efsp.example"]);
    // The firm's email from it is read again: its dates are proposed now.
    await process();
    events = await db.withFirm(x.paraCtx, (s) => listCourtEvents(s, x.matter.id));
    expect(events.map((e) => e.title).sort()).toEqual(["Motion Hearing", "Motion Hearing", "Pretrial Conference", "Pretrial Conference"]);
    expect(events.every((e) => e.date !== plus(2) && e.date !== plus(3))).toBe(true);
    // Clients and other firms don't see the list; removing it stops new proposals (existing ones stay for a decision).
    await expect(db.withFirm(x.portalCtx, (s) => listNoticeSenders(s))).rejects.toThrow(/permission/i);
    const g = await newFirm(db, "Other Owner");
    expect((await db.withFirm(g.owner, (s) => s.client.query("SELECT * FROM huis.court_notice_senders"))).rowCount).toBe(0);
    await db.withFirm(x.owner, (s) => removeNoticeSender(s, id));
    const audit = await t.admin.query("SELECT metadata::text AS m FROM huis.audit_events WHERE firm_id = $1 AND action LIKE 'court.notice_sender%'", [x.firmId]);
    expect(audit.rowCount).toBe(2);
    for (const r of audit.rows) expect(r.m).not.toContain("notify@");
  });
});

describe("court date reminders (8.3)", () => {
  it("reminds the Matter's staff (members and lead attorney) in Huis on the 30/14/7/3/1/0 schedule — never clients or other staff", async () => {
    const x = await setup();
    const week = await db.withFirm(x.owner, (s) => addCourtEvent(s, x.matter.id, { kind: "hearing", title: "Motion hearing", date: plus(7), time: "10:00" }));
    await db.withFirm(x.owner, (s) => addCourtEvent(s, x.matter.id, { kind: "deadline", title: "Not a reminder day", date: plus(5) }));
    await db.withFirm(x.owner, (s) => addCourtEvent(s, x.matter.id, { kind: "deadline", title: "Due today", date: plus(0) }));
    const w = new CourtAlertWorker(t.worker, {}, "https://huis.example/alerts");
    expect(await w.queueDue(true)).toBe(4); // owner (lead) and paralegal (member), two dates each
    expect(await w.queueDue(true)).toBe(0); // only ever once

    const mine = await db.withFirm(x.paraCtx, (s) => listMyAlerts(s));
    expect(mine.map((a) => [a.title, a.daysBefore, a.channel, a.status]).sort()).toEqual([
      ["Due today", 0, "in_app", "delivered"], ["Motion hearing", 7, "in_app", "delivered"],
    ]);
    expect(await db.withFirm(x.paraCtx, (s) => unreadAlertCount(s))).toBe(2);
    expect(await db.withFirm(x.paraCtx, (s) => markAlertsRead(s, mine[0]!.id))).toBe(1);
    expect(await db.withFirm(x.paraCtx, (s) => unreadAlertCount(s))).toBe(1);
    // Read-only staff who aren't on the Matter, and clients who are, get nothing.
    expect(await db.withFirm(x.readerCtx, (s) => listMyAlerts(s))).toEqual([]);
    await expect(db.withFirm(x.portalCtx, (s) => listMyAlerts(s))).rejects.toThrow(/permission/i);
    expect((await t.admin.query("SELECT count(*)::int AS n FROM huis.court_alerts WHERE user_id = ANY($1)", [[x.reader.id, x.portal.id]])).rows[0].n).toBe(0);

    // Reminders can only be marked read (once, stamped by the database), and only your own.
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query("UPDATE huis.court_alerts SET status = 'sent'"))).rejects.toThrow(/cannot be changed/);
    expect((await db.withFirm(x.paraCtx, (s) => s.client.query("UPDATE huis.court_alerts SET read_at = now() WHERE user_id <> $1", [x.para.id]))).rowCount).toBe(0);
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query("DELETE FROM huis.court_alerts"))).rejects.toThrow();

    // Done or moved dates: done ones stop; a moved date gets its own reminders on its own schedule.
    await db.withFirm(x.owner, (s) => setCourtEventDone(s, week, true));
    expect((await db.withFirm(x.paraCtx, (s) => listMyAlerts(s))).length).toBe(2);
  });

  it("emails, texts and push wait visibly for a sending service; once one is set up they're sent — bare unless the person asked for details", async () => {
    const x = await setup();
    await db.withFirm(x.owner, (s) => addCourtEvent(s, x.matter.id, { kind: "hearing", title: "Secret-word hearing", date: plus(3), time: "09:30" }));
    await expect(db.withFirm(x.paraCtx, (s) => setAlertPreferences(s, { channels: ["in_app", "sms"], reminderDays: [3] }))).rejects.toThrow(/mobile number/);
    await db.withFirm(x.paraCtx, (s) => setAlertPreferences(s, { channels: ["in_app", "email", "sms"], reminderDays: [3, 1], smsNumber: "+1 (801) 555-0100" }));
    await db.withFirm(x.owner, (s) => setAlertPreferences(s, { channels: ["email"], reminderDays: [30, 3], includeDetails: true }));
    expect(await db.withFirm(x.paraCtx, (s) => getAlertPreferences(s))).toMatchObject({ channels: ["in_app", "email", "sms"], reminderDays: [3, 1], smsNumber: "+18015550100" });

    // No sending service yet: kept and visible as waiting.
    const none = new CourtAlertWorker(t.worker, {}, "https://huis.example/alerts");
    await none.queueDue(true);
    while (await none.deliverOnce()) { /* drain */ }
    const waiting = await db.withFirm(x.paraCtx, (s) => listMyAlerts(s));
    expect(waiting.map((a) => [a.channel, a.status]).sort()).toEqual([["email", "waiting_for_provider"], ["in_app", "delivered"], ["sms", "waiting_for_provider"]]);

    // A sending service is set up: what waited is sent.
    const email = new FakeSender("email");
    const sms = new FakeSender("sms");
    const w = new CourtAlertWorker(t.worker, { email, sms }, "https://huis.example/alerts");
    await w.queueDue(true);
    while (await w.deliverOnce()) { /* drain */ }
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]!.to).toBe("+18015550100");
    // Bare by default: no title, Matter or wording leaves Huis.
    expect(sms.sent[0]!.text).toMatch(/^Huis Law: you have a court date in 3 days \(/);
    expect(JSON.stringify(sms.sent)).not.toMatch(/Secret-word|Smith/);
    // The owner asked for details.
    const ownerMail = email.sent.find((m) => m.to !== `p@${x.slug}.example`)!;
    expect(ownerMail.subject).toBe("Court date in 3 days: Hearing: Secret-word hearing");
    expect(ownerMail.text).toContain("(Smith v. Acme)");
    expect((await db.withFirm(x.paraCtx, (s) => listMyAlerts(s))).every((a) => ["delivered", "sent"].includes(a.status))).toBe(true);
    // Preferences are logged without the phone number.
    const audit = await t.admin.query("SELECT metadata::text AS m FROM huis.audit_events WHERE firm_id = $1 AND action = 'alerts.preferences_changed'", [x.firmId]);
    for (const r of audit.rows) expect(r.m).not.toContain("555");
  });

  it("a reminder is checked again when sent: removal from a wall, a done date, or a moved date stops it; message wording can't break lines", async () => {
    const x = await setup();
    await db.withFirm(x.owner, (s) => addMatterMember(s, { matterId: x.walled.id, userId: x.para.id, access: "edit" }));
    await db.withFirm(x.owner, (s) => addCourtEvent(s, x.walled.id, { kind: "hearing", title: "Walled hearing", date: plus(1) }));
    await db.withFirm(x.paraCtx, (s) => setAlertPreferences(s, { channels: ["in_app", "email"], reminderDays: [7, 1] }));
    const email = new FakeSender("email");
    const w = new CourtAlertWorker(t.worker, { email }, "https://huis.example/alerts");
    await w.queueDue(true);
    expect((await db.withFirm(x.paraCtx, (s) => listMyAlerts(s))).map((a) => a.title)).toEqual(["Walled hearing", "Walled hearing"]);
    // Removed from the wall before the email goes out.
    await db.withFirm(x.owner, (s) => removeMatterMember(s, x.walled.id, x.para.id));
    while (await w.deliverOnce()) { /* drain */ }
    expect(email.sent.filter((m) => m.to === `p@${x.slug}.example`)).toEqual([]);
    expect(await db.withFirm(x.paraCtx, (s) => listMyAlerts(s))).toEqual([]);

    // Proposals never remind; a rejected one never does either.
    await upload(x.owner, x.matter.id, "utah.eml", utahNotice("noreply@utcourts.gov", plus(14), plus(7)));
    await process();
    await w.queueDue(true);
    expect((await db.withFirm(x.paraCtx, (s) => listMyAlerts(s))).map((a) => a.title)).toEqual([]);
    const [p] = await db.withFirm(x.owner, (s) => listCourtEvents(s, x.matter.id));
    await db.withFirm(x.owner, (s) => decideCourtEvent(s, p!.id, "confirmed"));
    await w.queueDue(true);
    expect((await db.withFirm(x.paraCtx, (s) => listMyAlerts(s))).map((a) => [a.title, a.daysBefore, a.channel]).sort())
      .toEqual([["Pretrial Conference", 7, "email"], ["Pretrial Conference", 7, "in_app"]]);

    const m = alertMessage({ days_before: 1, event_date: "2026-12-01", include_details: true, kind: "hearing", title: "A\r\nBcc: x@evil.example", event_time: "10:00", matter_title: "M\u2028N" }, "email", "a@b.example", "https://h/alerts");
    expect(m.subject).not.toMatch(/[\r\n\u2028]/);
    expect(m.subject).toBe("Court date tomorrow: Hearing: A Bcc: x@evil.example");
  });
});
