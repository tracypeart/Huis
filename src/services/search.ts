import { z } from "zod";
import type { FirmSession } from "../db/tenant";
import { recordAudit } from "./audit";

/** Markers wrapped around matched words in snippets (rendered as highlights, never as HTML). */
export const HIT_START = "\u0002";
export const HIT_END = "\u0003";

export const SearchInput = z.object({
  q: z.string().trim().min(2, "Type at least 2 characters").max(500),
  matterId: z.uuid().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type SearchInput = z.input<typeof SearchInput>;

export interface SearchHit {
  evidenceId: string;
  matterId: string;
  matterTitle: string;
  huisNumber: string;
  filename: string;
  containerPath: string | null;
  folderName: string;
  folderIsPrivileged: boolean;
  snippet: string;
  emailSubject: string | null;
  emailFrom: string | null;
  emailSentAt: Date | null;
  rank: number;
}

/**
 * Searches the text of every document, email, scan and attachment the user
 * is allowed to see — the database applies firm isolation, ethical walls and
 * the privileged-area rules, so results can never include anything else.
 * Supports phrases ("March meeting"), OR, and -exclusions.
 */
export async function searchEvidence(s: FirmSession, input: SearchInput): Promise<SearchHit[]> {
  const v = SearchInput.parse(input);
  const like = `%${v.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { rows } = await s.client.query(
    `WITH q AS (SELECT websearch_to_tsquery('english', $1) AS query)
     SELECT i.id, i.matter_id, m.title, m.huis_number, i.original_filename, i.container_path,
            f.name AS folder_name, f.is_privileged_area,
            em.subject, em.from_addr, em.sent_at,
            coalesce(ts_rank(t.tsv, q.query), 0) + CASE WHEN i.original_filename ILIKE $3 THEN 0.5 ELSE 0 END AS rank,
            CASE WHEN t.tsv @@ q.query THEN ts_headline('english', left(t.content, 300000), q.query,
              'StartSel=${HIT_START}, StopSel=${HIT_END}, MaxFragments=2, MaxWords=30, MinWords=10, FragmentDelimiter=" … "')
              ELSE left(coalesce(t.content, ''), 200) END AS snippet
       FROM q, huis.evidence_items i
       JOIN huis.matters m ON m.id = i.matter_id
       JOIN huis.matter_folders f ON f.id = i.folder_id
       LEFT JOIN huis.evidence_text t ON t.evidence_id = i.id
       LEFT JOIN huis.evidence_email em ON em.evidence_id = i.id
      WHERE (t.tsv @@ q.query OR i.original_filename ILIKE $3 OR em.subject ILIKE $3 OR em.from_addr ILIKE $3)
        AND ($2::uuid IS NULL OR i.matter_id = $2)
      ORDER BY rank DESC, i.uploaded_at DESC
      LIMIT $4`,
    [v.q, v.matterId ?? null, like, v.limit],
  );
  // Searches are part of the firm's audit trail (visible to firm admins only).
  await recordAudit(s, "evidence.searched", {
    matterId: v.matterId, metadata: { query: v.q, results: rows.length },
  });
  return rows.map((r) => ({
    evidenceId: r.id, matterId: r.matter_id, matterTitle: r.title, huisNumber: r.huis_number,
    filename: r.original_filename, containerPath: r.container_path, folderName: r.folder_name,
    folderIsPrivileged: r.is_privileged_area, snippet: r.snippet ?? "", emailSubject: r.subject,
    emailFrom: r.from_addr, emailSentAt: r.sent_at, rank: Number(r.rank),
  }));
}
