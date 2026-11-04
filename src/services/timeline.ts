import { z } from "zod";
import type { FirmSession } from "../db/tenant";
import { PermissionDeniedError } from "../errors";
import { INTERNAL_ROLES } from "../security/permissions";
import { CATEGORIES, CATEGORY_LABELS, suggestCategories, type Category } from "../timeline/categories";
import { recordAudit } from "./audit";
import { citationsFor, type DnaCitation } from "./dna";
import { csv } from "./matterExport";
import { getMatter } from "./matters";
import { WORK_PRODUCT_LABEL } from "../ai/gateway";

/**
 * Master Timeline: one chronology per Matter.
 *
 * Built at the moment it's read from what the person can already see: Case
 * DNA's dated events, facts and damages (confirmed, plus Huis's suggestions,
 * never rejected ones), and the Matter's filed email. Every entry links to
 * its sources. Attorney work product: firm staff on the Matter only, the same
 * as Case DNA; the database's row-level security decides what each person
 * sees (walls, clean evidence only).
 */

export type EntryKind = "event" | "fact" | "damage" | "email";

export interface TimelinePerson { id: string; label: string }

export interface TimelineEntry {
  /** Stable key: the Case DNA item or the email's evidence id. */
  key: string;
  date: string;
  kind: EntryKind;
  label: string;
  details: string;
  /** Case DNA item (null for a filed email). */
  nodeId: string | null;
  /** The filed email itself (null for a Case DNA item). */
  evidenceId: string | null;
  status: "confirmed" | "suggested";
  origin: "attorney" | "huis";
  categories: Category[];
  /** Who chose the categories: an attorney, or Huis's rules (an attorney can replace them). */
  categoriesBy: "attorney" | "huis";
  amount: number | null;
  people: TimelinePerson[];
  /** For a filed email: who sent it and to whom. */
  from: string | null;
  to: string[];
  sources: DnaCitation[];
}

export const timelineFilters = z.object({
  category: z.enum(CATEGORIES).optional().catch(undefined),
  from: z.iso.date().optional().catch(undefined),
  to: z.iso.date().optional().catch(undefined),
  person: z.uuid().optional().catch(undefined),
  q: z.string().trim().max(200).optional().catch(undefined).transform((v) => v || undefined),
  show: z.enum(["all", "confirmed"]).default("all").catch("all"),
  source: z.enum(["any", "evidence", "none"]).default("any").catch("any"),
  emails: z.enum(["yes", "no"]).default("yes").catch("yes"),
});
export type TimelineFilters = z.infer<typeof timelineFilters>;

export interface Timeline {
  entries: TimelineEntry[];
  /** Entries before filtering. */
  total: number;
  /** How many of the filtered entries fall in each category (before the category filter itself). */
  categoryCounts: Record<Category, number>;
  /** Confirmed people and organizations, for the person filter. */
  people: TimelinePerson[];
  /** The Matter has more dated items or emails than the timeline reads at once. */
  truncated: boolean;
}

/** The most dated Case DNA items, and filed emails, read for one timeline. */
export const MAX_ITEMS = 5000;
export const MAX_EMAILS = 5000;
/** Characters in one spreadsheet cell of the download (below the 32,767 spreadsheets allow). */
const MAX_CELL = 32_000;

function reader(s: FirmSession) {
  if (!INTERNAL_ROLES.has(s.actor.role)) throw new PermissionDeniedError("use the timeline");
}

/** The email address inside a header value such as `Pat Smith <pat@example.com>`. */
// Only the address that ends the header counts (a display name can contain another address);
// a bare address must be the whole value. Bounded and anchored, so long or malformed input stays fast.
const ANGLE_AT_END = /<([^<>@\s]{1,64}@[^<>@\s]{1,255})>$/;
const BARE = /^[^<>@\s,;"]{1,64}@[^<>@\s,;"]{1,255}$/;
export function address(v: string): string | null {
  const s = v.slice(-330).trim();
  const m = ANGLE_AT_END.exec(s);
  if (m) return m[1]!.toLowerCase();
  return BARE.test(s) ? s.toLowerCase() : null;
}

/** Everything on the Matter's timeline, unfiltered, in date order. */
async function allEntries(s: FirmSession, matterId: string): Promise<{ entries: TimelineEntry[]; people: TimelinePerson[]; truncated: boolean }> {
  // Row-level security: only items the person can see, built on clean evidence.
  const nodes = (await s.client.query(
    `SELECT id, kind, label, details, event_date::text AS event_date, amount, status, origin, categories
       FROM huis.dna_nodes
      WHERE matter_id = $1 AND event_date IS NOT NULL AND status <> 'rejected' AND kind IN ('event', 'fact', 'damage')
      ORDER BY event_date, created_at, id LIMIT ${MAX_ITEMS + 1}`, [matterId])).rows;
  const people = (await s.client.query(
    `SELECT id, kind, label, email, role FROM huis.dna_nodes
      WHERE matter_id = $1 AND kind IN ('person', 'organization') AND status = 'confirmed' ORDER BY label LIMIT ${MAX_ITEMS}`, [matterId])).rows as
    { id: string; kind: string; label: string; email: string | null; role: string | null }[];
  const byId = new Map(people.map((p) => [p.id, p]));
  const shown = nodes.slice(0, MAX_ITEMS);
  const ids = shown.map((n) => n.id as string);
  // Confirmed links between dated items and confirmed people: who was involved, and who witnessed it.
  const links = ids.length ? (await s.client.query(
    `SELECT from_id, to_id, relation FROM huis.dna_links
      WHERE status = 'confirmed' AND relation IN ('involves', 'witness_to') AND (from_id = ANY($1::uuid[]) OR to_id = ANY($1::uuid[]))
      LIMIT 50000`, [ids])).rows as { from_id: string; to_id: string; relation: string }[] : [];
  const linked = new Map<string, { people: Set<string>; witnessed: boolean }>();
  const idSet = new Set(ids);
  for (const l of links) {
    // event → person ("involves") or person → event ("witnessed").
    const [item, other] = idSet.has(l.from_id) && byId.has(l.to_id) ? [l.from_id, l.to_id]
      : idSet.has(l.to_id) && byId.has(l.from_id) ? [l.to_id, l.from_id] : [null, null];
    if (!item || !other) continue;
    const e = linked.get(item) ?? { people: new Set<string>(), witnessed: false };
    e.people.add(other);
    if (l.relation === "witness_to") e.witnessed = true;
    linked.set(item, e);
  }
  const cites = await citationsFor(s, ids, 50_000);

  const entries: TimelineEntry[] = shown.map((n) => {
    const l = linked.get(n.id);
    const persons = [...(l?.people ?? [])].map((id) => byId.get(id)!).sort((a, b) => a.label.localeCompare(b.label));
    const sources = cites.get(n.id) ?? [];
    const amount = n.amount == null ? null : Number(n.amount);
    const chosen = n.categories as Category[] | null;
    return {
      key: n.id, date: n.event_date, kind: n.kind, label: n.label, details: n.details, nodeId: n.id, evidenceId: null,
      status: n.status, origin: n.origin, amount, from: null, to: [], sources,
      people: persons.map((p) => ({ id: p.id, label: p.label })),
      categoriesBy: chosen ? "attorney" : "huis",
      categories: chosen ?? suggestCategories(`${n.label}\n${n.details}`, {
        linkedRoles: persons.map((p) => p.role ?? "").filter(Boolean),
        hasWitness: l?.witnessed ?? false,
        isDamage: n.kind === "damage" || amount != null,
      }),
    };
  });

  // Filed email, dated by when it was sent (in the firm's own time zone).
  // Only clean items the person can open; dna_readable keeps outside users out even for shared items.
  const emails = (await s.client.query(
    `SELECT i.id, coalesce(nullif(m.subject, ''), i.original_filename) AS subject, m.from_addr, m.to_addrs, m.cc_addrs,
            (m.sent_at AT TIME ZONE f.time_zone)::date::text AS sent_on
       FROM huis.evidence_email m
       JOIN huis.evidence_items i ON i.id = m.evidence_id
       JOIN huis.firms f ON f.id = i.firm_id
      WHERE i.matter_id = $1 AND i.status = 'clean' AND m.sent_at IS NOT NULL AND huis.dna_readable(i.matter_id)
        -- An exact duplicate appears once: as its original, when the person can see that.
        AND NOT EXISTS (SELECT 1 FROM huis.evidence_items o WHERE o.id = i.duplicate_of AND o.status = 'clean')
        AND (m.sent_at AT TIME ZONE f.time_zone)::date BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'
      ORDER BY m.sent_at, i.id LIMIT ${MAX_EMAILS + 1}`, [matterId])).rows;
  const byEmail = new Map(people.filter((p) => p.email).map((p) => [p.email!, p]));
  for (const m of emails.slice(0, MAX_EMAILS)) {
    const to = [...(m.to_addrs as string[]), ...(m.cc_addrs as string[])].slice(0, 100);
    const addrs = [m.from_addr as string | null, ...to].filter((a): a is string => !!a).map(address).filter((a): a is string => !!a);
    const persons = [...new Set(addrs)].map((a) => byEmail.get(a)).filter((p): p is NonNullable<typeof p> => !!p);
    const label = String(m.subject).slice(0, 300);
    entries.push({
      key: m.id, date: m.sent_on, kind: "email", label, details: "", nodeId: null, evidenceId: m.id,
      status: "confirmed", origin: "attorney", amount: null, from: m.from_addr, to, sources: [],
      people: persons.map((p) => ({ id: p.id, label: p.label })),
      categoriesBy: "huis",
      categories: suggestCategories(label, { isEmail: true, linkedRoles: persons.map((p) => p.role ?? "").filter(Boolean) }),
    });
  }
  // Date order; on the same day, Case DNA items before emails, then as created.
  const rank = (e: TimelineEntry) => (e.kind === "email" ? 1 : 0);
  entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : rank(a) - rank(b)));
  return {
    entries,
    people: people.map((p) => ({ id: p.id, label: p.label })),
    truncated: nodes.length > MAX_ITEMS || emails.length > MAX_EMAILS,
  };
}

/** The categories Huis's rules give one Case DNA item (the same rules as the timeline), for the attorney to start from. */
export async function suggestedCategoriesFor(s: FirmSession, nodeId: string): Promise<Category[]> {
  reader(s);
  const n = (await s.client.query("SELECT kind, label, details, amount FROM huis.dna_nodes WHERE id = $1", [nodeId])).rows[0];
  if (!n) return [];
  const linked = (await s.client.query(
    `SELECT l.relation, p.kind, p.role FROM huis.dna_links l
       JOIN huis.dna_nodes p ON p.id = CASE WHEN l.from_id = $1 THEN l.to_id ELSE l.from_id END
      WHERE (l.from_id = $1 OR l.to_id = $1) AND l.status = 'confirmed' AND l.relation IN ('involves', 'witness_to')
        AND p.kind IN ('person', 'organization') AND p.status = 'confirmed' LIMIT 1000`, [nodeId])).rows;
  return suggestCategories(`${n.label}\n${n.details}`, {
    linkedRoles: linked.map((p) => p.role ?? "").filter(Boolean),
    hasWitness: linked.some((p) => p.relation === "witness_to"),
    isDamage: n.kind === "damage" || n.amount != null,
  });
}

function matches(e: TimelineEntry, f: TimelineFilters): boolean {
  if (f.from && e.date < f.from) return false;
  if (f.to && e.date > f.to) return false;
  if (f.show === "confirmed" && e.status !== "confirmed") return false;
  if (f.emails === "no" && e.kind === "email") return false;
  if (f.source === "evidence" && !(e.evidenceId || e.sources.some((c) => c.evidenceId))) return false;
  if (f.source === "none" && (e.kind === "email" || e.sources.length > 0)) return false;
  if (f.person && !e.people.some((p) => p.id === f.person)) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    const hay = [e.label, e.details, e.from ?? "", ...e.to, ...e.people.map((p) => p.label), ...e.sources.map((c) => `${c.sourceTitle} ${c.quote}`)]
      .join("\n").toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/** The Matter's timeline, filtered. */
export async function getTimeline(s: FirmSession, matterId: string, filters: unknown = {}): Promise<Timeline> {
  reader(s);
  await getMatter(s, matterId);
  const f = timelineFilters.parse(filters ?? {});
  const all = await allEntries(s, matterId);
  const beforeCategory = all.entries.filter((e) => matches(e, f));
  const categoryCounts = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  for (const e of beforeCategory) for (const c of e.categories) categoryCounts[c]++;
  return {
    entries: f.category ? beforeCategory.filter((e) => e.categories.includes(f.category!)) : beforeCategory,
    total: all.entries.length,
    categoryCounts,
    people: all.people,
    truncated: all.truncated,
  };
}

/**
 * The filtered timeline as a chronology spreadsheet (CSV), for the attorney's
 * own working file. Firm staff who can change Case DNA may download it (not
 * read-only staff), after confirming it contains privileged material. The
 * audit log records that it was downloaded and how many rows, never what.
 */
export async function timelineCsv(s: FirmSession, matterId: string, filters: unknown, acknowledged: boolean): Promise<{ filename: string; body: string }> {
  reader(s);
  if (s.actor.role === "read_only") throw new PermissionDeniedError("download the timeline");
  const matter = await getMatter(s, matterId);
  if (!acknowledged) {
    throw new PermissionDeniedError("download the timeline without confirming it will be stored securely");
  }
  const t = await getTimeline(s, matterId, filters);
  const lines = [
    [WORK_PRODUCT_LABEL],
    [`Timeline: ${matter.title}`],
    [],
    ["Date", "Status", "Type", "Description", "Categories", "Categories chosen by", "People", "Amount", "Sources"],
    ...t.entries.map((e) => [
      e.date,
      e.status === "confirmed" ? "Confirmed" : "Suggested by Huis",
      e.kind === "email" ? "Email" : e.kind[0]!.toUpperCase() + e.kind.slice(1),
      e.kind === "email" ? `${e.label}${e.from ? ` (from ${e.from})` : ""}` : e.label,
      e.categories.map((c) => CATEGORY_LABELS[c]).join("; "),
      e.categoriesBy === "attorney" ? "Attorney" : "Huis",
      e.people.map((p) => p.label).join("; "),
      e.amount == null ? "" : e.amount.toFixed(2),
      e.kind === "email" ? "This email" : e.sources.map((c) => `${c.sourceTitle}: "${c.quote}"`).join("\n"),
    ]),
  ];
  await recordAudit(s, "timeline.downloaded", { targetType: "matter", targetId: matterId, matterId, metadata: { rows: String(t.entries.length) } });
  // Spreadsheets hold at most 32,767 characters a cell (more can spill into the next cell, past the formula guard).
  const cell = (v: unknown) => csv(String(v ?? "").length > MAX_CELL ? `${String(v).slice(0, MAX_CELL)}… (shortened)` : v);
  const body = `﻿${lines.map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
  const safe = matter.huisNumber.replace(/[^A-Za-z0-9-]/g, "_").slice(0, 80) || "matter";
  return { filename: `${safe}-timeline.csv`, body };
}
