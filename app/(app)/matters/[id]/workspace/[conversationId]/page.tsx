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
import { AGENTS, AGENT_LABELS } from "../../../../../../src/ai/router";
import { agentTurns, type AgentResult, type AgentTurn } from "../../../../../../src/services/agents";
import { CATEGORY_LABELS } from "../../../../../../src/timeline/categories";
import type { BrainAnswer } from "../../../../../../src/services/brain";

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
    return {
      view, prompt, turns: await agentTurns(s, conversationId),
      prompts: view.conversation.mine ? await listPrompts(s) : [], provider: await getAiProviderSetting(s),
    };
  });
  if (!data) notFound();
  const { conversation: c, answers, hidden } = data.view;
  // Matter Brain answers and agent turns, in the order they were asked.
  const items: ({ at: Date; answer: BrainAnswer } | { at: Date; turn: AgentTurn })[] = [
    ...answers.map((answer) => ({ at: answer.createdAt, answer })), ...data.turns.map((turn) => ({ at: turn.createdAt, turn })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
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

      {items.length === 0 && hidden === 0 ? <div className="card"><p className="notice">No questions yet.</p></div> : null}
      {items.map((it) => ("answer" in it ? (
        <div className="card" key={it.answer.id}>
          <h2 style={{ marginBottom: 4 }}>{it.answer.question}</h2>
          <p className="notice" style={{ marginTop: 0 }}>{when(it.answer.createdAt)} · <span className="badge">{AGENT_LABELS.matter}</span></p>
          <div className="doc-text" style={{ fontFamily: "inherit" }}>{it.answer.answer}</div>
          {it.answer.citations.length ? (
            <>
              <h3 style={{ marginTop: 12 }}>Sources</h3>
              <ol style={{ paddingLeft: 20 }}>
                {it.answer.citations.map((x) => (
                  <li key={x.n} value={x.n} style={{ marginBottom: 6 }}>
                    {x.evidenceId ? <Link href={`/evidence/${x.evidenceId}`}>{x.sourceTitle}</Link> : <span>Note: {x.sourceTitle}</span>}
                    <div className="notice">“{x.excerpt.length >= 400 ? `${x.excerpt}…` : x.excerpt}”</div>
                  </li>
                ))}
              </ol>
            </>
          ) : null}
        </div>
      ) : (
        <div className="card" key={it.turn.id}>
          <h2 style={{ marginBottom: 4 }}>{it.turn.question}</h2>
          <p className="notice" style={{ marginTop: 0 }}>{when(it.turn.createdAt)} · <span className="badge">{AGENT_LABELS[it.turn.agent]}</span></p>
          <p className="notice">{it.turn.why} Worked out now, from what you can open.</p>
          <AgentAnswer matterId={id} result={it.turn.result} />
        </div>
      )))}
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
              <label>Answered by
                <select name="agent" defaultValue="auto">
                  <option value="auto">Automatic (Huis picks the agent and says why)</option>
                  {AGENTS.map((a) => <option key={a} value={a}>{AGENT_LABELS[a]}</option>)}
                </select>
              </label>
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

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** One agent's answer, as worked out for the person reading. */
function AgentAnswer({ matterId, result: r }: { matterId: string; result: AgentResult }) {
  const notes = r.notes.length ? <>{r.notes.map((n) => <p key={n} className="notice">{n}</p>)}</> : null;
  if (r.kind === "timeline" || r.kind === "email") {
    return (
      <>
        {notes}
        {r.entries.length === 0 ? <p className="notice">Nothing matches.</p> : (
          <table><tbody>
            {r.entries.map((e) => (
              <tr key={e.key}>
                <td style={{ whiteSpace: "nowrap", width: 100 }}>{e.date}</td>
                <td>
                  {e.status === "suggested" ? <><span className="badge walled">Suggested by Huis</span>{" "}</> : null}
                  {e.nodeId ? <Link href={`/matters/${matterId}/dna/${e.nodeId}`}>{e.label}</Link> : <Link href={`/evidence/${e.evidenceId}`}>{e.label}</Link>}
                  {e.kind === "email" && e.from ? <div className="notice">From {e.from}</div> : null}
                  {e.sources.slice(0, 2).map((c) => (
                    <div key={c.id} className="notice">
                      {c.evidenceId ? <Link href={`/evidence/${c.evidenceId}`}>{c.sourceTitle}</Link> : <>Note: {c.sourceTitle}</>} — “{c.quote.slice(0, 200)}{c.quote.length > 200 ? "…" : ""}”
                    </div>
                  ))}
                  {e.categories.length ? <div className="notice">{e.categories.map((k) => CATEGORY_LABELS[k]).join(", ")}</div> : null}
                </td>
              </tr>
            ))}
          </tbody></table>
        )}
        {r.total > r.entries.length ? <p className="notice">Showing {r.entries.length} of {r.total}. <Link href={`/matters/${matterId}/timeline`}>Open the timeline</Link> for all of them.</p> : null}
      </>
    );
  }
  if (r.kind === "evidence") {
    return (
      <>
        {notes}
        {r.element ? <p>Passages that may prove or disprove <Link href={`/matters/${matterId}/dna/${r.element.id}`}>{r.element.label}</Link>:</p> : null}
        {r.passages.length === 0 ? (r.element ? <p className="notice">Nothing found.</p> : null) : (
          <ol style={{ paddingLeft: 20 }}>
            {r.passages.map((p) => (
              <li key={p.chunkId} style={{ marginBottom: 6 }}>
                {p.evidenceId ? <Link href={`/evidence/${p.evidenceId}`}>{p.sourceTitle}</Link> : <>Note: {p.sourceTitle}</>}
                <div className="notice">“{p.content.slice(0, 400)}{p.content.length > 400 ? "…" : ""}”</div>
              </li>
            ))}
          </ol>
        )}
        {r.element ? <p className="notice">Add one as a supporting or contradicting fact from the claim in Case DNA.</p> : null}
      </>
    );
  }
  if (r.kind === "contradictions") {
    return (
      <>
        {notes}
        <p>{plural(r.potentialCount, "potential contradiction")} to decide · {r.confirmed} confirmed · {r.rejected} rejected.</p>
        {r.potential.length ? (
          <ul style={{ paddingLeft: 18 }}>
            {r.potential.map((f, i) => (
              <li key={i} style={{ marginBottom: 6 }}>“{f.quote}” <span className="notice">({f.sourceTitle}) · {f.confidence} confidence · {f.why}</span></li>
            ))}
          </ul>
        ) : null}
        <p className="notice"><Link href={`/matters/${matterId}/contradictions`}>Open Contradictions</Link> to see the evidence and decide.</p>
      </>
    );
  }
  if (r.kind !== "privilege") return null;
  return (
    <>
      {notes}
      {r.items.length === 0 ? <p className="notice">No documents are filed as privileged or work product in this Matter.</p> : (
        <ul style={{ paddingLeft: 18 }}>
          {r.items.map((i) => (
            <li key={i.id}>
              <Link href={`/evidence/${i.id}`}>{i.title}</Link>{" "}
              <span className="notice">{i.folder}{i.privilegedArea ? " (privileged area)" : ""} · {i.classification.replace(/_/g, " ")}</span>
            </li>
          ))}
        </ul>
      )}
      {r.total > r.items.length ? <p className="notice">Showing {r.items.length} of {r.total}.</p> : null}
    </>
  );
}
