import { redirect } from "next/navigation";
import { createFirmAction } from "../../lib/actions";
import { getFlash, getPending } from "../../lib/server";
import { FlashBanner, StateSelect } from "../../lib/ui";

export const dynamic = "force-dynamic";

export default async function Onboarding({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const pending = await getPending();
  if (!pending) redirect("/signin?reason=expired");
  const flash = await getFlash((await searchParams).f);
  return (
    <main className="centered">
      <div className="panel" style={{ maxWidth: 560 }}>
        <h1>Set up your firm</h1>
        <p className="sub">
          Signed in as {pending.name}{pending.email ? ` (${pending.email})` : ""}. Your firm starts with a free 7-day trial.
          If you were invited to an existing firm, use the invitation link instead.
        </p>
        <FlashBanner flash={flash} />
        <form action={createFirmAction} className="stack">
          <label>Firm name<input name="firmName" required minLength={2} maxLength={200} placeholder="e.g. Smith & Rivera Law" /></label>
          <label>Your name (as it should appear on matters)<input name="ownerName" defaultValue={pending.name} required maxLength={200} /></label>
          <label>Main office name<input name="locationName" defaultValue="Main Office" maxLength={200} /></label>
          <label>State<StateSelect name="stateCode" /></label>
          <button type="submit">Create firm</button>
        </form>
      </div>
    </main>
  );
}
