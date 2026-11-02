import { z } from "zod";
import type { FirmSession } from "../db/tenant.js";
import { NotFoundError } from "../errors.js";
import { assertCan, INTERNAL_ROLES, ROLES, type Role } from "../security/permissions.js";
import { recordAudit } from "./audit.js";
import { deriveMatterCode } from "./firms.js";

export const InviteUserInput = z.object({
  email: z.email(),
  fullName: z.string().trim().min(1).max(200),
  role: z.enum(ROLES),
  locationId: z.uuid(),
  matterCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,12}$/).optional(),
});
export type InviteUserInput = z.input<typeof InviteUserInput>;

export interface User {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  status: string;
  matterCode: string;
  locationId: string | null;
}

function toUser(r: Record<string, any>): User {
  return {
    id: r.id, email: r.email, fullName: r.full_name, role: r.role, status: r.status,
    matterCode: r.matter_code, locationId: r.location_id,
  };
}

/**
 * Adds a person to the firm and assigns their license. Internal roles use an
 * attorney or staff license; clients, co-counsel and experts use an external
 * license and can only ever see matters they are explicitly added to.
 */
export async function inviteUser(s: FirmSession, input: InviteUserInput): Promise<User> {
  assertCan(s.actor.role, "users.manage");
  const v = InviteUserInput.parse(input);
  const { rows } = await s.client.query(
    `INSERT INTO huis.users (firm_id, location_id, email, full_name, matter_code, role)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, email, full_name, role, status, matter_code, location_id`,
    [s.actor.firmId, v.locationId, v.email, v.fullName, v.matterCode ?? deriveMatterCode(v.fullName), v.role],
  );
  const user = toUser(rows[0]!);
  const licenseKind = !INTERNAL_ROLES.has(v.role)
    ? "external"
    : ["firm_owner", "managing_partner", "attorney"].includes(v.role) ? "attorney" : "staff";
  await s.client.query(
    `INSERT INTO huis.licenses (firm_id, location_id, user_id, kind) VALUES ($1, $2, $3, $4)`,
    [s.actor.firmId, v.locationId, user.id, licenseKind],
  );
  await recordAudit(s, "user.invited", {
    targetType: "user", targetId: user.id, metadata: { role: v.role, license: licenseKind },
  });
  return user;
}

export async function listUsers(s: FirmSession): Promise<User[]> {
  const { rows } = await s.client.query(
    `SELECT id, email, full_name, role, status, matter_code, location_id
       FROM huis.users ORDER BY full_name`,
  );
  return rows.map(toUser);
}

/** Changes a user's role. The firm can never be left without an active owner. */
export async function changeUserRole(s: FirmSession, userId: string, role: Role): Promise<void> {
  assertCan(s.actor.role, "users.manage");
  z.enum(ROLES).parse(role);
  const { rows } = await s.client.query<{ role: Role }>(
    "SELECT role FROM huis.users WHERE id = $1 FOR UPDATE", [userId],
  );
  const current = rows[0];
  if (!current) throw new NotFoundError("User");
  if (current.role === "firm_owner" && role !== "firm_owner") {
    await assertAnotherActiveOwner(s, userId);
  }
  await s.client.query("UPDATE huis.users SET role = $2 WHERE id = $1", [userId, role]);
  await recordAudit(s, "user.role_changed", {
    targetType: "user", targetId: userId, metadata: { from: current.role, to: role },
  });
}

/** Disables a user and their license. Their history and audit trail remain. */
export async function disableUser(s: FirmSession, userId: string): Promise<void> {
  assertCan(s.actor.role, "users.manage");
  const { rows } = await s.client.query<{ role: Role }>(
    "SELECT role FROM huis.users WHERE id = $1 FOR UPDATE", [userId],
  );
  const current = rows[0];
  if (!current) throw new NotFoundError("User");
  if (current.role === "firm_owner") await assertAnotherActiveOwner(s, userId);
  await s.client.query("UPDATE huis.users SET status = 'disabled' WHERE id = $1", [userId]);
  await s.client.query(
    "UPDATE huis.licenses SET status = 'disabled', ends_at = now() WHERE user_id = $1 AND status = 'active'",
    [userId],
  );
  await recordAudit(s, "user.disabled", { targetType: "user", targetId: userId });
}

async function assertAnotherActiveOwner(s: FirmSession, excludingUserId: string): Promise<void> {
  const { rows } = await s.client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM huis.users
      WHERE role = 'firm_owner' AND status = 'active' AND id <> $1`,
    [excludingUserId],
  );
  if ((rows[0]?.n ?? 0) === 0) {
    throw new Error("A firm must always have at least one active owner.");
  }
}
