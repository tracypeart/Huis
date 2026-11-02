import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FirmSession } from "../db/tenant.js";
import { NotFoundError, PermissionDeniedError } from "../errors.js";
import { assertCan, ATTORNEY_ROLES, INTERNAL_ROLES, type Role } from "../security/permissions.js";
import { recordAudit } from "./audit.js";

export const CreateMatterInput = z.object({
  title: z.string().trim().min(1).max(300),
  clientId: z.uuid(),
  leadAttorneyId: z.uuid(),
  jurisdictionState: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/),
  locationId: z.uuid().optional(),
  courtCaseNumber: z.string().trim().min(1).max(100).optional(),
  firmMatterNumber: z.string().trim().min(1).max(100).optional(),
  courtName: z.string().trim().max(300).optional(),
  practiceArea: z.string().trim().max(100).optional(),
  /** Ethical wall: only explicitly added members can see this matter. */
  restricted: z.boolean().default(false),
});
export type CreateMatterInput = z.input<typeof CreateMatterInput>;

export interface Matter {
  id: string;
  title: string;
  huisNumber: string;
  courtCaseNumber: string | null;
  firmMatterNumber: string | null;
  clientId: string;
  leadAttorneyId: string;
  jurisdictionState: string;
  courtName: string | null;
  practiceArea: string | null;
  status: string;
  restricted: boolean;
  openedAt: Date;
}

export interface MatterFolder {
  id: string;
  name: string;
  classification: string;
  isPrivilegedArea: boolean;
  color: string | null;
}

const MATTER_COLUMNS = `id, title, huis_number, court_case_number, firm_matter_number, client_id,
  lead_attorney_id, jurisdiction_state, court_name, practice_area, status, restricted, opened_at`;

const toMatter = (r: Record<string, any>): Matter => ({
  id: r.id, title: r.title, huisNumber: r.huis_number, courtCaseNumber: r.court_case_number,
  firmMatterNumber: r.firm_matter_number, clientId: r.client_id, leadAttorneyId: r.lead_attorney_id,
  jurisdictionState: r.jurisdiction_state, courtName: r.court_name, practiceArea: r.practice_area,
  status: r.status, restricted: r.restricted, openedAt: r.opened_at,
});

/**
 * Creates a matter. The attorney creates it first (decision #6). The database
 * assigns the Huis number, makes the creator and lead attorney owners, creates
 * the red Privileged & Confidential area and standard folders, and writes the
 * audit event — all in the same transaction.
 */
export async function createMatter(s: FirmSession, input: CreateMatterInput): Promise<Matter> {
  assertCan(s.actor.role, "matters.create");
  const v = CreateMatterInput.parse(input);

  const lead = (await s.client.query<{ role: Role; status: string; location_id: string | null }>(
    "SELECT role, status, location_id FROM huis.users WHERE id = $1", [v.leadAttorneyId],
  )).rows[0];
  if (!lead || lead.status !== "active") throw new NotFoundError("Lead attorney");
  if (!ATTORNEY_ROLES.has(lead.role)) {
    throw new Error("The lead attorney must be an attorney, managing partner or firm owner.");
  }

  const clientVisible = (await s.client.query("SELECT 1 FROM huis.clients WHERE id = $1", [v.clientId])).rowCount;
  if (!clientVisible) throw new NotFoundError("Client");

  const locationId = v.locationId ?? lead.location_id ?? (await firstLocation(s));
  const id = randomUUID();
  // No RETURNING: on a walled matter the creator only becomes a member in the
  // after-insert trigger, so the row is read back afterwards instead.
  await s.client.query(
    `INSERT INTO huis.matters (id, firm_id, location_id, client_id, title, court_case_number,
       firm_matter_number, jurisdiction_state, court_name, practice_area, restricted,
       lead_attorney_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [id, s.actor.firmId, locationId, v.clientId, v.title, v.courtCaseNumber ?? null,
     v.firmMatterNumber ?? null, v.jurisdictionState, v.courtName ?? null, v.practiceArea ?? null,
     v.restricted, v.leadAttorneyId, s.actor.userId],
  );
  return getMatter(s, id);
}

async function firstLocation(s: FirmSession): Promise<string> {
  const { rows } = await s.client.query<{ id: string }>(
    "SELECT id FROM huis.firm_locations ORDER BY created_at LIMIT 1",
  );
  if (!rows[0]) throw new NotFoundError("Firm location");
  return rows[0].id;
}

export async function getMatter(s: FirmSession, matterId: string): Promise<Matter> {
  assertCan(s.actor.role, "matters.view");
  const { rows } = await s.client.query(`SELECT ${MATTER_COLUMNS} FROM huis.matters WHERE id = $1`, [matterId]);
  if (!rows[0]) throw new NotFoundError("Matter");
  return toMatter(rows[0]);
}

/** Matters the current user may see (the database applies walls and firm isolation). */
export async function listMatters(s: FirmSession): Promise<Matter[]> {
  assertCan(s.actor.role, "matters.view");
  const { rows } = await s.client.query(`SELECT ${MATTER_COLUMNS} FROM huis.matters ORDER BY opened_at DESC`);
  return rows.map(toMatter);
}

export async function listMatterFolders(s: FirmSession, matterId: string): Promise<MatterFolder[]> {
  await getMatter(s, matterId);
  const { rows } = await s.client.query(
    `SELECT id, name, classification, is_privileged_area, color FROM huis.matter_folders
      WHERE matter_id = $1 ORDER BY is_privileged_area DESC, name`,
    [matterId],
  );
  return rows.map((r) => ({
    id: r.id, name: r.name, classification: r.classification,
    isPrivilegedArea: r.is_privileged_area, color: r.color,
  }));
}

/** Court case numbers often arrive after the matter is opened, and can change. */
export async function setCourtCaseNumber(s: FirmSession, matterId: string, courtCaseNumber: string | null): Promise<void> {
  const value = courtCaseNumber === null ? null : z.string().trim().min(1).max(100).parse(courtCaseNumber);
  const before = await getMatter(s, matterId);
  const res = await s.client.query("UPDATE huis.matters SET court_case_number = $2 WHERE id = $1", [matterId, value]);
  if (res.rowCount === 0) throw new PermissionDeniedError("edit this matter");
  await recordAudit(s, "matter.court_case_number_changed", {
    targetType: "matter", targetId: matterId, matterId,
    metadata: { from: before.courtCaseNumber, to: value },
  });
}

export class PrivilegeWaiverAcknowledgementRequired extends Error {
  constructor() {
    super(
      "Adding someone outside the firm to this matter may expose privileged material. " +
      "Sharing privileged communications with third parties can waive privilege. " +
      "Confirm you have reviewed this before continuing.",
    );
    this.name = "PrivilegeWaiverAcknowledgementRequired";
  }
}

export interface AddMemberInput {
  matterId: string;
  userId: string;
  access: "owner" | "edit" | "view";
  /** Required when adding a client, co-counsel, expert or other external user. */
  acknowledgePrivilegeWaiverRisk?: boolean;
}

/**
 * Gives a user access to a matter. External users (clients, co-counsel,
 * experts) are view-only and require an explicit privilege-waiver
 * acknowledgement, which is recorded in the audit log.
 */
export async function addMatterMember(s: FirmSession, input: AddMemberInput): Promise<void> {
  const v = z.object({
    matterId: z.uuid(), userId: z.uuid(), access: z.enum(["owner", "edit", "view"]),
    acknowledgePrivilegeWaiverRisk: z.boolean().optional(),
  }).parse(input);
  await getMatter(s, v.matterId);

  const target = (await s.client.query<{ role: Role; status: string }>(
    "SELECT role, status FROM huis.users WHERE id = $1", [v.userId],
  )).rows[0];
  if (!target || target.status !== "active") throw new NotFoundError("User");

  const external = !INTERNAL_ROLES.has(target.role);
  if (external) {
    if (v.access !== "view") throw new Error("People outside the firm can only be given view access.");
    if (!v.acknowledgePrivilegeWaiverRisk) throw new PrivilegeWaiverAcknowledgementRequired();
  }

  await s.client.query(
    `INSERT INTO huis.matter_members (firm_id, matter_id, user_id, access, added_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (matter_id, user_id) DO UPDATE SET access = EXCLUDED.access`,
    [s.actor.firmId, v.matterId, v.userId, v.access, s.actor.userId],
  );
  await recordAudit(s, "matter.member_added", {
    targetType: "user", targetId: v.userId, matterId: v.matterId,
    metadata: { access: v.access, external, privilegeWaiverAcknowledged: external ? true : undefined },
  });
}

export async function removeMatterMember(s: FirmSession, matterId: string, userId: string): Promise<void> {
  await getMatter(s, matterId);
  const res = await s.client.query(
    "DELETE FROM huis.matter_members WHERE matter_id = $1 AND user_id = $2", [matterId, userId],
  );
  if (res.rowCount === 0) throw new PermissionDeniedError("remove this member");
  await recordAudit(s, "matter.member_removed", { targetType: "user", targetId: userId, matterId });
}

export async function linkContactToMatter(s: FirmSession, matterId: string, contactId: string, roleLabel?: string): Promise<void> {
  await getMatter(s, matterId);
  await s.client.query(
    `INSERT INTO huis.matter_contacts (firm_id, matter_id, contact_id, role_label)
     VALUES ($1, $2, $3, $4) ON CONFLICT (matter_id, contact_id) DO UPDATE SET role_label = EXCLUDED.role_label`,
    [s.actor.firmId, matterId, contactId, roleLabel ?? null],
  );
  await recordAudit(s, "matter.contact_linked", { targetType: "contact", targetId: contactId, matterId });
}
