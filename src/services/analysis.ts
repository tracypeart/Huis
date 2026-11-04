import type { FirmSession } from "../db/tenant";
import { PermissionDeniedError } from "../errors";
import { INTERNAL_ROLES } from "../security/permissions";
import { recordAudit } from "./audit";
import { brainStatus, getAiProviderSetting, type BrainStatus } from "./brain";
import { getContradictions } from "./contradictions";
import { claimView } from "./dna";
import { getMatter } from "./matters";

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

/** Claims and defenses checked per analysis. */
export const MAX_CLAIMS = 200;

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
  /** More claims than are checked here. */
  claimsTruncated: boolean;
  timeline: { dated: number; withoutSource: number };
  contradictions: { potential: number; confirmed: number };
  steps: NextStep[];
}

/**
 * New evidence and notes since the last Reanalyze (or all of them, if never run): today's counts less what that
 * analysis counted (security review 15, F7: an item that arrived while it ran, unseen by it, still counts as new).
 */
export async function sinceLastAnalysis(s: FirmSession, matterId: string): Promise<{ evidence: number; notes: number; lastRun: Date | null }> {
  reader(s);
  const last = (await s.client.query<{ run_at: Date; counts: { evidence?: number; notes?: number } }>(
    "SELECT run_at, counts FROM huis.matter_analyses WHERE matter_id = $1 ORDER BY run_at DESC LIMIT 1", [matterId])).rows[0] ?? null;
  const now = (await s.client.query<{ e: number; n: number }>(
    `SELECT (SELECT count(*)::int FROM huis.evidence_items WHERE matter_id = $1 AND parent_id IS NULL) AS e,
            (SELECT count(*)::int FROM huis.matter_notes WHERE matter_id = $1) AS n`, [matterId])).rows[0]!;
  return {
    evidence: Math.max(0, now.e - (last?.counts.evidence ?? 0)),
    notes: Math.max(0, now.n - (last?.counts.notes ?? 0)),
    lastRun: last?.run_at ?? null,
  };
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

  // Counted in the database (never capped by a list's read limit; security review 15, F8). Row-level security applies.
  const d = (await s.client.query<Record<string, number>>(
    `SELECT count(*) FILTER (WHERE status = 'suggested' AND kind = 'event')::int AS suggested_events,
            count(*) FILTER (WHERE status = 'suggested' AND kind IN ('person', 'organization'))::int AS suggested_people,
            count(*) FILTER (WHERE status = 'confirmed' AND kind IN ('person', 'organization'))::int AS people,
            count(*) FILTER (WHERE status = 'confirmed' AND kind = 'event')::int AS events,
            count(*) FILTER (WHERE status = 'confirmed' AND kind = 'fact')::int AS facts,
            count(*) FILTER (WHERE status = 'confirmed' AND kind IN ('claim', 'defense'))::int AS claims,
            count(*) FILTER (WHERE status = 'confirmed' AND kind IN ('event', 'fact', 'damage') AND event_date IS NOT NULL)::int AS dated,
            count(*) FILTER (WHERE status = 'confirmed' AND kind IN ('event', 'fact', 'damage') AND event_date IS NOT NULL
                               AND NOT EXISTS (SELECT 1 FROM huis.dna_citations c WHERE c.node_id = huis.dna_nodes.id))::int AS unsourced
       FROM huis.dna_nodes WHERE matter_id = $1`, [matterId])).rows[0]!;
  const dna = {
    suggestedEvents: d.suggested_events!, suggestedPeople: d.suggested_people!, people: d.people!, events: d.events!, facts: d.facts!, claims: d.claims!,
  };

  // Each claim: elements with no confirmed supporting fact (fixed rule), and how many have contradicting ones.
  const claimNodes = (await s.client.query<{ id: string; label: string }>(
    `SELECT id, label FROM huis.dna_nodes WHERE matter_id = $1 AND status = 'confirmed' AND kind IN ('claim', 'defense')
      ORDER BY created_at, id LIMIT ${MAX_CLAIMS + 1}`, [matterId])).rows;
  const claims: ClaimGap[] = [];
  for (const c of claimNodes.slice(0, MAX_CLAIMS)) {
    const v = await claimView(s, c.id);
    claims.push({
      id: c.id, label: c.label, elements: v.elements.length,
      unsupported: v.elements.filter((e) => !e.supporting.some((f) => f.status === "confirmed" && f.linkStatus === "confirmed"))
        .map((e) => ({ id: e.element.id, label: e.element.label })),
      contradicted: v.elements.filter((e) => e.contradicting.some((f) => f.linkStatus === "confirmed")).length,
    });
  }

  const timeline = { dated: d.dated!, withoutSource: d.unsourced! };
  const con = await getContradictions(s, matterId);
  const contradictions = { potential: con.potential.length, confirmed: con.confirmed.length };
  const partial = (await s.client.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM huis.evidence_items WHERE matter_id = $1 AND status = 'clean' AND extraction_status = 'partial'", [matterId])).rows[0]!.n;
  const aiOff = (await getAiProviderSetting(s)) === "off";

  // Next steps: one fixed rule each, most useful first.
  const steps: NextStep[] = [];
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  if (ev.waiting) steps.push({ text: `${n(ev.waiting, "item is", "items are")} still being virus-scanned; nothing reads them until they're clean.`, href: base });
  if (ev.scan_failed) steps.push({ text: `${n(ev.scan_failed, "item's", "items'")} virus scan failed, so ${ev.scan_failed === 1 ? "it hasn't" : "they haven't"} been read or added to anything. Upload ${ev.scan_failed === 1 ? "it" : "them"} again.`, href: base });
  if (ev.quarantined) steps.push({ text: `${n(ev.quarantined, "item was", "items were")} found infected and quarantined; they're left out of everything.`, href: base });
  if (brain.failed) steps.push({ text: `${n(brain.failed, "item", "items")} couldn't be added to the Matter Brain. Reanalyze Matter tries them again.`, href: `${base}/analysis` });
  if (aiOff && brain.waiting) steps.push({ text: `AI features are turned off for your firm, so ${n(brain.waiting, "item is", "items are")} waiting to be added to the Matter Brain.`, href: `${base}/brain` });
  if (partial) steps.push({ text: `${n(partial, "item was", "items were")} only partly read (for example, a very long scan); the rest can't be found or cited.`, href: base });
  if (ev.unreadable) steps.push({ text: `${n(ev.unreadable, "item has", "items have")} no readable text (for example, a photo with no words, or an unsupported format), so nothing in them can be found or cited.`, href: base });
  if (dna.suggestedEvents + dna.suggestedPeople) steps.push({ text: `Review ${n(dna.suggestedEvents + dna.suggestedPeople, "suggestion", "suggestions")} from Huis (dated events and people) in Case DNA.`, href: `${base}/dna` });
  if (contradictions.potential) steps.push({ text: `Decide ${n(contradictions.potential, "potential contradiction", "potential contradictions")}.`, href: `${base}/contradictions` });
  for (const c of claims) {
    if (!c.elements) steps.push({ text: `${c.label} has no elements yet: add them to see what each needs.`, href: `${base}/dna/${c.id}` });
    if (c.unsupported.length) {
      steps.push({ text: `${c.label}: ${n(c.unsupported.length, "element has", "elements have")} no confirmed supporting fact yet (${c.unsupported.slice(0, 3).map((e) => e.label).join("; ")}${c.unsupported.length > 3 ? "; …" : ""}).`, href: `${base}/dna/${c.id}` });
    }
  }
  if (timeline.withoutSource) steps.push({ text: `${n(timeline.withoutSource, "confirmed timeline item has", "confirmed timeline items have")} no source yet.`, href: `${base}/timeline?show=confirmed&source=none&emails=no` });
  if (claimNodes.length > MAX_CLAIMS) steps.push({ text: `This Matter has more than ${MAX_CLAIMS} claims and defenses; only the first ${MAX_CLAIMS} are checked here.`, href: `${base}/claims` });
  if (con.truncated) steps.push({ text: "This Matter is very large: only part of it was checked for contradictions.", href: `${base}/contradictions` });
  if (!dna.claims) steps.push({ text: "Add a claim or defense to see its elements and the evidence for each.", href: `${base}/dna` });

  return {
    lastRun: last ? { at: last.run_at, by: last.by } : null,
    sinceLast: { evidence: since.evidence, notes: since.notes },
    evidence: { total: ev.total!, clean: ev.clean!, waitingScan: ev.waiting!, quarantined: ev.quarantined!, scanFailed: ev.scan_failed!, unreadable: ev.unreadable! },
    brain, dna, claims, claimsTruncated: claimNodes.length > MAX_CLAIMS, timeline, contradictions, steps,
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
  // One database step retries (what the caller can see, at most 3 times per document), counts and records the moment.
  const retried = (await s.client.query<{ n: number }>("SELECT huis.reanalyze_matter($1) AS n", [matterId])).rows[0]!.n;
  await recordAudit(s, "matter.reanalyzed", { targetType: "matter", targetId: matterId, matterId, metadata: { retried: String(retried) } });
  return { retried };
}
