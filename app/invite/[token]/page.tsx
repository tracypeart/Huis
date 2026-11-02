export const dynamic = "force-dynamic";

export default async function Invite({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const valid = /^[A-Za-z0-9_-]{43}$/.test(token);
  return (
    <main className="centered">
      <div className="panel">
        <h1>You&apos;ve been invited to Huis Law IP</h1>
        {valid ? (
          <>
            <p className="sub">
              Sign in with the Microsoft account you want to use for this firm. This link works once and links that
              account to your invitation.
            </p>
            <a className="button ms-button" href={`/api/auth/microsoft/start?invite=${token}`}>Accept and sign in with Microsoft</a>
          </>
        ) : (
          <div className="flash error">This invitation link is not valid. Ask your firm administrator for a new one.</div>
        )}
      </div>
    </main>
  );
}
