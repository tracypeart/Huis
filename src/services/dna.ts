import { z } from "zod";
import type { FirmSession } from "../db/tenant";
import { CLAIM_TEMPLATES } from "../dna/templates";
import { NotFoundError, PermissionDeniedError, UserFacingError } from "../errors";
import { INTERNAL_ROLES } from "../security/permissions";
import { recordAudit } from "./audit";
import { terms } from "../ai/local";
import { searchPassages, type FoundPassage } from "./brain";
import { getMatter } from "./matters";
import { citeExactly } from "./cite";
import { CATEGORIES, type Category } from "../timeline/categories";

/**
 * Case DNA™: each Matter's relationship map.
 *
 * Attorney work product: firm staff who can see the Matter only — the
 * database enforces it, and clients and other outside users never see it.
 * Huis suggests (dated events from documents, people on filed email,
 * passages that may prove an element); attorneys confirm or reject, and
 * only confirmed items count. The audit log records what kind of change was
 * made, never the wording.
 */

export const NODE_KINDS = ["person", "organization", "event", "claim", "defense", "element", "fact", "damage"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];
export const RELATIONS = ["element_of", "supports", "contradicts", "involves", "witness_to", "defends_against", "caused", "works_for", "related_to"] as const;
export type Relation = (typeof RELATIONS)[number];
type Status = "suggested" | "confirmed" | "rejected";

export const KIND_LABELS: Record<NodeKind, string> = {
  person: "People", organization: "Organizations", event: "Events", claim: "Claims", defense: "Defenses",
  element: "Elements", fact: "Facts", damage: "Damages",
};
export const RELATION_LABELS: Record<Relation, string> = {
  element_of: "is an element of", supports: "supports", contradicts: "contradicts", involves: "involves",
  witness_to: "witnessed", defends_against: "defends against", caused: "caused", works_for: "works for", related_to: "is related to",
};

const uuid = z.uuid();
const reader = (s: FirmSession) => {
  if (!INTERNAL_ROLES.has(s.actor.role)) throw new PermissionDeniedError("use Case DNA");
};
const writer = (s: FirmSession) => {
  reader(s);
  if (s.actor.role === "read_only") throw new PermissionDeniedError("change Case DNA");
};

export interface DnaNode {
  id: string; matterId: string; kind: NodeKind; label: string; details: string; eventDate: string | null; email: string | null;
  role: string | null; amount: number | null; status: Status; origin: "attorney" | "huis"; createdAt: Date;
  /** Timeline categories an attorney chose; null until they choose (Huis's rules apply until then). */
  categories: Category[] | null;
}
export interface DnaLink { id: string; fromId: string; toId: string; relation: Relation; status: Status; origin: "attorney" | "huis" }
export interface DnaCitation { id: string; evidenceId: string | null; noteId: string | null; quote: string; sourceTitle: string; isEmail: boolean }

const NODE_COLS = "id, matter_id, kind, label, details, event_date::text AS event_date, email, role, amount, status, origin, created_at, categories";
const toNode = (r: Record<string, unknown>): DnaNode => ({
  id: r.id as string, matterId: r.matter_id as string, kind: r.kind as NodeKind, label: r.label as string, details: r.details as string,
  eventDate: (r.event_date as string | null) ?? null, email: (r.email as string | null) ?? null, role: (r.role as string | null) ?? null,
  amount: r.amount == null ? null : Number(r.amount), status: r.status as Status, origin: r.origin as "attorney" | "huis",
  createdAt: r.created_at as Date, categories: (r.categories as Category[] | null | undefined) ?? null,
});

async function node(s: FirmSession, id: string): Promise<DnaNode> {
  if (!uuid.safeParse(id).success) throw new NotFoundError("Item");
  const r = (await s.client.query(`SELECT ${NODE_COLS} FROM huis.dna_nodes WHERE id = $1`, [id])).rows[0];
  if (!r) throw new NotFoundError("Item");
  return toNode(r);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------
/** Confirmed items always come first, so suggestions can never crowd them out. */
export const MAX_LISTED = 5000;

export async function listNodes(s: FirmSession, matterId: string, opts: { includeRejected?: boolean } = {}): Promise<DnaNode[]> {
  reader(s);
  await getMatter(s, matterId);
  const { rows } = await s.client.query(
    `SELECT ${NODE_COLS} FROM huis.dna_nodes WHERE matter_id = $1 ${opts.includeRejected ? "" : "AND status <> 'rejected'"}
      ORDER BY (status = 'confirmed') DESC, kind, event_date NULLS LAST, label LIMIT ${MAX_LISTED}`, [matterId]);
  return rows.map(toNode);
}

export interface NodeDetail {
  node: DnaNode;
  links: (DnaLink & { other: DnaNode; direction: "out" | "in" })[];
  citations: DnaCitation[];
}

export async function citationsFor(s: FirmSession, nodeIds: string[], limit = 2000): Promise<Map<string, DnaCitation[]>> {
  const out = new Map<string, DnaCitation[]>();
  if (!nodeIds.length) return out;
  const { rows } = await s.client.query(
    `SELECT c.id::text, c.node_id, c.evidence_id, c.note_id, c.quote, coalesce(i.original_filename, x.title, 'Source') AS title,
            (m.evidence_id IS NOT NULL OR i.source = 'mailbox') AS is_email
       FROM huis.dna_citations c
       LEFT JOIN huis.evidence_items i ON i.id = c.evidence_id
       LEFT JOIN huis.evidence_email m ON m.evidence_id = c.evidence_id
       LEFT JOIN huis.matter_notes x ON x.id = c.note_id
      WHERE c.node_id = ANY($1::uuid[]) ORDER BY c.id LIMIT ${Math.max(1, Math.min(Math.trunc(limit), 50_000))}`, [nodeIds]);
  for (const r of rows) {
    const list = out.get(r.node_id) ?? [];
    list.push({ id: r.id, evidenceId: r.evidence_id, noteId: r.note_id, quote: r.quote, sourceTitle: r.title, isEmail: Boolean(r.is_email) });
    out.set(r.node_id, list);
  }
  return out;
}

export async function getNode(s: FirmSession, nodeId: string): Promise<NodeDetail> {
  reader(s);
  const n = await node(s, nodeId);
  const { rows } = await s.client.query(
    `SELECT l.id, l.from_id, l.to_id, l.relation, l.status, l.origin, CASE WHEN l.from_id = $1 THEN 'out' ELSE 'in' END AS direction,
            o.id AS o_id, o.matter_id AS o_matter_id, o.kind AS o_kind, o.label AS o_label, o.details AS o_details,
            o.event_date::text AS o_event_date, o.email AS o_email, o.role AS o_role, o.amount AS o_amount, o.status AS o_status,
            o.origin AS o_origin, o.created_at AS o_created_at
       FROM huis.dna_links l JOIN huis.dna_nodes o ON o.id = CASE WHEN l.from_id = $1 THEN l.to_id ELSE l.from_id END
      WHERE (l.from_id = $1 OR l.to_id = $1) AND l.status <> 'rejected' ORDER BY l.relation, o.label LIMIT 1000`, [nodeId]);
  const links = rows.map((r) => ({
    id: r.id, fromId: r.from_id, toId: r.to_id, relation: r.relation, status: r.status, origin: r.origin, direction: r.direction,
    other: toNode(Object.fromEntries(Object.entries(r).filter(([k]) => k.startsWith("o_")).map(([k, v]) => [k.slice(2), v]))),
  }));
  return { node: n, links, citations: (await citationsFor(s, [n.id])).get(n.id) ?? [] };
}

export interface ElementView {
  element: DnaNode;
  supporting: (DnaNode & { citations: DnaCitation[]; linkStatus: Status })[];
  contradicting: (DnaNode & { citations: DnaCitation[]; linkStatus: Status })[];
}
export interface ClaimView {
  claim: DnaNode;
  elements: ElementView[];
  witnesses: DnaNode[];
  emails: DnaCitation[];
  evidence: DnaCitation[];
}

/** A claim at a glance: elements → supporting and contradicting facts → evidence, witnesses and emails. */
export async function claimView(s: FirmSession, claimId: string): Promise<ClaimView> {
  reader(s);
  const claim = await node(s, claimId);
  if (claim.kind !== "claim" && claim.kind !== "defense") throw new UserFacingError("That item isn't a claim or defense.");
  const elements = (await s.client.query(
    `SELECT e.id, e.matter_id, e.kind, e.label, e.details, e.event_date::text AS event_date, e.email, e.role, e.amount, e.status, e.origin, e.created_at
       FROM huis.dna_links l JOIN huis.dna_nodes e ON e.id = l.from_id
      WHERE l.to_id = $1 AND l.relation = 'element_of' AND l.status = 'confirmed' AND e.kind = 'element' AND e.status = 'confirmed'
      ORDER BY e.created_at, e.label`, [claimId])).rows.map(toNode);
  const elementIds = elements.map((e) => e.id);
  const facts = elementIds.length ? (await s.client.query(
    `SELECT l.to_id AS element_id, l.relation, l.status AS link_status, f.id, f.matter_id, f.kind, f.label, f.details, f.event_date::text AS event_date,
            f.email, f.role, f.amount, f.status, f.origin, f.created_at
       FROM huis.dna_links l JOIN huis.dna_nodes f ON f.id = l.from_id
      WHERE l.to_id = ANY($1::uuid[]) AND l.relation IN ('supports', 'contradicts') AND l.status <> 'rejected' AND f.status <> 'rejected'
      ORDER BY f.event_date NULLS LAST, f.created_at`, [elementIds])).rows : [];
  const factIds = [...new Set(facts.map((f) => f.id as string))];
  const cites = await citationsFor(s, factIds);
  const witnesses = factIds.length ? (await s.client.query(
    `SELECT DISTINCT p.id, p.matter_id, p.kind, p.label, p.details, p.event_date::text AS event_date, p.email, p.role, p.amount, p.status, p.origin, p.created_at
       FROM huis.dna_links l JOIN huis.dna_nodes p ON p.id = CASE WHEN l.from_id = ANY($1::uuid[]) THEN l.to_id ELSE l.from_id END
      WHERE (l.from_id = ANY($1::uuid[]) OR l.to_id = ANY($1::uuid[])) AND l.relation IN ('witness_to', 'involves')
        AND l.status = 'confirmed' AND p.kind = 'person' AND p.status = 'confirmed'
      ORDER BY p.label`, [factIds])).rows.map(toNode) : [];
  const all = factIds.flatMap((id) => cites.get(id) ?? []);
  const unique = (list: DnaCitation[]) => [...new Map(list.map((c) => [`${c.evidenceId ?? c.noteId}`, c])).values()];
  return {
    claim,
    elements: elements.map((element) => {
      const mine = facts.filter((f) => f.element_id === element.id);
      const shape = (f: Record<string, unknown>) => ({ ...toNode(f), citations: cites.get(f.id as string) ?? [], linkStatus: f.link_status as Status });
      return { element, supporting: mine.filter((f) => f.relation === "supports").map(shape), contradicting: mine.filter((f) => f.relation === "contradicts").map(shape) };
    }),
    witnesses,
    emails: unique(all.filter((c) => c.isEmail)),
    evidence: unique(all.filter((c) => !c.isEmail)),
  };
}

// ---------------------------------------------------------------------------
// Changing
// ---------------------------------------------------------------------------
const nodeInput = z.object({
  kind: z.enum(NODE_KINDS),
  label: z.string().trim().min(1).max(300),
  details: z.string().trim().max(20_000).optional().default(""),
  eventDate: z.iso.date().nullish(),
  email: z.email().max(320).nullish().transform((v) => v?.toLowerCase() ?? null),
  role: z.string().trim().max(100).nullish(),
  amount: z.coerce.number().nonnegative().max(999_999_999_999).nullish(),
  categories: z.array(z.enum(CATEGORIES)).max(CATEGORIES.length).nullish().transform((v) => (v ? [...new Set(v)] : null)),
});

async function insertNode(s: FirmSession, matterId: string, v: z.input<typeof nodeInput>): Promise<string> {
  return (await s.client.query<{ id: string }>(
    `INSERT INTO huis.dna_nodes (firm_id, matter_id, kind, label, details, event_date, email, role, amount, status, origin, created_by, categories)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'confirmed', 'attorney', $10, $11) RETURNING id`,
    [s.actor.firmId, matterId, v.kind, v.label, v.details ?? "", v.eventDate ?? null, v.email ?? null, v.role || null, v.amount ?? null, s.actor.userId,
     v.categories ?? null],
  )).rows[0]!.id;
}

async function insertLink(s: FirmSession, matterId: string, fromId: string, toId: string, relation: Relation): Promise<string> {
  const r = await s.client.query<{ id: string }>(
    `INSERT INTO huis.dna_links (firm_id, matter_id, from_id, to_id, relation, status, origin, created_by)
     VALUES ($1, $2, $3, $4, $5, 'confirmed', 'attorney', $6)
     ON CONFLICT (from_id, to_id, relation) DO UPDATE SET status = 'confirmed' RETURNING id`,
    [s.actor.firmId, matterId, fromId, toId, relation, s.actor.userId]);
  return r.rows[0]!.id;
}

const audit = (s: FirmSession, action: string, matterId: string, targetId: string, metadata: Record<string, string> = {}) =>
  recordAudit(s, `dna.${action}`, { targetType: "dna", targetId, matterId, metadata });

export async function addNode(s: FirmSession, matterId: string, input: unknown): Promise<string> {
  writer(s);
  await getMatter(s, matterId);
  const v = nodeInput.parse(input);
  const id = await insertNode(s, matterId, v);
  await audit(s, "added", matterId, id, { kind: v.kind });
  return id;
}

export async function updateNode(s: FirmSession, nodeId: string, input: unknown): Promise<void> {
  writer(s);
  const n = await node(s, nodeId);
  if (n.origin === "huis" && n.status === "suggested") throw new UserFacingError("Confirm Huis's suggestion before changing it.");
  const v = nodeInput.omit({ kind: true, categories: true }).parse(input);
  await s.client.query(
    "UPDATE huis.dna_nodes SET label = $2, details = $3, event_date = $4, email = $5, role = $6, amount = $7 WHERE id = $1",
    [nodeId, v.label, v.details ?? "", v.eventDate ?? null, v.email ?? null, v.role || null, v.amount ?? null]);
  await audit(s, "changed", n.matterId, nodeId, { kind: n.kind });
}

export async function deleteNode(s: FirmSession, nodeId: string): Promise<void> {
  writer(s);
  const n = await node(s, nodeId);
  if (n.origin === "huis") throw new UserFacingError("Huis's suggestions can't be deleted; reject them instead, so they aren't suggested again.");
  await s.client.query("DELETE FROM huis.dna_nodes WHERE id = $1", [nodeId]);
  await audit(s, "deleted", n.matterId, nodeId, { kind: n.kind });
}

/**
 * An item's timeline categories, chosen by an attorney (null goes back to Huis's suggestions).
 * A suggestion has to be confirmed first, like any other change to it.
 */
export async function setCategories(s: FirmSession, nodeId: string, input: unknown): Promise<void> {
  writer(s);
  const cats = z.array(z.enum(CATEGORIES)).max(CATEGORIES.length).nullable().parse(input);
  const n = await node(s, nodeId);
  if (n.origin === "huis" && n.status === "suggested") throw new UserFacingError("Confirm Huis's suggestion before changing it.");
  const value = cats ? CATEGORIES.filter((c) => cats.includes(c)) : null;
  await s.client.query("UPDATE huis.dna_nodes SET categories = $2 WHERE id = $1", [nodeId, value]);
  await audit(s, "categories_changed", n.matterId, nodeId, { kind: n.kind });
}

/** Confirm or reject a suggestion (or reverse an earlier decision). */
export async function decideNode(s: FirmSession, nodeId: string, decision: unknown): Promise<void> {
  writer(s);
  const d = z.enum(["confirmed", "rejected"]).parse(decision);
  const n = await node(s, nodeId);
  await s.client.query("UPDATE huis.dna_nodes SET status = $2 WHERE id = $1", [nodeId, d]);
  await audit(s, d === "confirmed" ? "confirmed" : "rejected", n.matterId, nodeId, { kind: n.kind });
}

export async function decideLink(s: FirmSession, linkId: string, decision: unknown): Promise<void> {
  writer(s);
  const d = z.enum(["confirmed", "rejected"]).parse(decision);
  if (!uuid.safeParse(linkId).success) throw new NotFoundError("Link");
  const r = await s.client.query("UPDATE huis.dna_links SET status = $2 WHERE id = $1 RETURNING matter_id, relation", [linkId, d]);
  if (!r.rowCount) throw new NotFoundError("Link");
  await audit(s, d === "confirmed" ? "link_confirmed" : "link_rejected", r.rows[0].matter_id, linkId, { relation: r.rows[0].relation });
}

/** Which kinds each relation can join (from → to). */
const ALLOWED: Record<Relation, [NodeKind[], NodeKind[]]> = {
  element_of: [["element"], ["claim", "defense"]],
  supports: [["fact", "event", "person", "organization", "damage"], ["element", "claim", "defense", "fact", "damage"]],
  contradicts: [["fact", "event", "person", "organization"], ["element", "claim", "defense", "fact", "event"]],
  involves: [["event", "fact", "claim", "damage"], ["person", "organization"]],
  witness_to: [["person"], ["event", "fact"]],
  defends_against: [["defense"], ["claim"]],
  caused: [["event", "fact"], ["damage", "event"]],
  works_for: [["person"], ["organization"]],
  related_to: [[...NODE_KINDS], [...NODE_KINDS]],
};

export async function linkNodes(s: FirmSession, fromId: string, toId: string, relation: unknown): Promise<string> {
  writer(s);
  const rel = z.enum(RELATIONS).parse(relation);
  const [a, b] = [await node(s, fromId), await node(s, toId)];
  if (a.matterId !== b.matterId) throw new NotFoundError("Item");
  if (a.id === b.id) throw new UserFacingError("An item can't be linked to itself.");
  const [froms, tos] = ALLOWED[rel];
  if (!froms.includes(a.kind) || !tos.includes(b.kind)) {
    throw new UserFacingError(`A ${a.kind} can't be linked to a ${b.kind} with "${RELATION_LABELS[rel]}".`);
  }
  const id = await insertLink(s, a.matterId, a.id, b.id, rel);
  await audit(s, "linked", a.matterId, id, { relation: rel });
  return id;
}

export async function unlink(s: FirmSession, linkId: string): Promise<void> {
  writer(s);
  if (!uuid.safeParse(linkId).success) throw new NotFoundError("Link");
  const r = await s.client.query("DELETE FROM huis.dna_links WHERE id = $1 RETURNING matter_id", [linkId]);
  if (!r.rowCount) throw new NotFoundError("Link");
  await audit(s, "unlinked", r.rows[0].matter_id, linkId);
}

/** A claim (or defense) from a template, with its elements. */
export async function addClaimFromTemplate(s: FirmSession, matterId: string, templateKey: unknown): Promise<string> {
  writer(s);
  await getMatter(s, matterId);
  const t = CLAIM_TEMPLATES.find((x) => x.key === templateKey);
  if (!t) throw new NotFoundError("Claim template");
  const claimId = await insertNode(s, matterId, { kind: t.kind, label: t.title, details: `Source: ${t.source}`, eventDate: null, email: null, role: null, amount: null });
  for (const e of t.elements) {
    const id = await insertNode(s, matterId, { kind: "element", label: e.label, details: e.details, eventDate: null, email: null, role: null, amount: null });
    await insertLink(s, matterId, id, claimId, "element_of");
  }
  await audit(s, "claim_added", matterId, claimId, { template: t.key });
  return claimId;
}

export async function addElement(s: FirmSession, claimId: string, input: unknown): Promise<string> {
  writer(s);
  const claim = await node(s, claimId);
  if (claim.kind !== "claim" && claim.kind !== "defense") throw new UserFacingError("Elements belong to a claim or defense.");
  const v = z.object({ label: z.string().trim().min(1).max(300), details: z.string().trim().max(20_000).optional().default("") }).parse(input);
  const id = await insertNode(s, claim.matterId, { kind: "element", label: v.label, details: v.details, eventDate: null, email: null, role: null, amount: null });
  await insertLink(s, claim.matterId, id, claim.id, "element_of");
  await audit(s, "added", claim.matterId, id, { kind: "element" });
  return id;
}

/** People already known to the Matter (its client and linked contacts) join the map, confirmed. */
export async function importMatterPeople(s: FirmSession, matterId: string): Promise<number> {
  writer(s);
  await getMatter(s, matterId);
  const { rows } = await s.client.query<{ label: string; email: string | null; role: string; kind: NodeKind }>(
    `SELECT c.display_name AS label, lower(c.email) AS email, 'client' AS role, CASE WHEN c.kind = 'organization' THEN 'organization' ELSE 'person' END AS kind
       FROM huis.matters m JOIN huis.clients c ON c.id = m.client_id WHERE m.id = $1
     UNION ALL
     SELECT ct.full_name, lower(ct.email), replace(coalesce(nullif(mc.role_label, ''), ct.kind::text), '_', ' '), 'person'
       FROM huis.matter_contacts mc JOIN huis.contacts ct ON ct.id = mc.contact_id WHERE mc.matter_id = $1`, [matterId]);
  const existing = await listNodes(s, matterId, { includeRejected: true });
  let n = 0;
  for (const p of rows) {
    if (existing.some((e) => (e.kind === "person" || e.kind === "organization") && (e.label === p.label || (p.email && e.email === p.email) ) && e.origin === "attorney")) continue;
    // A matching suggestion from Huis is confirmed rather than duplicated.
    const suggestion = p.email ? existing.find((e) => e.origin === "huis" && e.email === p.email && e.status === "suggested") : undefined;
    if (suggestion) {
      // Confirm first (a suggestion can't be reworded while it's a suggestion), then name it.
      await s.client.query("UPDATE huis.dna_nodes SET status = 'confirmed' WHERE id = $1", [suggestion.id]);
      await s.client.query("UPDATE huis.dna_nodes SET label = $2, role = $3 WHERE id = $1", [suggestion.id, p.label.slice(0, 300), p.role.slice(0, 100)]);
      n++; continue;
    }
    const email = p.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email) ? p.email : null;
    await insertNode(s, matterId, { kind: p.kind, label: p.label.slice(0, 300), details: "", eventDate: null, email, role: p.role.slice(0, 100), amount: null });
    n++;
  }
  if (n) await audit(s, "people_imported", matterId, matterId, { count: String(n) });
  return n;
}

// ---------------------------------------------------------------------------
// Finding evidence for an element (Matter Brain), and adding it as a fact
// ---------------------------------------------------------------------------
export async function findEvidenceFor(s: FirmSession, elementId: string): Promise<FoundPassage[]> {
  reader(s);
  const el = await node(s, elementId);
  if (el.kind !== "element") throw new UserFacingError("Huis finds evidence for a claim's elements.");
  const claim = (await s.client.query<{ label: string }>(
    "SELECT c.label FROM huis.dna_links l JOIN huis.dna_nodes c ON c.id = l.to_id WHERE l.from_id = $1 AND l.relation = 'element_of' LIMIT 1", [elementId])).rows[0];
  const query = `${claim?.label ?? ""} ${el.label} ${el.details}`.slice(0, 2000);
  return searchPassages(s, el.matterId, query, 10, 2);
}

/** The sentence in a passage that best matches an element (so a fact reads as the point, not the start of the page). */
function bestSentence(passage: string, about: string): string {
  // Word roots (first five letters), so "employee" meets "employment".
  const root = (w: string) => w.slice(0, 5);
  const want = new Set(terms(about).map(root));
  let best = "";
  let bestScore = -1;
  for (const line of passage.split(/\n+/)) {
    for (const raw of line.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/)) {
      const sentence = raw.trim();
      if (sentence.length < 15 || /^(from|to|cc|date|subject|sent):/i.test(sentence)) continue;
      const words = terms(sentence);
      // Matching words count most; a fuller sentence wins a tie over a short heading.
      const score = words.filter((w) => want.has(root(w))).length / Math.sqrt(words.length || 1) + Math.min(words.length, 20) / 1000;
      if (score > bestScore) { best = sentence; bestScore = score; }
    }
  }
  const out = best || passage.replace(/\s+/g, " ").trim();
  return out.length > 300 ? `${out.slice(0, 297)}…` : out;
}

/** Adds a passage (one this person can open) as a fact that supports or contradicts an element, cited to its source. */
export async function addFactFromPassage(s: FirmSession, elementId: string, input: unknown): Promise<string> {
  writer(s);
  const v = z.object({
    chunkId: z.string().regex(/^[0-9]{1,19}$/),
    relation: z.enum(["supports", "contradicts"]),
    label: z.string().trim().min(1).max(300).optional(),
  }).parse(input);
  const el = await node(s, elementId);
  if (el.kind !== "element") throw new UserFacingError("Facts are linked to a claim's elements.");
  // Row-level security: only a passage this person can open, from this Matter.
  const c = (await s.client.query(
    "SELECT content, evidence_id, note_id, char_start, char_end FROM huis.brain_chunks WHERE id = $1 AND matter_id = $2", [v.chunkId, el.matterId])).rows[0];
  if (!c) throw new NotFoundError("Passage");
  const text = String(c.content).replace(/\s+/g, " ").trim();
  const label = v.label ?? bestSentence(String(c.content), `${el.label} ${el.details}`);
  const factId = await insertNode(s, el.matterId, { kind: "fact", label, details: "", eventDate: null, email: null, role: null, amount: null });
  // Cited at the passage's exact position (in characters, as the database counts them).
  await citeExactly(s, { matterId: el.matterId, nodeId: factId, evidenceId: c.evidence_id, noteId: c.note_id, start: c.char_start, end: c.char_end });
  await insertLink(s, el.matterId, factId, el.id, v.relation);
  await audit(s, "fact_added", el.matterId, factId, { relation: v.relation });
  return factId;
}

export { CLAIM_TEMPLATES };
