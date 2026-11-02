import { z } from "zod";
import type { FirmSession } from "../db/tenant.js";
import { assertCan } from "../security/permissions.js";
import { recordAudit } from "./audit.js";

export const CreateClientInput = z.object({
  kind: z.enum(["person", "organization"]),
  displayName: z.string().trim().min(1).max(300),
  email: z.email().optional(),
  phone: z.string().trim().max(50).optional(),
});
export type CreateClientInput = z.input<typeof CreateClientInput>;

export interface Client {
  id: string;
  kind: "person" | "organization";
  displayName: string;
  email: string | null;
  phone: string | null;
}

const toClient = (r: Record<string, any>): Client => ({
  id: r.id, kind: r.kind, displayName: r.display_name, email: r.email, phone: r.phone,
});

export async function createClient(s: FirmSession, input: CreateClientInput): Promise<Client> {
  assertCan(s.actor.role, "clients.create");
  const v = CreateClientInput.parse(input);
  const { rows } = await s.client.query(
    `INSERT INTO huis.clients (firm_id, kind, display_name, email, phone, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, kind, display_name, email, phone`,
    [s.actor.firmId, v.kind, v.displayName, v.email ?? null, v.phone ?? null, s.actor.userId],
  );
  const client = toClient(rows[0]!);
  // Client names are confidential; the audit log records the id only.
  await recordAudit(s, "client.created", { targetType: "client", targetId: client.id });
  return client;
}

export async function listClients(s: FirmSession): Promise<Client[]> {
  assertCan(s.actor.role, "clients.view");
  const { rows } = await s.client.query(
    "SELECT id, kind, display_name, email, phone FROM huis.clients ORDER BY display_name",
  );
  return rows.map(toClient);
}
