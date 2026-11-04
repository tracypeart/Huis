// Security review 16: Phase 7 part 1 (claims matrix and legal authority library).
// F-tests fail on the reviewed code and pass once the finding is fixed; "blocked:" tests document attacks that are stopped.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { createClient } from "../src/services/clients";
import {
  addAuthority, citeAuthority, claimsMatrix, deleteAuthority, isOfficial, listAuthorities, updateAuthority, verifyAuthority,
} from "../src/services/authorities";
import { addClaimFromTemplate, claimView } from "../src/services/dna";
import { addMatterMember, createMatter } from "../src/services/matters";
import { inviteUser } from "../src/services/users";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

let t: TestDatabase;
let db: HuisDb;
beforeAll(async () => { t = await createTestDatabase(); db = t.db; });
afterAll(async () => { await t?.drop(); });

async function setup() {
  const f = await newFirm(db);
  const x = await db.withFirm(f.owner, async (s) => {
    const client = await createClient(s, { kind: "person", displayName: "Pat Smith", email: "pat.smith@example.com" });
    const para = await inviteUser(s, { email: `p@${f.slug}.example`, fullName: "Pat Para", role: "paralegal", locationId: f.locationId });
    const billing = await inviteUser(s, { email: `b@${f.slug}.example`, fullName: "Bo Billing", role: "billing_admin", locationId: f.locationId });
    const assistant = await inviteUser(s, { email: `a@${f.slug}.example`, fullName: "Al Assistant", role: "legal_assistant", locationId: f.locationId });
    const reader = await inviteUser(s, { email: `r@${f.slug}.example`, fullName: "Rae Reader", role: "read_only", locationId: f.locationId });
    const portal = await inviteUser(s, { email: `c@${f.slug}.example`, fullName: "Casey Client", role: "client", locationId: f.locationId });
    const matter = await createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
    const walled = await createMatter(s, { title: "Walled", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT", restricted: true });
    return { para, billing, assistant, reader, portal, matter, walled };
  });
  await db.withFirm(f.owner, (s) => addMatterMember(s, { matterId: x.matter.id, userId: x.portal.id, access: "view", acknowledgePrivilegeWaiverRisk: true }));
  const ctx = (id: string): RequestContext => ({ firmId: f.firmId, userId: id });
  return {
    ...f, ...x,
    paraCtx: ctx(x.para.id), billingCtx: ctx(x.billing.id), assistantCtx: ctx(x.assistant.id), readerCtx: ctx(x.reader.id), portalCtx: ctx(x.portal.id),
  };
}
async function firstElement(ctx: RequestContext, matterId: string) {
  const claimId = await db.withFirm(ctx, (s) => addClaimFromTemplate(s, matterId, "fmla_retaliation"));
  const el = (await db.withFirm(ctx, (s) => claimView(s, claimId))).elements[0]!.element.id;
  return { claimId, el };
}
const verifiedRow = async (id: string) =>
  (await t.admin.query("SELECT citation, url, title, court, year, verified_by, verified_at FROM huis.legal_authorities WHERE id = $1", [id])).rows[0];

const CASE = { kind: "case", citation: "Metzler v. Fed. Home Loan Bank of Topeka, 464 F.3d 1164 (10th Cir. 2006)", title: "Metzler v. Federal Home Loan Bank of Topeka",
  court: "10th Cir.", year: 2006, url: "https://www.courtlistener.com/opinion/000000/metzler-v-federal-home-loan-bank/" };
const OTHER_CASE = { kind: "case", citation: "Doe v. Roe, 999 F.3d 1 (9th Cir. 2021)", title: "Doe v. Roe", court: "9th Cir.", year: 2021,
  url: "https://www.courtlistener.com/opinion/999999/doe-v-roe/" };
const STATUTE = { kind: "statute", citation: "29 U.S.C. § 2615(a)(2)", url: "https://www.law.cornell.edu/uscode/text/29/2615" };

describe("security review 16: confirmed findings", () => {
  it("F1: non-attorney staff (billing administrator, legal assistant, paralegal) cannot mark an authority verified", async () => {
    const x = await setup();
    const id = await db.withFirm(x.owner, (s) => addAuthority(s, CASE));
    // Billing staff: service.
    await expect(db.withFirm(x.billingCtx, (s) => verifyAuthority(s, id, true))).rejects.toThrow(/permission/i);
    // Legal assistant: direct SQL as the app role.
    await db.withFirm(x.assistantCtx, (s) => s.client.query("UPDATE huis.legal_authorities SET verified_at = now(), verified_by = $2 WHERE id = $1", [id, x.assistant.id])).catch(() => undefined);
    // Paralegal: service.
    await db.withFirm(x.paraCtx, (s) => verifyAuthority(s, id, true)).catch(() => undefined);
    expect((await verifiedRow(id)).verified_at).toBeNull();
  });

  it("F2: changing a verified authority's name, court or year (what case it is) clears the verification", async () => {
    const x = await setup();
    const id = await db.withFirm(x.owner, (s) => addAuthority(s, CASE));
    await db.withFirm(x.owner, (s) => verifyAuthority(s, id, true));
    // Same citation string and link, but now presented as a different decision of a different court and year.
    await db.withFirm(x.paraCtx, (s) => updateAuthority(s, id, { ...CASE, title: "Smith v. Jones", court: "U.S. Supreme Court", year: 2024 }));
    const [a] = await db.withFirm(x.paraCtx, (s) => listAuthorities(s));
    expect(a).toMatchObject({ title: "Smith v. Jones", court: "U.S. Supreme Court", year: 2024 });
    expect(a!.verified).toBeNull();
  });

  it("F3: staff walled out of a Matter can rewrite what that Matter's citation points to (and are told it is cited nowhere)", async () => {
    const x = await setup();
    const id = await db.withFirm(x.paraCtx, (s) => addAuthority(s, CASE));
    await db.withFirm(x.owner, (s) => verifyAuthority(s, id, true));
    const { el } = await firstElement(x.owner, x.walled.id);
    await db.withFirm(x.owner, (s) => citeAuthority(s, el, { authorityId: id, stance: "supports", proposition: "An adverse action shortly after FMLA leave supports causation.", pinpoint: "at 1171" }));
    // The walled-out paralegal sees the authority as cited in 0 places (correct: no leak) ...
    const [seen] = await db.withFirm(x.paraCtx, (s) => listAuthorities(s));
    expect(seen!.citedIn).toBe(0);
    // ... so they "safely" repoint it at another case and verify it (F1 lets them).
    await db.withFirm(x.paraCtx, (s) => updateAuthority(s, id, OTHER_CASE)).catch(() => undefined);
    await db.withFirm(x.paraCtx, (s) => verifyAuthority(s, id, true)).catch(() => undefined);
    // The walled Matter's work product must still cite what its attorney cited.
    const m = await db.withFirm(x.owner, (s) => claimsMatrix(s, x.walled.id));
    const cited = m[0]!.elements.find((e) => e.id === el)!.authorities[0]!;
    expect(cited.proposition).toMatch(/causation/);
    expect(cited.authority.citation).toBe(CASE.citation);
    expect(cited.authority.url).toBe(CASE.url);
  });

  it("F4: a verification applies to the version the attorney checked, not to whatever the authority was changed to meanwhile", async () => {
    const x = await setup();
    const id = await db.withFirm(x.paraCtx, (s) => addAuthority(s, CASE));
    // The attorney opens the library and checks CASE against its record ...
    const [checked] = await db.withFirm(x.owner, (s) => listAuthorities(s));
    expect(checked!.citation).toBe(CASE.citation);
    // ... meanwhile someone repoints the entry at a different case ...
    await db.withFirm(x.paraCtx, (s) => updateAuthority(s, id, OTHER_CASE));
    // ... and the attorney's click ("I checked it against its record") lands. A fixed API would take what was checked.
    const verifyChecked = verifyAuthority as unknown as (s: unknown, id: string, v: boolean, expected?: unknown) => Promise<void>;
    await db.withFirm(x.owner, (s) => verifyChecked(s, id, true, { kind: checked!.kind, citation: checked!.citation, url: checked!.url })).catch(() => undefined);
    const row = await verifiedRow(id);
    expect(row.citation).toBe(OTHER_CASE.citation);
    expect(row.verified_at).toBeNull();
  });

  it("F5: the audit log does not record a verification that didn't happen", async () => {
    const x = await setup();
    const id = await db.withFirm(x.owner, (s) => addAuthority(s, CASE));
    await db.withFirm(x.owner, (s) => verifyAuthority(s, id, true));
    // A second attorney "verifies" an already verified authority: nothing changes in the database ...
    const second = await db.withFirm(x.owner, (s) => inviteUser(s, { email: `a2@${x.slug}.example`, fullName: "Ann Attorney", role: "attorney", locationId: x.locationId }));
    await db.withFirm({ firmId: x.firmId, userId: second.id }, (s) => verifyAuthority(s, id, true)).catch(() => undefined);
    expect((await verifiedRow(id)).verified_by).toBe(x.ownerUserId);
    // ... but the audit log says they verified it.
    const audit = await t.admin.query("SELECT 1 FROM huis.audit_events WHERE firm_id = $1 AND action = 'authority.verified' AND actor_user_id = $2", [x.firmId, second.id]);
    expect(audit.rowCount).toBe(0);
  });

  it("F6: the same citation can't be added twice by varying its inner whitespace", async () => {
    const x = await setup();
    await db.withFirm(x.owner, (s) => addAuthority(s, STATUTE));
    for (const citation of ["29 U.S.C.  § 2615(a)(2)", "29 U.S.C. § 2615(a)(2)", "29 U.S.C. §\t2615(a)(2)"]) {
      await expect(db.withFirm(x.owner, (s) => addAuthority(s, { ...STATUTE, citation }))).rejects.toThrow(/already in the library/);
    }
  });
});

describe("security review 16: attacks blocked", () => {
  it("blocked: read-only staff, clients and other firms can't change the library or citations (direct SQL as the app role)", async () => {
    const x = await setup();
    const id = await db.withFirm(x.owner, (s) => addAuthority(s, STATUTE));
    const { el } = await firstElement(x.owner, x.matter.id);
    await db.withFirm(x.owner, (s) => citeAuthority(s, el, { authorityId: id, stance: "supports", proposition: "Protected activity." }));
    expect((await db.withFirm(x.readerCtx, (s) => s.client.query("UPDATE huis.legal_authorities SET citation = 'x', verified_at = now()"))).rowCount).toBe(0);
    expect((await db.withFirm(x.readerCtx, (s) => s.client.query("DELETE FROM huis.authority_links"))).rowCount).toBe(0);
    await expect(db.withFirm(x.readerCtx, (s) => s.client.query(
      "INSERT INTO huis.legal_authorities (firm_id, kind, citation, url, created_by) VALUES ($1, 'rule', 'R1', 'https://a.example/x', $2)", [x.firmId, x.reader.id]))).rejects.toThrow(/permission|row-level security/);
    expect((await db.withFirm(x.portalCtx, (s) => s.client.query("SELECT 1 FROM huis.authority_links"))).rowCount).toBe(0);
    expect((await db.withFirm(x.portalCtx, (s) => s.client.query("UPDATE huis.legal_authorities SET note = 'x'"))).rowCount).toBe(0);
    const other = await newFirm(db, "Other Owner");
    expect((await db.withFirm(other.owner, (s) => s.client.query("SELECT 1 FROM huis.authority_links UNION ALL SELECT 1 FROM huis.legal_authorities"))).rowCount).toBe(0);
    // Another firm's own-firm row pointing at this firm's authority fails the composite foreign key.
    const theirMatter = await db.withFirm(other.owner, async (s) => {
      const c = await createClient(s, { kind: "person", displayName: "Q", email: "q@example.com" });
      return createMatter(s, { title: "Q", clientId: c.id, leadAttorneyId: other.ownerUserId, jurisdictionState: "UT" });
    });
    const theirs = await firstElement(other.owner, theirMatter.id);
    await expect(db.withFirm(other.owner, (s) => s.client.query(
      "INSERT INTO huis.authority_links (firm_id, matter_id, node_id, authority_id, stance, proposition, created_by) VALUES ($1, $2, $3, $4, 'supports', 'x', $5)",
      [other.firmId, theirMatter.id, theirs.el, id, other.ownerUserId]))).rejects.toThrow(/foreign key/);
  });

  it("blocked: an authority cited only in a walled Matter can't be deleted by a walled-out adder, and its count doesn't leak", async () => {
    const x = await setup();
    const id = await db.withFirm(x.paraCtx, (s) => addAuthority(s, STATUTE));
    const { el } = await firstElement(x.owner, x.walled.id);
    await db.withFirm(x.owner, (s) => citeAuthority(s, el, { authorityId: id, stance: "supports", proposition: "Walled reasoning." }));
    expect((await db.withFirm(x.paraCtx, (s) => listAuthorities(s)))[0]!.citedIn).toBe(0);
    await expect(db.withFirm(x.paraCtx, (s) => deleteAuthority(s, id))).rejects.toThrow(/foreign key/);
    expect((await t.admin.query("SELECT count(*)::int AS n FROM huis.authority_links WHERE authority_id = $1", [id])).rows[0].n).toBe(1);
  });

  it("blocked: verification can't be forged on insert, and changing the citation/kind/link together with a verification clears it", async () => {
    const x = await setup();
    const id = (await db.withFirm(x.owner, (s) => s.client.query(
      "INSERT INTO huis.legal_authorities (firm_id, kind, citation, url, created_by, verified_by, verified_at) VALUES ($1, 'rule', 'Fed. R. Civ. P. 56', 'https://www.law.cornell.edu/rules/frcp/rule_56', $2, $2, '2001-01-01') RETURNING id",
      [x.firmId, x.ownerUserId]))).rows[0].id as string;
    expect((await verifiedRow(id)).verified_at).toBeNull();
    await db.withFirm(x.owner, (s) => verifyAuthority(s, id, true));
    for (const set of ["kind = 'other'", "citation = 'Fed. R. Civ. P. 12'", "url = 'https://www.law.cornell.edu/rules/frcp/rule_12'"]) {
      await db.withFirm(x.owner, (s) => s.client.query(`UPDATE huis.legal_authorities SET ${set}, verified_at = verified_at WHERE id = $1`, [id]));
      expect((await verifiedRow(id)).verified_at).toBeNull();
      await db.withFirm(x.owner, (s) => verifyAuthority(s, id, true));
    }
  });

  it("blocked: citing across Matters, for unconfirmed or non-claim items, or when walled out (service and SQL)", async () => {
    const x = await setup();
    const id = await db.withFirm(x.owner, (s) => addAuthority(s, STATUTE));
    const { el } = await firstElement(x.owner, x.matter.id);
    const walled = await firstElement(x.owner, x.walled.id);
    await expect(db.withFirm(x.owner, (s) => s.client.query(
      "INSERT INTO huis.authority_links (firm_id, matter_id, node_id, authority_id, stance, proposition, created_by) VALUES ($1, $2, $3, $4, 'supports', 'x', $5)",
      [x.firmId, x.walled.id, el, id, x.ownerUserId]))).rejects.toThrow(/same Matter/);
    await expect(db.withFirm(x.paraCtx, (s) => s.client.query(
      "INSERT INTO huis.authority_links (firm_id, matter_id, node_id, authority_id, stance, proposition, created_by) VALUES ($1, $2, $3, $4, 'supports', 'x', $5)",
      [x.firmId, x.walled.id, walled.el, id, x.para.id]))).rejects.toThrow();
    const fact = (await db.withFirm(x.owner, (s) => s.client.query(
      "INSERT INTO huis.dna_nodes (firm_id, matter_id, kind, label, status, origin, created_by) VALUES ($1, $2, 'fact', 'A fact', 'confirmed', 'attorney', $3) RETURNING id",
      [x.firmId, x.matter.id, x.ownerUserId]))).rows[0].id as string;
    await expect(db.withFirm(x.owner, (s) => citeAuthority(s, fact, { authorityId: id, stance: "supports", proposition: "x" }))).rejects.toThrow(/confirmed claim/);
  });

  it("blocked: the official-source badge isn't spoofable by look-alike hosts", () => {
    for (const u of ["https://courtlistener.com.evil.example/x", "https://evilcourtlistener.com/x", "https://xn--courtlistner-abc.com/x", "https://www.courtlіstener.com/x",
      "https://evil.example\\.courtlistener.com/x", "https://evil.example/?u=https://courtlistener.com", "https://evil.example#.courtlistener.com", "https://courtlistener.com@evil.example/"]) {
      expect(isOfficial(u)).toBe(false);
    }
    expect(isOfficial("https://www.courtlistener.com/opinion/1/")).toBe(true);
  });
});
