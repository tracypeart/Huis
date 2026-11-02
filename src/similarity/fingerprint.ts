/**
 * Wording fingerprints for near-duplicate and version detection.
 *
 * MinHash over 5-word phrases: two documents' fingerprints agree in roughly
 * the same proportion of positions as the share of phrases they have in
 * common (Jaccard similarity). 64 values per document; the database compares
 * them in 32 bands of 2 to find candidates quickly.
 */

export const MINHASH_SIZE = 64;
const SHINGLE_WORDS = 5;
/** Words considered per document (keeps very large files cheap to fingerprint). */
const MAX_WORDS = 400_000;

// Fixed, arbitrary seeds: fingerprints must stay comparable forever.
const SEEDS: number[] = (() => {
  const out: number[] = [];
  let x = 0x9e3779b9;
  for (let i = 0; i < MINHASH_SIZE; i++) {
    x = (Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) + 0x297a2d39) | 0;
    out.push(x >>> 0);
  }
  return out;
})();

/** 32-bit FNV-1a of a string. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Murmur3 finalizer: a strong 32-bit mix, keyed by seed. */
function mix(x: number, seed: number): number {
  let h = (x ^ seed) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Normalized words: lowercase letters and digits only. */
export function words(text: string): string[] {
  const out = text.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
  return out.length > MAX_WORDS ? out.slice(0, MAX_WORDS) : out;
}

export interface Fingerprint {
  /** 64 signed 32-bit integers (as stored in Postgres int[]). */
  minhash: number[];
  /** Number of distinct 5-word phrases (too few means "don't compare"). */
  phraseCount: number;
}

export function fingerprint(text: string): Fingerprint {
  const w = words(text);
  const shingles = new Set<number>();
  if (w.length > 0 && w.length < SHINGLE_WORDS) shingles.add(fnv1a(w.join(" ")));
  for (let i = 0; i + SHINGLE_WORDS <= w.length; i++) shingles.add(fnv1a(w.slice(i, i + SHINGLE_WORDS).join(" ")));
  const min = new Array<number>(MINHASH_SIZE).fill(0xffffffff);
  for (const s of shingles) {
    for (let k = 0; k < MINHASH_SIZE; k++) {
      const v = mix(s, SEEDS[k]!);
      if (v < min[k]!) min[k] = v;
    }
  }
  return { minhash: min.map((v) => v | 0), phraseCount: shingles.size };
}

/** Estimated share of wording two fingerprints have in common (0–1). */
export function similarity(a: number[], b: number[]): number {
  let same = 0;
  for (let k = 0; k < MINHASH_SIZE; k++) if (a[k] === b[k]) same += 1;
  return same / MINHASH_SIZE;
}

const VERSION_WORDS = new Set([
  "final", "draft", "copy", "rev", "revised", "revision", "version", "ver", "v", "redline", "redlined", "clean",
  "signed", "executed", "edited", "edits", "updated", "update", "new", "old", "latest", "fully", "comments",
  "markup", "marked", "tracked", "changes", "of",
]);

/**
 * A document's name with version words stripped, so "Agreement v2 FINAL
 * (1).docx" and "agreement - draft 2024-03-01.pdf" both become "agreement".
 * Returns null when nothing meaningful is left.
 */
export function nameStem(filename: string): string | null {
  let base = filename.replace(/\.[A-Za-z0-9]{1,8}$/, "").toLowerCase().normalize("NFKC").replace(/_/g, " ");
  base = base
    .replace(/\b\d{4}[-_. ]\d{1,2}[-_. ]\d{1,2}\b/g, " ")
    .replace(/\b\d{1,2}[-_. ]\d{1,2}[-_. ]\d{2,4}\b/g, " ")
    .replace(/\(\d+\)/g, " ")
    .replace(/\bv\d+(\.\d+)*\b/g, " ")
    .replace(/\b(final|draft|rev|version)\d+\b/g, " ");
  const kept = (base.match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !VERSION_WORDS.has(t) && !/^\d+$/.test(t));
  const stem = kept.join(" ").trim();
  return stem.length >= 3 ? stem.slice(0, 200) : null;
}
