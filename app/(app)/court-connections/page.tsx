import { notFound } from "next/navigation";
import { noticeSenderAddAction, noticeSenderRemoveAction } from "../../../lib/actions";
import { getFlash, withSession } from "../../../lib/server";
import { FlashBanner } from "../../../lib/ui";
import { DATA_VENDORS, NOTICE_READERS } from "../../../src/court/connectors";
import { listNoticeSenders } from "../../../src/services/court";
import { ADMIN_ROLES, INTERNAL_ROLES } from "../../../src/security/permissions";

export const dynamic = "force-dynamic";

export default async function CourtConnectionsPage({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const flash = await getFlash((await searchParams).f);
  const data = await withSession(async (s) => {
    if (!INTERNAL_ROLES.has(s.actor.role)) return null;
    return { senders: await listNoticeSenders(s), admin: ADMIN_ROLES.has(s.actor.role) };
  });
  if (!data) notFound();

  return (
    <>
      <h1>Court connections</h1>
      <p className="sub">
        How Huis learns about court dates. Everything it finds is only a proposal: an attorney confirms each court date before it counts.
        No scraping, and never anyone&apos;s e-filing password.
      </p>
      <FlashBanner flash={flash} />

      <div className="card">
        <h2>Court notices from email</h2>
        <table><tbody>
          {NOTICE_READERS.map((r) => (
            <tr key={r.id}>
              <td><strong>{r.name}</strong><div className="notice">{r.jurisdiction}</div></td>
              <td style={{ width: 260 }}>
                {r.verified ? <span className="badge">Active</span> : <span className="badge walled">Active — format not yet verified</span>}
              </td>
            </tr>
          ))}
        </tbody></table>
        <p className="notice">
          Federal notices are read from CM/ECF email (uscourts.gov). Utah notices come through your firm&apos;s e-filing service provider, in that
          provider&apos;s own format: Huis reads email from a Utah courts address (utcourts.gov) and from the provider address registered below. The
          Utah reader is marked &ldquo;not yet verified&rdquo; until it has been checked against real (redacted) Utah notices; its proposals say so.
        </p>
      </div>

      <div className="card">
        <h2>Your e-filing provider&apos;s notice address</h2>
        {data.senders.length === 0 ? <p className="notice">None registered yet.</p> : (
          <table><tbody>
            {data.senders.map((v) => (
              <tr key={v.id}>
                <td><strong>{v.label}</strong><div className="notice">{v.address}</div></td>
                <td style={{ width: 1 }}>
                  {data.admin ? (
                    <form action={noticeSenderRemoveAction}><input type="hidden" name="senderId" value={v.id} /><button type="submit" className="secondary">Remove</button></form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody></table>
        )}
        {data.admin ? (
          <form action={noticeSenderAddAction} className="row" style={{ alignItems: "flex-end", flexWrap: "wrap", marginTop: 10 }}>
            <label style={{ flex: 2 }}>Address your provider sends court notices from<input type="email" name="address" required maxLength={320} placeholder="notifications@your-efiling-provider.example" /></label>
            <label style={{ flex: 1 }}>Name<input name="label" required maxLength={100} placeholder="e.g. Our e-filing provider" /></label>
            <button type="submit">Register</button>
          </form>
        ) : <p className="notice">Your firm&apos;s administrators register this address.</p>}
        <p className="notice">Only register the provider&apos;s own notification address. Anyone who can send from it could propose court dates (which still need an attorney to confirm them).</p>
      </div>

      <div className="card">
        <h2>Court data services</h2>
        <p className="notice">Licensed services that can add dockets and hearing dates directly. Each needs a commercial agreement before it&apos;s connected.</p>
        <table><tbody>
          {DATA_VENDORS.map((v) => (
            <tr key={v.id}>
              <td><strong>{v.name}</strong><div className="notice">{v.covers}</div></td>
              <td style={{ width: 200 }}><span className="badge walled">Needs an agreement</span></td>
            </tr>
          ))}
        </tbody></table>
      </div>
    </>
  );
}
