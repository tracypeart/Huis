# Phase 5 — Timeline + Evidence Intelligence

**Status:** Part 1 (Master Timeline) built and tested; **awaiting independent security review 11** before merge. Part 2 (contradiction engine) planned.

## Plan
| Part | What | Status |
|---|---|---|
| 5.1 | **Master Timeline**: one chronology per Matter, made from Case DNA's dated events, facts and damages plus every filed email, each linked to its sources. Views by category (court, plaintiff, defendant, medical, financial, employment, communications, discovery, witness, damages) and filters (dates, person, words, confirmed only, source). Huis suggests categories by fixed rules; attorneys choose their own. Chronology download | Built, review pending |
| 5.2 | **Contradiction engine**: Huis flags *potential* contradictions (for example a witness statement "I didn't know about the surgery until May" against earlier dated evidence that mentions it), showing the supporting material and why it was flagged. Attorneys decide whether something is a contradiction; confirmed ones become `contradicts` links in Case DNA | Planned |

As in Phase 4, PostgreSQL stays the single source of truth. The timeline isn't a separate copy of anything. It is put together from Case DNA and filed email each time it's read, under the same database rules.

## Part 1 — Master Timeline

| Area | What Huis does |
|---|---|
| What's on it | Every Case DNA event, fact and damage with a date (confirmed items, plus Huis's suggestions marked **Suggested by Huis**; never rejected ones), and every filed email on the day it was sent, in the firm's time zone. Exact duplicate emails appear once. Same-day items list Case DNA first, then email |
| Sources | Each entry shows where it came from (document or note, with the quoted passage) and links to the original. A filed email links to itself. Items with no source yet say so |
| Views and filters | **Master**, or one category (with counts). Filters: date range, a person (items linked to them in Case DNA, and email they sent or received), words, confirmed only, *backed by evidence* or *no source yet*, and including or leaving out email. Nonsense filter values are ignored rather than breaking the page |
| Categories | Huis suggests them with **fixed, explainable rules**, not AI: word lists ("surgery" → medical, "terminated" → employment; whole words, with listed stems such as *terminat-*), plus links (an item involving the client → plaintiff; the opposing party or employer → defendant; a confirmed witness → witness; damages and amounts → damages; email → communications). The same wording always gets the same categories. On a confirmed item, an attorney can choose its categories, including none, and can go back to Huis's suggestions. A suggestion must be confirmed first |
| Changing things | Confirm or reject Huis's suggestions directly on the timeline; add an event (date, description, categories). Citations and people are added on the item's Case DNA page, which also shows its categories and links to that day on the timeline |
| Download | **Download timeline**: a CSV of the entries shown, with their sources, headed *Privileged & Confidential — Attorney Work Product*. Requires confirming it will be stored securely. Firm staff who can change Case DNA only (not read-only staff, clients or outside users). Cells can't run as spreadsheet formulas. POST only, from Huis's own pages |
| Who can use it | Firm staff on the Matter (the same rule as Case DNA). Read-only staff can view but not change or download. Clients and other outside users never see it, even for a Matter or emails shared with them. Ethical walls apply. Another firm gets "not found" |
| Evidence that changes | Built on the database's row-level security at the moment it's read, so an item or email whose evidence is no longer clean (for example later found infected) leaves the timeline at once |
| Data | One new column, `dna_nodes.categories`: NULL until an attorney chooses, then exactly their choice. The database refuses unknown categories, accepts at most 10, refuses changes to an unconfirmed suggestion, and refuses categories on Huis's own suggestions. Full export includes it in `case-dna.json` |
| Logs | The audit log records `dna.categories_changed` (the kind of item, never the categories or wording) and `timeline.downloaded` (how many rows, never what) |
| Size | Reads up to 5,000 dated items and 5,000 emails per Matter (and says so when there are more); the page shows 1,000 entries at a time, and the download includes all the filtered entries |

**Tests:** `test/timeline.test.ts`, 6 tests:
- the category rules: words, links, whole words versus stems, bounded input;
- date order, sources, categories and the firm's time zone on email; duplicate emails appear once; an email's own Date header isn't a separate event; rejected suggestions leave;
- every filter, including nonsense values;
- attorney categories: confirm first (in the service and directly in the database), none, back to Huis's, unknown or NULL values refused, Huis can't plant categories, read-only staff can't change them, audit without content;
- clients, walls and other firms are kept out, and evidence later found infected leaves at once;
- the download: confirmation required, read-only staff and clients refused, formula-proof cells, the work-product label, audit without content.

The duplicate-email test was checked to fail without its fix.

**Checked in a real browser** (made-up data, as an attorney): category views and counts, filters, Confirm, choosing and resetting categories, *See this day on the timeline*, adding an event, and the download (opens as a spreadsheet, label first). Read-only staff see no change or download controls. Read-only, client and cross-site download requests are refused. The pre-release check (`scripts/qa`, now with timeline pages and seeded timeline items) is clean: every 404 is an expected one (walled Matter, client, administrator pages, another person's mailbox).

**Found while checking, not part of this part:** at phone width the shared site menu makes most pages, not only the timeline, wider than the screen. To fix separately in the app layout.

**Before merge (README ground rule 4):** independent security review 11 (an attacker who didn't write the code, with working tests), fixes for anything confirmed, the review recorded in `SECURITY-REVIEW-2026-11.md`, and green GitHub checks.
