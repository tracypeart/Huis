import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { IntegrationWorker } from "../src/integrations/worker";
import { createClient } from "../src/services/clients";
import { custodyLog } from "../src/services/evidence";
import { browse, connectIntegration, importFiles, listMyConnections } from "../src/services/integrations";
import { addMatterMember, createMatter, listMatterFolders } from "../src/services/matters";
import { disableUser, inviteUser } from "../src/services/users";
import { MasterKeyProvider } from "../src/storage/encryption";
import { EvidenceVault, LocalObjectStore } from "../src/storage/store";
import { CLIENT_ID, FakeMicrosoft, OID, TID } from "./fake-microsoft";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

/**
 * Security review 19 — Phase 9 part 1 (Integration Hub, OneDrive / SharePoint import).
 * Each "R19-N" test asserts the secure behaviour and fails against the code as reviewed.
 */

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
  vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-r19-vault-"));
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
    "I-memo": { id: "I-memo", drive: "D1", name: "Termination memo.txt", parent: "D1-root", content: "Fired April 18, two days after the FMLA request.", mime: "text/plain", path: "/drive/root:" },
    "I-other": { id: "I-other", drive: "D1", name: "Draft letter.txt", parent: "D1-root", content: "Dear counsel.", mime: "text/plain",
      path: "/drive/root:/Clients/Jones v. Acme (CONFIDENTIAL settlement)" },
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
    const matter = await createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
    return { attorney, assistant, portal, matter };
  });
  const ctx = (id: string): RequestContext => ({ firmId: f.firmId, userId: id });
  const avery = ctx(x.attorney.id);
  const connectionId = await db.withFirm(avery, (s) => connectIntegration(s, {
    provider: "onedrive", subject: SUBJECT, tenant: TID, label: "avery@lawfirm.example", refreshToken: "RT-1", masterKey: MASTER,
  }));
  const folders = await db.withFirm(avery, (s) => listMatterFolders(s, x.matter.id));
  const correspondence = folders.find((g) => g.name === "Correspondence")!;
  const shared = folders.find((g) => g.classification === "client_accessible" && !g.isPrivilegedArea)!;
  return { ...f, ...x, avery, sam: ctx(x.assistant.id), pat: ctx(x.portal.id), connectionId, correspondence, shared };
}

async function drain() {
  while (await hub.runOnce()) { /* until idle */ }
}

async function open(who: RequestContext, connectionId: string, location = "root") {
  await db.withFirm(who, (s) => browse(s, connectionId, location));
  await drain();
  return db.withFirm(who, (s) => browse(s, connectionId, location));
}

const evidenceIn = async (matterId: string) =>
  (await t.admin.query("SELECT id, original_filename, sha256 FROM huis.evidence_items WHERE matter_id = $1 ORDER BY uploaded_at", [matterId])).rows;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("review 19", () => {
  it("R19-1: a colleague can't squat a OneDrive account before its owner connects (a connection that never worked is taken over)", async () => {
    const x = await setup();
    // Sam records Avery's (directory-visible) account id with a made-up token before Avery connects.
    const victim = `${TID}:${randomUUID()}`;
    const squat = await db.withFirm(x.sam, (s) => s.client.query("SELECT huis.connect_integration('onedrive', $1, NULL, 'sam', $2) AS id",
      [victim, Buffer.from("junk")]));
    expect(squat.rows[0].id).toBeTruthy();
    // Avery then connects with a working Microsoft sign-in: she must get her own account.
    const id = await db.withFirm(x.avery, (s) => connectIntegration(s, {
      provider: "onedrive", subject: victim, tenant: TID, label: "avery@lawfirm.example", refreshToken: "RT-1", masterKey: MASTER,
    }));
    expect(id).toBeTruthy();
    expect((await db.withFirm(x.avery, (s) => listMyConnections(s))).map((c) => c.id)).toContain(id);
  });

  it("R19-1: a colleague can't hijack a connection that needs reconnecting and then lock its owner out", async () => {
    const x = await setup();
    await t.admin.query("UPDATE huis.integration_connections SET status = 'needs_reconnect' WHERE id = $1", [x.connectionId]);
    // Sam takes it over with a made-up token (no Microsoft sign-in)...
    await db.withFirm(x.sam, (s) => s.client.query("SELECT huis.connect_integration('onedrive', $1, NULL, 'sam', $2)", [SUBJECT, Buffer.from("junk")]));
    // ...then Avery reconnects with a working sign-in and must get her connection back.
    await expect(db.withFirm(x.avery, (s) => connectIntegration(s, {
      provider: "onedrive", subject: SUBJECT, tenant: TID, label: "avery@lawfirm.example", refreshToken: "RT-2", masterKey: MASTER,
    }))).resolves.toBeTruthy();
  });

  it("R19-2: the attorney's private OneDrive folder path isn't shown to the client in the chain of custody", async () => {
    const x = await setup();
    await db.withFirm(x.owner, (s) => addMatterMember(s, { matterId: x.matter.id, userId: x.portal.id, access: "view", acknowledgePrivilegeWaiverRisk: true }));
    await open(x.avery, x.connectionId);
    await db.withFirm(x.avery, (s) => importFiles(s, x.connectionId, {
      matterId: x.matter.id, folderId: x.shared.id, items: ["drive:D1:I-other"], acknowledgePrivilegeWaiverRisk: true,
    }));
    await drain();
    const [ev] = await evidenceIn(x.matter.id);
    expect(ev).toBeTruthy();
    // Staff can see where it came from...
    expect(JSON.stringify((await db.withFirm(x.avery, (s) => custodyLog(s, ev.id))).events)).toContain("Jones v. Acme");
    // ...but the client (who can open the document) must not learn the firm's other clients' folder names.
    const clientView = await db.withFirm(x.pat, (s) => custodyLog(s, ev.id));
    expect(clientView.events.length).toBeGreaterThan(0);
    expect(JSON.stringify(clientView.events)).not.toContain("Jones");
  });

  it("R19-3: the version recorded in the chain of custody is the version whose bytes were copied", async () => {
    const x = await setup();
    await open(x.avery, x.connectionId);
    const v1 = ms.drive["I-memo"]!.content!;
    const v2 = "Fired April 19, two days after the FMLA request."; // same length: the size check can't see it
    expect(v2.length).toBe(v1.length);
    // The file is saved again in OneDrive between Huis reading its details and downloading it.
    ms.downloadRedirect = (d, i) => {
      ms.drive["I-memo"]!.content = v2;
      ms.drive["I-memo"]!.ctag = "c-I-memo-2";
      return `${ms.base}/download/${d}/${i}?tempauth=x`;
    };
    await db.withFirm(x.avery, (s) => importFiles(s, x.connectionId, { matterId: x.matter.id, folderId: x.correspondence.id, items: ["drive:D1:I-memo"] }));
    await drain();
    const ev = await evidenceIn(x.matter.id);
    for (const e of ev) {
      const c = (await t.admin.query("SELECT details FROM huis.evidence_custody_events WHERE evidence_id = $1 AND event = 'imported_from_integration'", [e.id])).rows[0];
      const pair = `${c.details.version}=${e.sha256}`;
      expect([`c-I-memo-1=${sha(v1)}`, `c-I-memo-2=${sha(v2)}`]).toContain(pair);
    }
  });

  it("R19-4: one failed download link doesn't mark the whole account as needing reconnecting", async () => {
    const x = await setup();
    await open(x.avery, x.connectionId);
    // Graph accepted the token (describe succeeded); only the short-lived download link was refused.
    ms.downloadRedirect = () => `${ms.base}/v1.0/expired-download-link`;
    await db.withFirm(x.avery, (s) => importFiles(s, x.connectionId, { matterId: x.matter.id, folderId: x.correspondence.id, items: ["drive:D1:I-memo"] }));
    await hub.importOnce();
    expect((await db.withFirm(x.avery, (s) => listMyConnections(s)))[0]).toMatchObject({ status: "active" });
  });

  it("R19-5: an import request can't make the database scan every held listing once per file", async () => {
    const x = await setup();
    // 300 folders of 1,000 files each, as the worker would hold them for a large OneDrive.
    const items = (n: number) => JSON.stringify(Array.from({ length: 1000 }, (_, k) => ({ id: `drive:D1:L${n}-F${k}`, kind: "file", name: `f${k}.txt` })));
    for (let n = 0; n < 300; n++) {
      await t.admin.query(
        `INSERT INTO huis.integration_listings (firm_id, connection_id, location, status, items, requested_at)
         VALUES ($1, $2, $3, 'ready', $4::jsonb, now() - make_interval(secs => $5))`,
        [x.firmId, x.connectionId, `drive:D1:L${n}`, items(n), 300 - n]);
    }
    // (Since the fix, the worker also keeps each listing's files as indexed rows, as it saves the listing.)
    await t.admin.query(
      `INSERT INTO huis.integration_listing_items (listing_id, connection_id, item_id, name)
       SELECT l.id, l.connection_id, x->>'id', x->>'name' FROM huis.integration_listings l, jsonb_array_elements(l.items) x
        WHERE l.connection_id = $1`, [x.connectionId]);
    const picks = Array.from({ length: 200 }, (_, k) => `drive:D1:L299-F${999 - k}`);
    const started = Date.now();
    await db.withFirm(x.avery, (s) => importFiles(s, x.connectionId, { matterId: x.matter.id, folderId: x.correspondence.id, items: picks }));
    expect(Date.now() - started).toBeLessThan(2000);
  }, 120_000);
});

describe("review 19: what held", () => {
  it("holds: the firm owner and colleagues can't read, list, import from or disconnect someone else's connection", async () => {
    const x = await setup();
    await open(x.avery, x.connectionId);
    for (const who of [x.owner, x.sam]) {
      const rows = await db.withFirm(who, async (s) => ({
        c: (await s.client.query("SELECT * FROM huis.integration_connections")).rowCount,
        l: (await s.client.query("SELECT * FROM huis.integration_listings")).rowCount,
      }));
      expect(rows).toEqual({ c: 0, l: 0 });
      await expect(db.withFirm(who, (s) => s.client.query("SELECT huis.request_integration_listing($1, 'root')", [x.connectionId]))).rejects.toThrow(/not permitted|permission/);
      await expect(db.withFirm(who, (s) => s.client.query("SELECT huis.request_integration_import($1, $2, $3, $4, true)",
        [x.connectionId, x.matter.id, x.correspondence.id, ["drive:D1:I-memo"]]))).rejects.toThrow(/not permitted|permission/);
      await expect(db.withFirm(who, (s) => s.client.query("SELECT huis.disconnect_integration($1)", [x.connectionId]))).rejects.toThrow(/not permitted|permission/);
    }
    // Another firm can't either.
    const other = await newFirm(db);
    await expect(db.withFirm(other.owner, (s) => s.client.query("SELECT huis.request_integration_listing($1, 'root')", [x.connectionId]))).rejects.toThrow(/not permitted|permission/);
  });

  it("holds: the app can't write listings, imports or sync records, or call worker functions", async () => {
    const x = await setup();
    await expect(db.withFirm(x.avery, (s) => s.client.query(
      "INSERT INTO huis.integration_listings (firm_id, connection_id, location, status, items) VALUES ($1, $2, 'x', 'ready', '[]')",
      [x.firmId, x.connectionId]))).rejects.toThrow(/permission/);
    await expect(db.withFirm(x.avery, (s) => s.client.query("SELECT * FROM huis.worker_claim_integration_import()"))).rejects.toThrow(/permission/);
    await expect(db.withFirm(x.avery, (s) => s.client.query("SELECT huis.integration_import_allowed($1)", [randomUUID()]))).rejects.toThrow(/permission/);
  });

  it("holds: the requester disabled, or the folder shared outside the firm, before the worker runs: nothing is imported", async () => {
    const x = await setup();
    await open(x.avery, x.connectionId);
    await db.withFirm(x.avery, (s) => importFiles(s, x.connectionId, { matterId: x.matter.id, folderId: x.correspondence.id, items: ["drive:D1:I-memo"] }));
    await t.admin.query("UPDATE huis.matter_folders SET classification = 'client_accessible' WHERE id = $1", [x.correspondence.id]);
    await drain();
    expect(await evidenceIn(x.matter.id)).toHaveLength(0);

    const y = await setup();
    await open(y.avery, y.connectionId);
    await db.withFirm(y.avery, (s) => importFiles(s, y.connectionId, { matterId: y.matter.id, folderId: y.correspondence.id, items: ["drive:D1:I-memo"] }));
    await db.withFirm(y.owner, (s) => disableUser(s, y.attorney.id));
    await drain();
    expect(await evidenceIn(y.matter.id)).toHaveLength(0);
  });

  it("holds: the worker can't complete an import into another storage location or with a stale lock", async () => {
    const x = await setup();
    await open(x.avery, x.connectionId);
    await db.withFirm(x.avery, (s) => importFiles(s, x.connectionId, { matterId: x.matter.id, folderId: x.correspondence.id, items: ["drive:D1:I-memo"] }));
    const j = (await t.worker.query("SELECT * FROM huis.worker_claim_integration_import()")).rows[0];
    const ev = randomUUID();
    await expect(t.worker.query("SELECT huis.worker_complete_integration_import($1, $2, $3, 1, $4, $5, 'v', now(), 'text/plain', '/x')",
      [j.import_id, j.lock_token, ev, "a".repeat(64), `firm/${randomUUID()}/matter/${j.matter_id}/evidence/${ev}/original`])).rejects.toThrow(/unexpected storage/);
    await expect(t.worker.query("SELECT huis.worker_complete_integration_import($1, $2, $3, 1, $4, $5, 'v', now(), 'text/plain', '/x')",
      [j.import_id, randomUUID(), ev, "a".repeat(64), `firm/${j.firm_id}/matter/${j.matter_id}/evidence/${ev}/original`])).rejects.toThrow(/not held/);
  });

  it("holds: taking over a connection that needs reconnecting leaves the new owner nothing of the old owner's", async () => {
    const x = await setup();
    await open(x.avery, x.connectionId);
    await db.withFirm(x.avery, (s) => importFiles(s, x.connectionId, { matterId: x.matter.id, folderId: x.correspondence.id, items: ["drive:D1:I-memo"] }));
    await t.admin.query("UPDATE huis.integration_connections SET status = 'needs_reconnect' WHERE id = $1", [x.connectionId]);
    await db.withFirm(x.sam, (s) => connectIntegration(s, {
      provider: "onedrive", subject: SUBJECT, tenant: TID, label: "x", refreshToken: "RT-9", masterKey: MASTER,
    }));
    const seen = await db.withFirm(x.sam, async (s) => ({
      l: (await s.client.query("SELECT * FROM huis.integration_listings")).rowCount,
      i: (await s.client.query("SELECT * FROM huis.integration_imports")).rowCount,
    }));
    expect(seen).toEqual({ l: 0, i: 0 });
    await drain();
    expect(await evidenceIn(x.matter.id)).toHaveLength(0);
  });

  it("holds: folder ids and listing values can't be used for slow patterns (JS and database)", async () => {
    const x = await setup();
    const hostile = ["drive:" + "a".repeat(5000) + ":", "site:" + ",".repeat(100_000) + " ", "drive:" + "!".repeat(200) + ":" + "-".repeat(100_000)];
    const started = Date.now();
    for (const h of hostile) {
      await expect(db.withFirm(x.avery, (s) => browse(s, x.connectionId, h))).rejects.toThrow(/not found/i);
      await expect(db.withFirm(x.avery, (s) => s.client.query("SELECT huis.request_integration_listing($1, $2)", [x.connectionId, h]))).rejects.toThrow(/invalid folder/);
    }
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
