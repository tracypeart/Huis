import { isCourtSender, parseNef } from "./nef";
import type { FoundCourtEvent } from "./nef";
import { isUtahCourtSender, parseUtahNotice } from "./utah";

/**
 * CourtConnector framework: how Huis gets court information, one connector
 * per source, so new courts and licensed data vendors plug in state by state
 * without changing the rest of Huis.
 *
 * Two kinds:
 *  - **Notice readers** read court notices from email filed into a Matter
 *    (available now): federal CM/ECF notices, and Utah notices (unverified
 *    until checked against real samples).
 *  - **Data vendors** (UniCourt, Trellis, Docket Alarm, CourtListener/RECAP,
 *    PACER) bring dockets and hearing dates through licensed APIs. Each needs
 *    a commercial agreement first; none is connected. No scraping, ever.
 *
 * Whatever a connector finds is only ever a proposal: an attorney confirms
 * each court date before it counts.
 */

export interface ReadNotice {
  connector: NoticeReaderId;
  court: string | null;
  caseNumber: string | null;
  caseName: string | null;
  documentNumber: string | null;
  enteredOn: string | null;
  docketText: string;
  documentUrl: string | null;
  events: FoundCourtEvent[];
}

export type NoticeReaderId = "federal" | "utah";

export interface NoticeReader {
  id: NoticeReaderId;
  name: string;
  jurisdiction: string;
  /** Checked against real notices. Proposals from an unverified reader say so. */
  verified: boolean;
  /** Whether an email's sender may send this kind of notice (plus the firm's registered senders). */
  acceptsSender(from: string | null, firmSenders: string[]): boolean;
  read(text: string): ReadNotice | null;
}

const address = (from: string | null) => ((from ?? "").match(/<([^<>\s]+@[^<>\s]+)>\s*$/)?.[1] ?? (from ?? "").trim()).toLowerCase();

export const NOTICE_READERS: NoticeReader[] = [
  {
    id: "federal", name: "Federal courts (CM/ECF notices)", jurisdiction: "U.S. federal courts", verified: true,
    acceptsSender: (from) => isCourtSender(from),
    read: (text) => {
      const n = parseNef(text);
      return n ? { connector: "federal", ...n } : null;
    },
  },
  {
    id: "utah", name: "Utah state courts (email notices)", jurisdiction: "Utah", verified: false,
    acceptsSender: (from, firmSenders) => isUtahCourtSender(from) || firmSenders.includes(address(from)),
    read: (text) => {
      const n = parseUtahNotice(text);
      return n ? {
        connector: "utah", court: n.court, caseNumber: n.caseNumber, caseName: n.caseName, documentNumber: null, enteredOn: null,
        docketText: n.summary, documentUrl: null, events: n.events,
      } : null;
    },
  },
];

/** The first reader that accepts the sender and recognizes the text. */
export function readCourtNotice(text: string, from: string | null, firmSenders: string[] = []): ReadNotice | null {
  for (const r of NOTICE_READERS) {
    if (!r.acceptsSender(from, firmSenders)) continue;
    const n = r.read(text);
    if (n) return n;
  }
  return null;
}

export interface DataVendor { id: string; name: string; covers: string; status: "needs_agreement" }

/** Licensed court-data vendors the framework is ready for; each needs a commercial agreement before it's connected. */
export const DATA_VENDORS: DataVendor[] = [
  { id: "pacer", name: "PACER (Case Locator and dockets)", covers: "Federal courts", status: "needs_agreement" },
  { id: "courtlistener", name: "CourtListener / RECAP", covers: "Federal dockets and opinions", status: "needs_agreement" },
  { id: "unicourt", name: "UniCourt", covers: "3,000+ state and federal courts, hearing-date updates", status: "needs_agreement" },
  { id: "trellis", name: "Trellis", covers: "State trial courts (Utah coverage to confirm)", status: "needs_agreement" },
  { id: "docketalarm", name: "Docket Alarm", covers: "Federal and many state courts, docket tracking", status: "needs_agreement" },
];

export interface CourtDataConnector {
  id: string;
  /** Upcoming hearings and deadlines for a case, as proposals. */
  hearings(caseNumber: string, court: string): Promise<FoundCourtEvent[]>;
}
