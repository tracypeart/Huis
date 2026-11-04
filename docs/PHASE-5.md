# Phase 5 — Timeline + Evidence Intelligence

**Status:** Part 1 (Master Timeline) built, tested and through independent security review 11 (2 problems confirmed, all fixed). It merges once GitHub's checks pass. Part 2 (contradiction engine) built, tested and through independent security review 12 (9 problems confirmed, all fixed).

## Plan
| Part | What | Status |
|---|---|---|
| 5.1 | **Master Timeline**: one chronology per Matter, made from Case DNA's dated events, facts and damages plus every filed email, each linked to its sources. Views by category (court, plaintiff, defendant, medical, financial, employment, communications, discovery, witness, damages) and filters (dates, person, words, confirmed only, source). Huis suggests categories by fixed rules; attorneys choose their own. Chronology download | Review 11 done, fixes in |
| 5.2 | **Contradiction engine**: Huis flags *potential* contradictions (for example a witness statement "I didn't know about the surgery until May" against earlier dated evidence that mentions it), showing the supporting material and why it was flagged. Attorneys decide whether something is a contradiction; confirmed ones become `contradicts` links in Case DNA | Review 12 done, fixes in |

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

**Security review 11** (independent; see `SECURITY-REVIEW-2026-11.md`) found no access-control break. It confirmed two problems, both in reading email addresses: malformed addresses could make the timeline very slow, and an address hidden in a sender's display name could tie an email to the wrong person, including in Huis's Phase 4 people suggestions. Both are fixed, along with three smaller suspicions. Regression tests are in `test/security-review-11.test.ts` (8 tests). After the fixes: all 226 tests, the type check, the build and the dependency scan pass, and the pre-release check is clean again.

## Part 2 — Contradiction engine

| Area | What Huis does |
|---|---|
| Statements | Huis looks through the Matter's passages (documents, transcripts, filed email, notes) for statements denying knowledge or notice, using **fixed rules, not AI**. Examples: "I didn't know…", "she was not aware…", "we never received…", "no one told me…", "I first learned of it on…". Each statement keeps its topic words ("surgery"; "FMLA leave request") and any date it claims ("until May", "before May 1, 2026", "on 5/6/2026"). A month without a year takes the latest year written in the same document; with no year anywhere, Huis doesn't guess and treats the statement as undated. "I don't know." on its own has no topic and isn't flagged |
| Comparing | Each statement is compared with the Matter's timeline: Case DNA's dated events and facts, and filed email (its subject and text). An item counts when it is dated **before** the claimed date (any date if none is given), mentions the statement's topic (two topic words when the statement has two or more), and comes from **another source**. The statement's own document never counts, and neither do its other versions |
| Confidence | Fixed rule on how many **separate sources** conflict: three or more is high, two is medium, one is low. Versions and near-duplicates of one document (as Huis already links them) count once, so a draft doesn't corroborate its final. Items with no source yet, and the statement's own document, don't count. Every flag says why, e.g. *"2 earlier items from 2 different sources mention "surgery", dated before the statement's "until May (2026)"."* |
| Attorneys decide | Huis only ever calls it a **potential** contradiction. **Confirm**: the statement becomes a confirmed Case DNA fact, cited to where it was said (the quote is taken from the source itself), and each conflicting item is linked to it as *contradicts*. Huis's suggested events among them are confirmed, and a conflicting email becomes a fact cited to its passage that mentions the subject. **Not a contradiction**: it isn't suggested again until someone chooses **Reconsider**. A confirmed decision can't be withdrawn from the app; the Case DNA items it created are edited or removed there as usual |
| Exact citations | A confirmed statement is cited to its **exact words**: Huis checks the quote the database takes from the source, and saves nothing if it differs (for example, the document changed). Positions are counted the way the database counts characters, so emoji and other symbols can't shift a citation. A conflicting email is cited to its passage about the subject, or else its subject line; an item that can't be cited is left out |
| Acting on what was reviewed | The page sends a fingerprint of the flag as shown. If new evidence was added or some was removed since, **Confirm** is refused with "please review it again", and nothing is saved |
| Fresh and safe | Worked out at the moment it's read, as the person reading it, from passages and timeline items they can open. Nothing about a potential contradiction is stored until someone decides. The page never trusts the browser: a decision names a flag by a key, and Huis works out the flag again before acting on it. Evidence later found infected leaves at once, both as a conflicting item and as the statement |
| Who can use it | Firm staff on the Matter. Read-only staff can look but not decide. Clients and other outside users never see it. Ethical walls apply; another firm gets "not found". In the database, decisions record who made them and when (not changeable by the app), can't point at another Matter's items, and only rejections can be withdrawn |
| Logs | The audit log records `contradiction.confirmed` (how many items, and the confidence), `contradiction.rejected` and `contradiction.reconsidered`, never the wording |
| Size | Examines up to 5,000 candidate passages and 500 statements per Matter (and says so when there are more), shows up to 10 conflicting items per flag and 100 flags at a time, strongest first. A decision works out only its own statement |

**Security review 12** (independent; see `SECURITY-REVIEW-2026-11.md`) found no access-control break. It confirmed 9 problems, all fixed:
- the page could be made very slow;
- citations were off in indented or emoji-containing text;
- a conflicting email could become an uncited fact;
- confirming acted on a flag that had changed;
- a hand-made decision could hide a flag;
- dates and confidence could be misleading.

Regression tests are in `test/security-review-12.test.ts`. The date rule now prefers "until/before" over "on/in". After the fixes: all 250 tests, the type check, the build and the dependency scan pass, the pre-release check is clean, and a stale confirmation is refused in the browser.

**Tests:** `test/contradictions.test.ts`, 9 tests:
- the statement rules: denials, topics, claimed dates, no guessed years, non-denials ignored, speed on hostile text;
- flags with the right items, confidence and reasons (later evidence and the statement's own document excluded);
- versions of one document counting once (checked to fail without the fix);
- a confirmation refused once the flag has changed;
- confirming: a cited statement fact, *contradicts* links, suggestions confirmed, the email cited, audit without wording;
- rejecting, reconsidering, and made-up or other Matters' keys refused;
- access: clients, read-only staff, walls, other firms, and direct database writes (decisions as someone else, across Matters, withdrawing confirmed ones);
- infected evidence leaving as a conflicting item and as the statement.

**Checked in a real browser** (made-up data): flags with reasons and confidence, confirming (the statement then appears in Case DNA with its contradicting links), rejecting and the "Not contradictions" list; read-only staff see no decision buttons. This check is what caught drafts inflating the confidence. The pre-release check (`scripts/qa`, now with the contradictions page and a seeded deposition) is clean.

**Limits to know:** the rules find common phrasings, not every way of denying knowledge. Topic matching is by words (lightly stemmed), so "operation" doesn't match "surgery". A person's identity isn't checked: a statement by one witness is compared with everything in the Matter. That is why Huis says *potential* and the attorney decides.
