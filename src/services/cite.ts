import type { FirmSession } from "../db/tenant";
import { UserFacingError } from "../errors";

/**
 * Citing exact words in a source (a document's text or an attorney note).
 *
 * Huis finds passages in JavaScript, which counts positions in UTF-16 units;
 * the database quotes a source by characters. Text with emoji or other
 * characters outside the basic range would otherwise be cited a few
 * characters off (security review 12, F2). Positions are converted here, and
 * the database's own quote can be checked against what Huis expected to cite.
 */

/** The text a citation quotes from, as the database reads it (row-level security applies). */
export async function sourceText(s: FirmSession, evidenceId: string | null, noteId: string | null): Promise<string | null> {
  const r = evidenceId
    ? (await s.client.query<{ t: string }>("SELECT left(content, 2000000) AS t FROM huis.evidence_text WHERE evidence_id = $1", [evidenceId])).rows[0]
    : (await s.client.query<{ t: string }>("SELECT title || E'\\n\\n' || body AS t FROM huis.matter_notes WHERE id = $1", [noteId])).rows[0];
  return r?.t ?? null;
}

/** UTF-16 positions in a text → character (code point) positions. */
export function toCharPositions(text: string, start: number, end: number): { start: number; end: number } {
  const count = (upTo: number) => {
    let n = 0;
    for (let i = 0; i < upTo && i < text.length; i++) {
      const c = text.charCodeAt(i);
      // The second half of a surrogate pair isn't a character of its own.
      if (!(c >= 0xdc00 && c <= 0xdfff && i > 0 && text.charCodeAt(i - 1) >= 0xd800 && text.charCodeAt(i - 1) <= 0xdbff)) n++;
    }
    return n;
  };
  const a = count(start);
  return { start: a, end: a + count(end) - count(start) };
}

const norm = (t: string) => t.replace(/\s+/g, " ").trim();

/**
 * Adds a citation to a Case DNA item at UTF-16 positions in its source. With
 * `expect`, the quote the database takes from the source must be those words,
 * or nothing is saved (the person is asked to look again).
 */
export async function citeExactly(s: FirmSession, c: {
  matterId: string; nodeId: string; evidenceId: string | null; noteId: string | null; start: number; end: number; text?: string | null; expect?: string;
}): Promise<void> {
  const text = c.text ?? await sourceText(s, c.evidenceId, c.noteId);
  if (text == null) throw new UserFacingError("That source can no longer be cited.");
  const pos = toCharPositions(text, c.start, c.end);
  const r = await s.client.query<{ quote: string }>(
    `INSERT INTO huis.dna_citations (firm_id, matter_id, node_id, evidence_id, note_id, char_start, char_end, quote)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'x') RETURNING quote`,
    [s.actor.firmId, c.matterId, c.nodeId, c.evidenceId, c.noteId, pos.start, pos.end]);
  if (c.expect !== undefined && norm(r.rows[0]!.quote) !== norm(c.expect).slice(0, 1500)) {
    throw new UserFacingError("Huis couldn't cite the exact words in the source (it may have changed). Nothing was saved; please look again.");
  }
}
