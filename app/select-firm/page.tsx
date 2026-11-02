import { redirect } from "next/navigation";
import { chooseFirmAction } from "../../lib/actions";
import { db, getPending } from "../../lib/server";
import { ROLE_LABELS } from "../../lib/ui";
import { resolveIdentity } from "../../src/services/firms";

export const dynamic = "force-dynamic";

export default async function SelectFirm() {
  const pending = await getPending();
  if (!pending) redirect("/signin?reason=expired");
  const accounts = await resolveIdentity(db(), pending.provider, pending.subject);
  return (
    <main className="centered">
      <div className="panel">
        <h1>Choose a firm</h1>
        <p className="sub">You have licenses at more than one firm. Each firm&apos;s information is kept completely separate.</p>
        {accounts.map((a) => (
          <form key={a.userId} action={chooseFirmAction} style={{ marginBottom: 8 }}>
            <input type="hidden" name="userId" value={a.userId} />
            <button type="submit" className="secondary" style={{ width: "100%", textAlign: "left" }}>
              <strong>{a.firmName}</strong> <span className="notice">— {ROLE_LABELS[a.role]}</span>
            </button>
          </form>
        ))}
      </div>
    </main>
  );
}
