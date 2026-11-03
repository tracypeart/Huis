/**
 * Splits a document's text into passages for the Matter Brain: about 1,500
 * characters each, ending at a paragraph or sentence where possible, with a
 * small overlap so a fact split across a boundary is still found whole.
 * Each passage keeps its position in the original text, for citations.
 */
export interface Chunk { n: number; content: string; start: number; end: number }

const TARGET = 1500;
const MAX = 3000;
const OVERLAP = 200;
export const MAX_CHUNKS = 3000;

export function chunkText(text: string): Chunk[] {
  const out: Chunk[] = [];
  let start = 0;
  // Skip leading whitespace.
  while (start < text.length && /\s/.test(text[start]!)) start++;
  while (start < text.length && out.length < MAX_CHUNKS) {
    let end = Math.min(text.length, start + TARGET);
    if (end < text.length) {
      const window = text.slice(start + Math.floor(TARGET / 2), Math.min(text.length, start + MAX));
      // Prefer a paragraph break, then a sentence end, after the halfway point.
      const para = window.search(/\n\s*\n/);
      const sentence = window.search(/[.!?]["”)]?\s/);
      const cut = para !== -1 && para < TARGET ? para : sentence !== -1 ? sentence + 1 : -1;
      end = cut !== -1 ? start + Math.floor(TARGET / 2) + cut + 1 : Math.min(text.length, start + TARGET);
    }
    const content = text.slice(start, end).replace(/\u0000/g, "").trim();
    if (content) out.push({ n: out.length, content: content.slice(0, 4000), start, end });
    if (end >= text.length) break;
    let next = Math.max(end - OVERLAP, start + 1);
    // Start the overlap at a word boundary.
    while (next < end && /\S/.test(text[next - 1] ?? " ")) next++;
    start = next;
  }
  return out;
}
