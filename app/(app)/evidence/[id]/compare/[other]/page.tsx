import Link from "next/link";
import { notFound } from "next/navigation";
import { withSession } from "../../../../../../lib/server";
import { formatBytes } from "../../../../../../lib/ui";
import { NotFoundError } from "../../../../../../src/errors";
import { compareEvidence } from "../../../../../../src/services/evidence";
import type { DiffLine } from "../../../../../../src/similarity/diff";

export const dynamic = "force-dynamic";

/** Collapses long unchanged stretches so the changes stand out. */
function collapse(lines: DiffLine[]): (DiffLine | { kind: "gap"; count: number })[] {
  const out: (DiffLine | { kind: "gap"; count: number })[] = [];
  const CONTEXT = 3;
  for (let i = 0; i < lines.length; ) {
    if (lines[i]!.kind !== "same") { out.push(lines[i]!); i += 1; continue; }
    let j = i;
    while (j < lines.length && lines[j]!.kind === "same") j += 1;
    const run = j - i;
    const keepStart = i === 0 ? 0 : CONTEXT;
    const keepEnd = j === lines.length ? 0 : CONTEXT;
    if (run > keepStart + keepEnd + 2) {
      for (let k = i; k < i + keepStart; k++) out.push(lines[k]!);
      out.push({ kind: "gap", count: run - keepStart - keepEnd });
      for (let k = j - keepEnd; k < j; k++) out.push(lines[k]!);
    } else {
      for (let k = i; k < j; k++) out.push(lines[k]!);
    }
    i = j;
  }
  return out;
}

export default async function Compare({ params }: { params: Promise<{ id: string; other: string }> }) {
  const { id, other } = await params;
  const data = await withSession(async (s) => {
    try { return await compareEvidence(s, id, other); } catch (err) { if (err instanceof NotFoundError) return null; throw err; }
  });
  if (!data) notFound();
  const { left, right, diff, tooLarge } = data;
  const changed = diff ? diff.filter((l) => l.kind !== "same").length : 0;

  return (
    <>
      <p className="notice"><Link href={`/evidence/${left.id}`}>← {left.originalFilename}</Link></p>
      <h1>Compare text</h1>
      <div className="grid">
        <div className="card">
          <h2 style={{ wordBreak: "break-word" }}><span className="badge" style={{ background: "#fdecec", color: "#8a1c1c" }}>−</span> <Link href={`/evidence/${left.id}`}>{left.originalFilename}</Link></h2>
          <p className="notice">{formatBytes(left.sizeBytes)} · {left.folderName}</p>
        </div>
        <div className="card">
          <h2 style={{ wordBreak: "break-word" }}><span className="badge" style={{ background: "#e9f7ee", color: "#14532d" }}>+</span> <Link href={`/evidence/${right.id}`}>{right.originalFilename}</Link></h2>
          <p className="notice">{formatBytes(right.sizeBytes)} · {right.folderName}</p>
        </div>
      </div>
      <div className="card">
        {!diff ? (
          <p className="notice">One of these files has no readable text yet (or hasn&apos;t passed its security scan), so it can&apos;t be compared.</p>
        ) : tooLarge ? (
          <p className="notice">These documents differ in too many places to show here. Download both originals to compare them in full.</p>
        ) : changed === 0 ? (
          <div className="flash success">The readable text of these two documents is identical (formatting or images may still differ).</div>
        ) : (
          <>
            <p className="notice">
              {changed.toLocaleString()} changed line(s). Lines only in the first document are struck through in red; lines only in the second are green.
              This compares the readable text — always confirm against the originals before relying on it.
            </p>
            <div className="diff">
              {collapse(diff).map((l, i) => l.kind === "gap"
                ? <div key={i} className="gap">… {l.count.toLocaleString()} unchanged line(s) …</div>
                : <div key={i} className={l.kind}>{l.text || " "}</div>)}
            </div>
          </>
        )}
      </div>
    </>
  );
}
