import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { openCredential } from "../src/mail/credentials";
import { completeMailboxConnect, mailboxAuthorizeUrl } from "../src/mail/microsoft";
import { MailWorker } from "../src/mail/worker";
import { createClient } from "../src/services/clients";
import { getEmailHeaders, getEvidence, listContainedItems } from "../src/services/evidence";
import {
  connectMailbox, fileMessage, fileToSuggestion, getMessage, listMailboxes, listMailFolders, listMessages, requestSync, setAutoFile, setDelegate,
  setFilingMode, setFolderIncluded, setMatterColor, suggestMatters, updateMailbox,
} from "../src/services/inbox";
import { createContact } from "../src/services/contacts";
import { addMatterMember, createMatter, linkContactToMatter, listMatterFolders, removeMatterMember, setCourtCaseNumber } from "../src/services/matters";
import { changeUserRole, disableUser, inviteUser } from "../src/services/users";
import { MasterKeyProvider } from "../src/storage/encryption";
import type { MalwareScanner } from "../src/storage/scanner";
import { EvidenceVault, LocalObjectStore } from "../src/storage/store";
import { EvidenceProcessor } from "../src/worker/processor";
import { CLIENT_ID, FakeMicrosoft, mimeOf, OID, TID } from "./fake-microsoft";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

// ---------------------------------------------------------------------------
let t: TestDatabase;
let db: HuisDb;
let vault: EvidenceVault;
let vaultDir: string;
let ms: FakeMicrosoft;
let mail: MailWorker;
let processor: EvidenceProcessor;
const MASTER = Buffer.alloc(32, 7).toString("base64");
const scanner: MalwareScanner = {
  name: "test",
  async scan(stream) { for await (const _ of stream) { /* drain */ } return { status: "clean", detail: "No threats found" }; },
};

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-inbox-vault-"));
  vault = new EvidenceVault(new LocalObjectStore(vaultDir), new MasterKeyProvider(MASTER));
  ms = new FakeMicrosoft();
  await ms.start();
  process.env.HUIS_MS_LOGIN_BASE = ms.base;
  process.env.HUIS_GRAPH_BASE = `${ms.base}/v1.0`;
  mail = new MailWorker(t.worker, vault, { masterKey: MASTER, microsoft: { clientId: CLIENT_ID, clientSecret: "secret" } });
  processor = new EvidenceProcessor(t.worker, vault, scanner);
});

afterAll(async () => {
  ms?.server.close();
  await t?.drop();
  if (vaultDir) await rm(vaultDir, { recursive: true, force: true });
});

beforeEach(() => {
  ms.messages = [
    { id: "M1", folder: "F-inbox", subject: "Smith v. Acme — deposition notice", from: "opposing@biglaw.example", to: ["avery@lawfirm.example"],
      received: "2026-10-01T15:00:00Z", body: "Please find the deposition notice for Case No. 250901234 attached.", mime: "" },
    { id: "M2", folder: "F-inbox", subject: "Lunch Friday?", from: "friend@example.com", to: ["avery@lawfirm.example"],
      received: "2026-10-02T15:00:00Z", body: "Are you free for lunch on Friday", mime: "" },
    { id: "M3", folder: "F-smith", subject: "Re: settlement range", from: "client.smith@example.com", to: ["avery@lawfirm.example"],
      received: "2025-03-05T15:00:00Z", body: "I would accept anything above 80000. Privileged, between us.", mime: "", attachments: true },
    { id: "M4", folder: "F-sent", subject: "Re: deposition notice", from: "avery@lawfirm.example", to: ["opposing@biglaw.example"],
      received: "2026-10-03T15:00:00Z", body: "We will produce the witness.", mime: "" },
  ];
  for (const m of ms.messages) {
    m.mime = mimeOf({ ...m, ...(m.attachments ? { attachment: { name: "timeline.txt", text: "Timeline: fired on April 18 after FMLA request." } } : {}) });
  }
  ms.removed = [];
  ms.rotateTo = null;
  ms.refreshError = null;
  ms.deltaOverride = null;
  ms.endlessEmptyPages = false;
  ms.rawSubjects = {};
  ms.graphCalls = [];
});

async function setup() {
  const f = await newFirm(db);
  const x = await db.withFirm(f.owner, async (s) => {
    const client = await createClient(s, { kind: "person", displayName: "Pat Smith" });
    const attorney = await inviteUser(s, { email: `avery@${f.slug}.example`, fullName: "Avery Attorney", role: "attorney", locationId: f.locationId });
    const assistant = await inviteUser(s, { email: `sam@${f.slug}.example`, fullName: "Sam Assistant", role: "legal_assistant", locationId: f.locationId });
    const portal = await inviteUser(s, { email: `pat@${f.slug}.example`, fullName: "Pat Smith", role: "client", locationId: f.locationId });
    const matter = await createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
    const walled = await createMatter(s, { title: "Walled", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT", restricted: true });
    return { attorney, assistant, portal, matter, walled };
  });
  const ctx = (id: string): RequestContext => ({ firmId: f.firmId, userId: id });
  await db.withFirm(f.owner, (s) => addMatterMember(s, { matterId: x.matter.id, userId: x.portal.id, access: "view", acknowledgePrivilegeWaiverRisk: true }));
  const avery = ctx(x.attorney.id);
  const connectionId = await db.withFirm(avery, (s) => connectMailbox(s, {
    provider: "microsoft", subject: `${TID}:${OID}`, address: "avery@lawfirm.example", displayName: "Avery Attorney", refreshToken: "RT-1", masterKey: MASTER,
  }));
  return { ...f, ...x, avery, sam: ctx(x.assistant.id), pat: ctx(x.portal.id), connectionId };
}

async function syncAll() {
  let n = 0;
  while (await mail.syncOnce()) n += 1;
  return n;
}

describe("connecting an Outlook mailbox", () => {
  it("authorizes read-only mail access and identifies the mailbox by Microsoft's ids, not the email address", async () => {
    const url = new URL(mailboxAuthorizeUrl({ clientId: CLIENT_ID, redirectUri: "http://localhost:3000/cb", state: "s", nonce: "n", verifier: "v".repeat(48) }));
    expect(url.searchParams.get("scope")).toBe("openid profile email offline_access User.Read Mail.Read");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    ms.idNonce = "nonce-1";
    const c = await completeMailboxConnect({ clientId: CLIENT_ID, clientSecret: "secret", redirectUri: "http://localhost:3000/cb", code: "abc", verifier: "v".repeat(48), nonce: "nonce-1", keys: ms.jwks });
    expect(c).toMatchObject({ subject: `${TID}:${OID}`, address: "avery@lawfirm.example", displayName: "Avery Attorney", refreshToken: "RT-1" });
    await expect(completeMailboxConnect({ clientId: CLIENT_ID, clientSecret: "secret", redirectUri: "x", code: "abc", verifier: "v", nonce: "wrong", keys: ms.jwks }))
      .rejects.toThrow(/nonce/);
  });

  it("stores the refresh token encrypted, where the app can't read it", async () => {
    const x = await setup();
    const row = (await t.admin.query("SELECT ciphertext FROM huis.mail_credentials WHERE connection_id = $1", [x.connectionId])).rows[0];
    expect(row.ciphertext.toString("latin1")).not.toContain("RT-1");
    expect(openCredential(MASTER, { firmId: x.firmId, provider: "microsoft", subject: `${TID}:${OID}` }, row.ciphertext)).toBe("RT-1");
    // Bound to its mailbox: another firm or account can't use it.
    expect(() => openCredential(MASTER, { firmId: randomUUID(), provider: "microsoft", subject: `${TID}:${OID}` }, row.ciphertext)).toThrow();
    await expect(db.withFirm(x.avery, (s) => s.client.query("SELECT * FROM huis.mail_credentials"))).rejects.toThrow(/permission/);
    await expect(db.withFirm(x.avery, (s) => s.client.query("SELECT delta_link FROM huis.mail_folders"))).rejects.toThrow(/permission/);
    // Once the mailbox works (has synced), a second person in the firm can't take it over.
    await syncAll();
    await expect(db.withFirm(x.sam, (s) => connectMailbox(s, {
      provider: "microsoft", subject: `${TID}:${OID}`, address: "x", displayName: "x", refreshToken: "RT-evil", masterKey: MASTER,
    }))).rejects.toThrow(/already connected/);
  });
});

describe("review 5 regressions", () => {
  it("R5-5: claiming a colleague's mailbox id can't block them; a never-working connection is taken over and wiped", async () => {
    const x = await setup();
    // Sam (a colleague) squats Avery's real Microsoft account id with a bogus token on a fresh mailbox id.
    const SUBJ = `${TID}:99999999-9999-9999-9999-999999999999`;
    const squat = await db.withFirm(x.sam, (s) => connectMailbox(s, { provider: "microsoft", subject: SUBJ, address: "victim@lawfirm.example", displayName: "x", refreshToken: "garbage", masterKey: MASTER }));
    const real = await db.withFirm(x.avery, (s) => connectMailbox(s, { provider: "microsoft", subject: SUBJ, address: "victim@lawfirm.example", displayName: "Avery", refreshToken: "RT-1", masterKey: MASTER }));
    expect(real).toBe(squat);
    expect((await db.withFirm(x.sam, (s) => listMailboxes(s))).map((m) => m.id)).not.toContain(squat);
    expect((await db.withFirm(x.avery, (s) => listMailboxes(s))).find((m) => m.id === real)?.mine).toBe(true);
  });
});

describe("review 5 regressions (2)", () => {
  it("R5-1: the audit log never holds what someone searched for in their mailbox, or the mailbox address", async () => {
    const x = await setup();
    await syncAll();
    await db.withFirm(x.avery, (s) => listMessages(s, { q: "settlement 80000" }));
    const rows = (await db.withFirm(x.owner, async (s) => (await s.client.query(
      "SELECT action, metadata::text AS m FROM huis.audit_events WHERE action LIKE 'mailbox.%'")).rows));
    expect(rows.map((r) => r.action)).toContain("mailbox.searched");
    const all = rows.map((r) => r.m).join(" ");
    expect(all).not.toMatch(/settlement|80000|avery@lawfirm/);
  });

  it("R5-2: disconnecting removes every email, including ones waiting to be filed", async () => {
    const x = await setup();
    await syncAll();
    const msg = (await db.withFirm(x.avery, (s) => listMessages(s, { q: "settlement" })))[0]!;
    const folder = (await db.withFirm(x.avery, (s) => listMatterFolders(s, x.matter.id))).find((f) => f.name === "Correspondence")!;
    await db.withFirm(x.avery, (s) => fileMessage(s, msg.id, { matterId: x.matter.id, folderId: folder.id }));
    await db.withFirm(x.avery, (s) => updateMailbox(s, x.connectionId, { scope: "all", manage: false, status: "disconnected" }));
    expect((await t.admin.query("SELECT count(*)::int n FROM huis.mail_messages WHERE connection_id = $1", [x.connectionId])).rows[0].n).toBe(0);
    expect((await t.admin.query("SELECT count(*)::int n FROM huis.mail_filings WHERE message_id = $1", [msg.id])).rows[0].n).toBe(0);
    expect(await mail.fileOnce()).toBe(false);
  });

  it("R5-3: a filing doesn't complete if the requester lost access to the Matter or the mailbox first", async () => {
    const x = await setup();
    await syncAll();
    await db.withFirm(x.owner, (s) => addMatterMember(s, { matterId: x.walled.id, userId: x.attorney.id, access: "edit" }));
    const msg = (await db.withFirm(x.avery, (s) => listMessages(s, { q: "settlement" })))[0]!;
    const walledFolder = (await db.withFirm(x.avery, (s) => listMatterFolders(s, x.walled.id))).find((f) => f.name === "Correspondence")!;
    await db.withFirm(x.avery, (s) => fileMessage(s, msg.id, { matterId: x.walled.id, folderId: walledFolder.id }));
    await db.withFirm(x.owner, (s) => removeMatterMember(s, x.walled.id, x.attorney.id));
    await mail.fileOnce();
    expect((await t.admin.query("SELECT count(*)::int n FROM huis.evidence_items WHERE matter_id = $1", [x.walled.id])).rows[0].n).toBe(0);
    expect((await t.admin.query("SELECT status, last_error FROM huis.mail_filings WHERE message_id = $1", [msg.id])).rows[0])
      .toMatchObject({ status: "failed", last_error: "the requester no longer has access" });

    // A delegate whose access is removed: their waiting filings are cancelled.
    await db.withFirm(x.avery, (s) => setDelegate(s, x.connectionId, x.assistant.id, true));
    const other = (await db.withFirm(x.sam, (s) => listMessages(s, { q: "deposition -witness" })))[0]!;
    const folder = (await db.withFirm(x.sam, (s) => listMatterFolders(s, x.matter.id))).find((f) => f.name === "Correspondence")!;
    await db.withFirm(x.sam, (s) => fileMessage(s, other.id, { matterId: x.matter.id, folderId: folder.id }));
    await db.withFirm(x.avery, (s) => setDelegate(s, x.connectionId, x.assistant.id, false));
    await mail.fileOnce();
    expect((await t.admin.query("SELECT status FROM huis.mail_filings WHERE message_id = $1", [other.id])).rows[0].status).toBe("failed");
    expect((await db.withFirm(x.avery, (s) => getMessage(s, other.id))).filedMatterId).toBeNull();
  });

  it("R5-4: access follows later changes — a delegate made read-only, or an owner who leaves the firm", async () => {
    const x = await setup();
    await syncAll();
    await db.withFirm(x.avery, (s) => setDelegate(s, x.connectionId, x.assistant.id, true));
    expect(await db.withFirm(x.sam, (s) => listMessages(s, {}))).toHaveLength(4);
    await db.withFirm(x.owner, (s) => changeUserRole(s, x.assistant.id, "read_only"));
    expect(await db.withFirm(x.sam, (s) => listMessages(s, {}))).toEqual([]);
    await db.withFirm(x.owner, (s) => changeUserRole(s, x.assistant.id, "legal_assistant"));
    expect(await db.withFirm(x.sam, (s) => listMessages(s, {}))).toHaveLength(4);
    // The owner leaves: nobody can read their mailbox and Huis stops syncing it.
    await db.withFirm(x.owner, (s) => disableUser(s, x.attorney.id));
    expect(await db.withFirm(x.sam, (s) => listMessages(s, {}))).toEqual([]);
    ms.messages.push({ id: "M9", folder: "F-inbox", subject: "After departure", from: "x@y.example", to: [], received: "2026-10-09T00:00:00Z", body: "z", mime: "z" });
    await t.admin.query("UPDATE huis.mail_connections SET next_sync_at = now() WHERE id = $1", [x.connectionId]);
    expect(await mail.syncOnce()).toBe(false);
    expect((await t.admin.query("SELECT count(*)::int n FROM huis.mail_messages WHERE subject = 'After departure'")).rows[0].n).toBe(0);
  });

  it("R5-6: a misbehaving mail service can't keep a sync running forever", async () => {
    const x = await setup();
    ms.endlessEmptyPages = true;
    ms.graphCalls = [];
    await mail.syncOnce();
    expect(ms.graphCalls.length).toBeLessThan(3500);
    expect((await db.withFirm(x.avery, (s) => listMailboxes(s)))[0]!.lastError ?? "").not.toBe("");
  });

  it("R5-7: one email with a NUL character can't stop the mailbox from syncing", async () => {
    const x = await setup();
    ms.rawSubjects = { M2: "Lunch\u0000 Friday?" };
    await syncAll();
    const subjects = (await db.withFirm(x.avery, (s) => listMessages(s, {}))).map((m) => m.subject);
    expect(subjects).toHaveLength(4);
    expect(subjects).toContain("Lunch Friday?");
    expect((await db.withFirm(x.avery, (s) => listMailboxes(s)))[0]!.lastError).toBeNull();
  });
});

describe("syncing", () => {
  it("imports the whole mailbox, folder by folder, then only changes; deletions are marked", async () => {
    const x = await setup();
    await syncAll();
    const folders = await db.withFirm(x.avery, (s) => listMailFolders(s, x.connectionId));
    expect(folders.map((f) => f.path)).toEqual(["Inbox", "Inbox/Smith matter", "Sent Items"]);
    let msgs = await db.withFirm(x.avery, (s) => listMessages(s, {}));
    expect(msgs.map((m) => m.subject)).toEqual(["Re: deposition notice", "Lunch Friday?", "Smith v. Acme — deposition notice", "Re: settlement range"]);
    expect(msgs.find((m) => m.subject === "Re: settlement range")).toMatchObject({ folderPath: "Inbox/Smith matter", hasAttachments: true, fromAddress: "client.smith@example.com" });

    // Next sync: one new message and one deletion; only changes are fetched.
    ms.messages.push({ id: "M5", folder: "F-inbox", subject: "New scheduling order", from: "clerk@utcourts.example", to: ["avery@lawfirm.example"], received: "2026-10-04T15:00:00Z", body: "Scheduling order entered.", mime: "x" });
    ms.removed = ["M2"];
    await db.withFirm(x.avery, (s) => requestSync(s, x.connectionId));
    ms.graphCalls = [];
    await syncAll();
    expect(ms.graphCalls.some((c) => c.includes("$deltatoken"))).toBe(true);
    msgs = await db.withFirm(x.avery, (s) => listMessages(s, {}));
    expect(msgs.map((m) => m.subject)).toContain("New scheduling order");
    expect(msgs.map((m) => m.subject)).not.toContain("Lunch Friday?");
  });

  it("only selected folders and only mail since a date, when the owner chooses", async () => {
    const x = await setup();
    await db.withFirm(x.avery, (s) => updateMailbox(s, x.connectionId, { scope: "selected", syncSince: "2026-01-01", manage: false, status: "active" }));
    await syncAll();
    expect(await db.withFirm(x.avery, (s) => listMessages(s, {}))).toEqual([]);
    const smith = (await db.withFirm(x.avery, (s) => listMailFolders(s, x.connectionId))).find((f) => f.path === "Inbox/Smith matter")!;
    const inbox = (await db.withFirm(x.avery, (s) => listMailFolders(s, x.connectionId))).find((f) => f.path === "Inbox")!;
    await db.withFirm(x.avery, (s) => setFolderIncluded(s, smith.id, true));
    await db.withFirm(x.avery, (s) => setFolderIncluded(s, inbox.id, true));
    await db.withFirm(x.avery, (s) => requestSync(s, x.connectionId));
    await syncAll();
    const subjects = (await db.withFirm(x.avery, (s) => listMessages(s, {}))).map((m) => m.subject);
    // Smith matter mail is from 2025, before the "since" date; sent items aren't selected.
    expect(subjects.sort()).toEqual(["Lunch Friday?", "Smith v. Acme — deposition notice"]);
  });

  it("saves a rotated refresh token; a revoked one asks the attorney to reconnect", async () => {
    const x = await setup();
    ms.rotateTo = "RT-2";
    await syncAll();
    const row = (await t.admin.query("SELECT ciphertext FROM huis.mail_credentials WHERE connection_id = $1", [x.connectionId])).rows[0];
    expect(openCredential(MASTER, { firmId: x.firmId, provider: "microsoft", subject: `${TID}:${OID}` }, row.ciphertext)).toBe("RT-2");
    ms.refreshError = "invalid_grant";
    await db.withFirm(x.avery, (s) => requestSync(s, x.connectionId));
    await syncAll();
    expect((await db.withFirm(x.avery, (s) => listMailboxes(s)))[0]).toMatchObject({ status: "needs_reconnect" });
  });

  it("never sends the mailbox token to a host other than Microsoft Graph", async () => {
    const x = await setup();
    let leaked = 0;
    const other = http.createServer((req, res) => { if (req.headers.authorization) leaked += 1; res.end("{}"); });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", () => r()));
    ms.deltaOverride = `http://127.0.0.1:${(other.address() as AddressInfo).port}/v1.0/steal`;
    await syncAll();
    await db.withFirm(x.avery, (s) => requestSync(s, x.connectionId));
    await syncAll();
    other.close();
    expect(leaked).toBe(0);
    expect((await db.withFirm(x.avery, (s) => listMailboxes(s)))[0]!.lastError).toMatch(/unexpected Graph link/);
  });
});

describe("privacy of unfiled mail", () => {
  it("only the owner and their delegates see the mailbox — not firm owners, other staff, clients or other firms", async () => {
    const x = await setup();
    await syncAll();
    expect(await db.withFirm(x.avery, (s) => listMessages(s, {}))).toHaveLength(4);
    // The firm owner (an administrator) sees nothing.
    expect(await db.withFirm(x.owner, (s) => listMailboxes(s))).toEqual([]);
    expect(await db.withFirm(x.owner, (s) => listMessages(s, {}))).toEqual([]);
    await db.withFirm(x.owner, async (s) => {
      expect((await s.client.query("SELECT count(*)::int n FROM huis.mail_messages")).rows[0].n).toBe(0);
      expect((await s.client.query("SELECT count(*)::int n FROM huis.mail_folders")).rows[0].n).toBe(0);
    });
    expect(await db.withFirm(x.sam, (s) => listMessages(s, {}))).toEqual([]);
    await expect(db.withFirm(x.pat, (s) => listMessages(s, {}))).rejects.toThrow();
    await db.withFirm(x.pat, async (s) => {
      expect((await s.client.query("SELECT count(*)::int n FROM huis.mail_messages")).rows[0].n).toBe(0);
    });
    const other = await newFirm(db);
    expect(await db.withFirm(other.owner, (s) => listMessages(s, {}))).toEqual([]);

    // The owner delegates to their assistant.
    await db.withFirm(x.avery, (s) => setDelegate(s, x.connectionId, x.assistant.id, true));
    expect(await db.withFirm(x.sam, (s) => listMessages(s, {}))).toHaveLength(4);
    // Delegates can't change the mailbox or add more delegates; clients can't be delegates.
    await expect(db.withFirm(x.sam, (s) => updateMailbox(s, x.connectionId, { scope: "all", manage: true, status: "active" }))).rejects.toThrow();
    await expect(db.withFirm(x.sam, (s) => setDelegate(s, x.connectionId, x.ownerUserId, true))).rejects.toThrow();
    await expect(db.withFirm(x.avery, (s) => setDelegate(s, x.connectionId, x.portal.id, true))).rejects.toThrow();
    await db.withFirm(x.avery, (s) => setDelegate(s, x.connectionId, x.assistant.id, false));
    expect(await db.withFirm(x.sam, (s) => listMessages(s, {}))).toEqual([]);

    // The app can't change mail directly.
    await expect(db.withFirm(x.avery, (s) => s.client.query("UPDATE huis.mail_messages SET subject = 'x'"))).rejects.toThrow(/permission/);
    await expect(db.withFirm(x.avery, (s) => s.client.query("INSERT INTO huis.mail_delegates (connection_id, firm_id, user_id, granted_by) VALUES ($1, $2, $3, $3)",
      [x.connectionId, x.firmId, x.ownerUserId]))).rejects.toThrow(/permission/);
  });

  it("searches the owner's mail (phrases, or, -exclude) and records searches", async () => {
    const x = await setup();
    await syncAll();
    const hit = await db.withFirm(x.avery, (s) => listMessages(s, { q: '"deposition notice"' }));
    expect(hit.map((m) => m.subject).sort()).toEqual(["Re: deposition notice", "Smith v. Acme — deposition notice"]);
    expect((await db.withFirm(x.avery, (s) => listMessages(s, { q: "80000" }))).map((m) => m.subject)).toEqual(["Re: settlement range"]);
    expect((await db.withFirm(x.avery, (s) => listMessages(s, { q: "deposition -witness" }))).map((m) => m.subject)).toEqual(["Smith v. Acme — deposition notice"]);
    expect((await db.withFirm(x.avery, (s) => listMessages(s, { q: "client.smith@example.com" }))).map((m) => m.subject)).toEqual(["Re: settlement range"]);
    const audit = (await t.admin.query("SELECT count(*)::int n FROM huis.audit_events WHERE firm_id = $1 AND action = 'mailbox.searched'", [x.firmId])).rows[0].n;
    expect(audit).toBe(4);
  });
});

describe("filing email into a Matter", () => {
  it("copies the original message into the Matter as evidence, with custody, scanning and attachments split out", async () => {
    const x = await setup();
    await syncAll();
    const msg = (await db.withFirm(x.avery, (s) => listMessages(s, { q: "settlement" })))[0]!;
    const correspondence = (await db.withFirm(x.avery, (s) => listMatterFolders(s, x.matter.id))).find((f) => f.name === "Correspondence")!;
    await db.withFirm(x.avery, (s) => fileMessage(s, msg.id, { matterId: x.matter.id, folderId: correspondence.id }));
    expect((await db.withFirm(x.avery, (s) => getMessage(s, msg.id))).pendingFiling).toBe(true);
    expect(await mail.fileOnce()).toBe(true);
    await processor.drain();

    const filed = await db.withFirm(x.avery, (s) => getMessage(s, msg.id));
    expect(filed).toMatchObject({ filedMatterId: x.matter.id, filedMatterTitle: "Smith v. Acme", pendingFiling: false });
    const ev = (await db.withFirm(x.avery, (s) => getEvidence(s, filed.filedEvidenceId!)))!;
    expect(ev).toMatchObject({ source: "mailbox", folderName: "Correspondence", status: "clean", originalFilename: "2025-03-05 Re settlement range.eml",
      receivedFrom: "client.smith@example.com", dateReceived: "2025-03-05", extractionStatus: "done" });
    expect(await db.withFirm(x.avery, (s) => getEmailHeaders(s, ev.id))).toMatchObject({ subject: "Re: settlement range" });
    const kids = await db.withFirm(x.avery, (s) => listContainedItems(s, ev.id));
    expect(kids.map((k) => k.originalFilename)).toEqual(["timeline.txt"]);
    const custody = (await t.admin.query("SELECT event, details FROM huis.evidence_custody_events WHERE evidence_id = $1 ORDER BY chain_seq", [ev.id])).rows;
    expect(custody.map((c) => c.event).slice(0, 2)).toEqual(["received", "filed_from_mailbox"]);
    expect(custody[1].details).toMatchObject({ mailbox: "avery@lawfirm.example", provider: "microsoft", internet_message_id: "<M3@lawfirm.example>", method: "manual" });

    // Once filed, the Matter's rules apply: the firm owner (on the Matter) can see it; the mail itself stays private.
    expect((await db.withFirm(x.owner, (s) => getEvidence(s, ev.id)))?.id).toBe(ev.id);
    expect(await db.withFirm(x.owner, (s) => listMessages(s, {}))).toEqual([]);
    // Filing twice is refused.
    await expect(db.withFirm(x.avery, (s) => fileMessage(s, msg.id, { matterId: x.matter.id, folderId: correspondence.id }))).rejects.toThrow(/already filed/);
  });

  it("can't file into a walled Matter you're not on; outsider-visible folders need the privilege acknowledgement", async () => {
    const x = await setup();
    await syncAll();
    const msg = (await db.withFirm(x.avery, (s) => listMessages(s, { q: "settlement" })))[0]!;
    const walledFolder = (await db.withFirm(x.owner, (s) => listMatterFolders(s, x.walled.id)))[0]!;
    await expect(db.withFirm(x.avery, (s) => fileMessage(s, msg.id, { matterId: x.walled.id, folderId: walledFolder.id }))).rejects.toThrow();
    const shared = (await db.withFirm(x.avery, (s) => listMatterFolders(s, x.matter.id))).find((f) => f.name === "Client Uploads")!;
    await expect(db.withFirm(x.avery, (s) => fileMessage(s, msg.id, { matterId: x.matter.id, folderId: shared.id }))).rejects.toThrow(/waive privilege/);
    // Someone who can't see the mailbox can't file its mail, even into their own Matter.
    const evidence = (await db.withFirm(x.owner, (s) => listMatterFolders(s, x.matter.id))).find((f) => f.name === "Evidence")!;
    await expect(db.withFirm(x.owner, (s) => fileMessage(s, msg.id, { matterId: x.matter.id, folderId: evidence.id }))).rejects.toThrow();
    // The app can't create mailbox evidence itself.
    await expect(db.withFirm(x.avery, (s) => s.client.query(
      `INSERT INTO huis.evidence_items (id, firm_id, matter_id, folder_id, original_filename, size_bytes, sha256, storage_key, source, uploaded_by)
       VALUES (gen_random_uuid(), $1, $2, $3, 'x.eml', 1, repeat('a', 64), 'k', 'mailbox', $4)`, [x.firmId, x.matter.id, evidence.id, x.attorney.id]))).rejects.toThrow();
  });

  it("disconnecting deletes the credentials and unfiled mail; filed copies stay in their Matters", async () => {
    const x = await setup();
    await syncAll();
    const msg = (await db.withFirm(x.avery, (s) => listMessages(s, { q: "settlement" })))[0]!;
    const folder = (await db.withFirm(x.avery, (s) => listMatterFolders(s, x.matter.id))).find((f) => f.name === "Correspondence")!;
    await db.withFirm(x.avery, (s) => fileMessage(s, msg.id, { matterId: x.matter.id, folderId: folder.id }));
    await mail.fileOnce();
    const evidenceId = (await db.withFirm(x.avery, (s) => getMessage(s, msg.id))).filedEvidenceId!;
    await db.withFirm(x.avery, (s) => updateMailbox(s, x.connectionId, { scope: "all", manage: false, status: "disconnected" }));
    expect((await t.admin.query("SELECT count(*)::int n FROM huis.mail_credentials WHERE connection_id = $1", [x.connectionId])).rows[0].n).toBe(0);
    expect((await t.admin.query("SELECT count(*)::int n FROM huis.mail_messages WHERE connection_id = $1", [x.connectionId])).rows[0].n).toBe(0);
    expect((await db.withFirm(x.avery, (s) => getEvidence(s, evidenceId)))?.id).toBe(evidenceId);
    expect(await db.withFirm(x.avery, (s) => listMailboxes(s))).toEqual([]);
  });

  it("matter colors: set by people who can change the Matter", async () => {
    const x = await setup();
    await db.withFirm(x.owner, (s) => setMatterColor(s, x.matter.id, "#2563EB"));
    await syncAll();
    const msg = (await db.withFirm(x.avery, (s) => listMessages(s, { q: "settlement" })))[0]!;
    const folder = (await db.withFirm(x.avery, (s) => listMatterFolders(s, x.matter.id))).find((f) => f.name === "Correspondence")!;
    await db.withFirm(x.avery, (s) => fileMessage(s, msg.id, { matterId: x.matter.id, folderId: folder.id }));
    await mail.fileOnce();
    expect((await db.withFirm(x.avery, (s) => getMessage(s, msg.id))).filedMatterColor).toBe("#2563EB");
    await expect(db.withFirm(x.pat, (s) => setMatterColor(s, x.matter.id, "#000000"))).rejects.toThrow();
    await expect(db.withFirm(x.owner, (s) => setMatterColor(s, x.matter.id, "red; drop table"))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Part 2: matter suggestions and filing modes
// ---------------------------------------------------------------------------
describe("part 3.2: suggestions and filing modes", () => {
  async function setupWithLinks() {
    const x = await setup();
    await db.withFirm(x.owner, async (s) => {
      await setCourtCaseNumber(s, x.matter.id, "250901234");
      const client = await createClient(s, { kind: "person", displayName: "Pat Smith (client)", email: "client.smith@example.com" });
      const other = await createMatter(s, { title: "Smith Family Trust", clientId: client.id, leadAttorneyId: x.ownerUserId, jurisdictionState: "UT" });
      const opposing = await createContact(s, { kind: "opposing_counsel", fullName: "Olivia Opposing", email: "opposing@biglaw.example" });
      await linkContactToMatter(s, x.matter.id, opposing.id, "opposing counsel");
      return other;
    }).then((other) => Object.assign(x, { other }));
    return x as typeof x & { other: { id: string } };
  }

  it("suggests Matters with the reasons, only among Matters the person can see and add to", async () => {
    const x = await setupWithLinks();
    await syncAll();
    const msgs = await db.withFirm(x.avery, (s) => listMessages(s, {}));
    const byId = (subj: string) => msgs.find((m) => m.subject === subj)!;
    const s1 = await db.withFirm(x.avery, (s) => suggestMatters(s, byId("Smith v. Acme — deposition notice").id));
    expect(s1[0]).toMatchObject({ matterId: x.matter.id, strong: true });
    expect(s1[0]!.reasons).toEqual(expect.arrayContaining(["Court case number 250901234 appears in the email", "Olivia Opposing (opposing counsel) is on this email"]));
    const s3 = await db.withFirm(x.avery, (s) => suggestMatters(s, byId("Re: settlement range").id));
    expect(s3.map((m) => m.matterId)).toEqual([x.other.id]);
    expect(s3[0]!.reasons).toEqual(["The client (Pat Smith (client)) is on this email"]);
    expect(await db.withFirm(x.avery, (s) => suggestMatters(s, byId("Lunch Friday?").id))).toEqual([]);
    // Nobody else learns anything about this mailbox through suggestions.
    expect(await db.withFirm(x.owner, (s) => suggestMatters(s, byId("Smith v. Acme — deposition notice").id))).toEqual([]);
    // A walled Matter the person isn't on is never suggested, even with its case number in the email.
    await db.withFirm(x.owner, (s) => setCourtCaseNumber(s, x.walled.id, "250901234"));
    const again = await db.withFirm(x.avery, (s) => suggestMatters(s, byId("Smith v. Acme — deposition notice").id));
    expect(again.map((m) => m.matterId)).not.toContain(x.walled.id);
  });

  it("assisted: one click files into the Matter's internal Correspondence folder, recording why", async () => {
    const x = await setupWithLinks();
    await syncAll();
    const msg = (await db.withFirm(x.avery, (s) => listMessages(s, { q: "deposition -witness" })))[0]!;
    await expect(db.withFirm(x.avery, (s) => fileToSuggestion(s, msg.id, x.other.id))).rejects.toThrow(/isn't a current suggestion/);
    await db.withFirm(x.avery, (s) => fileToSuggestion(s, msg.id, x.matter.id));
    await mail.fileOnce();
    const filed = await db.withFirm(x.avery, (s) => getMessage(s, msg.id));
    const ev = (await db.withFirm(x.avery, (s) => getEvidence(s, filed.filedEvidenceId!)))!;
    expect(ev.folderName).toBe("Correspondence");
    const custody = (await t.admin.query("SELECT details FROM huis.evidence_custody_events WHERE evidence_id = $1 AND event = 'filed_from_mailbox'", [ev.id])).rows[0];
    expect(custody.details).toMatchObject({ method: "assisted" });
    expect(custody.details.reasons).toContain("Court case number 250901234 appears in the email");
    // In Manual mode one-click filing is off.
    await db.withFirm(x.owner, (s) => setFilingMode(s, "manual"));
    const other = (await db.withFirm(x.avery, (s) => listMessages(s, { q: "witness" })))[0]!;
    await expect(db.withFirm(x.avery, (s) => fileToSuggestion(s, other.id, x.matter.id))).rejects.toThrow(/manually/);
    // Only administrators choose the mode.
    await expect(db.withFirm(x.avery, (s) => setFilingMode(s, "automatic"))).rejects.toThrow();
  });

  it("an email in a conversation already filed in a Matter is suggested strongly for it", async () => {
    const x = await setupWithLinks();
    ms.messages.push({ id: "M7", folder: "F-inbox", subject: "Re: Smith v. Acme — deposition notice", from: "someone@else.example", to: ["avery@lawfirm.example"], received: "2026-10-05T15:00:00Z", body: "Confirming.", mime: "m" });
    await syncAll();
    const first = (await db.withFirm(x.avery, (s) => listMessages(s, { q: "250901234" })))[0]!;
    const correspondence = (await db.withFirm(x.avery, (s) => listMatterFolders(s, x.other.id))).find((f) => f.name === "Correspondence")!;
    await db.withFirm(x.avery, (s) => fileMessage(s, first.id, { matterId: x.other.id, folderId: correspondence.id }));
    await mail.fileOnce();
    const reply = (await db.withFirm(x.avery, (s) => listMessages(s, { q: "confirming" })))[0]!;
    const sug = await db.withFirm(x.avery, (s) => suggestMatters(s, reply.id));
    expect(sug.find((m) => m.matterId === x.other.id)?.reasons).toContain("An earlier email in this conversation was filed here");
  });

  const now = () => new Date().toISOString();
  async function turnOnAutomatic(x: Awaited<ReturnType<typeof setupWithLinks>>) {
    await db.withFirm(x.owner, (s) => setFilingMode(s, "automatic"));
    await db.withFirm(x.avery, (s) => updateMailbox(s, x.connectionId, { scope: "all", manage: true, status: "active" }));
    await syncAll();
    await db.withFirm(x.avery, (s) => setAutoFile(s, x.connectionId, true));
  }
  async function drain() { let n = 0; while (await mail.fileOnce()) n += 1; return n; }

  it("automatic: files only strong, unambiguous matches with the client or a contact on the email, only when the firm and the mailbox owner both turned it on", async () => {
    const x = await setupWithLinks();
    await db.withFirm(x.owner, (s) => addMatterMember(s, { matterId: x.matter.id, userId: x.attorney.id, access: "edit" }));
    await db.withFirm(x.owner, (s) => setFilingMode(s, "automatic"));
    await db.withFirm(x.avery, (s) => updateMailbox(s, x.connectionId, { scope: "all", manage: true, status: "active" }));
    // Not yet opted in by the mailbox owner: nothing is filed.
    await syncAll();
    expect(await drain()).toBe(0);
    await db.withFirm(x.avery, (s) => setAutoFile(s, x.connectionId, true));
    ms.messages.push(
      { id: "N1", folder: "F-inbox", subject: "Smith v. Acme — amended notice", from: "opposing@biglaw.example", to: ["avery@lawfirm.example"], received: now(), body: "Case No. 250901234: amended notice attached.", mime: "n1" },
      // Anyone can type a case number into an email: on its own it's not enough.
      { id: "N2", folder: "F-inbox", subject: "Your case", from: "stranger@unrelated.example", to: ["avery@lawfirm.example"], received: now(), body: "About case 250901234.", mime: "n2" },
    );
    await db.withFirm(x.avery, (s) => requestSync(s, x.connectionId));
    await syncAll();
    expect(await drain()).toBe(1);
    const filed = (await db.withFirm(x.avery, (s) => listMessages(s, { status: "filed" })));
    // The older deposition notice (received before automatic filing was turned on) was left alone.
    expect(filed.map((m) => m.subject)).toEqual(["Smith v. Acme — amended notice"]);
    const ev = (await db.withFirm(x.avery, (s) => getEvidence(s, filed[0]!.filedEvidenceId!)))!;
    expect(ev.folderName).toBe("Correspondence");
    const custody = (await t.admin.query("SELECT details FROM huis.evidence_custody_events WHERE evidence_id = $1 AND event = 'filed_from_mailbox'", [ev.id])).rows[0];
    expect(custody.details).toMatchObject({ method: "automatic" });
    const unfiled = (await db.withFirm(x.avery, (s) => listMessages(s, { status: "unfiled" }))).map((m) => m.subject);
    expect(unfiled).toEqual(expect.arrayContaining(["Your case", "Smith v. Acme — deposition notice", "Re: settlement range", "Lunch Friday?"]));
    // Someone else can't turn on automatic filing for this mailbox.
    await db.withFirm(x.avery, (s) => setDelegate(s, x.connectionId, x.assistant.id, true));
    await expect(db.withFirm(x.sam, (s) => setAutoFile(s, x.connectionId, false))).rejects.toThrow();
  });

  it("review 6: automatic filing only files into Matters the mailbox owner is on", async () => {
    const x = await setupWithLinks();
    // Avery can add to Smith v. Acme (unrestricted) but isn't on it: e.g. a colleague's Matter.
    await turnOnAutomatic(x);
    ms.messages.push({ id: "N1", folder: "F-inbox", subject: "Notice", from: "opposing@biglaw.example", to: ["avery@lawfirm.example"], received: now(), body: "Case No. 250901234", mime: "n1" });
    await db.withFirm(x.avery, (s) => requestSync(s, x.connectionId));
    await syncAll();
    expect(await drain()).toBe(0);
    // Still suggested to Avery as a person, who can decide.
    const msg = (await db.withFirm(x.avery, (s) => listMessages(s, { q: "notice" }))).find((m) => m.subject === "Notice")!;
    expect((await db.withFirm(x.avery, (s) => suggestMatters(s, msg.id)))[0]?.matterId).toBe(x.matter.id);
  });

  it("review 6: words, phone numbers and longer numbers never match a court case number", async () => {
    const x = await setupWithLinks();
    await db.withFirm(x.owner, (s) => setCourtCaseNumber(s, x.other.id, "REGARDS"));
    await db.withFirm(x.owner, (s) => setCourtCaseNumber(s, x.walled.id, null));
    ms.messages.push(
      { id: "P1", folder: "F-inbox", subject: "Call me", from: "someone@else.example", to: ["avery@lawfirm.example"], received: now(), body: "Call me at 250.901.2345. Regards", mime: "p1" },
      { id: "P2", folder: "F-inbox", subject: "Federal", from: "someone@else.example", to: ["avery@lawfirm.example"], received: now(), body: "Re 2:24-cv-01234.", mime: "p2" },
      { id: "P3", folder: "F-inbox", subject: "State", from: "someone@else.example", to: ["avery@lawfirm.example"], received: now(), body: "Re: Case 25-0901-234, hearing moved.", mime: "p3" },
    );
    await syncAll();
    const msgs = await db.withFirm(x.avery, (s) => listMessages(s, {}));
    const sug = (subj: string) => db.withFirm(x.avery, (s) => suggestMatters(s, msgs.find((m) => m.subject === subj)!.id));
    expect(await sug("Call me")).toEqual([]);
    await db.withFirm(x.owner, (s) => setCourtCaseNumber(s, x.matter.id, "2:24-cv-0123"));
    expect(await sug("Federal")).toEqual([]);
    await db.withFirm(x.owner, (s) => setCourtCaseNumber(s, x.matter.id, "250901234"));
    // The same number written with separators still matches.
    expect((await sug("State"))[0]?.reasons).toContain("Court case number 250901234 appears in the email");
  });

  it("review 6: switching automatic filing off stops filings already queued", async () => {
    const x = await setupWithLinks();
    await db.withFirm(x.owner, (s) => addMatterMember(s, { matterId: x.matter.id, userId: x.attorney.id, access: "edit" }));
    await turnOnAutomatic(x);
    ms.messages.push({ id: "N1", folder: "F-inbox", subject: "Notice", from: "opposing@biglaw.example", to: ["avery@lawfirm.example"], received: now(), body: "Case No. 250901234", mime: "n1" });
    await db.withFirm(x.avery, (s) => requestSync(s, x.connectionId));
    await syncAll();
    expect((await t.admin.query("SELECT count(*)::int AS n FROM huis.mail_filings WHERE method = 'automatic' AND status = 'queued'")).rows[0].n).toBe(1);
    await db.withFirm(x.owner, (s) => setFilingMode(s, "assisted"));
    await drain();
    expect(await db.withFirm(x.avery, (s) => listMessages(s, { status: "filed" }))).toEqual([]);
  });

  it("automatic filing never acts when two Matters match equally", async () => {
    const x = await setupWithLinks();
    await db.withFirm(x.owner, (s) => setCourtCaseNumber(s, x.other.id, "250901234"));
    await db.withFirm(x.owner, (s) => addMatterMember(s, { matterId: x.matter.id, userId: x.attorney.id, access: "edit" }));
    await db.withFirm(x.owner, (s) => setFilingMode(s, "automatic"));
    await db.withFirm(x.avery, (s) => updateMailbox(s, x.connectionId, { scope: "all", manage: true, status: "active" }));
    await db.withFirm(x.avery, (s) => setAutoFile(s, x.connectionId, true));
    await t.admin.query("UPDATE huis.mail_connections SET auto_file_since = now() - interval '1 year' WHERE id = $1", [x.connectionId]);
    await t.admin.query("UPDATE huis.firms SET mail_filing_mode_since = now() - interval '1 year'");
    await syncAll();
    // Both Matters have the case number; one also has opposing counsel and its title in the email (100 vs 90): within 10, too close to call.
    const ambiguous = (await db.withFirm(x.avery, (s) => listMessages(s, { q: "250901234" })))[0]!;
    const sug = await db.withFirm(x.avery, (s) => suggestMatters(s, ambiguous.id));
    expect(sug.slice(0, 2).map((m) => m.score)).toEqual([100, 90]);
    let queued = 0;
    while (await mail.fileOnce()) queued += 1;
    expect(queued).toBe(0);
    expect(await db.withFirm(x.avery, (s) => listMessages(s, { status: "filed" }))).toEqual([]);
  });
});
