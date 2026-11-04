import { notFound } from "next/navigation";
import { createPromptAction, deletePromptAction, updatePromptAction } from "../../../lib/actions";
import { getFlash, withSession } from "../../../lib/server";
import { FlashBanner } from "../../../lib/ui";
import { AI_CATEGORIES, AI_CATEGORY_LABELS } from "../../../src/ai/prompts";
import { listPrompts, type Prompt } from "../../../src/services/workspace";
import { ADMIN_ROLES, INTERNAL_ROLES } from "../../../src/security/permissions";

export const dynamic = "force-dynamic";

function Editable({ p }: { p: Prompt }) {
  return (
    <details style={{ borderTop: "1px solid var(--border, #e5e7eb)", padding: "8px 0" }}>
      <summary><strong>{p.title}</strong> <span className="badge">{AI_CATEGORY_LABELS[p.category]}</span></summary>
      <form action={updatePromptAction} style={{ marginTop: 8 }}>
        <input type="hidden" name="promptId" value={p.id} />
        <div className="row">
          <label style={{ flex: 3 }}>Title<input name="title" maxLength={200} required defaultValue={p.title} /></label>
          <label style={{ flex: 1 }}>Category
            <select name="category" defaultValue={p.category}>{AI_CATEGORIES.map((c) => <option key={c} value={c}>{AI_CATEGORY_LABELS[c]}</option>)}</select>
          </label>
        </div>
        <label>Prompt<textarea name="body" rows={3} maxLength={2000} required defaultValue={p.body} /></label>
        <div style={{ marginTop: 8 }}><button type="submit">Save</button></div>
      </form>
      <form action={deletePromptAction} style={{ marginTop: 6 }}>
        <input type="hidden" name="promptId" value={p.id} /><button type="submit" className="secondary">Delete</button>
      </form>
    </details>
  );
}

function ReadOnly({ p }: { p: Prompt }) {
  return (
    <div style={{ borderTop: "1px solid var(--border, #e5e7eb)", padding: "8px 0" }}>
      <strong>{p.title}</strong> <span className="badge">{AI_CATEGORY_LABELS[p.category]}</span>
      <div className="notice">{p.body}</div>
    </div>
  );
}

export default async function PromptsPage({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const flash = await getFlash((await searchParams).f);
  const data = await withSession(async (s) => {
    if (!INTERNAL_ROLES.has(s.actor.role)) return null;
    return { prompts: await listPrompts(s), admin: ADMIN_ROLES.has(s.actor.role) };
  });
  if (!data) notFound();
  const by = (scope: Prompt["scope"]) => data.prompts.filter((p) => p.scope === scope);

  return (
    <>
      <h1>AI Prompts</h1>
      <p className="sub">
        Questions to start AI Workspace conversations from. Your own prompts are private to you; firm prompts are approved templates
        everyone at the firm can use; Huis&apos;s prompts are general starting points, not legal advice.
      </p>
      <FlashBanner flash={flash} />

      <div className="card">
        <h2>My prompts</h2>
        {by("personal").length === 0 ? <p className="notice">None yet.</p> : by("personal").map((p) => <Editable key={p.id} p={p} />)}
      </div>
      <div className="card">
        <h2>Firm prompts</h2>
        {by("firm").length === 0 ? <p className="notice">None yet.{data.admin ? "" : " Firm administrators add them."}</p>
          : by("firm").map((p) => (p.canEdit ? <Editable key={p.id} p={p} /> : <ReadOnly key={p.id} p={p} />))}
      </div>
      <div className="card">
        <h2>Huis prompts</h2>
        {by("huis").map((p) => <ReadOnly key={p.id} p={p} />)}
      </div>

      <div className="card">
        <h2>Add a prompt</h2>
        <form action={createPromptAction}>
          <div className="row">
            <label style={{ flex: 3 }}>Title<input name="title" maxLength={200} required /></label>
            <label style={{ flex: 1 }}>Category
              <select name="category" defaultValue="strategy">{AI_CATEGORIES.map((c) => <option key={c} value={c}>{AI_CATEGORY_LABELS[c]}</option>)}</select>
            </label>
            {data.admin ? (
              <label style={{ flex: 1 }}>For
                <select name="scope" defaultValue="personal"><option value="personal">Me</option><option value="firm">The whole firm</option></select>
              </label>
            ) : <input type="hidden" name="scope" value="personal" />}
          </div>
          <label>Prompt<textarea name="body" rows={3} maxLength={2000} required /></label>
          <div style={{ marginTop: 8 }}><button type="submit">Add</button></div>
          <p className="notice">Prompts are saved as written and shown to whoever they&apos;re for; don&apos;t put client details in a firm prompt.</p>
        </form>
      </div>
    </>
  );
}
