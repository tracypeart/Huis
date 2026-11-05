import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { openCredential } from "../src/mail/credentials";
import { credentialId } from "../src/integrations/credentials";
import { completeDropboxConnect, DROPBOX_SCOPES, dropboxAuthorizeUrl } from "../src/integrations/dropbox";
import { IntegrationWorker } from "../src/integrations/worker";
import { createClient } from "../src/services/clients";
import { browse, connectIntegration, importFiles, integrationHub, listMyConnections, matterSyncRecords } from "../src/services/integrations";
import { createMatter, listMatterFolders } from "../src/services/matters";
import { inviteUser } from "../src/services/users";
import { MasterKeyProvider } from "../src/storage/encryption";
import { EvidenceVault, LocalObjectStore } from "../src/storage/store";
import { DBX_ACCOUNT, FakeDropbox } from "./fake-dropbox";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

let t: TestDatabase;
let db: HuisDb;
let vault: EvidenceVault;
let vaultDir: string;
let dbx: FakeDropbox;
let hub: IntegrationWorker;
const MASTER = Buffer.alloc(32, 11).toString("base64");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const REV1 = "015f0e1a2b3c4d5e6f0001";
const REV2 = "015f0e1a2b3c4d5e6f0002";

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-dropbox-vault-"));
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
    { id: "id:fileMemo00001", name: "Termination memo.txt", path: "/Clients/Smith/Termination memo.txt", content: "Fired April 18, two days after FMLA.", rev: REV1 },
    { id: "id:fileTop000001", name: "Retainer – Smith.pdf", path: "/Retainer – Smith.pdf", content: "%PDF-retainer", rev: "0aa0000000001" },
  ];
  dbx.grantedScope = "account_info.read files.metadata.read files.content.read";
  dbx.tokenAccountId = null;
  dbx.refreshError = null;
  dbx.beforeDownload = null;
  dbx.calls = [];
  dbx.pageSize = 500;
});

async function setup() {
  const f = await newFirm(db);
  const x = await db.withFirm(f.owner, async (s) => {
    const client = await createClient(s, { kind: "person", displayName: "Pat Smith" });
    const attorney = await inviteUser(s, { email: `avery@${f.slug}.example`, fullName: "Avery Attorney", role: "attorney", locationId: f.locationId });
    const portal = await inviteUser(s, { email: `pat@${f.slug}.example`, fullName: "Pat Smith", role: "client", locationId: f.locationId });
    const matter = await createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
    return { attorney, portal, matter };
  });
  const avery: RequestContext = { firmId: f.firmId, userId: x.attorney.id };
  const connectionId = await db.withFirm(avery, (s) => connectIntegration(s, {
    provider: "dropbox", subject: DBX_ACCOUNT, tenant: null, label: "avery@lawfirm.example", refreshToken: "DBX-RT-1", masterKey: MASTER,
  }));
  const correspondence = (await db.withFirm(avery, (s) => listMatterFolders(s, x.matter.id))).find((g) => g.name === "Correspondence")!;
  return { ...f, ...x, avery, connectionId, correspondence };
}

async function drain() { while (await hub.runOnce()) { /* until idle */ } }
async function open(who: RequestContext, connectionId: string, location = "root") {
  await db.withFirm(who, (s) => browse(s, connectionId, location));
  await drain();
  return db.withFirm(who, (s) => browse(s, connectionId, location));
}
const evidenceIn = async (matterId: string) =>
  (await t.admin.query("SELECT id, original_filename, sha256, received_from FROM huis.evidence_items WHERE matter_id = $1 ORDER BY uploaded_at", [matterId])).rows;

describe("connecting Dropbox", () => {
  it("asks only for read access, offline, with PKCE", () => {
    const url = new URL(dropboxAuthorizeUrl({ clientId: "dbx-key", redirectUri: "http://localhost:3000/cb", state: "s", verifier: "v".repeat(48) }));
    expect(url.searchParams.get("scope")).toBe("account_info.read files.metadata.read files.content.read");
    expect(url.searchParams.get("scope")).not.toMatch(/write|sharing/);
    expect(url.searchParams.get("token_access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(DROPBOX_SCOPES).toHaveLength(3);
  });

  it("identifies the account by Dropbox's own id and refuses a sign-in that didn't grant file access", async () => {
    const c = await completeDropboxConnect({ clientId: "dbx-key", clientSecret: "s", redirectUri: "x", code: "c", verifier: "v" });
    expect(c).toMatchObject({ subject: DBX_ACCOUNT, address: "avery@lawfirm.example", displayName: "Avery Attorney", refreshToken: "DBX-RT-1" });
    dbx.grantedScope = "account_info.read files.metadata.read";
    await expect(completeDropboxConnect({ clientId: "dbx-key", clientSecret: "s", redirectUri: "x", code: "c", verifier: "v" })).rejects.toThrow(/read access/);
    dbx.grantedScope = "account_info.read files.metadata.read files.content.read";
    dbx.tokenAccountId = "dbid:someoneElse";
    await expect(completeDropboxConnect({ clientId: "dbx-key", clientSecret: "s", redirectUri: "x", code: "c", verifier: "v" })).rejects.toThrow(/identify/);
  });

  it("is available on the hub, and its token is sealed under the integration label", async () => {
    const x = await setup();
    expect((await db.withFirm(x.avery, (s) => integrationHub(s))).find((e) => e.provider === "dropbox")).toMatchObject({ status: "available" });
    const row = (await t.admin.query("SELECT ciphertext FROM huis.integration_credentials WHERE connection_id = $1", [x.connectionId])).rows[0];
    expect(openCredential(MASTER, credentialId(x.firmId, "dropbox", DBX_ACCOUNT), row.ciphertext)).toBe("DBX-RT-1");
    expect(() => openCredential(MASTER, credentialId(x.firmId, "onedrive", DBX_ACCOUNT), row.ciphertext)).toThrow();
  });
});

describe("browsing and importing from Dropbox", () => {
  it("lists folders (with the way up) and files — names, sizes and revisions only", async () => {
    const x = await setup();
    const root = await open(x.avery, x.connectionId);
    expect(root).toMatchObject({ status: "ready", title: "Dropbox", parent: null });
    expect(root.items.map((i) => [i.kind, i.id, i.name])).toEqual([
      ["folder", "dbx:id:folderClients", "Clients"], ["file", "dbx:id:fileTop000001", "Retainer – Smith.pdf"]]);
    const smith = await open(x.avery, x.connectionId, "dbx:id:folderSmith01");
    expect(smith).toMatchObject({ title: "Smith", parent: "dbx:id:folderClients" });
    expect(smith.items).toMatchObject([{ id: "dbx:id:fileMemo00001", kind: "file", version: REV1 }]);
    expect(JSON.stringify(smith.items)).not.toContain("FMLA");
    const clients = await open(x.avery, x.connectionId, "dbx:id:folderClients");
    expect(clients.parent).toBe("root");
    // The token only ever went to Dropbox's own hosts.
    expect(dbx.calls.every((c) => c.path === "/oauth2/token" ? !c.auth : c.auth === "Bearer DBX-AT")).toBe(true);
  });

  it("imports the exact revision it recorded, as evidence with custody and a sync record", async () => {
    const x = await setup();
    await open(x.avery, x.connectionId, "dbx:id:folderSmith01");
    await db.withFirm(x.avery, (s) => importFiles(s, x.connectionId, { matterId: x.matter.id, folderId: x.correspondence.id, items: ["dbx:id:fileMemo00001"] }));
    await drain();
    const [ev] = await evidenceIn(x.matter.id);
    expect(ev).toMatchObject({ original_filename: "Termination memo.txt", sha256: sha("Fired April 18, two days after FMLA."), received_from: "Dropbox (avery@lawfirm.example)" });
    const custody = (await t.admin.query("SELECT details FROM huis.evidence_custody_events WHERE evidence_id = $1 AND event = 'imported_from_integration'", [ev.id])).rows[0];
    expect(custody.details).toMatchObject({ system: "dropbox", external_id: "dbx:id:fileMemo00001", version: REV1, path: "/Clients/Smith/Termination memo.txt" });
    expect(dbx.calls.find((c) => c.path === "/2/files/download")?.arg).toBe(JSON.stringify({ path: `rev:${REV1}` }));
    expect(await db.withFirm(x.avery, (s) => matterSyncRecords(s, x.matter.id))).toMatchObject([{ system: "dropbox", version: REV1, direction: "import" }]);
  });

  it("a file saved again while being copied: the record always matches the bytes (review 19, R19-3)", async () => {
    const x = await setup();
    await open(x.avery, x.connectionId, "dbx:id:folderSmith01");
    const memo = dbx.entries.find((e) => e.id === "id:fileMemo00001")!;
    const v1 = memo.content!;
    const v2 = "Fired April 19, two days after FMLA.";
    dbx.beforeDownload = () => { memo.revisions = { [REV1]: v1 }; memo.content = v2; memo.rev = REV2; dbx.beforeDownload = null; };
    await db.withFirm(x.avery, (s) => importFiles(s, x.connectionId, { matterId: x.matter.id, folderId: x.correspondence.id, items: ["dbx:id:fileMemo00001"] }));
    await drain();
    const ev = await evidenceIn(x.matter.id);
    expect(ev).toHaveLength(1);
    const c = (await t.admin.query("SELECT details FROM huis.evidence_custody_events WHERE evidence_id = $1 AND event = 'imported_from_integration'", [ev[0].id])).rows[0];
    expect([`${REV1}=${sha(v1)}`, `${REV2}=${sha(v2)}`]).toContain(`${c.details.version}=${ev[0].sha256}`);
  });

  it("each system's ids stay its own (a OneDrive id on a Dropbox connection, and the reverse)", async () => {
    const x = await setup();
    await expect(db.withFirm(x.avery, (s) => s.client.query("SELECT huis.request_integration_listing($1, 'drive:D1:F1')", [x.connectionId]))).rejects.toThrow(/invalid folder/);
    await expect(db.withFirm(x.avery, (s) => s.client.query("SELECT huis.request_integration_listing($1, 'sites')", [x.connectionId]))).rejects.toThrow(/invalid folder/);
    await open(x.avery, x.connectionId);
    await expect(db.withFirm(x.avery, (s) => importFiles(s, x.connectionId, { matterId: x.matter.id, folderId: x.correspondence.id, items: ["drive:D1:I-memo"] })))
      .rejects.toThrow(/Choose files from the list/);
    for (const bad of ["dbx:id:../x", "dbx:/Clients", "dbx:id:a b", "dbx:rev:015f"]) {
      await expect(db.withFirm(x.avery, (s) => browse(s, x.connectionId, bad))).rejects.toThrow(/not found/i);
    }
    const one = await db.withFirm(x.avery, (s) => connectIntegration(s, {
      provider: "onedrive", subject: "tid:oid", tenant: "tid", label: "x", refreshToken: "RT", masterKey: MASTER }));
    await expect(db.withFirm(x.avery, (s) => s.client.query("SELECT huis.request_integration_listing($1, 'dbx:id:folderSmith01')", [one]))).rejects.toThrow(/invalid folder/);
  });

  it("a refused sign-in marks the connection for reconnecting; a missing file fails just that import", async () => {
    const x = await setup();
    await open(x.avery, x.connectionId);
    await db.withFirm(x.avery, (s) => importFiles(s, x.connectionId, { matterId: x.matter.id, folderId: x.correspondence.id, items: ["dbx:id:fileTop000001"] }));
    dbx.entries = dbx.entries.filter((e) => e.id !== "id:fileTop000001");
    await drain();
    expect((await t.admin.query("SELECT status FROM huis.integration_imports WHERE connection_id = $1", [x.connectionId])).rows[0].status).toBe("failed");
    expect((await db.withFirm(x.avery, (s) => listMyConnections(s)))[0]).toMatchObject({ status: "active" });
    dbx.refreshError = "invalid_grant";
    await db.withFirm(x.avery, (s) => browse(s, x.connectionId, "dbx:id:folderClients"));
    await drain();
    expect((await db.withFirm(x.avery, (s) => listMyConnections(s)))[0]).toMatchObject({ status: "needs_reconnect" });
  });

  it("long folders are read page by page, up to the listing limit", async () => {
    const x = await setup();
    dbx.pageSize = 2;
    for (let i = 0; i < 7; i++) dbx.entries.push({ id: `id:bulk${String(i).padStart(8, "0")}`, name: `Exhibit ${i}.txt`, path: `/Exhibit ${i}.txt`, content: `x${i}`, rev: `0bb000000000${i}` });
    const root = await open(x.avery, x.connectionId);
    expect(root.items.filter((i) => i.kind === "file")).toHaveLength(8);
    expect(root.truncated).toBe(false);
  });
});
