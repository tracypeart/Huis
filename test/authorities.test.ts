import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrainWorker } from "../src/brain/worker";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { createClient } from "../src/services/clients";
import { addAuthority, citeAuthority, claimsMatrix, deleteAuthority, listAuthorities, uncite, updateAuthority, verifyAuthority } from "../src/services/authorities";
import { addClaimFromTemplate, addFactFromPassage, claimView, findEvidenceFor } from "../src/services/dna";
import { assembleOriginal, getUploadSession, markChunkReceived, newEvidenceId, recordEvidence, startUpload, storeChunk } from "../src/services/evidence";
import { addMatterMember, createMatter } from "../src/services/matters";
import { inviteUser } from "../src/services/users";
import { MasterKeyProvider } from "../src/storage/encryption";
import type { MalwareScanner } from "../src/storage/scanner";
import { EvidenceVault, LocalObjectStore } from "../src/storage/store";
import { EvidenceProcessor } from "../src/worker/processor";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

let t: TestDatabase;
let db: HuisDb;
let vault: EvidenceVault;
let vaultDir: string;
let processor: EvidenceProcessor;
let brain: BrainWorker;
const scanner: MalwareScanner = {
  name: "test",
  async scan(stream) { for await (const _ of stream) { /* drain */ } return { status: "clean", detail: "No threats found" }; },
};

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-authorities-vault-"));
  vault = new EvidenceVault(new LocalObjectStore(vaultDir), new MasterKeyProvider(randomBytes(32).toString("base64")));
  processor = new EvidenceProcessor(t.worker, vault, scanner);
  brain = new BrainWorker(t.worker);
});
afterAll(async () => {
  await t?.drop();
  if (vaultDir) await rm(vaultDir, { recursive: true, force: true });
});

async function upload(ctx: RequestContext, matterId: string, filename: string, text: string, folderId?: string) {
  const content = Buffer.from(text);
  const session = await db.withFirm(ctx, (s) => startUpload(s, { matterId, filename, totalSize: content.length, folderId }));
  for (let i = 0; i < session.chunkCount; i++) {
    await storeChunk(vault, session, i, content.subarray(i * session.chunkSize, (i + 1) * session.chunkSize));
    await db.withFirm(ctx, (s) => markChunkReceived(s, session.id, i));
  }
  const fresh = await db.withFirm(ctx, (s) => getUploadSession(s, session.id));
  const id = newEvidenceId();
  const stored = await assembleOriginal(vault, fresh, id);
  return db.withFirm(ctx, (s) => recordEvidence(s, fresh, id, stored));
}
async function process() {
  await processor.drain();
  while (await brain.indexOnce()) { /* index */ }
}
const infect = (id: string) =>
  t.admin.query(`SET session_replication_role = replica; UPDATE huis.evidence_items SET status = 'infected' WHERE id = '${id}'; SET session_replication_role = origin;`);

async function setup() {
  const f = await newFirm(db);
  const x = await db.withFirm(f.owner, async (s) => {
    const client = await createClient(s, { kind: "person", displayName: "Pat Smith", email: "pat.smith@example.com" });
    const para = await inviteUser(s, { email: `p@${f.slug}.example`, fullName: "Pat Para", role: "paralegal", locationId: f.locationId });
    const reader = await inviteUser(s, { email: `r@${f.slug}.example`, fullName: "Rae Reader", role: "read_only", locationId: f.locationId });
    const portal = await inviteUser(s, { email: `c@${f.slug}.example`, fullName: "Casey Client", role: "client", locationId: f.locationId });
    const matter = await createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
    const walled = await createMatter(s, { title: "Walled", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT", restricted: true });
    return { para, reader, portal, matter, walled };
  });
  await db.withFirm(f.owner, (s) => addMatterMember(s, { matterId: x.matter.id, userId: x.portal.id, access: "view", acknowledgePrivilegeWaiverRisk: true }));
  const ctx = (id: string): RequestContext => ({ firmId: f.firmId, userId: id });
  return { ...f, ...x, paraCtx: ctx(x.para.id), readerCtx: ctx(x.reader.id), portalCtx: ctx(x.portal.id) };
}

const LETTER = `Termination letter.

Dear Ms. Smith, your employment with Acme Corporation is terminated effective April 18, 2026.
This decision follows your request for FMLA leave on April 2, 2026 for surgery.`;
const CASE = { kind: "case", citation: "Metzler v. Fed. Home Loan Bank of Topeka, 464 F.3d 1164 (10th Cir. 2006)", title: "Metzler v. Federal Home Loan Bank of Topeka",
  court: "10th Cir.", year: 2006, url: "https://www.courtlistener.com/opinion/000000/metzler-v-federal-home-loan-bank/" };
const STATUTE = { kind: "statute", citation: "29 U.S.C. § 2615(a)(2)", url: "https://www.law.cornell.edu/uscode/text/29/2615" };

describe("legal authority library", () => {
  it("adds authorities linked to a real record, unverified until an attorney confirms; changing the citation or link clears that", async () => {
    const x = await setup();
    const id = await db.withFirm(x.paraCtx, (s) => addAuthority(s, CASE));
    let [a] = await db.withFirm(x.paraCtx, (s) => listAuthorities(s));
    expect(a).toMatchObject({ kind: "case", official: true, verified: null, addedBy: "Pat Para", citedIn: 0 });
    await expect(db.withFirm(x.paraCtx, (s) => addAuthority(s, { ...CASE, citation: ` ${CASE.citation.toUpperCase()} ` }))).rejects.toThrow(/already in the library/);
    for (const url of ["http://example.com/x", "javascript:alert(1)", "https://localhost/x", "https://user:pw@law.example/x", "not a link"]) {
      await expect(db.withFirm(x.paraCtx, (s) => addAuthority(s, { ...STATUTE, url }))).rejects.toThrow();
    }
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query(
      "INSERT INTO huis.legal_authorities (firm_id, kind, citation, url, created_by) VALUES ($1, 'rule', 'x', 'javascript:alert(1)', $2)", [x.firmId, x.para.id]))).rejects.toThrow(/check/);
    expect((await db.withFirm(x.paraCtx, (s) => listAuthorities(s, "metzler"))).length).toBe(1);
    expect((await db.withFirm(x.paraCtx, (s) => listAuthorities(s, "%"))).length).toBe(0);

    await db.withFirm(x.owner, (s) => verifyAuthority(s, id, true));
    [a] = await db.withFirm(x.paraCtx, (s) => listAuthorities(s));
    expect(a!.verified?.by).toBe("Jane Smith");
    // Changing what the authority is clears its verification (in the database, too).
    await db.withFirm(x.paraCtx, (s) => updateAuthority(s, id, { ...CASE, url: "https://casetext.example.com/case/metzler" }));
    [a] = await db.withFirm(x.paraCtx, (s) => listAuthorities(s));
    expect(a).toMatchObject({ verified: null, official: false });
    // Nobody can record a verification as someone else, or backdate it, or change who added it.
    await db.withFirm(x.paraCtx, (s) => s.client.query(
      "UPDATE huis.legal_authorities SET verified_by = $2, verified_at = '2001-01-01' WHERE id = $1", [id, x.ownerUserId]));
    const row = (await t.admin.query("SELECT verified_by, verified_at, created_by FROM huis.legal_authorities WHERE id = $1", [id])).rows[0];
    expect(row.verified_by).toBe(x.para.id);
    expect(new Date(row.verified_at).getUTCFullYear()).toBeGreaterThan(2001);
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query("UPDATE huis.legal_authorities SET created_by = $2 WHERE id = $1", [id, x.ownerUserId]))).rejects.toThrow(/keeps who added/);
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query("UPDATE huis.legal_authorities SET verified_by = $2 WHERE id = $1", [id, x.ownerUserId]))).rejects.toThrow(/who verified/);
    // Read-only staff can read but not change; clients and other firms see nothing.
    expect((await db.withFirm(x.readerCtx, (s) => listAuthorities(s))).length).toBe(1);
    await expect(db.withFirm(x.readerCtx, (s) => addAuthority(s, STATUTE))).rejects.toThrow(/permission/i);
    await expect(db.withFirm(x.readerCtx, (s) => verifyAuthority(s, id, false))).rejects.toThrow(/permission/i);
    await expect(db.withFirm(x.portalCtx, (s) => listAuthorities(s))).rejects.toThrow(/permission/i);
    expect((await db.withFirm(x.portalCtx, (s) => s.client.query("SELECT 1 FROM huis.legal_authorities"))).rowCount).toBe(0);
    const other = await newFirm(db, "Other Owner");
    expect(await db.withFirm(other.owner, (s) => listAuthorities(s))).toEqual([]);
    // The audit log records the kind of authority, never the citation.
    const audit = await t.admin.query("SELECT metadata::text AS m FROM huis.audit_events WHERE firm_id = $1 AND action LIKE 'authority.%'", [x.firmId]);
    expect(audit.rows.length).toBeGreaterThanOrEqual(3);
    expect(audit.rows.every((r) => !/Metzler|2615|courtlistener/i.test(r.m))).toBe(true);
  });
});

describe("claims matrix", () => {
  it("shows each element's facts, sources and authorities, and its gaps by fixed rules", async () => {
    const x = await setup();
    await upload(x.owner, x.matter.id, "termination.txt", LETTER);
    await process();
    const claimId = await db.withFirm(x.owner, (s) => addClaimFromTemplate(s, x.matter.id, "fmla_retaliation"));
    const authId = await db.withFirm(x.owner, (s) => addAuthority(s, STATUTE));
    let m = await db.withFirm(x.paraCtx, (s) => claimsMatrix(s, x.matter.id));
    const el = m[0]!.elements[0]!;
    expect(el.gaps).toEqual(["no confirmed supporting fact", "no legal authority cited"]);

    await db.withFirm(x.paraCtx, async (s) => {
      const passage = (await findEvidenceFor(s, el.id))[0]!;
      await addFactFromPassage(s, el.id, { chunkId: passage.chunkId, relation: "supports" });
      await citeAuthority(s, el.id, { authorityId: authId, stance: "supports", proposition: "Taking FMLA leave is protected activity.", pinpoint: "(a)(2)" });
    });
    m = await db.withFirm(x.paraCtx, (s) => claimsMatrix(s, x.matter.id));
    const after = m[0]!.elements.find((e) => e.id === el.id)!;
    expect(after).toMatchObject({ supporting: 1, sources: 1, gaps: ["authority not yet verified"] });
    expect(after.authorities[0]).toMatchObject({ stance: "supports", pinpoint: "(a)(2)", authority: { citation: STATUTE.citation, official: true, verified: null } });
    await db.withFirm(x.owner, (s) => verifyAuthority(s, authId, true));
    expect((await db.withFirm(x.paraCtx, (s) => claimsMatrix(s, x.matter.id)))[0]!.elements.find((e) => e.id === el.id)!.gaps).toEqual([]);

    // A cited authority can't be deleted from the library until its citations are removed.
    await expect(db.withFirm(x.owner, (s) => deleteAuthority(s, authId))).rejects.toThrow(/cited in a Matter/);
    await expect(t.admin.query("DELETE FROM huis.legal_authorities WHERE id = $1", [authId])).rejects.toThrow(/foreign key/);
    const linkId = after.authorities[0]!.linkId;
    await expect(db.withFirm(x.readerCtx, (s) => uncite(s, linkId))).rejects.toThrow(/permission/i);
    await db.withFirm(x.paraCtx, (s) => uncite(s, linkId));
    // Only the person who added it (or an administrator) removes it from the library.
    await expect(db.withFirm(x.paraCtx, (s) => deleteAuthority(s, authId))).rejects.toThrow(/permission|someone else/i);
    await db.withFirm(x.owner, (s) => deleteAuthority(s, authId));
    void claimId;
  });

  it("citations are work product: staff on the Matter only; walls, other Matters and other firms are kept out (also in the database)", async () => {
    const x = await setup();
    const authId = await db.withFirm(x.owner, (s) => addAuthority(s, STATUTE));
    const [mine, walled] = await db.withFirm(x.owner, async (s) => [
      await addClaimFromTemplate(s, x.matter.id, "fmla_retaliation"), await addClaimFromTemplate(s, x.walled.id, "fmla_retaliation")]);
    const walledEl = (await db.withFirm(x.owner, (s) => claimView(s, walled!))).elements[0]!.element.id;
    await db.withFirm(x.owner, (s) => citeAuthority(s, walledEl, { authorityId: authId, stance: "supports", proposition: "Walled reasoning." }));
    await expect(db.withFirm(x.paraCtx, (s) => citeAuthority(s, walledEl, { authorityId: authId, stance: "supports", proposition: "x" }))).rejects.toThrow(/not found/i);
    await expect(db.withFirm(x.paraCtx, (s) => claimsMatrix(s, x.walled.id))).rejects.toThrow(/not found/i);
    expect((await db.withFirm(x.paraCtx, (s) => s.client.query("SELECT proposition FROM huis.authority_links"))).rowCount).toBe(0);
    expect((await db.withFirm(x.paraCtx, (s) => s.client.query("DELETE FROM huis.authority_links"))).rowCount).toBe(0);
    // A citation must be for a confirmed claim/defense/element of the same Matter.
    await expect(db.withFirm(x.owner, (s) => s.client.query(
      `INSERT INTO huis.authority_links (firm_id, matter_id, node_id, authority_id, stance, proposition, created_by) VALUES ($1, $2, $3, $4, 'supports', 'x', $5)`,
      [x.firmId, x.matter.id, walledEl, authId, x.ownerUserId]))).rejects.toThrow(/same Matter/);
    // Another firm's authority can't be cited.
    const other = await newFirm(db, "Other Owner");
    const theirs = await db.withFirm(other.owner, (s) => addAuthority(s, STATUTE));
    await expect(db.withFirm(x.owner, (s) => citeAuthority(s, mine!, { authorityId: theirs, stance: "supports", proposition: "x" }))).rejects.toThrow(/not found/i);
    await expect(db.withFirm(x.portalCtx, (s) => claimsMatrix(s, x.matter.id))).rejects.toThrow(/permission/i);
    expect((await db.withFirm(x.readerCtx, (s) => claimsMatrix(s, x.matter.id))).length).toBe(1);
    await expect(db.withFirm(x.readerCtx, (s) => citeAuthority(s, mine!, { authorityId: authId, stance: "supports", proposition: "x" }))).rejects.toThrow(/permission/i);
  });
});
