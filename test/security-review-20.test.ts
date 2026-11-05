import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { sealCredential } from "../src/mail/credentials";
import { credentialId } from "../src/integrations/credentials";
import { DropboxSource } from "../src/integrations/dropbox";
import { IntegrationWorker } from "../src/integrations/worker";
import { createClient } from "../src/services/clients";
import { browse, connectIntegration, importFiles, listMyConnections } from "../src/services/integrations";
import { createMatter, listMatterFolders } from "../src/services/matters";
import { inviteUser } from "../src/services/users";
import { MasterKeyProvider } from "../src/storage/encryption";
import { EvidenceVault, LocalObjectStore } from "../src/storage/store";
import { DBX_ACCOUNT, FakeDropbox } from "./fake-dropbox";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

/**
 * Security review 20 — Phase 9 part 2a (Dropbox in the Integration Hub).
 * Each "R20-N" test asserts the secure behaviour and fails against the code as reviewed.
 */

let t: TestDatabase;
let db: HuisDb;
let vault: EvidenceVault;
let vaultDir: string;
let dbx: FakeDropbox;
let hub: IntegrationWorker;
const MASTER = Buffer.alloc(32, 13).toString("base64");
const SAMS_OWN_ACCOUNT = "dbid:AAsamOwnDropboxAccount0000000000000";

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-r20-vault-"));
  vault = new EvidenceVault(new LocalObjectStore(vaultDir), new MasterKeyProvider(MASTER));
  dbx = new FakeDropbox();
  await dbx.start();
  process.env.HUIS_DROPBOX_AUTH_BASE = dbx.base;
  process.env.HUIS_DROPBOX_API_BASE = dbx.base;
  process.env.HUIS_DROPBOX_CONTENT_BASE = dbx.base;
  hub = new IntegrationWorker(t.worker, vault, { masterKey: MASTER, microsoft: null, dropbox: { clientId: "dbx-key", clientSecret: "dbx-secret" } });
});

afterAll(async () => {
  dbx?.server.close();
  await t?.drop();
  if (vaultDir) await rm(vaultDir, { recursive: true, force: true });
});

beforeEach(() => {
  dbx.entries = [
    { id: "id:folderSmith01", name: "Smith", path: "/Clients/Smith", folder: true },
    { id: "id:folderClients", name: "Clients", path: "/Clients", folder: true },
    { id: "id:fileMemo00001", name: "Termination memo.txt", path: "/Clients/Smith/Termination memo.txt", content: "Fired April 18.", rev: "015f0e1a2b3c4d5e6f0001" },
    { id: "id:fileTop000001", name: "Retainer.pdf", path: "/Retainer.pdf", content: "%PDF-retainer", rev: "0aa0000000001" },
  ];
  dbx.grantedScope = "account_info.read files.metadata.read files.content.read";
  dbx.tokenAccountId = null;
  dbx.refreshError = null;
  dbx.beforeDownload = null;
  dbx.calls = [];
  dbx.pageSize = 500;
  dbx.refreshTokens = {};
  dbx.accessAccounts = {};
});

async function setup() {
  const f = await newFirm(db);
  const x = await db.withFirm(f.owner, async (s) => {
    const client = await createClient(s, { kind: "person", displayName: "Pat Smith" });
    const attorney = await inviteUser(s, { email: `avery@${f.slug}.example`, fullName: "Avery Attorney", role: "attorney", locationId: f.locationId });
    const assistant = await inviteUser(s, { email: `sam@${f.slug}.example`, fullName: "Sam Assistant", role: "legal_assistant", locationId: f.locationId });
    const matter = await createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
    return { attorney, assistant, matter };
  });
  const ctx = (id: string): RequestContext => ({ firmId: f.firmId, userId: id });
  return { ...f, ...x, avery: ctx(x.attorney.id), sam: ctx(x.assistant.id) };
}

async function drain() { while (await hub.runOnce()) { /* until idle */ } }

describe("security review 20", () => {
  it("R20-1: a colleague can't lock someone out of their Dropbox by squatting the account id with a working token for a different account", async () => {
    const x = await setup();
    // Sam has his own, perfectly valid Dropbox sign-in...
    dbx.refreshTokens["DBX-RT-SAM"] = "DBX-AT-SAM";
    dbx.accessAccounts["DBX-AT-SAM"] = SAMS_OWN_ACCOUNT;
    // ...and records it under Avery's Dropbox account id (visible to anyone she shares a folder with), before she connects.
    const sealed = sealCredential(MASTER, credentialId(x.firmId, "dropbox", DBX_ACCOUNT), "DBX-RT-SAM");
    const squat = (await db.withFirm(x.sam, (s) => s.client.query(
      "SELECT huis.connect_integration('dropbox', $1, NULL, 'avery@lawfirm.example', $2) AS id", [DBX_ACCOUNT, sealed]))).rows[0].id as string;
    expect(squat).toBeTruthy();
    // The worker lists "Avery's" Dropbox with Sam's token: Dropbox accepts the token, so the connection is marked as verified.
    await db.withFirm(x.sam, (s) => browse(s, squat, "root"));
    await drain();
    const listed = (await t.admin.query("SELECT status FROM huis.integration_listings WHERE connection_id = $1", [squat])).rows[0];
    // Secure: a token that isn't the recorded account's is refused, and doesn't count as Dropbox accepting the connection...
    expect(listed.status).not.toBe("ready");
    // ...so Avery, signing in with her own Dropbox, gets her account (R19-1's rule).
    await expect(db.withFirm(x.avery, (s) => connectIntegration(s, {
      provider: "dropbox", subject: DBX_ACCOUNT, tenant: null, label: "avery@lawfirm.example", refreshToken: "DBX-RT-1", masterKey: MASTER,
    }))).resolves.toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // What held up
  // -------------------------------------------------------------------------
  it("holds: the same squat with a made-up token is taken over by the real owner (R19-1 kept by 0025)", async () => {
    const x = await setup();
    await db.withFirm(x.sam, (s) => s.client.query("SELECT huis.connect_integration('dropbox', $1, NULL, 'sam', $2)", [DBX_ACCOUNT, Buffer.from("junk")]));
    await expect(db.withFirm(x.avery, (s) => connectIntegration(s, {
      provider: "dropbox", subject: DBX_ACCOUNT, tenant: null, label: "avery", refreshToken: "DBX-RT-1", masterKey: MASTER,
    }))).resolves.toBeTruthy();
  });

  it("holds: an endless listing (has_more forever) stops after a bounded number of pages", async () => {
    dbx.pageSize = 0;
    await expect(new DropboxSource("DBX-AT").list("root")).rejects.toThrow(/did not finish/);
    expect(dbx.calls.filter((c) => c.path.startsWith("/2/files/list_folder")).length).toBeLessThanOrEqual(21);
  });

  it("holds: download arguments are ASCII JSON of an id or a hex revision only; odd versions fall back to the id", async () => {
    const src = new DropboxSource("DBX-AT");
    for (const v of ['0aa0000000001"}\r\nx-evil: 1', "rev:../x", "ünï", null]) {
      dbx.calls = [];
      await (await src.download("dbx:id:fileTop000001", v)).resume();
      const arg = dbx.calls.find((c) => c.path === "/2/files/download")!.arg!;
      expect(arg).toBe(JSON.stringify({ path: "id:fileTop000001" }));
    }
    await expect(src.download("dbx:/Clients/Smith")).rejects.toThrow(/unknown file/);
    await expect(src.download("dbx:id:a/../b")).rejects.toThrow(/unknown file/);
  });

  it("holds: a missing file fails just that import; only a refused refresh asks to reconnect (R19-4)", async () => {
    const x = await setup();
    const id = await db.withFirm(x.avery, (s) => connectIntegration(s, {
      provider: "dropbox", subject: DBX_ACCOUNT, tenant: null, label: "avery", refreshToken: "DBX-RT-1", masterKey: MASTER,
    }));
    await db.withFirm(x.avery, (s) => browse(s, id, "root"));
    await drain();
    const folder = (await db.withFirm(x.avery, (s) => listMatterFolders(s, x.matter.id))).find((g) => g.name === "Correspondence")!;
    await db.withFirm(x.avery, (s) => importFiles(s, id, { matterId: x.matter.id, folderId: folder.id, items: ["dbx:id:fileTop000001"] }));
    dbx.refreshError = "invalid_client";
    await drain();
    expect((await db.withFirm(x.avery, (s) => listMyConnections(s)))[0]).toMatchObject({ status: "active" });
  });

  it("holds: OneDrive ids can't be listed on a Dropbox connection and Dropbox ids can't be imported on OneDrive", async () => {
    const x = await setup();
    const id = await db.withFirm(x.avery, (s) => connectIntegration(s, {
      provider: "dropbox", subject: DBX_ACCOUNT, tenant: null, label: "avery", refreshToken: "DBX-RT-1", masterKey: MASTER,
    }));
    for (const bad of ["site:a,b", "drive:D1:root", "dbx:id:..", "dbx:id:x:..", "root/x"]) {
      await expect(db.withFirm(x.avery, (s) => s.client.query("SELECT huis.request_integration_listing($1, $2)", [id, bad]))).rejects.toThrow(/invalid folder/);
    }
  });
});
