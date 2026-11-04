import Link from "next/link";
import { notFound } from "next/navigation";
import { createConversationAction } from "../../../../../lib/actions";
import { getFlash, withSession } from "../../../../../lib/server";
import { FlashBanner } from "../../../../../lib/ui";
import { WORK_PRODUCT_LABEL } from "../../../../../src/ai/gateway";
import { AI_CATEGORIES, AI_CATEGORY_LABELS, type AiCategory } from "../../../../../src/ai/prompts";
import { NotFoundError } from "../../../../../src/errors";
import { getAiProviderSetting } from "../../../../../src/services/brain";
import { getMatter } from "../../../../../src/services/matters";
import { listConversations } from "../../../../../src/services/workspace";
import { INTERNAL_ROLES } from "../../../../../src/security/permissions";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const when = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

export default async function WorkspacePage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ f?: string; category?: string }>;
}) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const sp = await searchParams;
  const flash = await getFlash(sp.f);
  const category = (AI_CATEGORIES as readonly string[]).includes(sp.category ?? "") ? (sp.category as AiCategory) : undefined;
  const data = await withSession(async (s) => {
    if (!INTERNAL_ROLES.has(s.actor.role)) return null;
    let matter;
    try { matter = await getMatter(s, id); } catch (e) { if (e instanceof NotFoundError) return null; throw e; }
    return { matter, conversations: await listConversations(s, id, category), provider: await getAiProviderSetting(s) };
  });
  if (!data) notFound();
  const { matter: m } = data;
  const base = `/matters/${m.id}/workspace`;
  const mine = data.conversations.filter((c) => c.mine);
  const shared = data.conversations.filter((c) => !c.mine);
  const List = ({ list, empty }: { list: typeof mine; empty: string }) => list.length === 0 ? <p className="notice">{empty}</p> : (
    <table><tbody>
      {list.map((c) => (
        <tr key={c.id}>
          <td><Link href={`${base}/${c.id}`}>{c.title}</Link>{c.mine ? null : <div className="notice">by {c.ownerName}</div>}</td>
          <td style={{ width: 140 }}><span className="badge">{AI_CATEGORY_LABELS[c.category]}</span>{c.mine && c.shared ? <> <span className="badge walled">Shared</span></> : null}</td>
          <td style={{ width: 160 }} className="notice">{c.answers} {c.answers === 1 ? "answer" : "answers"} · {when(c.updatedAt)}</td>
        </tr>
      ))}
    </tbody></table>
  );

  return (
    <>
      <p className="notice">
        <Link href={`/matters/${m.id}`}>← {m.title}</Link> · <Link href={`/matters/${m.id}/brain`}>Matter Brain</Link> · <Link href="/prompts">AI Prompts</Link>
      </p>
      <h1>AI Workspace</h1>
      <p className="sub">
        Saved conversations with this Matter: each a series of questions answered from the Matter&apos;s own documents, email and notes, with their sources.
        Private to you unless you share one with the firm staff on this Matter.<br /><span className="badge privileged">{WORK_PRODUCT_LABEL}</span>
      </p>
      <FlashBanner flash={flash} />

      <div className="card">
        <nav aria-label="Categories" className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          <Link href={base} className={`badge${category ? "" : " privileged"}`}>All</Link>
          {AI_CATEGORIES.map((c) => <Link key={c} href={`${base}?category=${c}`} className={`badge${category === c ? " privileged" : ""}`}>{AI_CATEGORY_LABELS[c]}</Link>)}
        </nav>
        <h2 style={{ marginTop: 12 }}>My conversations</h2>
        <List list={mine} empty={category ? "None in this category." : "None yet. Start one below."} />
        <h2 style={{ marginTop: 16 }}>Shared with the Matter team</h2>
        <List list={shared} empty="None. Conversations colleagues share with this Matter's team appear here." />
      </div>

      {data.provider === "off" ? (
        <div className="card"><p className="notice">AI features are turned off for your firm; an administrator can turn them on from the Matter Brain.</p></div>
      ) : (
        <div className="card">
          <h2>Start a conversation</h2>
          <form action={createConversationAction}>
            <input type="hidden" name="matterId" value={m.id} />
            <div className="row">
              <label style={{ flex: 3 }}>Title<input name="title" maxLength={200} required placeholder="e.g. Notice of FMLA leave" /></label>
              <label style={{ flex: 1 }}>Category
                <select name="category" defaultValue={category ?? "strategy"}>
                  {AI_CATEGORIES.map((c) => <option key={c} value={c}>{AI_CATEGORY_LABELS[c]}</option>)}
                </select>
              </label>
            </div>
            <div style={{ marginTop: 8 }}><button type="submit">Start</button></div>
          </form>
        </div>
      )}
    </>
  );
}
