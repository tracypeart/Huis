import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PermissionDeniedError, NotFoundError, UnauthenticatedError } from "../src/errors";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { listAuditEvents, verifyAuditChain } from "../src/services/audit";
import { createClient, listClients } from "../src/services/clients";
import { createContact } from "../src/services/contacts";
import { acceptInvitation, deriveMatterCode, resolveIdentity, signUpFirm } from "../src/services/firms";
import {
  addMatterMember, createMatter, getMatter, listMatterFolders, listMatters,
  PrivilegeWaiverAcknowledgementRequired, setCourtCaseNumber,
} from "../src/services/matters";
import { changeUserRole, disableUser, inviteUser, issueInvitation } from "../src/services/users";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

let t: TestDatabase;
let db: HuisDb;

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
});
afterAll(async () => {
  await t?.drop();
});

/** A firm with an owner, an attorney, a paralegal, a client and one matter. */
async function firmWithMatter(opts: { restricted?: boolean } = {}) {
  const f = await newFirm(db);
  const setup = await db.withFirm(f.owner, async (s) => {
    const attorney = await inviteUser(s, { email: `atty@${f.slug}.example`, fullName: "Alex Rivera", role: "attorney", locationId: f.locationId });
    const paralegal = await inviteUser(s, { email: `para@${f.slug}.example`, fullName: "Pat Lee", role: "paralegal", locationId: f.locationId });
    const client = await createClient(s, { kind: "person", displayName: "Confidential Client" });
    return { attorney, paralegal, client };
  });
  const attorneyCtx: RequestContext = { firmId: f.firmId, userId: setup.attorney.id };
  const paralegalCtx: RequestContext = { firmId: f.firmId, userId: setup.paralegal.id };
  const matter = await db.withFirm(attorneyCtx, (s) =>
    createMatter(s, {
      title: "Smith v. Acme Corporation", clientId: setup.client.id,
      leadAttorneyId: setup.attorney.id, jurisdictionState: "UT",
      restricted: opts.restricted ?? false,
    }));
  return { f, ...setup, attorneyCtx, paralegalCtx, matter };
}

describe("firm isolation (attorney-client privilege)", () => {
  it("a user in one firm cannot see another firm's matters, clients or users", async () => {
    const a = await firmWithMatter();
    const b = await firmWithMatter();

    await db.withFirm(b.f.owner, async (s) => {
      const matters = await listMatters(s);
      expect(matters.map((m) => m.id)).not.toContain(a.matter.id);
      expect(matters).toHaveLength(1);
      await expect(getMatter(s, a.matter.id)).rejects.toBeInstanceOf(NotFoundError);
      expect((await listClients(s)).map((c) => c.id)).not.toContain(a.client.id);

      // Even raw SQL through the app connection cannot reach firm A.
      const raw = await s.client.query("SELECT count(*)::int AS n FROM huis.matters WHERE firm_id = $1", [a.f.firmId]);
      expect(raw.rows[0].n).toBe(0);
      const rawUsers = await s.client.query("SELECT count(*)::int AS n FROM huis.users WHERE firm_id = $1", [a.f.firmId]);
      expect(rawUsers.rows[0].n).toBe(0);
    });
  });

  it("cannot write rows into another firm", async () => {
    const a = await firmWithMatter();
    const b = await newFirm(db);
    await expect(db.withFirm(b.owner, (s) =>
      s.client.query(
        "INSERT INTO huis.clients (firm_id, kind, display_name, created_by) VALUES ($1, 'person', 'x', $2)",
        [a.f.firmId, b.ownerUserId],
      ))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("fails closed: with no firm context every table is empty", async () => {
    await firmWithMatter();
    await db.withoutFirm(async (client) => {
      for (const table of ["firms", "users", "clients", "matters", "matter_members", "matter_folders", "audit_events", "licenses"]) {
        const { rows } = await client.query(`SELECT count(*)::int AS n FROM huis.${table}`);
        expect(rows[0].n, table).toBe(0);
      }
    });
  });

  it("rejects a forged context (user id from a different firm)", async () => {
    const a = await firmWithMatter();
    const b = await newFirm(db);
    await expect(db.withFirm({ firmId: b.firmId, userId: a.attorney.id }, async () => 1))
      .rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("the application database role cannot bypass row-level security", async () => {
    await db.withoutFirm(async (client) => {
      const { rows } = await client.query(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    });
  });
});

describe("ethical walls (restricted matters)", () => {
  it("only explicit members can see a restricted matter — not even the firm owner", async () => {
    const w = await firmWithMatter({ restricted: true });

    await db.withFirm(w.attorneyCtx, async (s) => {
      expect((await getMatter(s, w.matter.id)).restricted).toBe(true);
    });
    for (const ctx of [w.paralegalCtx, w.f.owner]) {
      await db.withFirm(ctx, async (s) => {
        expect((await listMatters(s)).map((m) => m.id)).not.toContain(w.matter.id);
        await expect(getMatter(s, w.matter.id)).rejects.toBeInstanceOf(NotFoundError);
        const folders = await s.client.query("SELECT count(*)::int AS n FROM huis.matter_folders WHERE matter_id = $1", [w.matter.id]);
        expect(folders.rows[0].n).toBe(0);
      });
    }

    // The matter owner can let the paralegal in.
    await db.withFirm(w.attorneyCtx, (s) =>
      addMatterMember(s, { matterId: w.matter.id, userId: w.paralegal.id, access: "edit" }));
    await db.withFirm(w.paralegalCtx, async (s) => {
      expect((await getMatter(s, w.matter.id)).id).toBe(w.matter.id);
    });
  });

  it("a firm admin who is not a member cannot add people to a walled matter", async () => {
    const w = await firmWithMatter({ restricted: true });
    await expect(db.withFirm(w.f.owner, (s) =>
      s.client.query(
        "INSERT INTO huis.matter_members (firm_id, matter_id, user_id, access, added_by) VALUES ($1, $2, $3, 'view', $3)",
        [w.f.firmId, w.matter.id, w.f.ownerUserId],
      ))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("unrestricted matters are visible to all internal staff", async () => {
    const m = await firmWithMatter();
    await db.withFirm(m.paralegalCtx, async (s) => {
      expect((await getMatter(s, m.matter.id)).title).toBe("Smith v. Acme Corporation");
    });
  });
});

describe("external users and privilege-waiver warnings", () => {
  it("clients see only matters they are added to, view-only, after an explicit warning", async () => {
    const m = await firmWithMatter();
    const other = await db.withFirm(m.attorneyCtx, (s) =>
      createMatter(s, { title: "Unrelated matter", clientId: m.client.id, leadAttorneyId: m.attorney.id, jurisdictionState: "UT" }));
    const portalUser = await db.withFirm(m.f.owner, (s) =>
      inviteUser(s, { email: `client@${m.f.slug}.example`, fullName: "Chris Client", role: "client", locationId: m.f.locationId }));
    const clientCtx = { firmId: m.f.firmId, userId: portalUser.id };

    await db.withFirm(clientCtx, async (s) => {
      expect(await listMatters(s)).toHaveLength(0);
    });

    await expect(db.withFirm(m.attorneyCtx, (s) =>
      addMatterMember(s, { matterId: m.matter.id, userId: portalUser.id, access: "view" })))
      .rejects.toBeInstanceOf(PrivilegeWaiverAcknowledgementRequired);
    await expect(db.withFirm(m.attorneyCtx, (s) =>
      addMatterMember(s, { matterId: m.matter.id, userId: portalUser.id, access: "edit", acknowledgePrivilegeWaiverRisk: true })))
      .rejects.toThrow(/view access/);

    await db.withFirm(m.attorneyCtx, (s) =>
      addMatterMember(s, { matterId: m.matter.id, userId: portalUser.id, access: "view", acknowledgePrivilegeWaiverRisk: true }));

    await db.withFirm(clientCtx, async (s) => {
      const visible = (await listMatters(s)).map((x) => x.id);
      expect(visible).toEqual([m.matter.id]);
      expect(visible).not.toContain(other.id);
      // Clients never see the red privileged area, the client list or staff.
      const folders = (await s.client.query("SELECT name, is_privileged_area FROM huis.matter_folders WHERE matter_id = $1", [m.matter.id])).rows;
      expect(folders.length).toBeGreaterThan(0);
      expect(folders.some((f) => f.is_privileged_area)).toBe(false);
      expect((await s.client.query("SELECT count(*)::int AS n FROM huis.clients")).rows[0].n).toBe(0);
      expect((await s.client.query("SELECT count(*)::int AS n FROM huis.users")).rows[0].n).toBe(1);
    });

    await db.withFirm(m.f.owner, async (s) => {
      const event = (await listAuditEvents(s)).find((e) => e.action === "matter.member_added" && e.targetId === portalUser.id);
      expect(event?.metadata).toMatchObject({ external: true, privilegeWaiverAcknowledged: true });
    });
  });
});

describe("roles and permissions", () => {
  it("only admins can add users — in the app and in the database", async () => {
    const m = await firmWithMatter();
    await expect(db.withFirm(m.paralegalCtx, (s) =>
      inviteUser(s, { email: "x@example.com", fullName: "X", role: "attorney", locationId: m.f.locationId })))
      .rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(db.withFirm(m.paralegalCtx, (s) =>
      s.client.query(
        "INSERT INTO huis.users (firm_id, email, full_name, matter_code, role) VALUES ($1, 'x@example.com', 'X', 'X', 'firm_owner')",
        [m.f.firmId],
      ))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("the lead attorney must be an attorney", async () => {
    const m = await firmWithMatter();
    await expect(db.withFirm(m.attorneyCtx, (s) =>
      createMatter(s, { title: "x", clientId: m.client.id, leadAttorneyId: m.paralegal.id, jurisdictionState: "UT" })))
      .rejects.toThrow(/lead attorney/i);
  });

  it("a firm can never lose its last owner", async () => {
    const f = await newFirm(db);
    await expect(db.withFirm(f.owner, (s) => changeUserRole(s, f.ownerUserId, "attorney"))).rejects.toThrow(/owner/);
    await expect(db.withFirm(f.owner, (s) => disableUser(s, f.ownerUserId))).rejects.toThrow(/owner/);
  });

  it("disabled users are locked out immediately", async () => {
    const m = await firmWithMatter();
    await db.withFirm(m.f.owner, (s) => disableUser(s, m.paralegal.id));
    await expect(db.withFirm(m.paralegalCtx, async () => 1)).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

describe("matters, numbering and folders", () => {
  it("assigns Huis numbers and keeps the court case number separate", async () => {
    const m = await firmWithMatter();
    const year = new Date().getFullYear();
    expect(m.matter.huisNumber).toBe(`HUIS-UT-ARIVERA-${year}-000001`);
    expect(m.matter.courtCaseNumber).toBeNull();

    const second = await db.withFirm(m.attorneyCtx, (s) =>
      createMatter(s, { title: "Second", clientId: m.client.id, leadAttorneyId: m.attorney.id, jurisdictionState: "UT", firmMatterNumber: "2026-SMITH-02" }));
    expect(second.huisNumber).toBe(`HUIS-UT-ARIVERA-${year}-000002`);
    expect(second.firmMatterNumber).toBe("2026-SMITH-02");

    await db.withFirm(m.attorneyCtx, async (s) => {
      await setCourtCaseNumber(s, m.matter.id, "260400123");
      expect((await getMatter(s, m.matter.id)).courtCaseNumber).toBe("260400123");
    });
  });

  it("numbering is per firm", async () => {
    const a = await firmWithMatter();
    const b = await firmWithMatter();
    expect(a.matter.huisNumber.endsWith("-000001")).toBe(true);
    expect(b.matter.huisNumber.endsWith("-000001")).toBe(true);
  });

  it("every matter gets a red Privileged & Confidential area and standard folders", async () => {
    const m = await firmWithMatter();
    const folders = await db.withFirm(m.attorneyCtx, (s) => listMatterFolders(s, m.matter.id));
    const privileged = folders.filter((f) => f.isPrivilegedArea);
    expect(privileged).toHaveLength(1);
    expect(privileged[0]).toMatchObject({
      name: "Privileged & Confidential", classification: "attorney_client_privileged", color: "#DC2626",
    });
    expect(folders.map((f) => f.name)).toEqual(expect.arrayContaining(["Correspondence", "Discovery", "Evidence", "Client Uploads"]));
  });

  it("reusable contact profiles can be created", async () => {
    const m = await firmWithMatter();
    const judge = await db.withFirm(m.attorneyCtx, (s) => createContact(s, { kind: "judge", fullName: "Hon. Example Judge" }));
    expect(judge.kind).toBe("judge");
  });
});

describe("audit log", () => {
  it("records actions without client names", async () => {
    const m = await firmWithMatter();
    await db.withFirm(m.f.owner, async (s) => {
      const actions = (await listAuditEvents(s)).map((e) => e.action);
      expect(actions).toEqual(expect.arrayContaining(["firm.created", "user.invited", "client.created", "matter.created"]));
      const all = JSON.stringify(await listAuditEvents(s));
      expect(all).not.toContain("Confidential Client");
    });
  });

  it("only admins can read the audit log", async () => {
    const m = await firmWithMatter();
    await expect(db.withFirm(m.paralegalCtx, (s) => listAuditEvents(s))).rejects.toBeInstanceOf(PermissionDeniedError);
    await db.withFirm(m.paralegalCtx, async (s) => {
      expect((await s.client.query("SELECT count(*)::int AS n FROM huis.audit_events")).rows[0].n).toBe(0);
    });
  });

  it("cannot be edited or deleted by the application", async () => {
    const m = await firmWithMatter();
    await expect(db.withFirm(m.f.owner, (s) => s.client.query("UPDATE huis.audit_events SET action = 'x.y'")))
      .rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(db.withFirm(m.f.owner, (s) => s.client.query("DELETE FROM huis.audit_events")))
      .rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("cannot be edited even by a database superuser", async () => {
    await expect(t.admin.query("UPDATE huis.audit_events SET action = 'x.y'")).rejects.toThrow(/append-only/);
    await expect(t.admin.query("DELETE FROM huis.audit_events")).rejects.toThrow(/append-only/);
  });

  it("the hash chain detects tampering", async () => {
    const m = await firmWithMatter();
    expect(await db.withFirm(m.f.owner, (s) => verifyAuditChain(s))).toBeNull();

    // Simulate an attacker with full database access who disables the guard.
    const c = await t.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("ALTER TABLE huis.audit_events DISABLE TRIGGER audit_events_no_update");
      await c.query(
        "UPDATE huis.audit_events SET metadata = '{\"tampered\":true}' WHERE id = (SELECT min(id) FROM huis.audit_events WHERE firm_id = $1 AND action = 'matter.created')",
        [m.f.firmId],
      );
      await c.query("ALTER TABLE huis.audit_events ENABLE TRIGGER audit_events_no_update");
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    expect(await db.withFirm(m.f.owner, (s) => verifyAuditChain(s))).not.toBeNull();
  });
});

describe("invitations", () => {
  it("links an invited person to their sign-in only through the one-time link", async () => {
    const f = await newFirm(db);
    const invited = await db.withFirm(f.owner, (s) =>
      inviteUser(s, { email: `new@${f.slug}.example`, fullName: "New Associate", role: "attorney", locationId: f.locationId }));
    expect(invited.signInLinked).toBe(false);
    expect(invited.invitationToken.length).toBeGreaterThanOrEqual(43);

    // Wrong token: nothing happens.
    expect(await acceptInvitation(db, "x".repeat(43), "microsoft", "tenant:new")).toBeNull();
    // Signing in with a matching email but no invitation finds no account.
    expect(await resolveIdentity(db, "microsoft", "tenant:new")).toEqual([]);

    const linked = await acceptInvitation(db, invited.invitationToken, "microsoft", "tenant:new");
    expect(linked).toEqual({ firmId: f.firmId, userId: invited.id });
    expect((await resolveIdentity(db, "microsoft", "tenant:new")).map((a) => a.userId)).toEqual([invited.id]);

    // One-time: the same link cannot be used again by someone else.
    expect(await acceptInvitation(db, invited.invitationToken, "microsoft", "tenant:attacker")).toBeNull();
  });

  it("reissuing an invitation revokes the old link; expired links fail", async () => {
    const f = await newFirm(db);
    const invited = await db.withFirm(f.owner, (s) =>
      inviteUser(s, { email: `p@${f.slug}.example`, fullName: "Pat Para", role: "paralegal", locationId: f.locationId }));
    const fresh = await db.withFirm(f.owner, (s) => issueInvitation(s, invited.id));
    expect(await acceptInvitation(db, invited.invitationToken, "microsoft", "t:old")).toBeNull();

    await t.admin.query("UPDATE huis.user_invitations SET expires_at = now() - interval '1 minute' WHERE user_id = $1 AND revoked_at IS NULL", [invited.id]);
    expect(await acceptInvitation(db, fresh, "microsoft", "t:late")).toBeNull();
  });

  it("only admins can see invitation records", async () => {
    const m = await firmWithMatter();
    await db.withFirm(m.paralegalCtx, async (s) => {
      expect((await s.client.query("SELECT count(*)::int AS n FROM huis.user_invitations")).rows[0].n).toBe(0);
    });
  });
});

describe("sign-up and sign-in", () => {
  it("resolves an identity to its firm accounts only", async () => {
    const f = await newFirm(db);
    const accounts = await resolveIdentity(db, "microsoft", `subject-${f.slug}`);
    expect(accounts).toEqual([{ firmId: f.firmId, userId: f.ownerUserId, firmName: expect.any(String), role: "firm_owner" }]);
    expect(await resolveIdentity(db, "microsoft", "nobody")).toEqual([]);
  });

  it("starts firms on a 7-day trial and rejects duplicate slugs", async () => {
    const f = await newFirm(db);
    await db.withFirm(f.owner, async (s) => {
      const { rows } = await s.client.query("SELECT plan, trial_ends_at - created_at AS trial FROM huis.firms");
      expect(rows[0].plan).toBe("trial");
      expect(rows[0].trial.days).toBe(7);
    });
    await expect(signUpFirm(db, {
      firmName: "Copy", slug: f.slug, stateCode: "UT", ownerEmail: "a@b.example", ownerName: "A B",
      authProvider: "google", authSubject: "x",
    })).rejects.toThrow();
  });

  it("derives attorney codes for matter numbers", () => {
    expect(deriveMatterCode("Jane Smith")).toBe("JSMITH");
    expect(deriveMatterCode("José María García-López")).toBe("JLOPEZ");
    expect(deriveMatterCode("Cher")).toBe("CHER");
  });
});
