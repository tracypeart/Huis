import type { Flash } from "./server";

export const ROLE_LABELS: Record<string, string> = {
  firm_owner: "Firm Owner",
  managing_partner: "Managing Partner",
  firm_admin: "Firm Administrator",
  attorney: "Attorney",
  paralegal: "Paralegal",
  legal_assistant: "Legal Assistant",
  billing_admin: "Billing Administrator",
  investigator: "Investigator",
  expert_consultant: "Expert / Consultant",
  read_only: "Read Only",
  client: "Client (portal)",
  co_counsel: "Co-Counsel",
  expert_witness: "Expert Witness",
  authorized_third_party: "Authorized Third Party",
};

export const CONTACT_LABELS: Record<string, string> = {
  opposing_counsel: "Opposing Counsel",
  opposing_party: "Opposing Party",
  judge: "Judge",
  court_staff: "Court Staff",
  witness: "Witness",
  expert: "Expert",
  co_counsel: "Co-Counsel",
  insurance_adjuster: "Insurance Adjuster",
  other: "Other",
};

export const CLASSIFICATION_LABELS: Record<string, string> = {
  attorney_client_privileged: "Attorney-Client Privileged",
  attorney_work_product: "Attorney Work Product",
  confidential: "Confidential",
  highly_confidential: "Highly Confidential",
  protective_order: "Protective Order",
  internal_firm_only: "Internal Firm Only",
  client_accessible: "Client Accessible",
  co_counsel_accessible: "Co-Counsel Accessible",
  expert_accessible: "Expert Accessible",
  restricted: "Restricted",
  public: "Public",
};

export const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS",
  "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC",
  "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
];

export function FlashBanner({ flash }: { flash: Flash | null }) {
  if (!flash) return null;
  return (
    <div className={`flash ${flash.kind}`} role={flash.kind === "error" ? "alert" : "status"}>
      {flash.message}
      {flash.secretLink ? <div className="secret">{flash.secretLink}</div> : null}
    </div>
  );
}

export function StateSelect({ name, defaultValue = "UT" }: { name: string; defaultValue?: string }) {
  return (
    <select name={name} defaultValue={defaultValue}>
      {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
    </select>
  );
}

export function date(d: Date | string): string {
  return new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "America/Denver" });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`;
}

const STATUS: Record<string, [string, string]> = {
  pending_scan: ["Scanning — held", "badge walled"],
  clean: ["Scanned clean", "badge"],
  infected: ["Threat found — quarantined", "badge privileged"],
  scan_failed: ["Held — could not verify", "badge privileged"],
};

export function EvidenceStatus({ status }: { status: string }) {
  const [label, cls] = STATUS[status] ?? [status, "badge"];
  return <span className={cls}>{label}</span>;
}
