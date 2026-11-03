import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { openCredential } from "../src/mail/credentials";
import { completeGmailConnect, gmailAuthorizeUrl, toMailMessage } from "../src/mail/google";
import { MailWorker } from "../src/mail/worker";
import { createClient } from "../src/services/clients";
import { getEvidence } from "../src/services/evidence";
import { connectMailbox, fileMessage, listMailboxes, listMailFolders, listMessages, requestSync, setFolderIncluded, updateMailbox } from "../src/services/inbox";
import { createMatter, listMatterFolders } from "../src/services/matters";
import { inviteUser } from "../src/services/users";
import { MasterKeyProvider } from "../src/storage/encryption";
import { EvidenceVault, LocalObjectStore } from "../src/storage/store";
import { FakeGoogle, GOOGLE_CLIENT_ID, GOOGLE_SUB } from "./fake-google";
import { mimeOf } from "./fake-microsoft";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

let t: TestDatabase;
let db: HuisDb;
let vault: EvidenceVault;
let vaultDir: string;
let g: FakeGoogle;
let mail: MailWorker;
const MASTER = Buffer.alloc(32, 9).toString("base64");

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-gmail-vault-"));
  vault = new EvidenceVault(new LocalObjectStore(vaultDir), new MasterKeyProvider(MASTER));
  g = new FakeGoogle();
  await g.start();
  process.env.HUIS_GOOGLE_AUTH_BASE = g.base;
  process.env.HUIS_GOOGLE_TOKEN_BASE = g.base;
  process.env.HUIS_GMAIL_BASE = `${g.base}/gmail/v1/users/me`;
  mail = new MailWorker(t.worker, vault, { masterKey: MASTER, microsoft: null, google: { clientId: GOOGLE_CLIENT_ID, clientSecret: "gsecret" } });
});

afterAll(async () => {
  g?.server.close();
  await t?.drop();
  if (vaultDir) await rm(vaultDir, { recursive: true, force: true });
});

const msg = (id: string, labels: string[], subject: string, extra: Partial<{ from: string; body: string; html: boolean; attachment: boolean; received: string }> = {}) => {
  const m = { id, threadId: `t-${subject.replace(/^re: /i, "")}`, labels, subject, from: extra.from ?? "opposing@biglaw.example",
    to: ["avery@gmail-firm.example"], received: extra.received ?? "2026-10-01T15:00:00Z", body: extra.body ?? `Body of ${subject}`,
    html: extra.html, attachment: extra.attachment, mime: "" };
  m.mime = mimeOf({ ...m, attachment: m.attachment ? { name: "notice.pdf", text: "Notice" } : undefined });
  return m;
};

beforeEach(() => {
  g.reset();
  for (const m of [
    msg("g1", ["INBOX", "UNREAD", "IMPORTANT", "Label_2"], "Smith v. Acme — notice", { attachment: true }),
    msg("g2", ["Label_2"], "Smith timeline", { from: "client.smith@example.com", html: true, body: "Fired on <b>April 18</b>" }),
    msg("g3", ["CATEGORY_UPDATES"], "Archived newsletter"),
    msg("g4", ["SENT"], "Re: Smith v. Acme — notice", { from: "avery@gmail-firm.example" }),
    msg("g5", ["SPAM"], "You won"),
    msg("g6", ["TRASH"], "Deleted one"),
    msg("g7", ["DRAFT"], "Draft reply"),
  ]) g.add(m);
});

async function setup() {
  const f = await newFirm(db);
  const x = await db.withFirm(f.owner, async (s) => {
    const client = await createClient(s, { kind: "person", displayName: "Pat Smith" });
    const attorney = await inviteUser(s, { email: `avery@${f.slug}.example`, fullName: "Avery Attorney", role: "attorney", locationId: f.locationId });
    const matter = await createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
    return { attorney, matter };
  });
  const avery: RequestContext = { firmId: f.firmId, userId: x.attorney.id };
  const connectionId = await db.withFirm(avery, (s) => connectMailbox(s, {
    provider: "google", subject: GOOGLE_SUB, address: "avery@gmail-firm.example", displayName: "Avery Attorney", refreshToken: "GRT-1", masterKey: MASTER,
  }));
  return { ...f, ...x, avery, connectionId };
}

async function syncAll() { let n = 0; while (await mail.syncOnce()) n += 1; return n; }
const subjects = async (ctx: RequestContext) => (await db.withFirm(ctx, (s) => listMessages(s, { status: "all" }))).map((m) => m.subject).sort();

describe("connecting Gmail", () => {
  it("asks Google for read-only Gmail access with offline use, and identifies the account by Google's id", async () => {
    const url = new URL(gmailAuthorizeUrl({ clientId: GOOGLE_CLIENT_ID, redirectUri: "http://localhost:3000/cb", state: "s", nonce: "n", verifier: "v".repeat(48) }));
    expect(url.origin + url.pathname).toBe(`${g.base}/o/oauth2/v2/auth`);
    expect(url.searchParams.get("scope")).toBe("openid email profile https://www.googleapis.com/auth/gmail.readonly");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    g.idNonce = "n1";
    const c = await completeGmailConnect({ clientId: GOOGLE_CLIENT_ID, clientSecret: "x", redirectUri: "r", code: "c", verifier: "v", nonce: "n1", keys: g.jwks });
    expect(c).toMatchObject({ subject: GOOGLE_SUB, address: "avery@gmail-firm.example", displayName: "Avery Attorney", refreshToken: "GRT-1" });
  });

  it("rejects sign-in tokens with the wrong nonce, audience or issuer, and connections without Gmail permission", async () => {
    const go = (nonce = "n1") => completeGmailConnect({ clientId: GOOGLE_CLIENT_ID, clientSecret: "x", redirectUri: "r", code: "c", verifier: "v", nonce, keys: g.jwks });
    g.idNonce = "n1";
    await expect(go("other")).rejects.toThrow(/nonce/);
    g.idAudience = "someone-elses-app.apps.googleusercontent.com";
    await expect(go()).rejects.toThrow();
    g.idAudience = GOOGLE_CLIENT_ID;
    g.idIssuer = "https://evil.example";
    await expect(go()).rejects.toThrow();
    g.idIssuer = "https://accounts.google.com";
    g.grantedScope = "openid https://www.googleapis.com/auth/userinfo.email";
    await expect(go()).rejects.toThrow(/permission to read Gmail/);
  });

  it("stores the refresh token encrypted and bound to the Gmail account", async () => {
    const x = await setup();
    const row = (await t.admin.query("SELECT ciphertext FROM huis.mail_credentials WHERE connection_id = $1", [x.connectionId])).rows[0];
    expect(row.ciphertext.toString("latin1")).not.toContain("GRT-1");
    expect(openCredential(MASTER, { firmId: x.firmId, provider: "google", subject: GOOGLE_SUB }, row.ciphertext)).toBe("GRT-1");
    expect(() => openCredential(MASTER, { firmId: x.firmId, provider: "microsoft", subject: GOOGLE_SUB }, row.ciphertext)).toThrow();
  });
});

describe("syncing Gmail", () => {
  it("shows labels as folders and files each email under its first chosen label; never brings in Spam, Trash or Drafts", async () => {
    const x = await setup();
    await syncAll();
    const folders = await db.withFirm(x.avery, (s) => listMailFolders(s, x.connectionId));
    expect(folders.map((f) => f.path).sort()).toEqual(["Clients", "Clients/Smith", "Important", "Inbox", "No label (archived)", "Sent", "Starred"].sort());
    const msgs = await db.withFirm(x.avery, (s) => listMessages(s, { status: "all" }));
    const by = (subj: string) => msgs.find((m) => m.subject === subj)!;
    expect(msgs.map((m) => m.subject).sort()).toEqual(["Archived newsletter", "Re: Smith v. Acme — notice", "Smith timeline", "Smith v. Acme — notice"]);
    expect(by("Smith v. Acme — notice")).toMatchObject({ folderPath: "Inbox", isRead: false, hasAttachments: true, fromAddress: "opposing@biglaw.example" });
    expect(by("Smith timeline").folderPath).toBe("Clients/Smith");
    expect(by("Archived newsletter").folderPath).toBe("No label (archived)");
    expect(by("Re: Smith v. Acme — notice").folderPath).toBe("Sent");
    // HTML mail is read as text; scripts are dropped.
    const body = (await t.admin.query("SELECT body_text FROM huis.mail_messages WHERE provider_message_id = 'g2'")).rows[0].body_text;
    expect(body).toContain("Fired on April 18");
    expect(body).not.toMatch(/alert|<script/);
    // Search works the same as Outlook.
    expect((await db.withFirm(x.avery, (s) => listMessages(s, { q: "April" }))).map((m) => m.subject)).toEqual(["Smith timeline"]);
  });

  it("later syncs use Gmail's change history: new, deleted, trashed and relabelled email", async () => {
    const x = await setup();
    await syncAll();
    g.add(msg("g8", ["INBOX"], "New hearing date"));
    g.remove("g3");
    g.relabel("g4", ["TRASH"]);
    g.relabel("g2", ["Label_1"]);
    g.calls = [];
    await db.withFirm(x.avery, (s) => requestSync(s, x.connectionId));
    await syncAll();
    expect(g.calls.some((c) => c.includes("/history?"))).toBe(true);
    expect(g.calls.some((c) => /\/messages\?/.test(c))).toBe(false);
    const live = await db.withFirm(x.avery, (s) => listMessages(s, {}));
    expect(live.map((m) => m.subject).sort()).toEqual(["New hearing date", "Smith timeline", "Smith v. Acme — notice"]);
    expect(live.find((m) => m.subject === "Smith timeline")!.folderPath).toBe("Clients");
  });

  it("imports everything again if Gmail's history has expired", async () => {
    const x = await setup();
    await syncAll();
    g.add(msg("g9", ["INBOX"], "After a long pause"));
    g.expiredBefore = g.historyId + 1;
    await db.withFirm(x.avery, (s) => requestSync(s, x.connectionId));
    await syncAll();
    expect(await subjects(x.avery)).toContain("After a long pause");
    expect((await db.withFirm(x.avery, (s) => listMailboxes(s)))[0]!.lastError).toBeNull();
  });

  it("only chosen labels: choosing different labels re-imports, and email outside them leaves Huis", async () => {
    const x = await setup();
    await syncAll();
    await db.withFirm(x.avery, (s) => updateMailbox(s, x.connectionId, { scope: "selected", manage: false, status: "active" }));
    const folders = await db.withFirm(x.avery, (s) => listMailFolders(s, x.connectionId));
    for (const f of folders) await db.withFirm(x.avery, (s) => setFolderIncluded(s, f.id, f.path === "Clients/Smith"));
    await db.withFirm(x.avery, (s) => requestSync(s, x.connectionId));
    await syncAll();
    const live = await db.withFirm(x.avery, (s) => listMessages(s, {}));
    // g1 is in Inbox and Clients/Smith: with only Clients/Smith chosen it is kept, under that label.
    expect(live.map((m) => [m.subject, m.folderPath]).sort()).toEqual([["Smith timeline", "Clients/Smith"], ["Smith v. Acme — notice", "Clients/Smith"]]);
  });

  it("files the original Gmail message exactly as Google holds it", async () => {
    const x = await setup();
    await syncAll();
    const m = (await db.withFirm(x.avery, (s) => listMessages(s, { q: "notice" }))).find((y) => y.subject === "Smith v. Acme — notice")!;
    const folder = (await db.withFirm(x.owner, (s) => listMatterFolders(s, x.matter.id))).find((f) => f.name === "Correspondence")!;
    await db.withFirm(x.avery, (s) => fileMessage(s, m.id, { matterId: x.matter.id, folderId: folder.id }));
    expect(await mail.fileOnce()).toBe(true);
    const filed = (await db.withFirm(x.avery, (s) => listMessages(s, { status: "filed" })))[0]!;
    const ev = (await db.withFirm(x.avery, (s) => getEvidence(s, filed.filedEvidenceId!)))!;
    const original = g.messages.find((y) => y.id === "g1")!.mime;
    expect(ev.sha256).toBe((await import("node:crypto")).createHash("sha256").update(original).digest("hex"));
    const custody = (await t.admin.query("SELECT details FROM huis.evidence_custody_events WHERE evidence_id = $1 AND event = 'filed_from_mailbox'", [ev.id])).rows[0];
    expect(custody.details).toMatchObject({ provider: "google", mailbox: "avery@gmail-firm.example", internet_message_id: "<g1@mail.gmail.example>" });
  });

  it("an expired Google grant marks the mailbox for reconnecting", async () => {
    const x = await setup();
    g.refreshError = "invalid_grant";
    await syncAll();
    expect((await db.withFirm(x.avery, (s) => listMailboxes(s)))[0]!.status).toBe("needs_reconnect");
  });

  it("refuses unexpected paging tokens from the mail service, and only ever talks to Gmail", async () => {
    const x = await setup();
    g.pageTokenOverride = "https://evil.example/steal";
    await syncAll();
    const mb = (await db.withFirm(x.avery, (s) => listMailboxes(s)))[0]!;
    // The sync stops with an error rather than following it or silently skipping mail.
    expect(mb.lastError).toMatch(/page token/);
    expect(g.calls.every((c) => c.startsWith("/gmail/v1/users/me/"))).toBe(true);
    const link = (await t.admin.query("SELECT delta_link FROM huis.mail_folders WHERE connection_id = $1 AND provider_folder_id = 'HUIS_NO_LABEL'", [x.connectionId])).rows[0].delta_link;
    expect(link ?? "").not.toContain("evil");
  });

  it("Gmail mail is as private as Outlook mail: firm owners can't see it", async () => {
    const x = await setup();
    await syncAll();
    expect(await db.withFirm(x.owner, (s) => listMessages(s, { status: "all" }))).toEqual([]);
    expect((await t.admin.query("SELECT count(*)::int AS n FROM huis.mail_messages WHERE connection_id = $1", [x.connectionId])).rows[0].n).toBe(4);
    void randomUUID;
  });
});

describe("reading Gmail messages", () => {
  it("handles hostile or odd messages safely", () => {
    const m = toMailMessage({
      id: "x1", threadId: "t1", labelIds: ["INBOX", "../evil"], internalDate: "not a number", snippet: "a\u0000b",
      payload: { headers: [{ name: "From", value: "\"Eve, Esq.\" <eve@evil.example>" }, { name: "To", value: "a@x.example, \"B, Jr\" <b@y.example>" }, { name: "Subject", value: "Hi\u0000there" }],
        mimeType: "multipart/mixed", parts: [{ mimeType: "text/plain", body: { data: Buffer.from("plain").toString("base64url") } }] },
    });
    expect(m).toMatchObject({ removed: false, fromAddress: "eve@evil.example", fromName: "Eve, Esq.", to: ["a@x.example", "b@y.example"], subject: "Hithere", preview: "ab", receivedAt: null, body: "plain" });
    expect((m as { labels: string[] }).labels).toEqual(["INBOX"]);
    // Deeply nested parts don't blow up.
    let deep: { mimeType: string; parts?: unknown[] } = { mimeType: "text/plain" };
    for (let i = 0; i < 5000; i++) deep = { mimeType: "multipart/mixed", parts: [deep] };
    expect(() => toMailMessage({ id: "x2", payload: deep as never })).not.toThrow();
  });
});
