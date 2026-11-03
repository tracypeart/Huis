import Link from "next/link";
import { getSession } from "../../lib/server";
import { authConfig } from "../../src/auth/config";

export const dynamic = "force-dynamic";

const REASONS: Record<string, string> = {
  cancelled: "Sign-in was cancelled.",
  invalid: "That sign-in attempt expired or was invalid. Please try again.",
  failed: "We couldn't complete sign-in with Microsoft. Please try again.",
  expired: "Your session ended. Please sign in again.",
  invite: "That invitation link is invalid, already used or expired. Ask your firm administrator for a new one.",
  signedout: "You have signed out.",
};

export default async function SignIn({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const { reason } = await searchParams;
  const microsoftReady = Boolean(authConfig().microsoft);
  // Already signed in: offer the way back (a link, not an automatic redirect, so an ended session can't loop).
  const signedIn = !reason && Boolean(await getSession());
  return (
    <main className="centered">
      <div className="panel">
        <h1>Huis Law IP</h1>
        <p className="sub">Your entire case. Connected. Organized. Intelligent.</p>
        {reason && REASONS[reason] ? <div className={`flash ${reason === "signedout" ? "success" : "error"}`}>{REASONS[reason]}</div> : null}
        {signedIn ? <div className="flash success">You&apos;re already signed in. <Link href="/dashboard">Go to your dashboard</Link></div> : null}
        {microsoftReady ? (
          <a className="button ms-button" href="/api/auth/microsoft/start">
            <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true">
              <rect x="1" y="1" width="9" height="9" fill="#f25022" /><rect x="11" y="1" width="9" height="9" fill="#7fba00" />
              <rect x="1" y="11" width="9" height="9" fill="#00a4ef" /><rect x="11" y="11" width="9" height="9" fill="#ffb900" />
            </svg>
            Sign in with Microsoft
          </a>
        ) : (
          <div className="flash error">Microsoft sign-in is not configured on this server yet.</div>
        )}
        <p className="notice" style={{ marginTop: 16 }}>Google sign-in is coming soon.</p>
        <p className="notice" style={{ marginTop: 24 }}>
          Huis Law IP stores attorney-client privileged information. Access is limited to authorized users and every
          action is recorded in your firm&apos;s audit log.
        </p>
      </div>
    </main>
  );
}
