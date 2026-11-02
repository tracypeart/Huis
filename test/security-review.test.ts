/**
 * Regression tests for every finding of the independent security review
 * (November 2026). Each test is named after the finding it guards.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { PermissionDeniedError, UnauthenticatedError, UserFacingError } from "../src/errors";
import { verifyAuditChain, recordAudit } from "../src/services/audit";
import { createClient } from "../src/services/clients";
import { createContact } from "../src/services/contacts";
import {
  assembleOriginal, authorizeDownload, custodyLog, getUploadSession, listEvidence, markChunkReceived, moveEvidence,
  newEvidenceId, recordEvidence, SharingAcknowledgementRequired, startUpload, storeChunk,
} from "../src/services/evidence";
import { resolveIdentity } from "../src/services/firms";
import { addMatterMember, createMatter, getMatter, linkContactToMatter, listMatterFolders } from "../src/services/matters";
import { changeUserRole, endUserSessions, inviteUser, issueInvitation } from "../src/services/users";
import { MasterKeyProvider } from "../src/storage/encryption";
import type { MalwareScanner } from "../src/storage/scanner";
import { EvidenceVault, LocalObjectStore } from "../src/storage/store";
import { EvidenceProcessor } from "../src/worker/processor";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

let t: TestDatabase;
let db: HuisDb;
let dir: string;
let vault: EvidenceVault;
const cleanScanner: MalwareScanner = {
  name: "TestScanner",
  async scan(content: Readable) {
    let all = "";
    for await (const c of content) all += (c as Buffer).toString("latin1");
    return all.includes("VIRUS") ? { status: "infected", detail: "Threat detected: test" } : { status: "clean", detail: "No threats found" };
  },
};

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  dir = await mkdtemp(path.join(os.tmpdir(), "huis-review-"));
  vault = new EvidenceVault(new LocalObjectStore(dir), new MasterKeyProvider(randomBytes(32).toString("base64")));
});
afterAll(async () => {
  await t?.drop();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function upload(ctx: RequestContext, matterId: string, filename: string, content: Buffer, folderId?: string) {
  const session = await db.withFirm(ctx, (s) => startUpload(s, { matterId, filename, totalSize: content.length, folderId }));
  await storeChunk(vault, session, 0, content);
  await db.withFirm(ctx, (s) => markChunkReceived(s, session.id, 0));
  const fresh = await db.withFirm(ctx, (s) => getUploadSession(s, session.id));
  const id = newEvidenceId();
  const file = await assembleOriginal(vault, fresh, id);
  return db.withFirm(ctx, (s) => recordEvidence(s, fresh, id, file));
}

async function setup() {
  const f = await newFirm(db);
  const x = await db.withFirm(f.owner, async (s) => {
    const client = await createClient(s, { kind: "person", displayName: "Client" });
    const atty = await inviteUser(s, { email: `a@${f.slug}.example`, fullName: "Alex Atty", role: "attorney", locationId: f.locationId });
    const para = await inviteUser(s, { email: `p@${f.slug}.example`, fullName: "Pat Para", role: "paralegal", locationId: f.locationId });
    const ro = await inviteUser(s, { email: `r@${f.slug}.example`, fullName: "Rae Readonly", role: "read_only", locationId: f.locationId });
    const portal = await inviteUser(s, { email: `c@${f.slug}.example`, fullName: "Casey Client", role: "client", locationId: f.locationId });
    const matter = await createMatter(s, { title: "Open matter", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
    return { client, atty, para, ro, portal, matter };
  });
  const ctx = (id: string): RequestContext => ({ firmId: f.firmId, userId: id });
  return { ...f, ...x, attyCtx: ctx(x.atty.id), paraCtx: ctx(x.para.id), roCtx: ctx(x.ro.id), portalCtx: ctx(x.portal.id) };
}

describe("H2/F8 — sign-in identities are linked only through invitations", () => {
  it("an admin cannot set, change or clear anyone's sign-in identity", async () => {
    const x = await setup();
    await expect(db.withFirm(x.owner, (s) => s.client.query(
      "UPDATE huis.users SET auth_provider = 'microsoft', auth_subject = 'attacker' WHERE id = $1", [x.para.id])))
      .rejects.toThrow(/invitation/);
    await expect(db.withFirm(x.owner, (s) => s.client.query(
      "UPDATE huis.users SET auth_subject = NULL, auth_provider = NULL WHERE id = $1", [x.ownerUserId])))
      .rejects.toThrow(/invitation/);
    await expect(db.withFirm(x.owner, (s) => s.client.query(
      "INSERT INTO huis.users (firm_id, email, full_name, matter_code, role, auth_provider, auth_subject) VALUES ($1, 'z@z.example', 'Z', 'Z', 'attorney', 'microsoft', 'attacker2')",
      [x.firmId]))).rejects.toThrow(/invitation/);
    expect(await resolveIdentity(db, "microsoft", "attacker")).toEqual([]);
  });

  it("a linked account cannot be re-invited (so it can't be taken over)", async () => {
    const x = await setup();
    await expect(db.withFirm(x.owner, (s) => issueInvitation(s, x.ownerUserId))).rejects.toBeInstanceOf(UserFacingError);
  });
});

describe("F2 — the red privileged area stays protected", () => {
  it("nobody can un-designate or re-classify it, or create a second one", async () => {
    const x = await setup();
    const red = (await db.withFirm(x.owner, (s) => listMatterFolders(s, x.matter.id))).find((f) => f.isPrivilegedArea)!;
    // The firm owner (allowed to edit folders) is stopped by the database rule.
    await expect(db.withFirm(x.owner, (s) => s.client.query(
      "UPDATE huis.matter_folders SET is_privileged_area = false WHERE id = $1", [red.id]))).rejects.toThrow();
    await expect(db.withFirm(x.owner, (s) => s.client.query(
      "UPDATE huis.matter_folders SET classification = 'client_accessible' WHERE id = $1", [red.id]))).rejects.toThrow();
    // An attorney who isn't a matter owner/editor can't touch folders at all.
    const r = await db.withFirm(x.attyCtx, (s) => s.client.query(
      "UPDATE huis.matter_folders SET is_privileged_area = false, classification = 'client_accessible' WHERE id = $1", [red.id]))
      .catch((e: Error) => e);
    expect(r instanceof Error || (r as { rowCount: number }).rowCount === 0).toBe(true);
    const after = (await db.withFirm(x.owner, (s) => listMatterFolders(s, x.matter.id))).find((f) => f.id === red.id)!;
    expect(after).toMatchObject({ isPrivilegedArea: true, classification: "attorney_client_privileged" });
    await expect(db.withFirm(x.owner, (s) => s.client.query(
      "INSERT INTO huis.matter_folders (firm_id, matter_id, name, is_privileged_area, created_by) VALUES ($1, $2, 'Fake red', true, $3)",
      [x.firmId, x.matter.id, x.ownerUserId]))).rejects.toThrow();
  });

  it("read-only users cannot change folders", async () => {
    const x = await setup();
    const any = (await db.withFirm(x.owner, (s) => listMatterFolders(s, x.matter.id))).find((f) => f.name === "Evidence")!;
    const r = await db.withFirm(x.roCtx, (s) => s.client.query(
      "UPDATE huis.matter_folders SET classification = 'client_accessible' WHERE id = $1", [any.id]));
    expect(r.rowCount).toBe(0);
  });
});

describe("G3 / F5 — matter membership cannot be hijacked", () => {
  it("an owner of one matter cannot re-point a membership to another matter", async () => {
    const x = await setup();
    const mine = await db.withFirm(x.paraCtx, (s) => createMatter(s, {
      title: "Paralegal's matter", clientId: x.client.id, leadAttorneyId: x.atty.id, jurisdictionState: "UT" }));
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query(
      "UPDATE huis.matter_members SET matter_id = $1 WHERE matter_id = $2 AND user_id = $3", [x.matter.id, mine.id, x.para.id])))
      .rejects.toThrow(/cannot be moved/);
  });

  it("people outside the firm can never be owners or editors, even by direct database access", async () => {
    const x = await setup();
    await expect(db.withFirm(x.owner, (s) => s.client.query(
      "INSERT INTO huis.matter_members (firm_id, matter_id, user_id, access, added_by) VALUES ($1, $2, $3, 'owner', $4)",
      [x.firmId, x.matter.id, x.portal.id, x.ownerUserId]))).rejects.toThrow(/view access/);
  });

  it("staff cannot be switched to an outside role in place", async () => {
    const x = await setup();
    await expect(db.withFirm(x.owner, (s) => changeUserRole(s, x.atty.id, "client"))).rejects.toBeInstanceOf(UserFacingError);
    await expect(db.withFirm(x.owner, (s) => s.client.query("UPDATE huis.users SET role = 'client' WHERE id = $1", [x.atty.id])))
      .rejects.toThrow(/outside role/);
  });
});

describe("F10 — ethical walls and matter identity", () => {
  it("only a matter owner can lift a wall; Huis numbers can't be changed or supplied", async () => {
    const x = await setup();
    const walled = await db.withFirm(x.attyCtx, (s) => createMatter(s, {
      title: "Walled", clientId: x.client.id, leadAttorneyId: x.atty.id, jurisdictionState: "UT", restricted: true }));
    await db.withFirm(x.attyCtx, (s) => addMatterMember(s, { matterId: walled.id, userId: x.para.id, access: "edit" }));
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query("UPDATE huis.matters SET restricted = false WHERE id = $1", [walled.id])))
      .rejects.toThrow(/matter owner/);
    await expect(db.withFirm(x.attyCtx, (s) => s.client.query("UPDATE huis.matters SET huis_number = 'HUIS-FAKE' WHERE id = $1", [walled.id])))
      .rejects.toThrow(/immutable/);
    await db.withFirm(x.attyCtx, (s) => s.client.query("UPDATE huis.matters SET restricted = false WHERE id = $1", [walled.id]));

    const id = randomUUID();
    await db.withFirm(x.attyCtx, (s) => s.client.query(
      `INSERT INTO huis.matters (id, firm_id, location_id, client_id, title, huis_number, jurisdiction_state, lead_attorney_id, created_by)
       VALUES ($1, $2, $3, $4, 'Supplied number', 'HUIS-CHOSEN-BY-APP', 'UT', $5, $5)`,
      [id, x.firmId, x.locationId, x.client.id, x.atty.id]));
    expect((await db.withFirm(x.attyCtx, (s) => getMatter(s, id))).huisNumber).toMatch(/^HUIS-UT-AATTY-\d{4}-\d{6}$/);
  });
});

describe("F9 — sharing privileged material with outsiders needs an acknowledgement", () => {
  it("moving into Client Uploads is blocked until acknowledged, then recorded", async () => {
    const x = await setup();
    await db.withFirm(x.owner, (s) => addMatterMember(s, { matterId: x.matter.id, userId: x.portal.id, access: "view", acknowledgePrivilegeWaiverRisk: true }));
    const folders = await db.withFirm(x.owner, (s) => listMatterFolders(s, x.matter.id));
    const red = folders.find((f) => f.isPrivilegedArea)!;
    const clientUploads = folders.find((f) => f.name === "Client Uploads")!;
    const item = await upload(x.owner, x.matter.id, "strategy.docx", Buffer.from("privileged strategy"), red.id);

    await expect(db.withFirm(x.owner, (s) => moveEvidence(s, item.id, clientUploads.id))).rejects.toBeInstanceOf(SharingAcknowledgementRequired);
    expect((await db.withFirm(x.portalCtx, (s) => listEvidence(s, x.matter.id))).map((e) => e.id)).not.toContain(item.id);

    await db.withFirm(x.owner, (s) => moveEvidence(s, item.id, clientUploads.id, { acknowledgePrivilegeWaiverRisk: true }));
    const log = await db.withFirm(x.owner, (s) => custodyLog(s, item.id));
    expect(log.events.at(-1)).toMatchObject({
      event: "moved",
      details: { left_privileged_area: true, shared_outside_firm: true, privilege_waiver_acknowledged: true },
    });
    expect(log.brokenAt).toBeNull();
  });

  it("moves can't cross into another matter", async () => {
    const x = await setup();
    const other = await db.withFirm(x.owner, (s) => createMatter(s, { title: "Other", clientId: x.client.id, leadAttorneyId: x.ownerUserId, jurisdictionState: "UT" }));
    const otherFolder = (await db.withFirm(x.owner, (s) => listMatterFolders(s, other.id))).find((f) => f.name === "Evidence")!;
    const item = await upload(x.owner, x.matter.id, "a.txt", Buffer.from("a"));
    await expect(db.withFirm(x.owner, (s) => moveEvidence(s, item.id, otherFolder.id))).rejects.toThrow(/not found/);
  });
});

describe("H1 / F7 / J1 — custody, receipt details and scanning can't be forged", () => {
  it("the app cannot write custody events, queue jobs or edit evidence", async () => {
    const x = await setup();
    const item = await upload(x.owner, x.matter.id, "x.txt", Buffer.from("x"));
    for (const sql of [
      ["INSERT INTO huis.evidence_custody_events (firm_id, evidence_id, actor_user_id, event) VALUES ($1, $2, $3, 'moved')", [x.firmId, item.id, x.ownerUserId]],
      ["INSERT INTO huis.jobs (firm_id, kind, evidence_id) VALUES ($1, 'evidence.process', $2)", [x.firmId, item.id]],
      ["UPDATE huis.evidence_items SET received_from = 'forged' WHERE id = $1", [item.id]],
    ] as const) {
      await expect(db.withFirm(x.owner, (s) => s.client.query(sql[0], [...sql[1]]))).rejects.toBeInstanceOf(PermissionDeniedError);
    }
  });

  it("evidence can't be recorded into a folder of a different matter", async () => {
    const x = await setup();
    const other = await db.withFirm(x.owner, (s) => createMatter(s, { title: "Other", clientId: x.client.id, leadAttorneyId: x.ownerUserId, jurisdictionState: "UT" }));
    const otherFolder = (await db.withFirm(x.owner, (s) => listMatterFolders(s, other.id))).find((f) => f.name === "Evidence")!;
    await expect(db.withFirm(x.owner, (s) => s.client.query(
      `INSERT INTO huis.evidence_items (id, firm_id, matter_id, folder_id, original_filename, size_bytes, sha256, storage_key, source, uploaded_by)
       VALUES (gen_random_uuid(), $1, $2, $3, 'x', 1, repeat('a', 64), 'k-' || gen_random_uuid(), 'upload', $4)`,
      [x.firmId, x.matter.id, otherFolder.id, x.ownerUserId]))).rejects.toThrow();
  });

  it("a scan verdict is never overwritten, and only the worker holding the job can report", async () => {
    const x = await setup();
    const item = await upload(x.owner, x.matter.id, "bad.bin", Buffer.from("this has a VIRUS in it"));
    await new EvidenceProcessor(t.worker, vault, cleanScanner).drain();
    // Simulate a re-queue and a later "clean" report for the same item.
    await t.admin.query("UPDATE huis.jobs SET status = 'queued', run_after = now() WHERE evidence_id = $1", [item.id]);
    const claimed = (await t.worker.query("SELECT * FROM huis.worker_claim_job()")).rows[0];
    await expect(t.worker.query("SELECT huis.worker_complete($1, gen_random_uuid(), 'clean', 'x', 'x', $2)", [claimed.job_id, claimed.sha256]))
      .rejects.toThrow(/not held/);
    await t.worker.query("SELECT huis.worker_complete($1, $2, 'clean', 'x', 'x', $3)", [claimed.job_id, claimed.lock_token, claimed.sha256]);
    const status = (await t.admin.query("SELECT status FROM huis.evidence_items WHERE id = $1", [item.id])).rows[0].status;
    expect(status).toBe("infected");
    await expect(db.withFirm(x.owner, (s) => authorizeDownload(s, item.id))).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe("F3 / F4 / G2 — matter contacts", () => {
  it("read-only users can't link contacts and outsiders can't see them", async () => {
    const x = await setup();
    const judge = await db.withFirm(x.owner, (s) => createContact(s, { kind: "judge", fullName: "Hon. Judge" }));
    await expect(db.withFirm(x.roCtx, (s) => linkContactToMatter(s, x.matter.id, judge.id, "x"))).rejects.toBeInstanceOf(PermissionDeniedError);
    await db.withFirm(x.owner, (s) => linkContactToMatter(s, x.matter.id, judge.id, "Presiding judge"));
    await db.withFirm(x.owner, (s) => addMatterMember(s, { matterId: x.matter.id, userId: x.portal.id, access: "view", acknowledgePrivilegeWaiverRisk: true }));
    await db.withFirm(x.portalCtx, async (s) => {
      expect((await s.client.query("SELECT count(*)::int AS n FROM huis.matter_contacts")).rows[0].n).toBe(0);
    });
    await expect(db.withFirm(x.portalCtx, (s) => linkContactToMatter(s, x.matter.id, judge.id, "client-added"))).rejects.toThrow();
  });
});

describe("F6 / G1 — tamper-evident chains under concurrent use", () => {
  it("the audit and custody chains stay intact when many people work at once", async () => {
    const x = await setup();
    await Promise.all(Array.from({ length: 25 }, (_, i) => db.withFirm(i % 2 ? x.owner : x.attyCtx, async (s) => {
      await recordAudit(s, "test.concurrent", { metadata: { i } });
      await recordAudit(s, "test.concurrent", { metadata: { i, second: true } });
    })));
    expect(await db.withFirm(x.owner, (s) => verifyAuditChain(s))).toBeNull();

    const item = await upload(x.owner, x.matter.id, "c.txt", Buffer.from("concurrent"));
    await new EvidenceProcessor(t.worker, vault, cleanScanner).drain();
    await Promise.all(Array.from({ length: 20 }, () => db.withFirm(x.owner, (s) => authorizeDownload(s, item.id))));
    const log = await db.withFirm(x.owner, (s) => custodyLog(s, item.id));
    expect(log.events.filter((e) => e.event === "downloaded")).toHaveLength(20);
    expect(log.brokenAt).toBeNull();
  });
});

describe("Sessions, billing fields and other hardening", () => {
  it("'sign out everywhere' invalidates every existing session", async () => {
    const x = await setup();
    const version = await db.withFirm(x.owner, async (s) => s.actor.sessionVersion);
    await db.withFirm({ ...x.owner, sessionVersion: version }, async () => 1);
    await db.withFirm(x.owner, (s) => endUserSessions(s, x.ownerUserId));
    await expect(db.withFirm({ ...x.owner, sessionVersion: version }, async () => 1)).rejects.toBeInstanceOf(UnauthenticatedError);
    await db.withFirm({ ...x.owner, sessionVersion: version + 1 }, async () => 1);
  });

  it("firm admins can't change plan, trial or account status", async () => {
    const x = await setup();
    await expect(db.withFirm(x.owner, (s) => s.client.query("UPDATE huis.firms SET plan = 'enterprise', trial_ends_at = now() + interval '10 years'")))
      .rejects.toThrow(/managed by Huis/);
  });

  it("folder lookups don't reveal anything about walled matters", async () => {
    const x = await setup();
    const walled = await db.withFirm(x.attyCtx, (s) => createMatter(s, {
      title: "Walled", clientId: x.client.id, leadAttorneyId: x.atty.id, jurisdictionState: "UT", restricted: true }));
    const folder = (await db.withFirm(x.attyCtx, (s) => listMatterFolders(s, walled.id)))[0]!;
    const seen = await db.withFirm(x.paraCtx, (s) => s.client.query("SELECT huis.folder_classification($1) AS c", [folder.id]));
    expect(seen.rows[0].c).toBeNull();
  });

  it("request IPs reach the custody record only when provided by a trusted source", async () => {
    const x = await setup();
    const item = await upload({ ...x.owner, ipAddress: "203.0.113.7" }, x.matter.id, "ip.txt", Buffer.from("ip"));
    const ip = (await t.admin.query("SELECT host(ip_address) AS ip FROM huis.evidence_custody_events WHERE evidence_id = $1 AND event = 'received'", [item.id])).rows[0].ip;
    expect(ip).toBe("203.0.113.7");
    // Garbage is never passed through to the database.
    const item2 = await upload({ ...x.owner, ipAddress: "not-an-ip" }, x.matter.id, "ip2.txt", Buffer.from("ip2"));
    const ip2 = (await t.admin.query("SELECT ip_address FROM huis.evidence_custody_events WHERE evidence_id = $1 AND event = 'received'", [item2.id])).rows[0].ip_address;
    expect(ip2).toBeNull();
  });
});
