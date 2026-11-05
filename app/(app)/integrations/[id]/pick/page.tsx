import Link from "next/link";
import { notFound } from "next/navigation";
import { authConfig } from "../../../../../src/auth/config";
import { NotFoundError, PermissionDeniedError } from "../../../../../src/errors";
import { getConnection, PICKER_PROVIDERS } from "../../../../../src/services/integrations";
import { withSession } from "../../../../../lib/server";
import { GooglePicker } from "./picker";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@<>"]{1,200}@[^\s@<>"]{1,120}$/;

/**
 * Choosing files from Google Drive with Google's own picker. Only this page loads Google's scripts
 * (its security policy allows them; every other page's doesn't).
 */
export default async function PickPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ matter?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const c = await withSession(async (s) => {
    if (s.actor.role === "read_only") return null;
    try { return await getConnection(s, id); } catch (err) {
      if (err instanceof NotFoundError || err instanceof PermissionDeniedError) return null;
      throw err;
    }
  });
  if (!c || !PICKER_PROVIDERS.has(c.provider)) notFound();
  const cfg = authConfig();
  const matterId = sp.matter && UUID.test(sp.matter) ? sp.matter : null;
  const back = `/integrations/${c.id}${matterId ? `?matter=${matterId}` : ""}`;

  return (
    <>
      <p className="notice"><Link href={back}>← Google Drive</Link></p>
      <h1>Choose files from Google Drive</h1>
      <p className="sub">{c.accountLabel ?? "Connected account"} · Huis can open only the files you choose here</p>
      <div className="card">
        {c.status !== "active" ? (
          <p>This account needs reconnecting first. <a href="/api/integrations/google_drive/start">Reconnect</a></p>
        ) : !cfg.google || !cfg.googlePicker ? (
          <p className="notice">Google&apos;s file picker isn&apos;t set up for this firm yet (it needs the Picker API key and Google Cloud project number).</p>
        ) : (
          <>
            <p>
              Google&apos;s picker opens in a window from Google. Sign in as <strong>{c.accountLabel ?? "the connected account"}</strong> if asked, then tick
              the files to bring into Huis (up to 200). Huis then checks each one with your connected sign-in; nothing is copied until you import.
            </p>
            <GooglePicker connectionId={c.id} matterId={matterId} clientId={cfg.google.clientId} apiKey={cfg.googlePicker.apiKey}
              appId={cfg.googlePicker.appId} hint={c.accountLabel && EMAIL.test(c.accountLabel) ? c.accountLabel : null} origin={cfg.baseUrl} />
            <p className="notice" style={{ marginTop: 12 }}>
              The picker uses a short-lived Google permission that stays in this browser and covers only the files you choose. Huis&apos;s servers never receive it.
            </p>
          </>
        )}
      </div>
    </>
  );
}
