import Link from "next/link";
import { notFound } from "next/navigation";
import { addNoteAction, aiProviderAction, askMatterAction, deleteAnswerAction, deleteNoteAction } from "../../../../../lib/actions";
import { getFlash, withSession } from "../../../../../lib/server";
import { FlashBanner } from "../../../../../lib/ui";
import { WORK_PRODUCT_LABEL } from "../../../../../src/ai/gateway";
import { NotFoundError, PermissionDeniedError } from "../../../../../src/errors";
import { brainStatus, getAiProviderSetting, getAnswer, listMyQuestions, listNotes, type BrainAnswer } from "../../../../../src/services/brain";
import { getMatter } from "../../../../../src/services/matters";
import { can, INTERNAL_ROLES } from "../../../../../src/security/permissions";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const when = (d: Date) => new Date(d).toLocaleString("en-US", { timeZone: "America/Denver", dateStyle: "medium", timeStyle: "short" });

export default async function MatterBrainPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ a?: string; f?: string }>;
}) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const sp = await searchParams;
  const flash = await getFlash(sp.f);
  const data = await withSession(async (s) => {
    if (!INTERNAL_ROLES.has(s.actor.role)) return null;
    let matter;
    try { matter = await getMatter(s, id); } catch (e) { if (e instanceof NotFoundError) return null; throw e; }
    let answer: BrainAnswer | null = null;
    if (sp.a && UUID.test(sp.a)) {
      try { answer = await getAnswer(s, sp.a); } catch (e) { if (!(e instanceof NotFoundError) && !(e instanceof PermissionDeniedError)) throw e; }
      if (answer && answer.matterId !== id) answer = null;
    }
    return {
      matter, answer,
      status: await brainStatus(s, id),
      notes: await listNotes(s, id),
      questions: await listMyQuestions(s, id),
      provider: await getAiProviderSetting(s),
      isAdmin: can(s.actor.role, "firm.manage"),
      canWrite: s.actor.role !== "read_only",
    };
  });
  if (!data) notFound();
  const { matter: m, status: st } = data;

  return (
    <>
      <p className="notice"><Link href={`/matters/${m.id}`}>← {m.title}</Link></p>
      <h1>Matter Brain</h1>
      <p className="sub">
        Everything readable in this Matter — documents, filed email, transcripts and attorney notes — in one place you can ask.
        <br /><span className="badge privileged">{WORK_PRODUCT_LABEL}</span>
      </p>
      <FlashBanner flash={flash} />

      <div className="card">
        <h2>Ask this Matter</h2>
        {data.provider === "off" ? (
          <p className="notice">AI features are turned off for your firm{data.isAdmin ? " (you can turn them on below)" : "; an administrator can turn them on"}.</p>
        ) : (
          <form action={askMatterAction}>
            <input type="hidden" name="matterId" value={m.id} />
            <label>Question
              <textarea name="question" rows={2} maxLength={2000} required placeholder="e.g. When was she terminated, and what happened just before?" />
            </label>
            <div style={{ marginTop: 8 }}><button type="submit">Ask</button></div>
          </form>
        )}
        <p className="notice" style={{ marginTop: 8 }}>
          Answers come only from this Matter, and only from what you can open yourself. They are private to you.
          {data.provider === "local"
            ? " Huis is using its built-in AI, which runs inside Huis and sends nothing to any outside service: it shows the most relevant passages, each with its source, rather than written conclusions."
            : ""}
        </p>
      </div>

      {data.answer ? (
        <div className="card">
          <h2>{data.answer.question}</h2>
          <p className="notice">{when(data.answer.createdAt)} · <span className="badge privileged">{WORK_PRODUCT_LABEL}</span></p>
          {data.answer.withheld ? (
            <p>One of the sources for this answer is no longer available to you, so the answer is withheld.</p>
          ) : (
            <>
              <div className="doc-text" style={{ fontFamily: "inherit" }}>{data.answer.answer}</div>
              {data.answer.citations.length ? (
                <>
                  <h3 style={{ marginTop: 16 }}>Sources</h3>
                  <ol style={{ paddingLeft: 20 }}>
                    {data.answer.citations.map((c) => (
                      <li key={c.n} value={c.n} style={{ marginBottom: 8 }}>
                        {c.evidenceId ? <Link href={`/evidence/${c.evidenceId}`}>{c.sourceTitle}</Link> : <span>Note: {c.sourceTitle}</span>}
                        <div className="notice">“{c.excerpt.length >= 400 ? `${c.excerpt}…` : c.excerpt}”</div>
                      </li>
                    ))}
                  </ol>
                </>
              ) : null}
            </>
          )}
          <form action={deleteAnswerAction}>
            <input type="hidden" name="matterId" value={m.id} /><input type="hidden" name="answerId" value={data.answer.id} />
            <button type="submit" className="secondary">Remove from my questions</button>
          </form>
        </div>
      ) : null}

      <div className="grid">
        <div className="card">
          <h2>What the Brain holds</h2>
          <table><tbody>
            <tr><th>Documents</th><td>{st.documentsReady} of {st.documents} ready{st.waiting ? ` · ${st.waiting} being added` : ""}{st.failed ? ` · ${st.failed} couldn't be added` : ""}</td></tr>
            <tr><th>Attorney notes</th><td>{st.notes}</td></tr>
            <tr><th>Passages</th><td>{st.passages.toLocaleString()}</td></tr>
          </tbody></table>
          <p className="notice">Documents join once they have been virus-scanned and read. Exact duplicates are left out.</p>
          {data.isAdmin ? (
            <form action={aiProviderAction} className="row" style={{ marginTop: 8 }}>
              <input type="hidden" name="matterId" value={m.id} />
              <label style={{ flex: 1 }}>AI for your firm
                <select name="provider" defaultValue={data.provider}>
                  <option value="local">Built-in (runs inside Huis; nothing sent outside)</option>
                  <option value="off">Off</option>
                </select>
              </label>
              <button type="submit" className="secondary">Save</button>
            </form>
          ) : null}
        </div>

        <div className="card">
          <h2>My questions</h2>
          {data.questions.length === 0 ? <p className="notice">Questions you ask appear here. Only you can see them.</p> : (
            <ul style={{ paddingLeft: 18 }}>
              {data.questions.map((q) => (
                <li key={q.id}><Link href={`/matters/${m.id}/brain?a=${q.id}`}>{q.question}</Link> <span className="notice">{when(q.createdAt)}</span></li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="card">
        <h2>Attorney notes</h2>
        <p className="notice">Work product, visible to firm staff on this Matter only — never to clients or other outside users. Notes are part of the Matter Brain.</p>
        {data.canWrite ? (
          <form action={addNoteAction} style={{ marginBottom: 16 }}>
            <input type="hidden" name="matterId" value={m.id} />
            <label>Title<input name="title" maxLength={300} required /></label>
            <label>Note<textarea name="body" rows={4} maxLength={200000} required /></label>
            <div style={{ marginTop: 8 }}><button type="submit">Save note</button></div>
          </form>
        ) : null}
        {data.notes.length === 0 ? <p className="notice">No notes yet.</p> : data.notes.map((n) => (
          <div key={n.id} style={{ borderTop: "1px solid var(--border, #e5e7eb)", padding: "10px 0" }}>
            <strong>{n.title}</strong> <span className="notice">{n.authorName} · {when(n.updatedAt)}</span>
            <div className="doc-text" style={{ fontFamily: "inherit", marginTop: 6 }}>{n.body}</div>
            {n.mine ? (
              <form action={deleteNoteAction} style={{ marginTop: 6 }}>
                <input type="hidden" name="matterId" value={m.id} /><input type="hidden" name="noteId" value={n.id} />
                <button type="submit" className="secondary">Delete</button>
              </form>
            ) : null}
          </div>
        ))}
      </div>
    </>
  );
}
