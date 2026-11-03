# Phase 4 — Matter Brain + Case DNA™

**Status:** Part 1 (Matter Brain) merged after independent security review 8. Part 2 (Case DNA™) merged after independent security review 9. Part 3 (full export) merged after independent security review 10.

## Plan
| Part | What | Status |
|---|---|---|
| 4.1 | **Matter Brain**: each Matter's knowledge base (documents, filed email, transcripts, client uploads, attorney notes), split into passages, searchable by words and by meaning; **Ask this Matter** with cited answers; attorney notes; AI Gateway with a firm-level AI setting and a usage log | Merged |
| 4.2 | **Case DNA™**: the relationship map: people, organizations, events, claims, defenses, legal elements, witnesses, damages, each linked to the evidence behind it. AI suggests; attorneys confirm. Click a claim to see its elements, supporting and contradicting facts, evidence, witnesses and emails | Merged |
| 4.3 | Full export of a Matter (evidence, Matter Brain notes, Case DNA). Written answers from an outside AI provider follow once its zero-retention terms are signed (O-3) | Export merged (review 10) |

PostgreSQL stays the single source of truth. Passages and meaning fingerprints live in PostgreSQL (pgvector); a separate graph database is added only if Case DNA outgrows it.

## Part 1 — Matter Brain

| Area | What Huis does |
|---|---|
| What goes in | The readable text of every clean (virus-scanned) item in the Matter: documents, OCR'd scans, filed email and attachments, audio/video transcripts, client uploads. Also **attorney notes**. Exact duplicates are left out. New items join automatically once read |
| Passages | Text is split into passages of about 1,500 characters, at paragraph or sentence breaks, with a small overlap so facts aren't cut in half. Each passage keeps its position, so answers cite exactly where they came from |
| Searching | Each question is matched by words and by meaning (pgvector), across this Matter only |
| Ask this Matter | An answer built only from passages the person can open themselves, with numbered citations linking to the source document or note. Questions and answers are **private to the person who asked**, labelled *Privileged & Confidential — Attorney Work Product* |
| Who can use it | Firm staff only. Clients, co-counsel and experts never see the Matter Brain, notes or any AI output, even for documents shared with them. Ethical walls apply: someone outside a wall can't ask that Matter or read its passages, and loses their earlier answers if removed |
| Answers stay honest | Saved answers keep references to their sources, not copies. The database withholds an answer as soon as any source is no longer available to the asker (evidence found infected, access removed); deleting a note deletes the answers built on it |
| Attorney notes | Work product: firm staff on the Matter can read them; only the author can change or delete one; read-only staff can't add them |
| AI provider | A firm setting chosen by administrators. **Built-in** (default) runs entirely inside Huis and sends nothing to any outside service: meaning search uses a built-in text fingerprint, and answers are the most relevant passages with their sources rather than written conclusions. **Off** turns AI features off. Outside AI providers (for written answers) plug into the same AI Gateway once their zero-retention, no-training terms are signed (O-3) |
| Logs | The audit log records that a question was asked, never what. The AI usage log (administrators only) records provider, model, sizes and time — never questions, answers or document text |

**Tests:** `test/brain.test.ts`, 17 tests (6 from review 8): passage splitting, meaning fingerprints, cited answers from documents and notes, other Matters and walls, outside users (including direct database queries), answer privacy and withholding, infected evidence leaving at once, note permissions, AI off, logs without content, and the app being unable to write passages or run worker steps; question text can't inject into the search. Also checked in a real browser.

## Part 2 — Case DNA™

| Area | What Huis does |
|---|---|
| The map | People, organizations, events (with dates), claims, defenses, legal elements, facts and damages, and the links between them (supports, contradicts, witnessed, involves, works for, caused, defends against, is an element of). Each item can cite the passages it came from |
| Huis suggests | While reading each document, Huis suggests **dated events** (each sentence with a date, cited to where it appears) and **people** on filed email (except the firm's own staff; at most 20 per email; named by email address, with the name each email gave shown beside it). **Find evidence** on any legal element searches the Matter Brain for passages that may prove or disprove it |
| Attorneys decide | Suggestions count only once someone confirms them. Rejected suggestions aren't suggested again, even when documents are read again. Every decision records who made it and when. Huis's suggestions can be rejected but not deleted, so the record stays complete |
| Claims | Add a claim from a starting template, with its elements and sources, or build your own: FMLA retaliation, FMLA interference, Title VII retaliation, ADA discrimination, breach of contract (Utah), wrongful termination in violation of public policy (Utah). Templates are a starting point, not legal advice; check every element against the controlling law |
| Claim view | Click a claim to see each element with its supporting and contradicting facts and their sources, plus the claim's witnesses, emails and other evidence |
| People | **Add the client and contacts** puts the Matter's client and linked contacts on the map, confirming matching suggestions instead of duplicating them |
| Who can use it | Firm staff on the Matter; read-only staff can read but not change it. Clients and other outside users never see it. Ethical walls apply. Nothing can be linked or cited across Matters, and only a passage the person can open can become a fact |
| Evidence that changes | An item built on evidence that is no longer clean (e.g. later found infected) disappears from the map once none of its sources is clean. Quotes always come from the source itself |
| Logs | The audit log records the kind of change (added, confirmed, linked…), never the wording |

**Tests:** `test/dna.test.ts`, 14 tests (5 from review 9): event finding (formats, impossible dates, abbreviations, speed on hostile text), suggestions from documents and email, confirm/reject and rejections sticking, the claim view with facts, witnesses and emails, importing people, outside users and read-only staff, walls and cross-Matter attempts (including direct database writes), planting suggestions or rewriting history, evidence that stops being clean, and audit without wording. Also checked in a real browser.

## Part 3 — Full export of a Matter

The firm owns its data and can take a complete copy of a Matter at any time.

| Area | What Huis does |
|---|---|
| What's in it | A ZIP file containing: **every original exactly as received** (only items that passed their security scan; others are listed but left out), the text Huis read from each item, the **chain of custody** for every item with a check that it is intact, viewer marks, **attorney notes**, the exporter's own **Matter Brain questions and answers**, **Case DNA**, the Matter's details and people, a **manifest** (spreadsheet) and **SHA256SUMS.txt**, a checksum for every file so anyone can confirm nothing changed. A README explains each part and carries the *Privileged & Confidential — Attorney Work Product* label |
| Who can export | The Matter's owner, or a firm owner, managing partner or administrator who can see the Matter. Ethical walls apply. Other attorneys, paralegals, read-only staff and outside users can't, and don't see the option |
| Confirming | Exporting requires confirming that the export contains privileged material and will be stored securely |
| No copies kept | The ZIP is built as it downloads, from what the person can see at that moment, under the same database rules as everything else. Huis keeps no copy |
| Records | Each item's chain of custody records the export (with an export number), and the audit log records that the Matter was exported. Neither records any content |
| Safety | File names are made safe for every system (no folder tricks, reserved Windows names or unusual punctuation) and unique; the manifest keeps the original names. Spreadsheet cells in the manifest can't run as formulas. Invisible and direction-changing characters are removed from names, and names Windows or macOS would treat as the same are told apart. If any original fails its integrity check, or the person's access (or the item's scan result) changes while the export downloads, the download stops with an error rather than producing an incomplete copy. Access is checked again before every file |

Other people's Matter Brain questions stay private and are not exported.

**Tests:** `test/export.test.ts`, 8 tests: everything included and byte-for-byte identical, checksums for every file, the infected file left out, only the exporter's own questions, custody and audit records without content; who can and can't export, including an administrator outside a wall, with confirmation required; hostile file names and spreadsheet formulas; a tampered original stopping the export; and the review 10 regressions (access removed, user disabled or file found infected mid-download; invisible characters, long names, look-alike and device names; formula-proof spreadsheet cells; custody and audit records written together, export numbers used once). Also checked in a real browser: the download opens with standard tools and every checksum passes. The full page check (`scripts/qa`) is clean.

## Check before part 3 (pre-release check)

Before part 3, everything was tested and reviewed again:
- all automated tests (204), the type check, the production build, and a dependency vulnerability scan (none);
- every reachable page, opened as each kind of user (owner, attorney, paralegal, read-only staff and a client-portal user) on a made-up firm;
- every link inside the documentation.

**Fixed:**
- A client who typed the address of the Clients or People & Contacts page got an error page instead of "not found" (the menu already hid both).
- Signed-in people opening the sign-in page are now offered a link back to their dashboard.
- The sign-up page no longer tells a signed-in person their session ended.
- The dashboard's "Coming next" text was out of date.
- Clients no longer see the firm's trial countdown.

**Confirmed working:** every page a person is allowed to use loads without errors. Pages they aren't allowed to see answer "not found" (walled Matters, administrator pages, other people's mailboxes, and the Matter Brain and Case DNA for clients). Downloads, the PDF viewer, comparisons, and the Outlook and Gmail connect links all respond.

**Not checked from here:** the outside web pages the architecture notes cite as research sources (this environment can't open outside sites directly).

The check can be repeated at any time with `scripts/qa` (see its README).
