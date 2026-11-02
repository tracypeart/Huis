import type { FirmSession } from "../db/tenant";
import { assertCan } from "../security/permissions";

export interface AuditDetails {
  targetType?: string;
  targetId?: string;
  matterId?: string;
  metadata?: Record<string, unknown>;
}

/** Append an event to the firm's tamper-evident audit log. */
export async function recordAudit(s: FirmSession, action: string, d: AuditDetails = {}): Promise<void> {
  await s.client.query(
    `INSERT INTO huis.audit_events
       (firm_id, actor_user_id, action, target_type, target_id, matter_id, metadata, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, huis.request_ip(), $8)`,
    [
      s.actor.firmId, s.actor.userId, action, d.targetType ?? null, d.targetId ?? null,
      d.matterId ?? null, JSON.stringify(d.metadata ?? {}), (s.ctx.userAgent ?? "").slice(0, 500) || null,
    ],
  );
}

export interface AuditEvent {
  id: string;
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  matterId: string | null;
  metadata: Record<string, unknown>;
  occurredAt: Date;
}

export async function listAuditEvents(s: FirmSession, limit = 100): Promise<AuditEvent[]> {
  assertCan(s.actor.role, "audit.view");
  const { rows } = await s.client.query(
    `SELECT id, actor_user_id, action, target_type, target_id, matter_id, metadata, occurred_at
       FROM huis.audit_events ORDER BY id DESC LIMIT $1`,
    [Math.min(Math.max(limit, 1), 1000)],
  );
  return rows.map((r) => ({
    id: String(r.id), actorUserId: r.actor_user_id, action: r.action, targetType: r.target_type,
    targetId: r.target_id, matterId: r.matter_id, metadata: r.metadata, occurredAt: r.occurred_at,
  }));
}

/** Returns null if the firm's audit chain is intact, else the first broken event id. */
export async function verifyAuditChain(s: FirmSession): Promise<string | null> {
  assertCan(s.actor.role, "audit.view");
  const { rows } = await s.client.query<{ broken: string | null }>(
    "SELECT huis.verify_audit_chain() AS broken",
  );
  return rows[0]?.broken ?? null;
}
