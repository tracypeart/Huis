import type { FirmSession } from "../db/tenant";
import { PermissionDeniedError } from "../errors";
import { INTERNAL_ROLES } from "../security/permissions";
import { recordAudit } from "./audit";
import { brainStatus, type BrainStatus } from "./brain";
import { getContradictions } from "./contradictions";
import { claimView, listNodes } from "./dna";
import { getMatter } from "./matters";
import { getTimeline } from "./timeline";

/**
 * Light analysis and Reanalyze Matter (Phase 6 part 3).
 *
 * The Matter analysis is worked out each time it's read, as the reader, from
 * what Huis already knows: counts and gaps by fixed, explainable rules (new
 * evidence, suggestions waiting, claim elements with no supporting fact,
 * timeline items with no source, potential contradictions…). Never a score:
 * the architecture rules out a "case health %" not computed by fixed rules.
 *
 * Huis's light analysis already runs on every item as it arrives (reading,
 * dated events, people, the Matter Brain). "Reanalyze Matter" retries
 * anything the Matter Brain couldn't read and starts a new analysis period,
 * which is what "new since the last complete analysis" counts from.
 */

function reader(s: FirmSession) {
  if (!INTERNAL_ROLES.has(s.actor.role)) throw new PermissionDeniedError("see the Matter analysis");
}

export interface ClaimGap { id: string; label: string; elements: number; unsupported: { id: string; label: string }[]; contradicted: number }
export interface NextStep { text: string; href: string }

export interface MatterAnalysis {
  lastRun: { at: Date; by: string } | null;
  sinceLast: { evidence: number; notes: number };
  evidence: { total: number; clean: number; waitingScan: number; quarantined: number; scanFailed: number; unreadable: number };
  brain: BrainStatus;
  dna: { suggestedEvents: number; suggestedPeople: number; people: number; events: number; facts: number; claims: number };
  claims: ClaimGap[];
  timeline: { dated: number; withoutSource: number };
  contradictions: { potential: number; confirmed: number };
  steps: NextStep[];
}

/** New evidence and notes since the last Reanalyze (or ever, if never run), as this person can see them. */
export async function sinceLastAnalysis(s: FirmSession, matterId: string): Promise<{ evidence: number; notes: number; lastRun: Date | null }> {
  reader(s);
  const last = (await s.client.query<{ run_at: Date }>(
    "SELECT run_at FROM huis.matter_analyses WHERE matter_id = $1 ORDER BY run_at DESC LIMIT 1", [matterId])).rows[0]?.run_at ?? null;
  const r = (await s.client.query<{ e: number; n: number }>(
    `SELECT (SELECT count(*)::int FROM huis.evidence_items WHERE matter_id = $1 AND parent_id IS NULL AND ($2::timestamptz IS NULL OR uploaded_at > $2)) AS e,
            (SELECT count(*)::int FROM huis.matter_notes WHERE matter_id = $1 AND ($2::timestamptz IS NULL OR created_at > $2)) AS n`,
    [matterId, last])).rows[0]!;
  return { evidence: r.e, notes: r.n, lastRun: last };
}

export async function analyzeMatter(s: FirmSession, matterId: string): Promise<MatterAnalysis> {
  reader(s);
  await getMatter(s, matterId);
  const base = `/matters/${matterId}`;
  const last = (await s.client.query<{ run_at: Date; by: string }>(
    `SELECT a.run_at, coalesce(u.full_name, 'Former user') AS by FROM huis.matter_analyses a LEFT JOIN huis.users u ON u.id = a.run_by
      WHERE a.matter_id = $1 ORDER BY a.run_at DESC LIMIT 1`, [matterId])).rows[0];
  const since = await sinceLastAnalysis(s, matterId);

  // Row-level security: only items this person can see.
  const ev = (await s.client.query<Record<string, number>>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'clean')::int AS clean,
            count(*) FILTER (WHERE status = 'pending_scan')::int AS waiting,
            count(*) FILTER (WHERE status = 'infected')::int AS quarantined,
            count(*) FILTER (WHERE status = 'scan_failed')::int AS scan_failed,
            count(*) FILTER (WHERE status = 'clean' AND extraction_status IN ('no_text', 'unsupported', 'failed', 'needs_provider'))::int AS unreadable
       FROM huis.evidence_items WHERE matter_id = $1`, [matterId])).rows[0]!;
  const brain = await brainStatus(s, matterId);

  const nodes = await listNodes(s, matterId);
  const count = (pred: (n: (typeof nodes)[number]) => boolean) => nodes.filter(pred).length;
  const dna = {
    suggestedEvents: count((n) => n.status === "suggested" && n.kind === "event"),
    suggestedPeople: count((n) => n.status === "suggested" && (n.kind === "person" || n.kind === "organization")),
    people: count((n) => n.status === "confirmed" && (n.kind === "person" || n.kind === "organization")),
    events: count((n) => n.status === "confirmed" && n.kind === "event"),
    facts: count((n) => n.status === "confirmed" && n.kind === "fact"),
    claims: count((n) => n.status === "confirmed" && (n.kind === "claim" || n.kind === "defense")),
  };

  // Each claim: elements with no confirmed supporting fact (fixed rule), and how many have contradicting ones.
  const claims: ClaimGap[] = [];
  for (const c of nodes.filter((n) => n.status === "confirmed" && (n.kind === "claim" || n.kind === "defense")).slice(0, 50)) {
    const v = await claimView(s, c.id);
    claims.push({
      id: c.id, label: c.label, elements: v.elements.length,
      unsupported: v.elements.filter((e) => !e.supporting.some((f) => f.status === "confirmed" && f.linkStatus === "confirmed"))
        .map((e) => ({ id: e.element.id, label: e.element.label })),
      contradicted: v.elements.filter((e) => e.contradicting.some((f) => f.linkStatus === "confirmed")).length,
    });
  }

  const tl = await getTimeline(s, matterId, { show: "confirmed", emails: "no" });
  const timeline = { dated: tl.entries.length, withoutSource: tl.entries.filter((e) => e.sources.length === 0).length };
  const con = await getContradictions(s, matterId);
  const contradictions = { potential: con.potential.length, confirmed: con.confirmed.length };

  // Next steps: one fixed rule each, most useful first.
  const steps: NextStep[] = [];
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  if (ev.waiting) steps.push({ text: `${n(ev.waiting, "item is", "items are")} still being virus-scanned; nothing reads them until they're clean.`, href: base });
  if (ev.quarantined) steps.push({ text: `${n(ev.quarantined, "item was", "items were")} found infected and quarantined; they're left out of everything.`, href: base });
  if (brain.failed) steps.push({ text: `${n(brain.failed, "item", "items")} couldn't be added to the Matter Brain. Reanalyze Matter tries them again.`, href: `${base}/analysis` });
  if (ev.unreadable) steps.push({ text: `${n(ev.unreadable, "item has", "items have")} no readable text (for example, a photo with no words, or an unsupported format), so nothing in them can be found or cited.`, href: base });
  if (dna.suggestedEvents + dna.suggestedPeople) steps.push({ text: `Review ${n(dna.suggestedEvents + dna.suggestedPeople, "suggestion", "suggestions")} from Huis (dated events and people) in Case DNA.`, href: `${base}/dna` });
  if (contradictions.potential) steps.push({ text: `Decide ${n(contradictions.potential, "potential contradiction", "potential contradictions")}.`, href: `${base}/contradictions` });
  for (const c of claims) {
    if (c.unsupported.length) {
      steps.push({ text: `${c.label}: ${n(c.unsupported.length, "element has", "elements have")} no confirmed supporting fact yet (${c.unsupported.slice(0, 3).map((e) => e.label).join("; ")}${c.unsupported.length > 3 ? "; …" : ""}).`, href: `${base}/dna/${c.id}` });
    }
  }
  if (timeline.withoutSource) steps.push({ text: `${n(timeline.withoutSource, "confirmed timeline item has", "confirmed timeline items have")} no source yet.`, href: `${base}/timeline?show=confirmed&source=none&emails=no` });
  if (!dna.claims) steps.push({ text: "Add a claim or defense to see its elements and the evidence for each.", href: `${base}/dna` });

  return {
    lastRun: last ? { at: last.run_at, by: last.by } : null,
    sinceLast: { evidence: since.evidence, notes: since.notes },
    evidence: { total: ev.total!, clean: ev.clean!, waitingScan: ev.waiting!, quarantined: ev.quarantined!, scanFailed: ev.scan_failed!, unreadable: ev.unreadable! },
    brain, dna, claims, timeline, contradictions, steps,
  };
}

/**
 * Reanalyze Matter: the Matter Brain tries again everything it couldn't read, and a new analysis period
 * starts. Firm staff who can change the Matter's work (not read-only staff). Records numbers only.
 */
export async function reanalyzeMatter(s: FirmSession, matterId: string): Promise<{ retried: number }> {
  reader(s);
  if (s.actor.role === "read_only") throw new PermissionDeniedError("reanalyze a Matter");
  await getMatter(s, matterId);
  const retried = (await s.client.query<{ n: number }>("SELECT huis.brain_retry_failed($1) AS n", [matterId])).rows[0]!.n;
  const total = (await s.client.query<{ n: number }>("SELECT count(*)::int AS n FROM huis.evidence_items WHERE matter_id = $1 AND parent_id IS NULL", [matterId])).rows[0]!.n;
  await s.client.query("INSERT INTO huis.matter_analyses (firm_id, matter_id, run_by, counts) VALUES ($1, $2, $3, $4)",
    [s.actor.firmId, matterId, s.actor.userId, JSON.stringify({ evidence: total, retried })]);
  await recordAudit(s, "matter.reanalyzed", { targetType: "matter", targetId: matterId, matterId, metadata: { retried: String(retried) } });
  return { retried };
}
