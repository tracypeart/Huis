import { createHash } from "node:crypto";
import type { AiAnswer, AiProvider, Passage } from "./gateway";

/**
 * Huis's built-in AI provider. Runs inside Huis and sends nothing anywhere.
 *
 * Meaning fingerprints: words and word pairs (lightly stemmed, common words
 * dropped) hashed into a fixed-size vector. It matches related wording far
 * better than nothing, but much less well than a real language model.
 *
 * Answers: the sentences from the retrieved passages that best match the
 * question, each with its citation. It never writes conclusions of its own.
 */
const DIMS = 512;
const STOP = new Set(("a an and are as at be but by for from has have he her his i if in into is it its me my no not of on or our she " +
  "so that the their them then there these they this to was we were what when where which who why will with you your do does did " +
  "can could should would about after before over under than also any all been being more most other some such only own same").split(" "));

export function terms(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || raw.length > 40 || STOP.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

/** A light English stemmer: enough that "terminated", "terminating" and "termination" meet. */
function stem(w: string): string {
  if (/^\d+$/.test(w)) return w;
  for (const suf of ["ational", "ization", "fulness", "ousness", "iveness", "ation", "ments", "ment", "ness", "ions", "ion", "ing", "ies", "ied", "ed", "es", "ly", "s"]) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) return w.slice(0, -suf.length);
  }
  return w;
}

function bucket(feature: string): { index: number; sign: number } {
  const h = createHash("sha1").update(feature).digest();
  return { index: h.readUInt32BE(0) % DIMS, sign: h[4]! & 1 ? 1 : -1 };
}

export function fingerprint(text: string): number[] {
  const v = new Float64Array(DIMS);
  const t = terms(text.slice(0, 20_000));
  const counts = new Map<string, number>();
  for (let i = 0; i < t.length; i++) {
    counts.set(t[i]!, (counts.get(t[i]!) ?? 0) + 1);
    if (i + 1 < t.length) counts.set(`${t[i]} ${t[i + 1]}`, (counts.get(`${t[i]} ${t[i + 1]}`) ?? 0) + 0.5);
  }
  for (const [f, c] of counts) {
    const { index, sign } = bucket(f);
    v[index]! += sign * (1 + Math.log(c));
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  // Rounded so they store compactly.
  return Array.from(v, (x) => Math.round((x / norm) * 1e5) / 1e5);
}

function sentences(text: string): string[] {
  // Lines first (titles and headings stand alone), then sentences within each.
  return text.split(/\n+/).flatMap((line) => line.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/))
    .map((s) => s.trim()).filter((s) => s.length >= 20 && s.length <= 1200);
}

export class LocalAiProvider implements AiProvider {
  readonly name = "local" as const;
  readonly model = "huis-local-1";

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(fingerprint);
  }

  async answer(question: string, passages: Passage[]): Promise<AiAnswer> {
    const q = new Set(terms(question));
    const scored: { n: number; s: string; score: number; order: number }[] = [];
    let order = 0;
    for (const p of passages) {
      for (const s of sentences(p.text)) {
        const t = terms(s);
        if (!t.length) continue;
        let hit = 0;
        const seen = new Set<string>();
        for (const w of t) if (q.has(w) && !seen.has(w)) { hit++; seen.add(w); }
        if (hit) scored.push({ n: p.n, s, score: hit / Math.sqrt(t.length), order: order++ });
      }
    }
    if (!scored.length) {
      return { text: "Huis didn't find passages in this Matter that match the question. Try other words, or check that the documents have finished being read.", cited: [] };
    }
    const top = scored.sort((a, b) => b.score - a.score || a.order - b.order).slice(0, 5);
    // A closing curly quote inside a sentence is written as a plain one, so each quote stays one quote.
    const lines = top.map((x) => `• “${x.s.replace(/”/g, '"')}” [${x.n}]`);
    return { text: `The most relevant passages in this Matter:\n\n${lines.join("\n")}`, cited: [...new Set(top.map((x) => x.n))] };
  }
}
