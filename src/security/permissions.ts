import { PermissionDeniedError } from "../errors.js";

/**
 * Role-based access control (application layer).
 *
 * The database independently enforces firm isolation, ethical walls and the
 * admin-only operations, so a bug here cannot leak another firm's data. This
 * layer adds the finer-grained "what may this role do" rules and gives users
 * clear error messages.
 */
export const ROLES = [
  "firm_owner", "managing_partner", "firm_admin", "attorney", "paralegal",
  "legal_assistant", "billing_admin", "investigator", "expert_consultant",
  "read_only", "client", "co_counsel", "expert_witness", "authorized_third_party",
] as const;
export type Role = (typeof ROLES)[number];

export const INTERNAL_ROLES: ReadonlySet<Role> = new Set<Role>([
  "firm_owner", "managing_partner", "firm_admin", "attorney", "paralegal",
  "legal_assistant", "billing_admin", "investigator", "expert_consultant", "read_only",
]);
export const ADMIN_ROLES: ReadonlySet<Role> = new Set<Role>([
  "firm_owner", "managing_partner", "firm_admin",
]);
/** Roles that may be the lead attorney on a matter. */
export const ATTORNEY_ROLES: ReadonlySet<Role> = new Set<Role>([
  "firm_owner", "managing_partner", "attorney",
]);

export type Permission =
  | "firm.manage"
  | "users.manage"
  | "licenses.view"
  | "audit.view"
  | "clients.view"
  | "clients.create"
  | "contacts.view"
  | "contacts.create"
  | "matters.view"
  | "matters.create"
  | "matters.manage_members";

const ALL_INTERNAL_VIEW: Permission[] = ["clients.view", "contacts.view", "matters.view"];
const CASE_STAFF: Permission[] = [
  ...ALL_INTERNAL_VIEW, "clients.create", "contacts.create", "matters.create",
];
const ADMIN: Permission[] = [
  ...CASE_STAFF, "firm.manage", "users.manage", "licenses.view", "audit.view",
  "matters.manage_members",
];

const GRANTS: Record<Role, ReadonlySet<Permission>> = {
  firm_owner: new Set(ADMIN),
  managing_partner: new Set(ADMIN),
  firm_admin: new Set(ADMIN),
  attorney: new Set([...CASE_STAFF, "matters.manage_members"]),
  paralegal: new Set(CASE_STAFF),
  legal_assistant: new Set(CASE_STAFF),
  billing_admin: new Set([...ALL_INTERNAL_VIEW, "licenses.view"]),
  investigator: new Set(ALL_INTERNAL_VIEW),
  expert_consultant: new Set(ALL_INTERNAL_VIEW),
  read_only: new Set(ALL_INTERNAL_VIEW),
  // External users only ever see matters they are explicitly added to.
  client: new Set(["matters.view"]),
  co_counsel: new Set(["matters.view"]),
  expert_witness: new Set(["matters.view"]),
  authorized_third_party: new Set(["matters.view"]),
};

export function can(role: Role, permission: Permission): boolean {
  return GRANTS[role].has(permission);
}

export function assertCan(role: Role, permission: Permission): void {
  if (!can(role, permission)) throw new PermissionDeniedError(permission);
}
