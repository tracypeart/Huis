/**
 * Line-by-line comparison of two texts (longest common subsequence), used
 * to show what changed between versions. Bounded so a huge document can't
 * exhaust memory: beyond the limit the caller is told to compare offline.
 */

export type DiffLine =
  | { kind: "same"; text: string }
  | { kind: "removed"; text: string }
  | { kind: "added"; text: string };

export const DIFF_MAX_LINES = 3000;
/** Characters compared per side (the caller should slice first; this is a backstop). */
export const DIFF_MAX_CHARS = 1_000_000;

function lines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/\s+$/, ""));
}

export function diffLines(a: string, b: string): { lines: DiffLine[]; tooLarge: boolean } {
  if (a.length > DIFF_MAX_CHARS || b.length > DIFF_MAX_CHARS) return { lines: [], tooLarge: true };
  let x = lines(a);
  let y = lines(b);
  // Trim the common start and end first (cheap, and usually most of a document).
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start += 1;
  let endX = x.length;
  let endY = y.length;
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) { endX -= 1; endY -= 1; }
  const head = x.slice(0, start);
  const tail = x.slice(endX);
  x = x.slice(start, endX);
  y = y.slice(start, endY);
  if (x.length > DIFF_MAX_LINES || y.length > DIFF_MAX_LINES) return { lines: [], tooLarge: true };

  // Compare small integers instead of strings: each distinct line gets an id once.
  const ids = new Map<string, number>();
  const id = (l: string) => { let v = ids.get(l); if (v === undefined) { v = ids.size; ids.set(l, v); } return v; };
  const xi = Int32Array.from(x, id);
  const yi = Int32Array.from(y, id);
  const n = x.length;
  const m = y.length;
  const w = m + 1;
  const table = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * w + j] = xi[i] === yi[j] ? table[(i + 1) * w + j + 1]! + 1 : Math.max(table[(i + 1) * w + j]!, table[i * w + j + 1]!);
    }
  }
  const out: DiffLine[] = head.map((text) => ({ kind: "same" as const, text }));
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (xi[i] === yi[j]) { out.push({ kind: "same", text: x[i]! }); i += 1; j += 1; }
    else if (table[(i + 1) * w + j]! >= table[i * w + j + 1]!) { out.push({ kind: "removed", text: x[i]! }); i += 1; }
    else { out.push({ kind: "added", text: y[j]! }); j += 1; }
  }
  while (i < n) out.push({ kind: "removed", text: x[i++]! });
  while (j < m) out.push({ kind: "added", text: y[j++]! });
  for (const text of tail) out.push({ kind: "same", text });
  return { lines: out, tooLarge: false };
}
