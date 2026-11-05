import Link from "next/link";
import { notFound } from "next/navigation";
import { integrationRefreshAction } from "../../../../../lib/actions";
import { withSession } from "../../../../../lib/server";
import { authConfig } from "../../../../../src/auth/config";
import { NotFoundError, PermissionDeniedError } from "../../../../../src/errors";
import { DRIVE_FILE_SCOPE } from "../../../../../src/integrations/google-drive";
import { getConnection } from "../../../../../src/services/integrations";
import { GooglePicker } from "./picker";

export const dynamic = "force-dynamic";

/**
 * Google's own file picker, for choosing which Google Drive files Huis may open (drive.file).
 * The picker runs in the person's browser, with a short-lived token Google gives that browser for
 * drive.file only; Huis's server never sees it. Afterwards the worker lists the chosen files.
 */
export default async function PickPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await withSession(async (s) => {
    try { return await getConnection(s, id); } catch (err) {
      if (err instanceof NotFoundError || err instanceof PermissionDeniedError) return null;
      throw err;
    }
  });
  if (!c || c.provider !== "google_drive") notFound();
  const cfg = authConfig();
  return (
    <>
      <p className="notice"><Link href={`/integrations/${c.id}`}>← Google Drive</Link></p>
      <h1>Choose files for Huis</h1>
      <p className="sub">{c.accountLabel ?? "Connected account"} · Huis can open only the files you choose here</p>
      {c.status === "needs_reconnect" ? (
        <div className="card"><p>This account needs reconnecting first. <a href="/api/integrations/google_drive/start">Reconnect</a></p></div>
      ) : !cfg.google || !cfg.googlePicker ? (
        <div className="card"><p>Google&apos;s file picker isn&apos;t set up for this firm yet (it needs a browser key and the Google Cloud project number).</p></div>
      ) : (
        <div className="card">
          <p>Google&apos;s file picker opens in a window from Google. Sign in with <strong>{c.accountLabel ?? "the account you connected"}</strong> if Google asks, and choose the files Huis may open. Nothing is copied yet: you&apos;ll tick which ones to import into a Matter next.</p>
          <GooglePicker clientId={cfg.google.clientId} apiKey={cfg.googlePicker.apiKey} appId={cfg.googlePicker.appId}
            scope={DRIVE_FILE_SCOPE} loginHint={c.accountLabel && c.accountLabel.includes("@") ? c.accountLabel : null} backTo={`/integrations/${c.id}`} />
          {/* After choosing, the worker lists the chosen files again. */}
          <form action={integrationRefreshAction} id="picked">
            <input type="hidden" name="connectionId" value={c.id} /><input type="hidden" name="at" value="root" />
          </form>
          <p className="notice">Google Docs, Sheets and Slides can&apos;t be imported yet: download them as a file (such as PDF or Word) first.</p>
        </div>
      )}
    </>
  );
}
