import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { UserFacingError } from "../src/errors";
import { openCredential, sealCredential } from "../src/mail/credentials";
import { credentialId } from "../src/integrations/credentials";
import {
  completeGoogleDriveConnect, driveDownloadHostAllowed, GOOGLE_DRIVE_SCOPES, googleDriveAuthorizeUrl, GoogleDriveSource,
} from "../src/integrations/google-drive";
import { IntegrationWorker } from "../src/integrations/worker";
import { createClient } from "../src/services/clients";
import { browse, connectIntegration, importFiles, integrationHub, listMyConnections, matterSyncRecords } from "../src/services/integrations";
import { createMatter, listMatterFolders } from "../src/services/matters";
import { inviteUser } from "../src/services/users";
import { MasterKeyProvider } from "../src/storage/encryption";
import { EvidenceVault, LocalObjectStore } from "../src/storage/store";
import { DRIVE_CLIENT_ID, DRIVE_SUB, FakeGoogleDrive } from "./fake-google-drive";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

let t: TestDatabase;
let db: HuisDb;
let vault: EvidenceVault;
let vaultDir: string;
let g: FakeGoogleDrive;
let hub: IntegrationWorker;
const MASTER = Buffer.alloc(32, 21).toString("base64");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const REV1 = "0B7rev1AAAAAAAAAAAAAAAAAAAAA";
const REV2 = "0B7rev2BBBBBBBBBBBBBBBBBBBBB";
const MEMO = "1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123";
const RETAINER = "1zzRetainerSmithPdf00000000000";
const UNCHOSEN = "1notChosenForHuis000000000000";
const GDOC = "1googleDocNotAFile00000000000";
const connect = (nonce = "n1") => completeGoogleDriveConnect({
  clientId: DRIVE_CLIENT_ID, clientSecret: "s", redirectUri: "r", code: "c", verifier: "v", nonce, keys: g.jwks });

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-gdrive-vault-"));
  vault = new EvidenceVault(new LocalObjectStore(vaultDir), new MasterKeyProvider(MASTER));
  g = new FakeGoogleDrive();
  await g.start();
  process.env.HUIS_GOOGLE_AUTH_BASE = g.base;
  process.env.HUIS_GOOGLE_TOKEN_BASE = g.base;
  process.env.HUIS_GOOGLE_DRIVE_BASE = `${g.base}/drive/v3`;
  process.env.HUIS_GOOGLE_USERINFO_URL = `${g.base}/userinfo`;
  hub = new IntegrationWorker(t.worker, vault, { masterKey: MASTER, microsoft: null, google: { clientId: DRIVE_CLIENT_ID, clientSecret: "gs" } });
});

afterAll(async () => {
  g?.server.close();
  await t?.drop();
  if (vaultDir) await rm(vaultDir, { recursive: true, force: true });
});

beforeEach(() => {
  g.reset();
  g.idNonce = "n1";
  g.files = [
    { id: MEMO, name: "Termination memo.txt", content: "Fired April 18, two days after FMLA.", rev: REV1, chosen: true },
    { id: RETAINER, name: "Retainer – Smith.pdf", mime: "application/pdf", content: "%PDF-retainer", rev: "0B7retainerRRRRRRRRRRRRRRRRR", chosen: true },
    { id: UNCHOSEN, name: "Other client.docx", content: "not for Huis", chosen: false },
    { id: GDOC, name: "Notes (Google Doc)", mime: "application/vnd.google-apps.document", chosen: true },
    { id: "1trashedFile00000000000000000", name: "Old.txt", content: "old", chosen: true, trashed: true },
  ];
});

async function setup() {
  const f = await newFirm(db);
  const x = await db.withFirm(f.owner, async (s) => {
    const client = await createClient(s, { kind: "person", displayName: "Pat Smith" });
    const attorney = await inviteUser(s, { email: `avery@${f.slug}.example`, fullName: "Avery Attorney", role: "attorney", locationId: f.locationId });
    const paralegal = await inviteUser(s, { email: `sam@${f.slug}.example`, fullName: "Sam Paralegal", role: "paralegal", locationId: f.locationId });
    const matter = await createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
    return { attorney, paralegal, matter };
  });
  const avery: RequestContext = { firmId: f.firmId, userId: x.attorney.id };
  const sam: RequestContext = { firmId: f.firmId, userId: x.paralegal.id };
  const connectionId = await db.withFirm(avery, (s) => connectIntegration(s, {
    provider: "google_drive", subject: DRIVE_SUB, tenant: null, label: "avery@drive-firm.example", refreshToken: "GDRT-1", masterKey: MASTER,
  }));
  const correspondence = (await db.withFirm(avery, (s) => listMatterFolders(s, x.matter.id))).find((h) => h.name === "Correspondence")!;
  return { ...f, ...x, avery, sam, connectionId, correspondence };
}

async function drain() { while (await hub.runOnce()) { /* until idle */ } }
async function open(who: RequestContext, connectionId: string) {
  await db.withFirm(who, (s) => browse(s, connectionId, "root", true));
  await drain();
  return db.withFirm(who, (s) => browse(s, connectionId));
}
const evidenceIn = async (matterId: string) =>
  (await t.admin.query("SELECT id, original_filename, sha256, received_from FROM huis.evidence_items WHERE matter_id = $1 ORDER BY uploaded_at", [matterId])).rows;
const importsOf = async (connectionId: string) =>
  (await t.admin.query("SELECT status, last_error FROM huis.integration_imports WHERE connection_id = $1 ORDER BY requested_at", [connectionId])).rows;

describe("connecting Google Drive", () => {
  it("asks only for drive.file (the files the person chooses), offline, with PKCE — never Gmail or the whole Drive", () => {
    const url = new URL(googleDriveAuthorizeUrl({ clientId: DRIVE_CLIENT_ID, redirectUri: "http://localhost:3000/cb", state: "s", nonce: "n", verifier: "v".repeat(48) }));
    expect(url.searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/drive.file");
    expect(url.searchParams.get("scope")).not.toMatch(/gmail|auth\/drive(\s|$)|drive\.readonly|drive\.metadata/);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    // Other permissions given to the firm's Google app (Gmail) are never folded into a Drive sign-in.
    expect(url.searchParams.has("include_granted_scopes")).toBe(false);
    expect(GOOGLE_DRIVE_SCOPES).toHaveLength(3);
  });

  it("identifies the account by Google's own id and refuses sign-ins without drive.file, with more access, or for someone else", async () => {
    expect(await connect()).toMatchObject({ subject: DRIVE_SUB, address: "avery@drive-firm.example", displayName: "Avery Attorney", refreshToken: "GDRT-1" });
    g.grantedScope = "openid https://www.googleapis.com/auth/userinfo.email";
    await expect(connect()).rejects.toThrow(UserFacingError);
    g.grantedScope = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/gmail.readonly";
    await expect(connect()).rejects.toThrow(/more access/);
    g.grantedScope = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file";
    g.sub = "100000000000000000999";
    await expect(connect()).rejects.toThrow(/identify/);
    g.sub = DRIVE_SUB;
    await expect(connect("other-nonce")).rejects.toThrow(/nonce/);
  });

  it("is available on the hub, and its token is sealed under its own label (not a Gmail mailbox's)", async () => {
    const x = await setup();
    expect((await db.withFirm(x.avery, (s) => integrationHub(s))).find((e) => e.provider === "google_drive")).toMatchObject({ status: "available" });
    const row = (await t.admin.query("SELECT ciphertext FROM huis.integration_credentials WHERE connection_id = $1", [x.connectionId])).rows[0];
    expect(openCredential(MASTER, credentialId(x.firmId, "google_drive", DRIVE_SUB), row.ciphertext)).toBe("GDRT-1");
    expect(() => openCredential(MASTER, { firmId: x.firmId, provider: "google", subject: DRIVE_SUB }, row.ciphertext)).toThrow();
    expect(() => openCredential(MASTER, credentialId(x.firmId, "dropbox", DRIVE_SUB), row.ciphertext)).toThrow();
  });
});

describe("choosing and importing from Google Drive", () => {
  it("lists only the files chosen for Huis — no Google Docs, nothing in the trash, names and revisions only", async () => {
    const x = await setup();
    const root = await open(x.avery, x.connectionId);
    expect(root).toMatchObject({ status: "ready", title: "Files you've chosen for Huis", parent: null });
    expect(root.items.map((i) => [i.kind, i.id, i.name])).toEqual([
      ["file", `gdrive:${RETAINER}`, "Retainer – Smith.pdf"], ["file", `gdrive:${MEMO}`, "Termination memo.txt"]]);
    expect(root.items.find((i) => i.id === `gdrive:${MEMO}`)).toMatchObject({ version: REV1 });
    expect(JSON.stringify(root.items)).not.toContain("FMLA");
    // The token only ever went to Google's configured hosts, and never in a URL.
    expect(g.calls.every((c) => c.path === "/token" ? !c.auth : c.auth === "Bearer GDA-good")).toBe(true);
    expect(g.calls.some((c) => /GDA-good|GDRT/.test(c.query))).toBe(false);
  });

  it("imports the exact revision it recorded, as evidence with custody and a sync record", async () => {
    const x = await setup();
    await open(x.avery, x.connectionId);
    await db.withFirm(x.avery, (s) => importFiles(s, x.connectionId, { matterId: x.matter.id, folderId: x.correspondence.id, items: [`gdrive:${MEMO}`] }));
    await drain();
    const [ev] = await evidenceIn(x.matter.id);
    expect(ev).toMatchObject({ original_filename: "Termination memo.txt", sha256: sha("Fired April 18, two days after FMLA."), received_from: "Google Drive (avery@drive-firm.example)" });
    const custody = (await t.admin.query("SELECT details FROM huis.evidence_custody_events WHERE evidence_id = $1 AND event = 'imported_from_integration'", [ev.id])).rows[0];
    expect(custody.details).toMatchObject({ system: "google_drive", external_id: `gdrive:${MEMO}`, version: REV1 });
    expect(g.calls.some((c) => c.path === `/drive/v3/files/${MEMO}/revisions/${REV1}` && c.query === "?alt=media")).toBe(true);
    expect(await db.withFirm(x.avery, (s) => matterSyncRecords(s, x.matter.id))).toMatchObject([{ system: "google_drive", version: REV1, direction: "import" }]);
    // The same revision again: not copied twice.
    await db.withFirm(x.avery, (s) => importFiles(s, x.connectionId, { matterId: x.matter.id, folderId: x.correspondence.id, items: [`gdrive:${MEMO}`] }));
    await drain();
    expect(await evidenceIn(x.matter.id)).toHaveLength(1);
  });

  it("a file saved again while being copied: the record always matches the bytes (review 19, R19-3)", async () => {
    const x = await setup();
    await open(x.avery, x.connectionId);
    const memo = g.files.find((f) => f.id === MEMO)!;
    const v1 = memo.content!;
    const v2 = "Fired April 19, two days after FMLA.";
    g.beforeDownload = () => { memo.revisions = { [REV1]: v1 }; memo.content = v2; memo.rev = REV2; g.beforeDownload = null; };
    await db.withFirm(x.avery, (s) => importFiles(s, x.connectionId, { matterId: x.matter.id, folderId: x.correspondence.id, items: [`gdrive:${MEMO}`] }));
    await drain();
    const ev = await evidenceIn(x.matter.id);
    expect(ev).toHaveLength(1);
    const c = (await t.admin.query("SELECT details FROM huis.evidence_custody_events WHERE evidence_id = $1 AND event = 'imported_from_integration'", [ev[0].id])).rows[0];
    expect([`${REV1}=${sha(v1)}`, `${REV2}=${sha(v2)}`]).toContain(`${c.details.version}=${ev[0].sha256}`);
  });

  it("only listed files can be named: not unchosen files, Google Docs, other systems' ids or made-up ids", async () => {
    const x = await setup();
    await open(x.avery, x.connectionId);
    for (const bad of [`gdrive:${UNCHOSEN}`, `gdrive:${GDOC}`, "dbx:id:fileMemo00001", "drive:D1:I-memo", "gdrive:../x", "gdrive:a b"]) {
      await expect(db.withFirm(x.avery, (s) => importFiles(s, x.connectionId, { matterId: x.matter.id, folderId: x.correspondence.id, items: [bad] })))
        .rejects.toThrow(/Choose files from the list/);
    }
    expect(await importsOf(x.connectionId)).toHaveLength(0);
  });

  it("Google Drive has one listing; its file ids are never folders, and each system's ids stay its own", async () => {
    const x = await setup();
    for (const loc of [`gdrive:${MEMO}`, "sites", "dbx:id:folderSmith01", "drive:D1:F1"]) {
      await expect(db.withFirm(x.avery, (s) => s.client.query("SELECT huis.request_integration_listing($1, $2)", [x.connectionId, loc]))).rejects.toThrow(/invalid folder/);
    }
    const dbx = await db.withFirm(x.avery, (s) => connectIntegration(s, {
      provider: "dropbox", subject: "dbid:AAH4f99T0taONIb-OurWxbNQ6ywGRopQngc", tenant: null, label: "x", refreshToken: "RT", masterKey: MASTER }));
    await expect(db.withFirm(x.avery, (s) => s.client.query("SELECT huis.request_integration_listing($1, $2)", [dbx, `gdrive:${MEMO}`]))).rejects.toThrow(/invalid folder/);
    await open(x.avery, x.connectionId);
    await expect(db.withFirm(x.avery, (s) => importFiles(s, dbx, { matterId: x.matter.id, folderId: x.correspondence.id, items: [`gdrive:${MEMO}`] })))
      .rejects.toThrow(/Choose files from the list/);
  });

  it("the connection is its owner's alone: colleagues can't list or import from it", async () => {
    const x = await setup();
    await open(x.avery, x.connectionId);
    await expect(db.withFirm(x.sam, (s) => browse(s, x.connectionId))).rejects.toThrow(/not found/i);
    await expect(db.withFirm(x.sam, (s) => s.client.query("SELECT huis.request_integration_import($1, $2, $3, $4, false)",
      [x.connectionId, x.matter.id, x.correspondence.id, [`gdrive:${MEMO}`]]))).rejects.toThrow(/not permitted|permission/);
  });

  it("a Google Doc chosen after listing, or a file un-shared from Huis, fails just that import", async () => {
    const x = await setup();
    await open(x.avery, x.connectionId);
    await db.withFirm(x.avery, (s) => importFiles(s, x.connectionId, { matterId: x.matter.id, folderId: x.correspondence.id, items: [`gdrive:${RETAINER}`, `gdrive:${MEMO}`] }));
    g.files.find((f) => f.id === RETAINER)!.chosen = false;
    g.files.find((f) => f.id === MEMO)!.mime = "application/vnd.google-apps.document";
    await drain();
    const rows = await importsOf(x.connectionId);
    expect(rows.map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(rows.map((r) => r.last_error).join(" ")).toMatch(/Google Docs/);
    expect(await evidenceIn(x.matter.id)).toHaveLength(0);
    expect((await db.withFirm(x.avery, (s) => listMyConnections(s)))[0]).toMatchObject({ status: "active" });
  });

  it("a refused sign-in, or one that now carries more access, marks the connection for reconnecting", async () => {
    const x = await setup();
    g.refreshScope = "openid https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive";
    await open(x.avery, x.connectionId);
    expect((await db.withFirm(x.avery, (s) => listMyConnections(s)))[0]).toMatchObject({ status: "needs_reconnect" });
    const y = await setup();
    g.refreshScope = null;
    g.refreshError = "invalid_grant";
    await open(y.avery, y.connectionId);
    expect((await db.withFirm(y.avery, (s) => listMyConnections(s)))[0]).toMatchObject({ status: "needs_reconnect" });
  });

  it("a token for a different Google account is refused before anything is listed (review 20, R20-1)", async () => {
    const x = await setup();
    // Sam files their own working Google sign-in under Avery's account id.
    g.refreshTokens["SAM-RT"] = "SAM-AT";
    g.accessSubs["SAM-AT"] = "100000000000000000777";
    await t.admin.query("UPDATE huis.integration_credentials SET ciphertext = $2 WHERE connection_id = $1",
      [x.connectionId, sealCredential(MASTER, credentialId(x.firmId, "google_drive", DRIVE_SUB), "SAM-RT")]);
    await open(x.avery, x.connectionId);
    expect((await db.withFirm(x.avery, (s) => listMyConnections(s)))[0]).toMatchObject({ status: "needs_reconnect" });
    expect(g.calls.some((c) => c.path.startsWith("/drive/") && c.auth === "Bearer SAM-AT")).toBe(false);
  });

  it("long lists are read page by page", async () => {
    const x = await setup();
    g.pageSize = 2;
    for (let i = 0; i < 7; i++) g.files.push({ id: `1bulkExhibit${String(i).padStart(18, "0")}`, name: `Exhibit ${i}.txt`, content: `x${i}`, rev: `0B7bulk${i}`, chosen: true });
    const root = await open(x.avery, x.connectionId);
    expect(root.items).toHaveLength(9);
    expect(root.truncated).toBe(false);
  });
});

describe("downloads", () => {
  it("follow Google's redirects only to its content hosts over HTTPS, and never with the token", async () => {
    expect(driveDownloadHostAllowed("https://doc-0g-1c-docs.googleusercontent.com/docs/securesc/x")).toBe(true);
    for (const bad of ["http://doc-0g.googleusercontent.com/x", "https://googleusercontent.com.evil.example/x", "https://evil.example/googleusercontent.com",
      "https://user:pw@doc.googleusercontent.com/x", "https://doc.googleusercontent.com:8443/x", "https://www.googleapis.com/x", "not a url"]) {
      expect(driveDownloadHostAllowed(bad)).toBe(false);
    }
    g.files = [{ id: MEMO, name: "m.txt", content: "abc", chosen: true }];
    g.redirectDownloadTo = `${g.base}/content?id=${MEMO}`;
    // The fake's content host is plain http on localhost, so it is refused (as any non-Google host would be).
    await expect(new GoogleDriveSource("GDA-good").download(`gdrive:${MEMO}`)).rejects.toThrow(/somewhere unexpected/);
    expect(g.calls.some((c) => c.path === "/content")).toBe(false);
  });

  it("refuses ids of the wrong shape before asking Google anything", async () => {
    const src = new GoogleDriveSource("GDA-good");
    for (const bad of ["gdrive:../../about", "gdrive:a/b", "dbx:id:x", "root"]) {
      await expect(src.describe(bad)).rejects.toThrow(/unknown file/);
      await expect(src.download(bad)).rejects.toThrow(/unknown file/);
    }
    await expect(src.list("gdrive:abc")).rejects.toThrow(/unknown folder/);
    expect(g.calls).toHaveLength(0);
  });
});
