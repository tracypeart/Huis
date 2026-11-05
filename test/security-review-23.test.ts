import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { IntegrationWorker } from "../src/integrations/worker";
import { fetchDownload } from "../src/net/http";
import { createClient } from "../src/services/clients";
import { browse, connectIntegration, importFiles } from "../src/services/integrations";
import { createMatter, listMatterFolders } from "../src/services/matters";
import { inviteUser } from "../src/services/users";
import { MasterKeyProvider } from "../src/storage/encryption";
import { EvidenceVault, LocalObjectStore } from "../src/storage/store";
import { DBX_ACCOUNT, FakeDropbox } from "./fake-dropbox";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

/**
 * Security review 23 — a second look at the review 22 fixes (time limits, chosen versions) with Google Drive.
 * Each "R23-N" test asserts the secure behaviour.
 */

let t: TestDatabase;
let db: HuisDb;
let vault: EvidenceVault;
let vaultDir: string;
let dbx: FakeDropbox;
let hub: IntegrationWorker;
const MASTER = Buffer.alloc(32, 23).toString("base64");

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-r23-vault-"));
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
});

async function drain() { while (await hub.runOnce()) { /* until idle */ } }

/** A server that streams `chunks` pieces of data, `every` ms apart, and reports when the client goes away. */
async function streamer(chunks: number, every: number) {
  const sockets: Socket[] = [];
  let closedAt: number | null = null;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    let n = 0;
    const timer = setInterval(() => {
      if (n++ >= chunks) { clearInterval(timer); res.end(); return; }
      res.write(Buffer.alloc(64 * 1024, 120));
    }, every);
    req.socket.on("close", () => { clearInterval(timer); closedAt = Date.now(); });
  });
  server.on("connection", (s) => sockets.push(s));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/file`,
    closedAt: () => closedAt,
    close: () => { sockets.forEach((s) => s.destroy()); server.close(); },
  };
}

describe("security review 23", () => {
  it("R23-3: when a reader stops early (e.g. a size limit), the connection is closed, not left open", async () => {
    const srv = await streamer(1000, 5);
    const { stream } = await fetchDownload(srv.url, {}, { idleMs: 60_000 });
    const s = stream();
    for await (const _ of s) { s.destroy(); break; }
    const stoppedAt = Date.now();
    await new Promise((r) => setTimeout(r, 500));
    expect(srv.closedAt()).not.toBeNull();
    expect(srv.closedAt()! - stoppedAt).toBeLessThan(500);
    srv.close();
  }, 15000);

  it("R23-4: a reader that is slow (storage catching up) is never mistaken for a stalled download", async () => {
    const srv = await streamer(40, 2);
    const { stream } = await fetchDownload(srv.url, {}, { idleMs: 300 });
    let got = 0;
    let first = true;
    for await (const chunk of stream()) {
      got += (chunk as Buffer).length;
      // Huis's side pauses for longer than the idle limit while the service keeps sending.
      if (first) { first = false; await new Promise((r) => setTimeout(r, 900)); }
    }
    expect(got).toBe(40 * 64 * 1024);
    srv.close();
  }, 15000);

  it("R23-5: an API answer that trickles in forever hits its overall deadline", async () => {
    const srv = await streamer(100000, 100);
    const { stream } = await fetchDownload(srv.url, {}, { idleMs: 60_000, totalMs: 600 });
    const started = Date.now();
    await expect((async () => { for await (const _ of stream()) { /* keep reading */ } })()).rejects.toThrow(/did not answer in time/);
    expect(Date.now() - started).toBeLessThan(3000);
    srv.close();
  }, 15000);

  it("R23-2: a file held in two listings (it moved folders) is recorded with the newest listing's version", async () => {
    const f = await newFirm(db);
    const x = await db.withFirm(f.owner, async (s) => {
      const client = await createClient(s, { kind: "person", displayName: "Pat" });
      const attorney = await inviteUser(s, { email: `avery@${f.slug}.example`, fullName: "Avery", role: "attorney", locationId: f.locationId });
      const matter = await createMatter(s, { title: "Smith", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
      return { attorney, matter };
    });
    const avery: RequestContext = { firmId: f.firmId, userId: x.attorney.id };
    const cid = await db.withFirm(avery, (s) => connectIntegration(s, { provider: "dropbox", subject: DBX_ACCOUNT, tenant: null, label: "a", refreshToken: "DBX-RT-1", masterKey: MASTER }));
    dbx.entries = [
      { id: "id:folderSmith01", name: "Smith", path: "/Smith", folder: true },
      { id: "id:fileMove00001", name: "Memo.txt", path: "/Smith/Memo.txt", content: "old wording", rev: "0aa0000000001" },
    ];
    await db.withFirm(avery, (s) => browse(s, cid, "dbx:id:folderSmith01"));
    await drain();
    // The file moves to the top and is saved again; the person opens the top folder and chooses it there.
    dbx.entries[1] = { ...dbx.entries[1]!, path: "/Memo.txt", content: "new wording", rev: "0aa0000000002" };
    await new Promise((r) => setTimeout(r, 20));
    await db.withFirm(avery, (s) => browse(s, cid, "root"));
    await drain();
    const corr = (await db.withFirm(avery, (s) => listMatterFolders(s, x.matter.id))).find((h) => h.name === "Correspondence")!;
    await db.withFirm(avery, (s) => importFiles(s, cid, { matterId: x.matter.id, folderId: corr.id, items: ["dbx:id:fileMove00001"] }));
    expect((await t.admin.query("SELECT expected_version FROM huis.integration_imports WHERE matter_id = $1", [x.matter.id])).rows[0].expected_version)
      .toBe("0aa0000000002");
    await drain();
    expect((await t.admin.query("SELECT external_version FROM huis.sync_records WHERE matter_id = $1", [x.matter.id])).rows[0].external_version)
      .toBe("0aa0000000002");
  });
});
