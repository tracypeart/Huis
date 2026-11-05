import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { openCredential } from "../src/mail/credentials";
import { mailboxAuthorizeUrl } from "../src/mail/microsoft";
import { credentialId } from "../src/integrations/credentials";
import { downloadHostAllowed, ONEDRIVE_SCOPES } from "../src/integrations/onedrive";
import { INTEGRATIONS } from "../src/integrations/registry";
import { IntegrationWorker } from "../src/integrations/worker";
import { createClient } from "../src/services/clients";
import {
  browse, connectIntegration, disconnectIntegration, importFiles, integrationHub, listImports, listMyConnections, matterSyncRecords,
} from "../src/services/integrations";
import { addMatterMember, createMatter, listMatterFolders, removeMatterMember } from "../src/services/matters";
import { inviteUser } from "../src/services/users";
import { MasterKeyProvider } from "../src/storage/encryption";
import { EvidenceVault, LocalObjectStore } from "../src/storage/store";
import { CLIENT_ID, FakeMicrosoft, OID, TID } from "./fake-microsoft";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

let t: TestDatabase;
let db: HuisDb;
let vault: EvidenceVault;
let vaultDir: string;
let ms: FakeMicrosoft;
let hub: IntegrationWorker;
const MASTER = Buffer.alloc(32, 9).toString("base64");
const SUBJECT = `${TID}:${OID}`;

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-integrations-vault-"));
  vault = new EvidenceVault(new LocalObjectStore(vaultDir), new MasterKeyProvider(MASTER));
  ms = new FakeMicrosoft();
  await ms.start();
  process.env.HUIS_MS_LOGIN_BASE = ms.base;
  process.env.HUIS_GRAPH_BASE = `${ms.base}/v1.0`;
  hub = new IntegrationWorker(t.worker, vault, { masterKey: MASTER, microsoft: { clientId: CLIENT_ID, clientSecret: "secret" } });
});

afterAll(async () => {
  ms?.server.close();
  await t?.drop();
  if (vaultDir) await rm(vaultDir, { recursive: true, force: true });
});

beforeEach(() => {
  ms.drive = {
    "D1-root": { id: "D1-root", drive: "D1", name: "root", parent: null, folder: true },
    "F-smith": { id: "F-smith", drive: "D1", name: "Smith", parent: "D1-root", folder: true, path: "/drive/root:" },
    "I-memo": { id: "I-memo", drive: "D1", name: "Termination memo.txt", parent: "D1-root", content: "Fired April 18, two days after the FMLA request.", mime: "text/plain", path: "/drive/root:" },
    "I-photo": { id: "I-photo", drive: "D1", name: "Text messages.txt", parent: "F-smith", content: "Manager: don't bother coming back.", mime: "text/plain", path: "/drive/root:/Smith" },
    "b!SP1-root": { id: "b!SP1-root", drive: "b!SP1", name: "Documents", parent: null, folder: true },
    "SP-brief": { id: "SP-brief", drive: "b!SP1", name: "Brief bank.txt", parent: "b!SP1-root", content: "Retaliation brief.", mime: "text/plain", path: "/drive/root:" },
  };
  ms.downloadAuth = [];
  ms.downloadRedirect = null;
  ms.rotateTo = null;
  ms.refreshError = null;
});

async function setup() {
  const f = await newFirm(db);
  const x = await db.withFirm(f.owner, async (s) => {
    const client = await createClient(s, { kind: "person", displayName: "Pat Smith" });
    const attorney = await inviteUser(s, { email: `avery@${f.slug}.example`, fullName: "Avery Attorney", role: "attorney", locationId: f.locationId });
    const assistant = await inviteUser(s, { email: `sam@${f.slug}.example`, fullName: "Sam Assistant", role: "legal_assistant", locationId: f.locationId });
    const portal = await inviteUser(s, { email: `pat@${f.slug}.example`, fullName: "Pat Smith", role: "client", locationId: f.locationId });
    const reader = await inviteUser(s, { email: `rio@${f.slug}.example`, fullName: "Rio Reader", role: "read_only", locationId: f.locationId });
    const matter = await createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
    const walled = await createMatter(s, { title: "Walled", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT", restricted: true });
    return { attorney, assistant, portal, reader, matter, walled };
  });
  const ctx = (id: string): RequestContext => ({ firmId: f.firmId, userId: id });
  const avery = ctx(x.attorney.id);
  const connectionId = await db.withFirm(avery, (s) => connectIntegration(s, {
    provider: "onedrive", subject: SUBJECT, tenant: TID, label: "avery@lawfirm.example", refreshToken: "RT-1", masterKey: MASTER,
  }));
  const folders = await db.withFirm(avery, (s) => listMatterFolders(s, x.matter.id));
  const correspondence = folders.find((g) => g.name === "Correspondence")!;
  const shared = folders.find((g) => g.classification === "client_accessible" && !g.isPrivilegedArea)!;
  return { ...f, ...x, avery, sam: ctx(x.assistant.id), pat: ctx(x.portal.id), rio: ctx(x.reader.id), connectionId, correspondence, shared };
}

async function drain() {
  while (await hub.runOnce()) { /* until idle */ }
}

/** Opens a folder the way the page does: ask, let the worker list it, read it back. */
async function open(who: RequestContext, connectionId: string, location = "root") {
  await db.withFirm(who, (s) => browse(s, connectionId, location));
  await drain();
  return db.withFirm(who, (s) => browse(s, connectionId, location));
}

const evidenceIn = async (matterId: string) =>
  (await t.admin.query("SELECT id, original_filename, source::text AS source, sha256, size_bytes, received_from FROM huis.evidence_items WHERE matter_id = $1 ORDER BY uploaded_at", [matterId])).rows;

describe("the Integration Hub", () => {
  it("lists every planned system and its status; only OneDrive is available in this part", async () => {
    const x = await setup();
    const entries = await db.withFirm(x.avery, (s) => integrationHub(s));
    expect(entries.map((e) => e.provider)).toEqual(["onedrive", "google_drive", "dropbox", "filevine", "clio", "strongsuit"]);
    expect(entries.find((e) => e.provider === "onedrive")).toMatchObject({ status: "available" });
    expect(entries.find((e) => e.provider === "onedrive")!.connections).toHaveLength(1);
    expect(INTEGRATIONS.find((i) => i.provider === "strongsuit")).toMatchObject({ status: "needs_agreement" });
    // Clients can't use the hub at all.
    await expect(db.withFirm(x.pat, (s) => integrationHub(s))).rejects.toThrow(/permission|not allowed/i);
  });

  it("asks Microsoft for read-only file access, not mail", () => {
    const url = new URL(mailboxAuthorizeUrl({ clientId: CLIENT_ID, redirectUri: "http://localhost:3000/cb", state: "s", nonce: "n", verifier: "v".repeat(48), scopes: ONEDRIVE_SCOPES }));
    expect(url.searchParams.get("scope")).toBe("openid profile email offline_access User.Read Files.Read.All");
    expect(url.searchParams.get("scope")).not.toMatch(/Mail|ReadWrite/);
  });
});

describe("connecting OneDrive", () => {
  it("seals the sign-in token under an integration label the app can't read, and the connection is the owner's alone", async () => {
    const x = await setup();
    const row = (await t.admin.query("SELECT ciphertext FROM huis.integration_credentials WHERE connection_id = $1", [x.connectionId])).rows[0];
    expect(row.ciphertext.toString("latin1")).not.toContain("RT-1");
    expect(openCredential(MASTER, credentialId(x.firmId, "onedrive", SUBJECT), row.ciphertext)).toBe("RT-1");
    // A mailbox token label can't open it (and can't be swapped in).
    expect(() => openCredential(MASTER, { firmId: x.firmId, provider: "microsoft", subject: SUBJECT }, row.ciphertext)).toThrow();
    await expect(db.withFirm(x.avery, (s) => s.client.query("SELECT * FROM huis.integration_credentials"))).rejects.toThrow(/permission/);
    // Not even the firm owner sees someone else's connection.
    expect(await db.withFirm(x.owner, (s) => listMyConnections(s))).toHaveLength(0);
    await expect(db.withFirm(x.owner, (s) => browse(s, x.connectionId))).rejects.toThrow(/not found/i);
    // A colleague can't take over a working connection (one Microsoft has accepted).
    await open(x.avery, x.connectionId);
    await expect(db.withFirm(x.sam, (s) => connectIntegration(s, {
      provider: "onedrive", subject: SUBJECT, tenant: TID, label: "x", refreshToken: "RT-evil", masterKey: MASTER,
    }))).rejects.toThrow(/already connected/);
    // Read-only staff and clients can't connect.
    await expect(db.withFirm(x.rio, (s) => connectIntegration(s, {
      provider: "onedrive", subject: "other", tenant: null, label: null, refreshToken: "RT", masterKey: MASTER,
    }))).rejects.toThrow(/permission|not allowed/i);
    // The app can't write connections directly.
    await expect(db.withFirm(x.avery, (s) => s.client.query("UPDATE huis.integration_connections SET owner_user_id = owner_user_id"))).rejects.toThrow(/permission/);
  });
});

describe("browsing", () => {
  it("lists My files, folders, followed SharePoint sites and their libraries — names and sizes only", async () => {
    const x = await setup();
    const first = await db.withFirm(x.avery, (s) => browse(s, x.connectionId));
    expect(first.status).toBe("queued");
    const root = await open(x.avery, x.connectionId);
    expect(root).toMatchObject({ status: "ready", title: "My files", parent: null });
    expect(root.items.map((i) => [i.kind, i.name])).toEqual([["site", "SharePoint sites you follow"], ["folder", "Smith"], ["file", "Termination memo.txt"]]);
    expect(JSON.stringify(root.items)).not.toContain("FMLA");
    const smith = await open(x.avery, x.connectionId, "drive:D1:F-smith");
    expect(smith).toMatchObject({ title: "Smith", parent: "drive:D1:D1-root" });
    expect(smith.items.map((i) => i.name)).toEqual(["Text messages.txt"]);
    const sites = await open(x.avery, x.connectionId, "sites");
    expect(sites.items).toEqual([{ id: "site:contoso.sharepoint.com,1111,2222", kind: "site", name: "Litigation" }]);
    const libs = await open(x.avery, x.connectionId, "site:contoso.sharepoint.com,1111,2222");
    expect(libs.items).toMatchObject([{ id: "drive:b!SP1:root", kind: "folder", name: "Documents" }]);
    const docs = await open(x.avery, x.connectionId, "drive:b!SP1:root");
    expect(docs.items.map((i) => i.name)).toEqual(["Brief bank.txt"]);
  });

  it("refuses folder ids that aren't the provider's shape", async () => {
    const x = await setup();
    for (const bad of ["../me", "drive:..:..", "drive:D1:..", "site:.", "drive:D1:a/b", "drive:D1:x?$expand=*", "https://evil.example/x", "site:a b"]) {
      await expect(db.withFirm(x.avery, (s) => browse(s, x.connectionId, bad))).rejects.toThrow(/not found/i);
      await expect(db.withFirm(x.avery, (s) => s.client.query("SELECT huis.request_integration_listing($1, $2)", [x.connectionId, bad]))).rejects.toThrow(/invalid folder/);
    }
  });
});

describe("importing into a Matter", () => {
  it("copies the file as evidence, with its source, version and path in the chain of custody and a sync record", async () => {
    const x = await setup();
    await open(x.avery, x.connectionId);
    const r = await db.withFirm(x.avery, (s) => importFiles(s, x.connectionId, {
      matterId: x.matter.id, folderId: x.correspondence.id, items: ["drive:D1:I-memo"],
    }));
    expect(r).toEqual({ queued: 1, already: 0 });
    await drain();
    const ev = await evidenceIn(x.matter.id);
    expect(ev).toHaveLength(1);
    const content = "Fired April 18, two days after the FMLA request.";
    expect(ev[0]).toMatchObject({ original_filename: "Termination memo.txt", source: "integration", size_bytes: String(Buffer.byteLength(content)),
      sha256: createHash("sha256").update(content).digest("hex"), received_from: "OneDrive / SharePoint (avery@lawfirm.example)" });
    const custody = (await t.admin.query("SELECT event, details FROM huis.evidence_custody_events WHERE evidence_id = $1 ORDER BY id", [ev[0].id])).rows;
    expect(custody.map((c) => c.event)).toEqual(["received", "imported_from_integration"]);
    expect(custody[1].details).toMatchObject({ system: "onedrive", external_id: "drive:D1:I-memo", version: "c-I-memo-1", path: "/Termination memo.txt", tenant: TID });
    // The download link was fetched without the Microsoft token.
    expect(ms.downloadAuth).toEqual([]);
    const records = await db.withFirm(x.avery, (s) => matterSyncRecords(s, x.matter.id));
    expect(records).toMatchObject([{ system: "onedrive", externalId: "drive:D1:I-memo", internalType: "evidence", internalId: ev[0].id, direction: "import", status: "synced" }]);
    expect((await db.withFirm(x.avery, (s) => listImports(s, x.connectionId)))[0]).toMatchObject({ status: "done", evidenceId: ev[0].id });
  });

  it("imports the same version once; a changed file is imported again as its new version", async () => {
    const x = await setup();
    await open(x.avery, x.connectionId);
    const req = () => db.withFirm(x.avery, (s) => importFiles(s, x.connectionId, { matterId: x.matter.id, folderId: x.correspondence.id, items: ["drive:D1:I-memo"] }));
    await req();
    // Asking twice while it waits queues it once.
    expect(await req()).toEqual({ queued: 0, already: 1 });
    await drain();
    await req();
    await drain();
    expect(await evidenceIn(x.matter.id)).toHaveLength(1);
    expect((await db.withFirm(x.avery, (s) => listImports(s, x.connectionId)))[0]).toMatchObject({ status: "skipped", error: "this version is already in the Matter" });
    ms.drive["I-memo"]!.content = "Fired April 18. (Edited: and the manager knew.)";
    ms.drive["I-memo"]!.ctag = "c-I-memo-2";
    await req();
    await drain();
    expect(await evidenceIn(x.matter.id)).toHaveLength(2);
  });

  it("only files the worker listed in this connection can be imported (not folders, not invented ids)", async () => {
    const x = await setup();
    await open(x.avery, x.connectionId);
    const go = (items: string[]) => db.withFirm(x.avery, (s) => importFiles(s, x.connectionId, { matterId: x.matter.id, folderId: x.correspondence.id, items }));
    await expect(go(["drive:D1:I-photo"])).rejects.toThrow(/Choose files from the list/); // not listed yet
    await expect(go(["drive:D1:F-smith"])).rejects.toThrow(/Choose files from the list/); // a folder
    await expect(go(["sites"])).rejects.toThrow(/Choose files from the list/);
    expect(await evidenceIn(x.matter.id)).toHaveLength(0);
  });

  it("needs edit access to the Matter, and the privilege acknowledgement for a folder shared outside the firm", async () => {
    const x = await setup();
    await open(x.avery, x.connectionId);
    await expect(db.withFirm(x.avery, (s) => importFiles(s, x.connectionId, {
      matterId: x.walled.id, folderId: x.correspondence.id, items: ["drive:D1:I-memo"] }))).rejects.toThrow(/permission|not allowed/i);
    await expect(db.withFirm(x.avery, (s) => importFiles(s, x.connectionId, {
      matterId: x.matter.id, folderId: x.shared.id, items: ["drive:D1:I-memo"] }))).rejects.toThrow(/waive privilege/);
    expect(await db.withFirm(x.avery, (s) => importFiles(s, x.connectionId, {
      matterId: x.matter.id, folderId: x.shared.id, items: ["drive:D1:I-memo"], acknowledgePrivilegeWaiverRisk: true }))).toEqual({ queued: 1, already: 0 });
    await drain();
    const ev = await evidenceIn(x.matter.id);
    const custody = (await t.admin.query("SELECT details FROM huis.evidence_custody_events WHERE evidence_id = $1 AND event = 'imported_from_integration'", [ev[0].id])).rows[0];
    expect(custody.details).toMatchObject({ shared_outside_firm: true, privilege_waiver_acknowledged: true });
  });

  it("is checked again when the worker runs: losing Matter access or disconnecting cancels waiting imports", async () => {
    const x = await setup();
    await db.withFirm(x.owner, (s) => addMatterMember(s, { matterId: x.walled.id, userId: x.attorney.id, access: "edit" }));
    await open(x.avery, x.connectionId);
    const walledFolder = (await db.withFirm(x.avery, (s) => listMatterFolders(s, x.walled.id))).find((f) => f.name === "Correspondence")!;
    await db.withFirm(x.avery, (s) => importFiles(s, x.connectionId, { matterId: x.walled.id, folderId: walledFolder.id, items: ["drive:D1:I-memo"] }));
    await db.withFirm(x.owner, (s) => removeMatterMember(s, x.walled.id, x.attorney.id));
    await drain();
    expect(await evidenceIn(x.walled.id)).toHaveLength(0);
    expect((await t.admin.query("SELECT status, last_error FROM huis.integration_imports WHERE matter_id = $1", [x.walled.id])).rows[0])
      .toMatchObject({ status: "failed", last_error: "the requester no longer has access" });

    await db.withFirm(x.avery, (s) => importFiles(s, x.connectionId, { matterId: x.matter.id, folderId: x.correspondence.id, items: ["drive:D1:I-memo"] }));
    await db.withFirm(x.avery, (s) => disconnectIntegration(s, x.connectionId));
    await drain();
    expect(await evidenceIn(x.matter.id)).toHaveLength(0);
    expect((await t.admin.query("SELECT count(*)::int n FROM huis.integration_credentials WHERE connection_id = $1", [x.connectionId])).rows[0].n).toBe(0);
    expect((await t.admin.query("SELECT count(*)::int n FROM huis.integration_listings WHERE connection_id = $1", [x.connectionId])).rows[0].n).toBe(0);
    await expect(db.withFirm(x.avery, (s) => browse(s, x.connectionId))).rejects.toThrow(/not found/i);
  });

  it("the app can't create 'integration' evidence or sync records itself", async () => {
    const x = await setup();
    await expect(db.withFirm(x.avery, (s) => s.client.query(
      `INSERT INTO huis.evidence_items (firm_id, matter_id, folder_id, original_filename, declared_content_type, size_bytes, sha256, storage_key, source, uploaded_by)
       VALUES ($1, $2, $3, 'x.txt', 'text/plain', 1, repeat('a', 64), 'k', 'integration', $4)`,
      [x.firmId, x.matter.id, x.correspondence.id, x.attorney.id]))).rejects.toThrow(/row-level security|permission/);
    await expect(db.withFirm(x.avery, (s) => s.client.query(
      `INSERT INTO huis.sync_records (firm_id, matter_id, external_system, external_record_id, internal_type, internal_id, sync_direction, sync_status)
       VALUES ($1, $2, 'onedrive', 'x', 'evidence', $3, 'import', 'synced')`, [x.firmId, x.matter.id, randomUUID()]))).rejects.toThrow(/permission/);
  });
});

describe("tokens and downloads", () => {
  it("never follows a download link to a host that isn't Microsoft's", async () => {
    expect(downloadHostAllowed("https://contoso.sharepoint.com/_layouts/15/download.aspx?x=1")).toBe(true);
    expect(downloadHostAllowed("https://public.am.files.1drv.com/y4m")).toBe(true);
    expect(downloadHostAllowed("https://sharepoint.com.evil.example/x")).toBe(false);
    expect(downloadHostAllowed("http://contoso.sharepoint.com/x")).toBe(false);
    expect(downloadHostAllowed("https://user:pw@contoso.sharepoint.com/x")).toBe(false);
    const x = await setup();
    await open(x.avery, x.connectionId);
    ms.downloadRedirect = () => "https://evil.example/steal";
    await db.withFirm(x.avery, (s) => importFiles(s, x.connectionId, { matterId: x.matter.id, folderId: x.correspondence.id, items: ["drive:D1:I-memo"] }));
    await hub.importOnce();
    expect((await t.admin.query("SELECT status, last_error FROM huis.integration_imports WHERE connection_id = $1", [x.connectionId])).rows[0])
      .toMatchObject({ status: "queued", last_error: "unexpected download link" });
    expect(await evidenceIn(x.matter.id)).toHaveLength(0);
  });

  it("saves a rotated refresh token, and marks the connection for reconnecting when Microsoft refuses it", async () => {
    const x = await setup();
    ms.rotateTo = "RT-2";
    await open(x.avery, x.connectionId);
    const row = (await t.admin.query("SELECT ciphertext FROM huis.integration_credentials WHERE connection_id = $1", [x.connectionId])).rows[0];
    expect(openCredential(MASTER, credentialId(x.firmId, "onedrive", SUBJECT), row.ciphertext)).toBe("RT-2");
    ms.refreshError = "invalid_grant";
    const l = await db.withFirm(x.avery, (s) => browse(s, x.connectionId, "drive:D1:F-smith"));
    expect(l.status).toBe("queued");
    await drain();
    expect((await db.withFirm(x.avery, (s) => listMyConnections(s)))[0]).toMatchObject({ status: "needs_reconnect" });
    // The worker can't save credentials for work it doesn't hold.
    await expect(t.worker.query("SELECT huis.worker_save_integration_credentials('listing', $1, $2, $3)",
      [randomUUID(), randomUUID(), Buffer.from("x")])).rejects.toThrow(/not held/);
  });
});

describe("review 20 (OneDrive)", () => {
  it("R20-1: a token for a different Microsoft account than the one recorded is never used, and the connection isn't verified", async () => {
    const x = await setup();
    ms.meId = "99999999-9999-9999-9999-999999999999";
    try {
      const l = await open(x.avery, x.connectionId);
      expect(l.status).toBe("failed");
      expect((await db.withFirm(x.avery, (s) => listMyConnections(s)))[0]).toMatchObject({ status: "needs_reconnect" });
      expect((await t.admin.query("SELECT verified_at FROM huis.integration_connections WHERE id = $1", [x.connectionId])).rows[0].verified_at).toBeNull();
    } finally {
      ms.meId = OID;
    }
  });
});
