import { z } from "zod";
import type { HuisDb } from "../db/tenant";
import type { Role } from "../security/permissions";

const stateCode = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Use a two-letter state code");

export const SignUpFirmInput = z.object({
  firmName: z.string().trim().min(1).max(200),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  stateCode,
  locationName: z.string().trim().min(1).max(200).default("Main Office"),
  ownerEmail: z.email(),
  ownerName: z.string().trim().min(1).max(200),
  authProvider: z.enum(["microsoft", "google"]),
  authSubject: z.string().min(1).max(512),
});
export type SignUpFirmInput = z.input<typeof SignUpFirmInput>;

export interface SignUpResult {
  firmId: string;
  locationId: string;
  ownerUserId: string;
}

/**
 * Turns a name into the attorney code used in matter numbers,
 * e.g. "Jane Smith" -> "JSMITH", giving HUIS-UT-JSMITH-2026-000124.
 */
export function deriveMatterCode(fullName: string): string {
  const parts = fullName.normalize("NFKD").replace(/[^A-Za-z\s-]/g, "").trim().split(/[\s-]+/).filter(Boolean);
  if (parts.length === 0) return "ATTY";
  const last = parts[parts.length - 1] ?? "";
  const code = parts.length > 1 ? `${parts[0]?.[0] ?? ""}${last}` : last;
  return code.toUpperCase().slice(0, 12) || "ATTY";
}

/** Creates a brand-new firm with its owner on a 7-day trial (decision #35). */
export async function signUpFirm(db: HuisDb, input: SignUpFirmInput): Promise<SignUpResult> {
  const v = SignUpFirmInput.parse(input);
  return db.withoutFirm(async (client) => {
    const { rows } = await client.query<{ firm_id: string; location_id: string; owner_user_id: string }>(
      `SELECT * FROM huis.bootstrap_firm($1, $2, $3, $4, $5, $6, $7, $8, $9, 7)`,
      [v.firmName, v.slug, v.stateCode, v.locationName, v.ownerEmail, v.ownerName,
       deriveMatterCode(v.ownerName), v.authProvider, v.authSubject],
    );
    const row = rows[0];
    if (!row) throw new Error("Firm sign-up failed");
    return { firmId: row.firm_id, locationId: row.location_id, ownerUserId: row.owner_user_id };
  });
}

/**
 * Links a verified sign-in identity to an invited account using the one-time
 * invitation token. Returns null if the token is invalid, used or expired.
 */
export async function acceptInvitation(
  db: HuisDb, token: string, provider: string, subject: string,
): Promise<{ firmId: string; userId: string } | null> {
  return db.withoutFirm(async (client) => {
    const { rows } = await client.query<{ firm_id: string; user_id: string }>(
      "SELECT * FROM huis.accept_invitation($1, $2, $3)", [token, provider, subject],
    );
    const r = rows[0];
    return r ? { firmId: r.firm_id, userId: r.user_id } : null;
  });
}

export interface IdentityAccount {
  firmId: string;
  userId: string;
  firmName: string;
  role: Role;
}

/**
 * After the sign-in provider verifies who someone is, list the firm accounts
 * that identity may enter. More than one result means the person holds
 * licenses at more than one firm, and must choose which to open.
 */
export async function resolveIdentity(db: HuisDb, provider: string, subject: string): Promise<IdentityAccount[]> {
  return db.withoutFirm(async (client) => {
    const { rows } = await client.query<{ firm_id: string; user_id: string; firm_name: string; role: Role }>(
      "SELECT * FROM huis.resolve_identity($1, $2)",
      [provider, subject],
    );
    return rows.map((r) => ({ firmId: r.firm_id, userId: r.user_id, firmName: r.firm_name, role: r.role }));
  });
}
