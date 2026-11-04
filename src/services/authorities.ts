import { z } from "zod";
import type { FirmSession } from "../db/tenant";
import { NotFoundError, PermissionDeniedError, UserFacingError } from "../errors";
import { INTERNAL_ROLES } from "../security/permissions";
import { recordAudit } from "./audit";
import { claimView, listNodes } from "./dna";
import { getMatter } from "./matters";

/**
 * Legal authorities and the claims matrix (Phase 7 part 1).
 *
 * The firm's library of authorities (cases, statutes, regulations, rules) is
 * entered by attorneys and each links to a real record. An authority is
 * "unverified" until an attorney confirms it against that record. Huis never
 * cites from memory, and nothing here is generated. Citing an authority for a
 * claim's element in a Matter is work product, under the Case DNA rules.
 */

export const AUTHORITY_KINDS = ["case", "statute", "regulation", "rule", "other"] as const;
export type AuthorityKind = (typeof AUTHORITY_KINDS)[number];
export const KIND_LABELS: Record<AuthorityKind, string> = { case: "Case", statute: "Statute", regulation: "Regulation", rule: "Rule", other: "Other" };
export const STANCES = ["supports", "opposes", "explains"] as const;
export type Stance = (typeof STANCES)[number];

/** Official public sources, shown with a badge (any secure link is accepted; these are the government's or court's own records, or CourtListener's). */
const OFFICIAL_HOSTS = [
  "courtlistener.com", "law.cornell.edu", "govinfo.gov", "uscode.house.gov", "ecfr.gov", "federalregister.gov", "supremecourt.gov",
  "uscourts.gov", "congress.gov", "le.utah.gov", "utcourts.gov", "eeoc.gov", "dol.gov", "nlrb.gov",
];
export function isOfficial(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return OFFICIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch { return false; }
}

function staff(s: FirmSession) {
  if (!INTERNAL_ROLES.has(s.actor.role)) throw new PermissionDeniedError("use the legal authority library");
}
function writer(s: FirmSession) {
  staff(s);
  if (s.actor.role === "read_only") throw new PermissionDeniedError("change legal authorities");
}

export interface Authority {
  id: string; kind: AuthorityKind; citation: string; title: string; court: string; year: number | null; jurisdiction: string; url: string;
  note: string; official: boolean; verified: { by: string; at: Date } | null; addedBy: string; citedIn: number;
}

const authorityInput = z.object({
  kind: z.enum(AUTHORITY_KINDS),
  citation: z.string().trim().min(1).max(300),
  title: z.string().trim().max(300).default(""),
  court: z.string().trim().max(200).default(""),
  year: z.coerce.number().int().min(1600).max(2100).nullish().catch(null),
  jurisdiction: z.string().trim().max(100).default(""),
  url: z.string().trim().max(2000).refine((u) => {
    try { const x = new URL(u); return x.protocol === "https:" && x.hostname.includes(".") && !x.username && !x.password; } catch { return false; }
  }, "Give a secure (https) link to the authority itself"),
  note: z.string().trim().max(4000).default(""),
});

const AUTH_COLS = `a.id, a.kind, a.citation, a.title, a.court, a.year, a.jurisdiction, a.url, a.note, a.verified_at,
  coalesce(v.full_name, 'Former user') AS verified_by, coalesce(c.full_name, 'Former user') AS added_by,
  (SELECT count(*)::int FROM huis.authority_links l WHERE l.authority_id = a.id) AS cited_in`;
const AUTH_FROM = `huis.legal_authorities a LEFT JOIN huis.users v ON v.id = a.verified_by LEFT JOIN huis.users c ON c.id = a.created_by`;
const toAuthority = (r: Record<string, unknown>): Authority => ({
  id: r.id as string, kind: r.kind as AuthorityKind, citation: r.citation as string, title: r.title as string, court: r.court as string,
  year: (r.year as number | null) ?? null, jurisdiction: r.jurisdiction as string, url: r.url as string, note: r.note as string,
  official: isOfficial(r.url as string), addedBy: r.added_by as string, citedIn: r.cited_in as number,
  verified: r.verified_at ? { by: r.verified_by as string, at: r.verified_at as Date } : null,
});

export async function listAuthorities(s: FirmSession, query?: string): Promise<Authority[]> {
  staff(s);
  const q = (query ?? "").trim().slice(0, 200);
  const { rows } = await s.client.query(
    `SELECT ${AUTH_COLS} FROM ${AUTH_FROM}
      WHERE $1 = '' OR a.citation ILIKE '%' || $1 || '%' OR a.title ILIKE '%' || $1 || '%' OR a.court ILIKE '%' || $1 || '%'
      ORDER BY a.kind, a.citation LIMIT 1000`, [q.replace(/[%_\\]/g, (m) => `\\${m}`)]);
  return rows.map(toAuthority);
}

async function authority(s: FirmSession, id: unknown): Promise<Authority> {
  if (!z.uuid().safeParse(id).success) throw new NotFoundError("Authority");
  const r = (await s.client.query(`SELECT ${AUTH_COLS} FROM ${AUTH_FROM} WHERE a.id = $1`, [id])).rows[0];
  if (!r) throw new NotFoundError("Authority");
  return toAuthority(r);
}

export async function addAuthority(s: FirmSession, input: unknown): Promise<string> {
  writer(s);
  const v = authorityInput.parse(input);
  try {
    const id = (await s.client.query<{ id: string }>(
      `INSERT INTO huis.legal_authorities (firm_id, kind, citation, title, court, year, jurisdiction, url, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [s.actor.firmId, v.kind, v.citation, v.title, v.court, v.year ?? null, v.jurisdiction, v.url, v.note, s.actor.userId])).rows[0]!.id;
    await recordAudit(s, "authority.added", { targetType: "authority", targetId: id, metadata: { kind: v.kind } });
    return id;
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new UserFacingError("That authority is already in the library.");
    throw e;
  }
}

/** Edits an authority. Changing its citation, kind or link clears its verification (the database does this). */
export async function updateAuthority(s: FirmSession, id: string, input: unknown): Promise<void> {
  writer(s);
  const a = await authority(s, id);
  const v = authorityInput.parse(input);
  await s.client.query(
    "UPDATE huis.legal_authorities SET kind = $2, citation = $3, title = $4, court = $5, year = $6, jurisdiction = $7, url = $8, note = $9 WHERE id = $1",
    [a.id, v.kind, v.citation, v.title, v.court, v.year ?? null, v.jurisdiction, v.url, v.note]);
  await recordAudit(s, "authority.changed", { targetType: "authority", targetId: a.id, metadata: { kind: v.kind } });
}

/** An attorney confirms (or withdraws confirmation) that the authority says what it's cited for, checked against its record. */
export async function verifyAuthority(s: FirmSession, id: string, verified: boolean): Promise<void> {
  writer(s);
  const a = await authority(s, id);
  await s.client.query(
    verified ? "UPDATE huis.legal_authorities SET verified_at = now(), verified_by = $2 WHERE id = $1 AND verified_at IS NULL"
      : "UPDATE huis.legal_authorities SET verified_at = NULL, verified_by = NULL WHERE id = $1",
    verified ? [a.id, s.actor.userId] : [a.id]);
  await recordAudit(s, verified ? "authority.verified" : "authority.unverified", { targetType: "authority", targetId: a.id, metadata: { kind: a.kind } });
}

export async function deleteAuthority(s: FirmSession, id: string): Promise<void> {
  writer(s);
  const a = await authority(s, id);
  if (a.citedIn) throw new UserFacingError("This authority is cited in a Matter. Remove those citations first.");
  const r = await s.client.query("DELETE FROM huis.legal_authorities WHERE id = $1", [a.id]);
  if (!r.rowCount) throw new PermissionDeniedError("delete an authority someone else added");
  await recordAudit(s, "authority.deleted", { targetType: "authority", targetId: a.id, metadata: { kind: a.kind } });
}

// ---------------------------------------------------------------------------
// Citing authorities in a Matter
// ---------------------------------------------------------------------------
const linkInput = z.object({
  authorityId: z.uuid(),
  stance: z.enum(STANCES),
  proposition: z.string().trim().min(1).max(1000),
  pinpoint: z.string().trim().max(100).default(""),
});

/** Cites a library authority for a confirmed claim, defense or element, with the proposition it stands for. */
export async function citeAuthority(s: FirmSession, nodeId: string, input: unknown): Promise<string> {
  writer(s);
  const v = linkInput.parse(input);
  if (!z.uuid().safeParse(nodeId).success) throw new NotFoundError("Item");
  const n = (await s.client.query<{ matter_id: string; kind: string; status: string }>(
    "SELECT matter_id, kind, status FROM huis.dna_nodes WHERE id = $1", [nodeId])).rows[0];
  if (!n) throw new NotFoundError("Item");
  if (!["claim", "defense", "element"].includes(n.kind) || n.status !== "confirmed") throw new UserFacingError("Authorities are cited for a confirmed claim, defense or element.");
  await authority(s, v.authorityId);
  try {
    const id = (await s.client.query<{ id: string }>(
      `INSERT INTO huis.authority_links (firm_id, matter_id, node_id, authority_id, stance, proposition, pinpoint, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [s.actor.firmId, n.matter_id, nodeId, v.authorityId, v.stance, v.proposition, v.pinpoint, s.actor.userId])).rows[0]!.id;
    await recordAudit(s, "authority.cited", { targetType: "dna", targetId: nodeId, matterId: n.matter_id, metadata: { stance: v.stance } });
    return id;
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new UserFacingError("That authority is already cited for this, the same way.");
    throw e;
  }
}

export async function uncite(s: FirmSession, linkId: string): Promise<void> {
  writer(s);
  if (!z.uuid().safeParse(linkId).success) throw new NotFoundError("Citation");
  const r = await s.client.query("DELETE FROM huis.authority_links WHERE id = $1 RETURNING matter_id, node_id", [linkId]);
  if (!r.rowCount) throw new NotFoundError("Citation");
  await recordAudit(s, "authority.uncited", { targetType: "dna", targetId: r.rows[0].node_id, matterId: r.rows[0].matter_id });
}

export interface CitedAuthority {
  linkId: string; stance: Stance; proposition: string; pinpoint: string;
  authority: Pick<Authority, "id" | "kind" | "citation" | "title" | "court" | "year" | "url" | "official" | "verified">;
}

async function citationsIn(s: FirmSession, matterId: string): Promise<Map<string, CitedAuthority[]>> {
  const { rows } = await s.client.query(
    `SELECT l.id AS link_id, l.node_id, l.stance, l.proposition, l.pinpoint, ${AUTH_COLS}
       FROM huis.authority_links l JOIN huis.legal_authorities a ON a.id = l.authority_id
       LEFT JOIN huis.users v ON v.id = a.verified_by LEFT JOIN huis.users c ON c.id = a.created_by
      WHERE l.matter_id = $1 ORDER BY l.created_at LIMIT 5000`, [matterId]);
  const out = new Map<string, CitedAuthority[]>();
  for (const r of rows) {
    const a = toAuthority(r);
    const list = out.get(r.node_id) ?? [];
    list.push({
      linkId: r.link_id, stance: r.stance, proposition: r.proposition, pinpoint: r.pinpoint,
      authority: { id: a.id, kind: a.kind, citation: a.citation, title: a.title, court: a.court, year: a.year, url: a.url, official: a.official, verified: a.verified },
    });
    out.set(r.node_id, list);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Claims matrix
// ---------------------------------------------------------------------------
export interface MatrixElement {
  id: string; label: string; details: string;
  supporting: number; contradicting: number; sources: number;
  authorities: CitedAuthority[];
  /** Fixed-rule gaps, in plain words. */
  gaps: string[];
}
export interface MatrixClaim { id: string; kind: "claim" | "defense"; label: string; details: string; authorities: CitedAuthority[]; elements: MatrixElement[] }

/** Every claim and defense in the Matter, each element with its facts, sources and authorities, and the gaps. */
export async function claimsMatrix(s: FirmSession, matterId: string): Promise<MatrixClaim[]> {
  staff(s);
  await getMatter(s, matterId);
  const cites = await citationsIn(s, matterId);
  const claims = (await listNodes(s, matterId)).filter((n) => n.status === "confirmed" && (n.kind === "claim" || n.kind === "defense")).slice(0, 100);
  const out: MatrixClaim[] = [];
  for (const c of claims) {
    const v = await claimView(s, c.id);
    out.push({
      id: c.id, kind: c.kind as "claim" | "defense", label: c.label, details: c.details, authorities: cites.get(c.id) ?? [],
      elements: v.elements.map(({ element: e, supporting, contradicting }) => {
        const sup = supporting.filter((f) => f.status === "confirmed" && f.linkStatus === "confirmed");
        const con = contradicting.filter((f) => f.status === "confirmed" && f.linkStatus === "confirmed");
        const sources = new Set([...sup, ...con].flatMap((f) => f.citations.map((x) => x.evidenceId ?? x.noteId)));
        const auth = cites.get(e.id) ?? [];
        const gaps: string[] = [];
        if (!sup.length) gaps.push("no confirmed supporting fact");
        else if (!sup.some((f) => f.citations.length)) gaps.push("supporting facts have no source");
        if (!auth.some((a) => a.stance !== "opposes")) gaps.push("no legal authority cited");
        else if (!auth.some((a) => a.stance !== "opposes" && a.authority.verified)) gaps.push("authority not yet verified");
        if (con.length) gaps.push(`${con.length} contradicting ${con.length === 1 ? "fact" : "facts"}`);
        return { id: e.id, label: e.label, details: e.details, supporting: sup.length, contradicting: con.length, sources: sources.size, authorities: auth, gaps };
      }),
    });
  }
  return out;
}
