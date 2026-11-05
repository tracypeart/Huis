import Link from "next/link";
import { notFound } from "next/navigation";
import { integrationDisconnectAction } from "../../../lib/actions";
import { getFlash, withSession } from "../../../lib/server";
import { FlashBanner } from "../../../lib/ui";
import { integrationHub } from "../../../src/services/integrations";
import { INTERNAL_ROLES } from "../../../src/security/permissions";

export const dynamic = "force-dynamic";

const STATUS = { available: "Available", coming_next: "Coming next", needs_agreement: "Needs an agreement" } as const;
const KIND = { file_storage: "File storage", case_management: "Case management", legal_ai: "Legal AI" } as const;

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const flash = await getFlash((await searchParams).f);
  const data = await withSession(async (s) => {
    if (!INTERNAL_ROLES.has(s.actor.role)) return null;
    return { hub: await integrationHub(s), canConnect: s.actor.role !== "read_only" };
  });
  if (!data) notFound();

  return (
    <>
      <h1>Integrations</h1>
      <p className="sub">
        Connect the systems your firm already uses. Each connection is yours alone: nobody else at the firm can browse it, administrators included.
        Files you import become evidence in a Matter — scanned, fingerprinted and with a chain of custody recording exactly where they came from.
      </p>
      <FlashBanner flash={flash} />
      {data.hub.map((i) => (
        <div className="card" key={i.provider}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "space-between", alignItems: "center" }}>
            <h2 style={{ margin: 0 }}>{i.name}</h2>
            <span className={`badge${i.status === "available" ? "" : " walled"}`}>{STATUS[i.status]}</span>
          </div>
          <p className="notice">{KIND[i.kind]} · {i.access}</p>
          <p>{i.what}</p>
          {i.connections.length ? (
            <table><tbody>
              {i.connections.map((c) => (
                <tr key={c.id}>
                  <td><Link href={`/integrations/${c.id}`}><strong>{c.accountLabel ?? "Connected account"}</strong></Link>
                    {c.status === "needs_reconnect" ? <div className="notice">Needs reconnecting{c.lastError ? ` (${c.lastError})` : ""}.</div> : null}</td>
                  <td style={{ width: 1, whiteSpace: "nowrap" }}>
                    <Link href={`/integrations/${c.id}`}>Browse</Link>{" "}
                    <form action={integrationDisconnectAction} style={{ display: "inline" }}>
                      <input type="hidden" name="connectionId" value={c.id} />
                      <button type="submit" className="secondary">Disconnect</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody></table>
          ) : null}
          {i.status === "available" && data.canConnect ? (
            <p><a className="button" href={`/api/integrations/${i.provider}/start`}>{i.connections.length ? "Reconnect or add an account" : `Connect ${i.name}`}</a></p>
          ) : null}
          {i.needs ? <p className="notice">Before it can be used: {i.needs}</p> : null}
        </div>
      ))}
    </>
  );
}
