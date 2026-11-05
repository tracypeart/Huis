import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { completeGoogleDriveConnect, googleDriveAuthorizeUrl, GoogleDriveSource } from "../src/integrations/googledrive";
import { IntegrationWorker } from "../src/integrations/worker";
import { createClient } from "../src/services/clients";
import { getEvidence } from "../src/services/evidence";
import { browse, connectIntegration, importFiles, integrationHub, listImports, pickFiles } from "../src/services/integrations";
import { addMatterMember, createMatter, listMatterFolders } from "../src/services/matters";
import { inviteUser } from "../src/services/users";
import { MasterKeyProvider } from "../src/storage/encryption";
import { EvidenceVault, LocalObjectStore } from "../src/storage/store";
import { DRIVE_FILE, FakeGoogleDrive, GDRIVE_CLIENT_ID, GDRIVE_SUB } from "./fake-google-drive";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

/**
 * Phase 9 part 2b — Google Drive in the Integration Hub (drive.file: only files the person picks).
 */

let t: TestDatabase;
let db: HuisDb;
let vault: EvidenceVault;
let vaultDir: string;
let g: FakeGoogleDrive;
let hub: IntegrationWorker;
const MASTER = Buffer.alloc(32, 22).toString("base64");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const MEMO = "1AbCdEfGhIjKlMnOpQrStUvWxYz_memo01";
const NOTES = "1NoTeSdOcUmEnT_gdoc000000000001";
const FORM = "1FoRmFoRmFoRm_gform00000000001";
const OTHER = "1OtHeRaCcOuNt_file0000000000001";
const GONE = "1TrAsHeD_file000000000000000001";
const SECRET = "1NoTpIcKeD_file0000000000000001";

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-gdrive-vault-"));
  vault = new EvidenceVault(new LocalObjectStore(vaultDir), new MasterKeyProvider(MASTER));
  g = new FakeGoogleDrive();
  await g.start();
  process.env.HUIS_GOOGLE_AUTH_BASE = g.base;
  process.env.HUIS_GOOGLE_TOKEN_BASE = g.base;
  process.env.HUIS_GDRIVE_API_BASE = g.base;
  process.env.HUIS_GOOGLE_USERINFO_BASE = g.base;
  hub = new IntegrationWorker(t.worker, vault, { masterKey: MASTER, microsoft: null, google: { clientId: GDRIVE_CLIENT_ID, clientSecret: "g-secret" } });
});

afterAll(async () => {
  g?.server.close();
  await t?.drop();
  if (vaultDir) await rm(vaultDir, { recursive: true, force: true });
});

beforeEach(() => {
  g.files = [
    { id: MEMO, name: "Termination memo.pdf", mimeType: "application/pdf", content: "%PDF-fired April 18", rev: "0Bmemo-rev-1", version: 4 },
    { id: NOTES, name: "Interview notes", mimeType: "application/vnd.google-apps.document", exported: "PK-docx-interview-notes", version: 12 },
    { id: FORM, name: "Intake form", mimeType: "application/vnd.google-apps.form", version: 3 },
    { id: OTHER, name: "Someone else's file.pdf", mimeType: "application/pdf", content: "x", accessible: false },
    { id: GONE, name: "Deleted.pdf", mimeType: "application/pdf", content: "x", trashed: true },
    { id: SECRET, name: "Never picked.pdf", mimeType: "application/pdf", content: "never picked", rev: "0Bsecret-1" },
  ];
  g.grantedScope = `openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile ${DRIVE_FILE}`;
  g.refreshScope = null;
  g.refreshError = null;
  g.tokenSub = GDRIVE_SUB;
  g.exportStatus = 200;
  g.beforeDownload = null;
  g.calls = [];
});

async function setup() {
  const f = await newFirm(db);
  const x = await db.withFirm(f.owner, async (s) => {
    const client = await createClient(s, { kind: "person", displayName: "Pat Smith" });
    const attorney = await inviteUser(s, { email: `avery@${f.slug}.example`, fullName: "Avery Attorney", role: "attorney", locationId: f.locationId });
    const colleague = await inviteUser(s, { email: `sam@${f.slug}.example`, fullName: "Sam Paralegal", role: "paralegal", locationId: f.locationId });
    const reader = await inviteUser(s, { email: `rory@${f.slug}.example`, fullName: "Rory Reader", role: "read_only", locationId: f.locationId });
    const portal = await inviteUser(s, { email: `pat@${f.slug}.example`, fullName: "Pat Smith", role: "client", locationId: f.locationId });
    const matter = await createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
    return { attorney, colleague, reader, portal, matter };
  });
  await db.withFirm(f.owner, (s) => addMatterMember(s, { matterId: x.matter.id, userId: x.portal.id, access: "view", acknowledgePrivilegeWaiverRisk: true }));
  const ctx = (userId: string): RequestContext => ({ firmId: f.firmId, userId });
  const avery = ctx(x.attorney.id);
  const connectionId = await db.withFirm(avery, (s) => connectIntegration(s, {
    provider: "google_drive", subject: GDRIVE_SUB, tenant: null, label: "avery@drive-firm.example", refreshToken: "GDRT-1", masterKey: MASTER,
  }));
  const correspondence = (await db.withFirm(avery, (s) => listMatterFolders(s, x.matter.id))).find((h) => h.name === "Correspondence")!;
  return { ...f, ...x, avery, sam: ctx(x.colleague.id), rory: ctx(x.reader.id), pat: ctx(x.portal.id), owner: f.owner, connectionId, correspondence };
}

async function drain() { while (await hub.runOnce()) { /* until idle */ } }
async function pick(who: RequestContext, connectionId: string, files: string[]) {
  await db.withFirm(who, (s) => pickFiles(s, connectionId, files));
  await drain();
  return db.withFirm(who, (s) => browse(s, connectionId, "picked"));
}
const evidenceIn = async (matterId: string) =>
  (await t.admin.query("SELECT id, original_filename, sha256, received_from FROM huis.evidence_items WHERE matter_id = $1 ORDER BY uploaded_at", [matterId])).rows;

describe("connecting Google Drive", () => {
  it("asks only for drive.file (files the person picks), offline, with PKCE, never folding in earlier permissions", () => {
    const url = new URL(googleDriveAuthorizeUrl({ clientId: GDRIVE_CLIENT_ID, redirectUri: "http://localhost:3000/cb", state: "s", nonce: "n", verifier: "v".repeat(48) }));
    expect(url.searchParams.get("scope")).toBe(`openid email profile ${DRIVE_FILE}`);
    expect(url.searchParams.get("include_granted_scopes")).toBe("false");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("nonce")).toBe("n");
  });

  it("verifies who signed in and refuses sign-ins without drive.file or with broader access", async () => {
    g.idNonce = "n1";
    const go = (nonce = "n1") => completeGoogleDriveConnect({ clientId: GDRIVE_CLIENT_ID, clientSecret: "x", redirectUri: "r", code: "c", verifier: "v", nonce, keys: g.jwks });
    const ok = await go();
    expect(ok).toMatchObject({ subject: GDRIVE_SUB, address: "avery@drive-firm.example", refreshToken: "GDRT-1" });
    await expect(go("wrong")).rejects.toThrow(/nonce/);
    g.grantedScope = "openid email profile";
    await expect(go()).rejects.toThrow(/open the Google Drive files you choose/);
    for (const extra of ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/gmail.readonly"]) {
      g.grantedScope = `openid ${DRIVE_FILE} ${extra}`;
      await expect(go()).rejects.toThrow(/more access than Huis asked for/);
    }
  });

  it("is available on the hub, private to its owner, and can't be connected by read-only staff", async () => {
    const x = await setup();
    const entry = (await db.withFirm(x.avery, (s) => integrationHub(s))).find((i) => i.provider === "google_drive")!;
    expect(entry.status).toBe("available");
    expect(entry.connections.map((c) => c.id)).toEqual([x.connectionId]);
    for (const other of [x.sam, x.owner]) {
      expect((await db.withFirm(other, (s) => integrationHub(s))).find((i) => i.provider === "google_drive")!.connections).toEqual([]);
      await expect(db.withFirm(other, (s) => pickFiles(s, x.connectionId, [MEMO]))).rejects.toThrow(/not found/i);
    }
    await expect(db.withFirm(x.rory, (s) => connectIntegration(s, { provider: "google_drive", subject: "999", tenant: null, label: null, refreshToken: "r", masterKey: MASTER })))
      .rejects.toThrow();
    await expect(db.withFirm(x.pat, (s) => pickFiles(s, x.connectionId, [MEMO]))).rejects.toThrow();
    const sealed = (await t.admin.query("SELECT ciphertext FROM huis.integration_credentials WHERE connection_id = $1", [x.connectionId])).rows[0].ciphertext;
    expect(sealed.toString("latin1")).not.toContain("GDRT-1");
  });
});

describe("choosing files", () => {
  it("has no folders to browse: only the files the person chose", async () => {
    const x = await setup();
    await expect(db.withFirm(x.avery, (s) => browse(s, x.connectionId, "root"))).rejects.toThrow(/not found/i);
    await expect(db.withFirm(x.avery, (s) => s.client.query("SELECT huis.request_integration_listing($1, 'root')", [x.connectionId]))).rejects.toThrow(/invalid folder/);
    await expect(db.withFirm(x.avery, (s) => s.client.query("SELECT huis.request_integration_listing($1, 'picked')", [x.connectionId]))).rejects.toThrow(/invalid folder/);
    expect((await db.withFirm(x.avery, (s) => browse(s, x.connectionId, "picked"))).items).toEqual([]);
  });

  it("lists only chosen files the connected account itself can open, with names, sizes and versions only", async () => {
    const x = await setup();
    const l = await pick(x.avery, x.connectionId, [MEMO, NOTES, FORM, OTHER, GONE]);
    expect(l.status).toBe("ready");
    expect(l.items.map((i) => [i.id, i.name, i.version])).toEqual([
      [`gdrive:${NOTES}`, "Interview notes.docx", "v12"],
      [`gdrive:${MEMO}`, "Termination memo.pdf", "0Bmemo-rev-1"],
    ]);
    // A form (not importable), a file the account can't open and a trashed file are left out, and the person is told.
    expect(l.truncated).toBe(true);
    expect(JSON.stringify(l.items)).not.toContain("fired April 18");
    // The token went only to the configured Google hosts, and every call carried it.
    expect(g.calls.every((c) => c.auth === "Bearer GDAT-good")).toBe(true);
    expect(g.calls.some((c) => c.path === "/v1/userinfo")).toBe(true);
  });

  it("refuses anything that isn't a Drive file id (service and database)", async () => {
    const x = await setup();
    for (const bad of [["../etc/passwd"], ["short"], ["a b c d e f g h"], ["x".repeat(201)], []]) {
      await expect(db.withFirm(x.avery, (s) => pickFiles(s, x.connectionId, bad))).rejects.toThrow(/Choose between 1 and 200 files/);
    }
    await expect(db.withFirm(x.avery, (s) => s.client.query("SELECT huis.request_integration_picked($1, $2)", [x.connectionId, ["gdrive:../x"]])))
      .rejects.toThrow(/invalid file/);
    await expect(db.withFirm(x.avery, (s) => s.client.query("SELECT huis.request_integration_picked($1, $2)", [x.connectionId, Array(201).fill(MEMO)])))
      .rejects.toThrow(/between 1 and 200/);
    // Only Google Drive connections take picked files.
    const dbx = await db.withFirm(x.avery, (s) => connectIntegration(s, { provider: "dropbox", subject: "dbid:AAx", tenant: null, label: null, refreshToken: "r", masterKey: MASTER }));
    await expect(db.withFirm(x.avery, (s) => s.client.query("SELECT huis.request_integration_picked($1, $2)", [dbx, [MEMO]]))).rejects.toThrow(/invalid folder/);
  });

  it("a sign-in that belongs to a different Google account lists nothing and needs reconnecting", async () => {
    const x = await setup();
    g.tokenSub = "100000000000000000001";
    const l = await pick(x.avery, x.connectionId, [MEMO]);
    expect(l.status).toBe("failed");
    expect(l.items).toEqual([]);
    expect((await t.admin.query("SELECT status FROM huis.integration_connections WHERE id = $1", [x.connectionId])).rows[0].status).toBe("needs_reconnect");
  });

  it("a refreshed sign-in carrying broader access than drive.file is never used", async () => {
    const x = await setup();
    g.refreshScope = `openid ${DRIVE_FILE} https://www.googleapis.com/auth/drive`;
    const l = await pick(x.avery, x.connectionId, [MEMO]);
    expect(l.items).toEqual([]);
    expect(g.calls.filter((c) => c.path.startsWith("/drive/"))).toEqual([]);
  });
});

describe("importing from Google Drive", () => {
  it("imports a chosen file's exact revision as evidence, with custody and a sync record", async () => {
    const x = await setup();
    await pick(x.avery, x.connectionId, [MEMO]);
    await db.withFirm(x.avery, (s) => importFiles(s, x.connectionId, { matterId: x.matter.id, folderId: x.correspondence.id, items: [`gdrive:${MEMO}`] }));
    await drain();
    const [ev] = await evidenceIn(x.matter.id);
    expect(ev).toMatchObject({ original_filename: "Termination memo.pdf", sha256: sha("%PDF-fired April 18"), received_from: "Google Drive" });
    expect(g.calls.some((c) => c.path.startsWith(`/drive/v3/files/${MEMO}/revisions/0Bmemo-rev-1?alt=media`))).toBe(true);
    const c = (await t.admin.query("SELECT details FROM huis.evidence_custody_events WHERE evidence_id = $1 AND event = 'imported_from_integration'", [ev.id])).rows[0].details;
    expect(c).toMatchObject({ system: "google_drive", account: "avery@drive-firm.example", external_id: `gdrive:${MEMO}`, version: "0Bmemo-rev-1", path: "Google Drive/Termination memo.pdf" });
    const sync = (await t.admin.query("SELECT external_system, external_version, internal_id FROM huis.sync_records WHERE matter_id = $1", [x.matter.id])).rows;
    expect(sync).toEqual([{ external_system: "google_drive", external_version: "0Bmemo-rev-1", internal_id: ev.id }]);
  });

  it("imports a Google Doc converted to Word, and the same version only once", async () => {
    const x = await setup();
    await pick(x.avery, x.connectionId, [NOTES]);
    const req = () => db.withFirm(x.avery, (s) => importFiles(s, x.connectionId, { matterId: x.matter.id, folderId: x.correspondence.id, items: [`gdrive:${NOTES}`] }));
    await req();
    await drain();
    await req();
    await drain();
    const ev = await evidenceIn(x.matter.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ original_filename: "Interview notes.docx", sha256: sha("PK-docx-interview-notes") });
    expect(g.calls.some((c) => c.path.includes(`/drive/v3/files/${NOTES}/export?mimeType=application%2Fvnd.openxmlformats-officedocument.wordprocessingml.document`))).toBe(true);
    expect((await db.withFirm(x.avery, (s) => listImports(s, x.connectionId)))[0]).toMatchObject({ status: "skipped" });
  });

  it("only files chosen and listed for this connection can be imported", async () => {
    const x = await setup();
    await pick(x.avery, x.connectionId, [MEMO]);
    const go = (items: string[]) => db.withFirm(x.avery, (s) => importFiles(s, x.connectionId, { matterId: x.matter.id, folderId: x.correspondence.id, items }));
    // A file the account can open but the person never chose, an id from another system, a bad shape.
    for (const bad of [[`gdrive:${SECRET}`], ["dbx:id:fileMemo00001"], ["drive:D1:I-memo"], ["gdrive:../x"], [MEMO]]) {
      await expect(go(bad)).rejects.toThrow(/Choose files from the list/);
    }
    // Choosing again replaces the list: earlier choices aren't importable unless chosen again.
    await pick(x.avery, x.connectionId, [NOTES]);
    await expect(go([`gdrive:${MEMO}`])).rejects.toThrow(/Choose files from the list/);
    expect(g.calls.some((c) => c.path.includes(SECRET))).toBe(false);
  });

  it("a file changed after it was chosen is refused; a document Google can't convert fails just that file", async () => {
    const x = await setup();
    await pick(x.avery, x.connectionId, [MEMO, NOTES]);
    g.files.find((f) => f.id === MEMO)!.rev = "0Bmemo-rev-2";
    g.exportStatus = 403;
    await db.withFirm(x.avery, (s) => importFiles(s, x.connectionId, { matterId: x.matter.id, folderId: x.correspondence.id, items: [`gdrive:${MEMO}`, `gdrive:${NOTES}`] }));
    await drain();
    expect(await evidenceIn(x.matter.id)).toHaveLength(0);
    const jobs = await db.withFirm(x.avery, (s) => listImports(s, x.connectionId));
    expect(jobs.find((j) => j.name === "Termination memo.pdf")).toMatchObject({ status: "failed", error: expect.stringMatching(/changed after it was chosen/) });
    expect(jobs.find((j) => j.name === "Interview notes.docx")).toMatchObject({ status: "failed", error: expect.stringMatching(/couldn't convert/) });
    expect((await t.admin.query("SELECT status FROM huis.integration_connections WHERE id = $1", [x.connectionId])).rows[0].status).toBe("active");
  });

  it("into a folder the client can see: needs the privilege acknowledgement, and the client sees only 'Google Drive'", async () => {
    const x = await setup();
    await pick(x.avery, x.connectionId, [MEMO]);
    const shared = (await db.withFirm(x.avery, (s) => listMatterFolders(s, x.matter.id))).find((h) => h.classification === "client_accessible" && !h.isPrivilegedArea)!;
    const go = (ack: boolean) => db.withFirm(x.avery, (s) => importFiles(s, x.connectionId, { matterId: x.matter.id, folderId: shared.id, items: [`gdrive:${MEMO}`], acknowledgePrivilegeWaiverRisk: ack }));
    await expect(go(false)).rejects.toThrow(/privilege/i);
    await go(true);
    await drain();
    const [ev] = await evidenceIn(x.matter.id);
    const seen = await db.withFirm(x.pat, (s) => getEvidence(s, ev.id));
    expect(JSON.stringify(seen)).not.toContain("avery@drive-firm.example");
    expect(JSON.stringify(seen)).toContain("Google Drive");
  });

  it("the source reads only Drive ids of the right shape", async () => {
    const src = new GoogleDriveSource("GDAT-good");
    await expect(src.describe("gdrive:../../x")).rejects.toThrow(/unknown file/);
    await expect(src.download("dbx:id:abc")).rejects.toThrow(/unknown file/);
    await expect(src.list("root")).rejects.toThrow(/unknown folder/);
  });
});
