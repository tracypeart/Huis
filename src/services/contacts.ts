import { z } from "zod";
import type { FirmSession } from "../db/tenant";
import { assertCan } from "../security/permissions";
import { recordAudit } from "./audit";

export const CONTACT_KINDS = [
  "opposing_counsel", "opposing_party", "judge", "court_staff", "witness",
  "expert", "co_counsel", "insurance_adjuster", "other",
] as const;

export const CreateContactInput = z.object({
  kind: z.enum(CONTACT_KINDS),
  fullName: z.string().trim().min(1).max(200),
  organization: z.string().trim().max(300).optional(),
  email: z.email().optional(),
  phone: z.string().trim().max(50).optional(),
  barNumber: z.string().trim().max(50).optional(),
  notes: z.string().max(5000).optional(),
});
export type CreateContactInput = z.input<typeof CreateContactInput>;

export interface Contact {
  id: string;
  kind: (typeof CONTACT_KINDS)[number];
  fullName: string;
  organization: string | null;
  email: string | null;
  phone: string | null;
  barNumber: string | null;
}

const toContact = (r: Record<string, any>): Contact => ({
  id: r.id, kind: r.kind, fullName: r.full_name, organization: r.organization,
  email: r.email, phone: r.phone, barNumber: r.bar_number,
});

/** Reusable profiles for judges, opposing counsel, witnesses and experts. */
export async function createContact(s: FirmSession, input: CreateContactInput): Promise<Contact> {
  assertCan(s.actor.role, "contacts.create");
  const v = CreateContactInput.parse(input);
  const { rows } = await s.client.query(
    `INSERT INTO huis.contacts (firm_id, kind, full_name, organization, email, phone, bar_number, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, kind, full_name, organization, email, phone, bar_number`,
    [s.actor.firmId, v.kind, v.fullName, v.organization ?? null, v.email ?? null,
     v.phone ?? null, v.barNumber ?? null, v.notes ?? null, s.actor.userId],
  );
  const contact = toContact(rows[0]!);
  await recordAudit(s, "contact.created", { targetType: "contact", targetId: contact.id, metadata: { kind: v.kind } });
  return contact;
}

export async function listContacts(s: FirmSession, kind?: Contact["kind"]): Promise<Contact[]> {
  assertCan(s.actor.role, "contacts.view");
  const { rows } = await s.client.query(
    `SELECT id, kind, full_name, organization, email, phone, bar_number
       FROM huis.contacts WHERE ($1::huis.contact_kind IS NULL OR kind = $1) ORDER BY full_name`,
    [kind ?? null],
  );
  return rows.map(toContact);
}
