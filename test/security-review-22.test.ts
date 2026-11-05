import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { DropboxSource } from "../src/integrations/dropbox";
import { GoogleDriveSource } from "../src/integrations/google-drive";
import { IntegrationWorker } from "../src/integrations/worker";
import { fetchDownload, readTextCapped } from "../src/net/http";
import { createClient } from "../src/services/clients";
import { getEvidence } from "../src/services/evidence";
import { browse, connectIntegration, importFiles } from "../src/services/integrations";
import { addMatterMember, createMatter, listMatterFolders } from "../src/services/matters";
import { inviteUser } from "../src/services/users";
import { MasterKeyProvider } from "../src/storage/encryption";
import { EvidenceVault, LocalObjectStore } from "../src/storage/store";
import { DBX_ACCOUNT, FakeDropbox } from "./fake-dropbox";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

/**
 * Security review 22 — Phase 9 part 2a (Dropbox and the Integration Hub), second look.
 * Each "R22-N" test asserts the secure behaviour and fails against the code as reviewed.
 */

let t: TestDatabase;
let db: HuisDb;
let vault: EvidenceVault;
let vaultDir: string;
let dbx: FakeDropbox;
let hub: IntegrationWorker;
const MASTER = Buffer.alloc(32, 21).toString("base64");

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-r22-vault-"));
  vault = new EvidenceVault(new LocalObjectStore(vaultDir), new MasterKeyProvider(MASTER));
  dbx = new FakeDropbox();
  await dbx.start();
  hub = new IntegrationWorker(t.worker, vault, { masterKey: MASTER, microsoft: null, dropbox: { clientId: "k", clientSecret: "s" } });
});

afterAll(async () => {
  dbx?.server.close();
  await t?.drop();
  if (vaultDir) await rm(vaultDir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.HUIS_DROPBOX_AUTH_BASE = dbx.base;
  process.env.HUIS_DROPBOX_API_BASE = dbx.base;
  process.env.HUIS_DROPBOX_CONTENT_BASE = dbx.base;
  dbx.entries = [{ id: "id:fileTop000001", name: "Top.txt", path: "/Top.txt", content: "top", rev: "0aa0000000001" }];
});

afterEach(() => {
  delete process.env.HUIS_HTTP_TIMEOUT_MS;
  delete process.env.HUIS_DOWNLOAD_IDLE_MS;
});

async function drain() { while (await hub.runOnce()) { /* until idle */ } }

async function firmWithAttorneyAndClient() {
  const f = await newFirm(db);
  const x = await db.withFirm(f.owner, async (s) => {
    const client = await createClient(s, { kind: "person", displayName: "Pat" });
    const attorney = await inviteUser(s, { email: `avery@${f.slug}.example`, fullName: "Avery", role: "attorney", locationId: f.locationId });
    const portal = await inviteUser(s, { email: `pat@${f.slug}.example`, fullName: "Pat", role: "client", locationId: f.locationId });
    const matter = await createMatter(s, { title: "Smith", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
    return { attorney, portal, matter };
  });
  await db.withFirm(f.owner, (s) => addMatterMember(s, { matterId: x.matter.id, userId: x.portal.id, access: "view", acknowledgePrivilegeWaiverRisk: true }));
  const avery: RequestContext = { firmId: f.firmId, userId: x.attorney.id };
  const pat: RequestContext = { firmId: f.firmId, userId: x.portal.id };
  const cid = await db.withFirm(avery, (s) => connectIntegration(s, { provider: "dropbox", subject: DBX_ACCOUNT, tenant: null,
    label: "avery.private@gmail.example", refreshToken: "DBX-RT-1", masterKey: MASTER }));
  await db.withFirm(avery, (s) => browse(s, cid, "root"));
  await drain();
  return { f, x, avery, pat, cid };
}

/** A server that accepts connections and does whatever `handle` says (or nothing at all). */
async function rawServer(handle?: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const sockets: Socket[] = [];
  const server = http.createServer((req, res) => handle?.(req, res));
  server.on("connection", (s) => sockets.push(s));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => { sockets.forEach((s) => s.destroy()); server.close(); } };
}

describe("security review 22", () => {
  it("R22-1: a client sees only the system's name as 'received from', never the attorney's account address", async () => {
    const { x, avery, pat, cid } = await firmWithAttorneyAndClient();
    const shared = (await db.withFirm(avery, (s) => listMatterFolders(s, x.matter.id))).find((g) => g.classification === "client_accessible" && !g.isPrivilegedArea)!;
    await db.withFirm(avery, (s) => importFiles(s, cid, { matterId: x.matter.id, folderId: shared.id, items: ["dbx:id:fileTop000001"], acknowledgePrivilegeWaiverRisk: true }));
    await drain();
    const ev = (await t.admin.query("SELECT id, received_from FROM huis.evidence_items WHERE matter_id = $1", [x.matter.id])).rows[0];
    expect(ev.received_from).toBe("Dropbox");
    const seen = await db.withFirm(pat, (s) => getEvidence(s, ev.id));
    expect(JSON.stringify(seen)).not.toContain("avery.private@gmail.example");
    // The account is still recorded in the chain of custody, for firm staff.
    const custody = (await t.admin.query("SELECT details FROM huis.evidence_custody_events WHERE evidence_id = $1 AND event = 'imported_from_integration'", [ev.id])).rows[0];
    expect(custody.details.account).toBe("avery.private@gmail.example");
  });

  it("R22-2: a Dropbox host that never answers fails the call within the time limit", async () => {
    const hang = await rawServer();
    process.env.HUIS_DROPBOX_API_BASE = hang.base;
    process.env.HUIS_HTTP_TIMEOUT_MS = "500";
    const started = Date.now();
    await expect(new DropboxSource("tok").list("root")).rejects.toThrow(/did not answer in time/);
    expect(Date.now() - started).toBeLessThan(5000);
    hang.close();
  }, 15000);

  it("R22-2: a Google Drive host that never answers fails the call within the time limit", async () => {
    const hang = await rawServer();
    const prev = process.env.HUIS_GOOGLE_DRIVE_BASE;
    process.env.HUIS_GOOGLE_DRIVE_BASE = `${hang.base}/drive/v3`;
    process.env.HUIS_HTTP_TIMEOUT_MS = "500";
    const started = Date.now();
    await expect(new GoogleDriveSource("tok").describe("gdrive:1AbCdEfGhIjKlMnOpQrStUv")).rejects.toThrow(/did not answer in time/);
    expect(Date.now() - started).toBeLessThan(5000);
    if (prev === undefined) delete process.env.HUIS_GOOGLE_DRIVE_BASE; else process.env.HUIS_GOOGLE_DRIVE_BASE = prev;
    hang.close();
  }, 15000);

  it("R22-2: a download that stops sending data is stopped", async () => {
    const stall = await rawServer((_req, res) => { res.writeHead(200, { "content-type": "application/octet-stream" }); res.write("first part"); });
    const { stream } = await fetchDownload(`${stall.base}/file`, {}, { headerMs: 2000, idleMs: 300 });
    const read = (async () => { for await (const _ of stream()) { /* keep reading */ } })();
    await expect(read).rejects.toThrow(/did not answer in time/);
    stall.close();
  }, 15000);

  it("R22-3: a file changed after it was chosen is refused, not imported", async () => {
    const { x, avery, cid } = await firmWithAttorneyAndClient();
    dbx.entries[0] = { ...dbx.entries[0]!, content: "altered", rev: "0aa0000000002" };
    const corr = (await db.withFirm(avery, (s) => listMatterFolders(s, x.matter.id))).find((g) => g.name === "Correspondence")!;
    await db.withFirm(avery, (s) => importFiles(s, cid, { matterId: x.matter.id, folderId: corr.id, items: ["dbx:id:fileTop000001"] }));
    await drain();
    expect((await t.admin.query("SELECT count(*)::int AS n FROM huis.evidence_items WHERE matter_id = $1", [x.matter.id])).rows[0].n).toBe(0);
    const job = (await t.admin.query("SELECT status, last_error, expected_version FROM huis.integration_imports WHERE matter_id = $1", [x.matter.id])).rows[0];
    expect(job.status).toBe("failed");
    expect(job.expected_version).toBe("0aa0000000001");
    expect(job.last_error).toMatch(/changed after it was chosen/);
    // Listing the folder again and choosing it again imports the new version.
    await db.withFirm(avery, (s) => browse(s, cid, "root", true));
    await drain();
    await db.withFirm(avery, (s) => importFiles(s, cid, { matterId: x.matter.id, folderId: corr.id, items: ["dbx:id:fileTop000001"] }));
    await drain();
    const rec = (await t.admin.query("SELECT external_version FROM huis.sync_records WHERE matter_id = $1", [x.matter.id])).rows[0];
    expect(rec.external_version).toBe("0aa0000000002");
  });

  it("R22-4: an oversized response is refused without reading it all", async () => {
    const big = await rawServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const chunk = "x".repeat(64 * 1024);
      const pump = () => { while (res.write(chunk)) { /* keep sending */ } };
      res.on("drain", pump);
      pump();
    });
    const res = await fetch(`${big.base}/huge`);
    await expect(readTextCapped(res, 256 * 1024, "too large")).rejects.toThrow(/too large/);
    const declared = new Response("{}", { headers: { "content-length": String(30 * 1024 * 1024) } });
    await expect(readTextCapped(declared, 1024, "too large")).rejects.toThrow(/too large/);
    big.close();
  }, 15000);
});
