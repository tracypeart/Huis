# Phase 8 — Court Intelligence

**Status:** Part 1 (court calendar and federal court notices) merged after independent security review 17. Parts 2 (Utah court notices, reader unverified until O-7 samples) and 3 (reminders and the CourtConnector framework) built and tested on branch `phase-8-alerts`; independent security review 18 before merge.

## Plan
| Part | What | Status |
|---|---|---|
| 8.1 | **Court calendar** per Matter (hearings, conferences, trials, deadlines) with reminders 30/14/7/3/1 days before, on the Matter and the dashboard, and a calendar file (.ics) download. **Federal court notices**: Huis reads CM/ECF Notices of Electronic Filing filed into the Matter, proposes the dates their docket text sets, and shows the Matter's docket with the one-free-look window | Review 17 done, fixes in |
| 8.2 | **Utah court notices** from the attorney's inbox, from a Utah courts address or the firm's registered e-filing provider (no scraping, never the attorney's e-filing credentials). The reader is marked *not yet verified* until checked against real notices (O-7) | Built, in review; verify with O-7 samples |
| 8.3 | **Reminders** in Huis now, and by email, SMS and push once production hosting has a sending service (O-2); the **CourtConnector** framework for notice readers and licensed court-data vendors | Built, in review |

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

## Part 2 — Utah court notices

| Area | What Huis does |
|---|---|
| Where they come from | Utah sends court notices through each firm's **e-filing service provider (EFSP)**, in that provider's own format ("notification methods are unique to the EFSP", Utah eFiling FAQ for attorneys). Huis reads email filed into a Matter from a **Utah courts address** (utcourts.gov) or from the **address an administrator registers** on *Court connections* as the firm's provider. Personal email services (Gmail, Outlook.com…) can't be registered. Registering an address reads the firm's email from it again |
| What it reads | It needs a Utah court (e.g. "Third District Court", "Salt Lake County Justice Court", the Supreme Court or Court of Appeals) and a case number (nine digits, or an appellate number). It proposes dates written as a court date is set: "*A Pretrial Conference is scheduled for Wednesday, December 1, 2026 at 9:00 AM in Courtroom W43*", a "*Hearing Type … Date … Time …*" block, "*… set for 12/1/2026*", "*… due by …*". A date in a sentence that vacates, strikes or cancels it is skipped |
| Unverified | Until the reader has been checked against real (redacted) Utah notices (O-7), it's marked **not yet verified**: on *Court connections*, on each proposal ("Utah format not yet verified — compare it with the notice carefully") and in the docket. As always, nothing counts until an attorney confirms it |
| Same protections | Proposals are keyed by the filing, keep the exact words (by character position), can't be planted, changed before confirming, or deleted; walls, clients, read-only staff and other firms as in part 1 |

## Part 3 — Reminders and court connections

| Area | What Huis does |
|---|---|
| Who is reminded | Active firm staff who are **members of the Matter or its lead attorney**. Never clients or other outside users, even on Matters shared with them; never other staff. Walled Matters remind only their members |
| When | 30, 14, 7, 3 and 1 day before each **confirmed**, not-done court date, and on the day (in the firm's time zone). Proposals never remind. Each reminder is made once; a moved date gets its own |
| How | **In Huis**: the *Alerts* page and a count in the menu. **Email, text message (SMS) and phone notification**: each person chooses theirs on *Alerts*. These go through a sending service chosen with production hosting (O-2); until then they're kept and shown as *Waiting: no sending service set up yet*, and sent once one is (if the date is still ahead). Never silently dropped |
| What leaves Huis | **Bare by default**: "*Huis Law: you have a court date in 7 days (Dec 1, 2026). Open Huis to see it: …*". A person can choose to include the details (what, when, which Matter); the page explains why it's off by default. Wording can't add lines or headers |
| Checked when sent | Just before an email, text or push goes out, Huis checks again that the date is still confirmed, not done, on the same day, from a clean notice, and that the person is still active staff on the Matter (e.g. not removed from a wall). Otherwise it isn't sent |
| Privacy | A reminder stores no wording, only which court date: what it says is read from the court date each time, under the court calendar's rules, so it disappears with the court date or with access to the Matter. Each person sees only their own reminders and settings; reminders can only be marked read (stamped by the database). The audit log records settings changes (channels, details on or off), never a phone number |
| CourtConnector framework | **Court connections** lists how Huis learns about court dates: the notice readers (federal CM/ECF, active; Utah, active but not yet verified) and the licensed court-data services it's ready for (PACER, CourtListener/RECAP, UniCourt, Trellis, Docket Alarm), each needing a commercial agreement before it's connected. New readers and vendors plug into the same interface (`src/court/connectors.ts`) |

**Tests:** `test/court-alerts.test.ts`, 5 tests: the Utah reader (court and case number required, scheduled dates and date blocks, vacated dates, senders, bounded on hostile text) and reader and vendor status; Utah proposals from a Utah courts address and a registered provider only, administrators registering senders (personal email services refused; in the service and the database), reading again on registering, clients and other firms, audit without addresses; reminders for members and the lead attorney on the schedule, never clients or other staff, once only, marked read only (in the database too), done dates; email and text reminders waiting for a sending service then sent, bare by default and with details when chosen, preferences audit without the phone number; reminders checked again when sent (removed from a wall), proposals never reminding, and wording that can't break message lines.
