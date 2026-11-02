import Link from "next/link";
import { notFound } from "next/navigation";
import { withSession } from "../../../../../lib/server";
import { NotFoundError } from "../../../../../src/errors";
import { INTERNAL_ROLES } from "../../../../../src/security/permissions";
import { viewablePdf } from "../../../../../src/services/workingCopies";
import { Viewer } from "./viewer";

export const dynamic = "force-dynamic";

export default async function ViewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await withSession(async (s) => {
    let v;
    try { v = await viewablePdf(s, id); } catch (err) { if (err instanceof NotFoundError) return null; throw err; }
    const staff = INTERNAL_ROLES.has(s.actor.role);
    return { v, staff, canMark: staff && s.actor.role !== "read_only" };
  });
  if (!data) notFound();
  const { v } = data;
  if (!v) {
    return (
      <>
        <p className="notice"><Link href={`/evidence/${id}`}>← Back to the document</Link></p>
        <div className="card"><p>This document can&apos;t be shown as pages (it may still be in its security scan, or be a type Huis can&apos;t display). You can download the original from its page.</p></div>
      </>
    );
  }
  return (
    <>
      <p className="notice"><Link href={`/evidence/${id}`}>← {v.item.originalFilename}</Link></p>
      <h1 style={{ wordBreak: "break-word" }}>{v.item.originalFilename}</h1>
      <p className="sub">
        {v.isViewingCopy ? "Shown from a PDF viewing copy made by Huis — the original is unchanged. " : ""}
        Opening this document is recorded in its chain of custody.
      </p>
      <Viewer evidenceId={id} staff={data.staff} canMark={data.canMark} />
    </>
  );
}
