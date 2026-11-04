import Link from "next/link";
import { notFound } from "next/navigation";
import { askInConversationAction, deleteConversationAction, updateConversationAction } from "../../../../../../lib/actions";
import { getFlash, withSession } from "../../../../../../lib/server";
import { FlashBanner } from "../../../../../../lib/ui";
import { WORK_PRODUCT_LABEL } from "../../../../../../src/ai/gateway";
import { AI_CATEGORIES, AI_CATEGORY_LABELS } from "../../../../../../src/ai/prompts";
import { NotFoundError } from "../../../../../../src/errors";
import { getAiProviderSetting } from "../../../../../../src/services/brain";
import { getConversation, getPrompt, listPrompts, type ConversationView, type Prompt } from "../../../../../../src/services/workspace";
import { INTERNAL_ROLES } from "../../../../../../src/security/permissions";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROMPT_ID = /^(huis:[a-z0-9-]{1,60}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const when = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");
const SCOPE = { huis: "Huis", firm: "Firm", personal: "Mine" } as const;

export default async function ConversationPage({ params, searchParams }: {
  params: Promise<{ id: string; conversationId: string }>; searchParams: Promise<{ f?: string; prompt?: string }>;
}) {
  const { id, conversationId } = await params;
  if (!UUID.test(id) || !UUID.test(conversationId)) notFound();
  const sp = await searchParams;
  const flash = await getFlash(sp.f);
  const data = await withSession(async (s) => {
    if (!INTERNAL_ROLES.has(s.actor.role)) return null;
    let view: ConversationView;
    try { view = await getConversation(s, conversationId); } catch (e) { if (e instanceof NotFoundError) return null; throw e; }
    if (view.conversation.matterId !== id) return null;
    const prompt: Prompt | null = sp.prompt && PROMPT_ID.test(sp.prompt) ? await getPrompt(s, sp.prompt) : null;
    return { view, prompt, prompts: view.conversation.mine ? await listPrompts(s) : [], provider: await getAiProviderSetting(s) };
  });
  if (!data) notFound();
  const { conversation: c, answers, hidden } = data.view;
  const here = `/matters/${id}/workspace/${c.id}`;
  const hiddenFields = <><input type="hidden" name="matterId" value={id} /><input type="hidden" name="conversationId" value={c.id} /></>;

  return (
    <>
      <p className="notice"><Link href={`/matters/${id}/workspace`}>← AI Workspace</Link> · <Link href={`/matters/${id}/brain`}>Matter Brain</Link></p>
      <h1>{c.title}</h1>
      <p className="sub">
        <span className="badge">{AI_CATEGORY_LABELS[c.category]}</span>{" "}
        {c.mine ? (c.shared ? <span className="badge walled">Shared with the Matter team</span> : <span className="badge">Private to you</span>) : <>Shared by {c.ownerName}</>}
        <br /><span className="badge privileged">{WORK_PRODUCT_LABEL}</span>
      </p>
      <FlashBanner flash={flash} />

      {answers.length === 0 && hidden === 0 ? <div className="card"><p className="notice">No questions yet.</p></div> : null}
      {answers.map((a) => (
        <div className="card" key={a.id}>
          <h2 style={{ marginBottom: 4 }}>{a.question}</h2>
          <p className="notice" style={{ marginTop: 0 }}>{when(a.createdAt)}</p>
          <div className="doc-text" style={{ fontFamily: "inherit" }}>{a.answer}</div>
          {a.citations.length ? (
            <>
              <h3 style={{ marginTop: 12 }}>Sources</h3>
              <ol style={{ paddingLeft: 20 }}>
                {a.citations.map((x) => (
                  <li key={x.n} value={x.n} style={{ marginBottom: 6 }}>
                    {x.evidenceId ? <Link href={`/evidence/${x.evidenceId}`}>{x.sourceTitle}</Link> : <span>Note: {x.sourceTitle}</span>}
                    <div className="notice">“{x.excerpt.length >= 400 ? `${x.excerpt}…` : x.excerpt}”</div>
                  </li>
                ))}
              </ol>
            </>
          ) : null}
        </div>
      ))}
      {hidden ? (
        <div className="card"><p className="notice">
          {hidden} {hidden === 1 ? "answer isn't" : "answers aren't"} shown: {hidden === 1 ? "it draws" : "they draw"} on a source that is no longer available to you
          (for example, a document later found infected).
        </p></div>
      ) : null}

      {c.mine ? (
        data.provider === "off" ? <div className="card"><p className="notice">AI features are turned off for your firm.</p></div> : (
          <div className="card">
            <h2>Ask</h2>
            <form method="get" action={here} className="row" style={{ marginBottom: 8 }}>
              <label style={{ flex: 1 }}>Start from a prompt
                <select name="prompt" defaultValue={data.prompt?.id ?? ""}>
                  <option value="">Choose…</option>
                  {(["personal", "firm", "huis"] as const).map((scope) => {
                    const list = data.prompts.filter((p) => p.scope === scope);
                    return list.length ? (
                      <optgroup key={scope} label={`${SCOPE[scope]} prompts`}>
                        {list.map((p) => <option key={p.id} value={p.id}>{p.title} ({AI_CATEGORY_LABELS[p.category]})</option>)}
                      </optgroup>
                    ) : null;
                  })}
                </select>
              </label>
              <button type="submit" className="secondary">Use</button>
            </form>
            <form action={askInConversationAction}>
              {hiddenFields}
              <label>Question
                <textarea key={data.prompt?.id ?? "none"} name="question" rows={3} maxLength={2000} required defaultValue={data.prompt?.body ?? ""} />
              </label>
              <div style={{ marginTop: 8 }}><button type="submit">Ask</button></div>
            </form>
            <p className="notice" style={{ marginTop: 8 }}>
              Answers come only from this Matter, and only from what you can open yourself.
              {data.provider === "local" ? " Huis's built-in AI runs inside Huis and sends nothing outside: it shows the most relevant passages with their sources, not written conclusions." : ""}
            </p>
          </div>
        )
      ) : null}

      {c.mine ? (
        <div className="card">
          <h2>Settings</h2>
          <form action={updateConversationAction}>
            {hiddenFields}
            <div className="row">
              <label style={{ flex: 3 }}>Title<input name="title" maxLength={200} required defaultValue={c.title} /></label>
              <label style={{ flex: 1 }}>Category
                <select name="category" defaultValue={c.category}>
                  {AI_CATEGORIES.map((k) => <option key={k} value={k}>{AI_CATEGORY_LABELS[k]}</option>)}
                </select>
              </label>
            </div>
            <label style={{ display: "flex", gap: 8, fontWeight: 400, marginTop: 8 }}>
              <input type="checkbox" name="shared" defaultChecked={c.shared} />
              Share with the firm staff on this Matter (they can read it, not change it; each answer is shown only to people who can open all its sources)
            </label>
            <div style={{ marginTop: 8 }}><button type="submit">Save</button></div>
          </form>
          <form action={deleteConversationAction} style={{ marginTop: 12 }}>
            {hiddenFields}
            <button type="submit" className="secondary">Delete this conversation</button>
          </form>
        </div>
      ) : null}
    </>
  );
}
