# Phase 8 — Court Intelligence

**Status:** Part 1 (court calendar and federal court notices) built, tested and through independent security review 17 (9 problems confirmed, all fixed).

## Plan
| Part | What | Status |
|---|---|---|
| 8.1 | **Court calendar** per Matter (hearings, conferences, trials, deadlines) with reminders 30/14/7/3/1 days before, on the Matter and the dashboard, and a calendar file (.ics) download. **Federal court notices**: Huis reads CM/ECF Notices of Electronic Filing filed into the Matter, proposes the dates their docket text sets, and shows the Matter's docket with the one-free-look window | Review 17 done, fixes in |
| 8.2 | **Utah court notices**: Utah e-filing receipts and hearing notices from the attorney's inbox, the same way (no scraping, never the attorney's e-filing credentials) | Waiting on O-7 (redacted sample notices) |
| 8.3 | **Alerts by email, SMS and push**, and the `CourtConnector` framework for licensed court-data vendors state by state (UniCourt, Trellis, Docket Alarm…) | — |

## Part 1 — Court calendar and federal court notices

| Area | What Huis does |
|---|---|
| Court dates | Hearings, conferences, trials and deadlines, each with a date, an optional time (blank = all day), where, the judge and notes. Attorneys add, change, delete and mark them done |
| Which emails | Only email sent by a federal court's CM/ECF system (an address at a uscourts.gov host) is read as a court notice, so court-notice wording copied into any other email proposes nothing. A notice forwarded from another address isn't read: file the original from the inbox. The same notice sent to several attorneys of record is one filing: its dates are proposed once, and a rejected date stays rejected |
| Huis proposes | When a federal court notice (a CM/ECF *Notice of Electronic Filing* email) is filed into the Matter, Huis reads its docket text with fixed rules — "*Motion Hearing set for 5/20/2026 at 10:00 AM in Room 7.100 before Judge …*", "*Responses due by 5/4/2026*", "*Dispositive motions deadline 7/15/2026*" — and proposes each date with the exact words it came from and a link to the notice. Impossible dates are skipped, and so is a date the same sentence vacates, strikes or cancels. Notices already filed are read again when this is installed |
| Attorneys decide | **Nothing counts until someone confirms it** (Huis never silently creates a court deadline), and the page asks for each date to be checked against the order. Rejected proposals aren't proposed again. Who decided, and who marked a date done, and when, are recorded by the database. Huis's proposals can't be changed until confirmed and can't be deleted (only rejected) |
| Reminders | 30, 14, 7, 3 and 1 day before, plus "Today", on the Matter's court calendar and on the dashboard (**Court dates in the next 30 days**, across the Matters the person can see, walls applied). Email, SMS and push alerts come in part 3 |
| Calendar file | **Download calendar file (.ics)** adds the confirmed dates, with reminders, to Outlook, Google Calendar or Apple Calendar. Like every export, it needs the person's confirmation that they'll store it securely, and only works from Huis's own page. Wording (including emoji) can't break the file, and it defines the firm's time zone so times are read correctly. It doesn't update itself |
| Docket | The Matter's federal court notices, newest first: entry date, document number, docket text, court and case number, how many dates were found, and a link to the notice. A notice naming a different case number than the Matter's is flagged |
| Free look | Each notice gives attorneys of record one free look at the filed document for 15 days. Huis shows the days left and opens the court's link; after that, PACER fees apply. (Saving the document automatically on that first look needs a decision on how Huis connects to PACER, and comes later) |
| Who can use it | Firm staff on the Matter; read-only staff can read and download but not change it. Clients and other outside users never see it, even on Matters shared with them. Ethical walls apply, including on the dashboard. Nothing moves between Matters or firms |
| Evidence that changes | A notice later found infected takes its proposed and confirmed dates, and its docket entry, with it |
| Logs | The audit log records the kind of change (added, confirmed, rejected, done, exported) and the kind of date, never titles, notes, judges or places |

**Known limit:** notices are read by the same background step that reads documents for the Matter Brain, so a firm that turns AI off gets no proposals; attorneys add their dates by hand.

**Security review 17:** see `SECURITY-REVIEW-2026-11.md`; regression tests in `test/security-review-17.test.ts` (11 tests).

**Tests:** `test/court.test.ts`, 8 tests: reading notices (court, case, document, docket text, dates with times, places and judges including initials, exact words), only court notices, impossible dates, hostile text; the reminder schedule; proposals from a filed notice, confirming and rejecting (recorded by the database), rejected dates not proposed again, done and reopened, the docket with the free-look days and a case-number mismatch; proposals that can't be planted, changed before confirming, deleted or rewritten (also directly in the database); read-only staff, clients, walls (including the dashboard), other Matters and firms; an infected notice taking its dates with it; the calendar file (escaping, folding, reminders) and audit without wording.
