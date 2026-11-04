# Independent security reviews — Phases 1 & 2 (November 2026)

**Scope:** everything in Phase 1 (firms, roles, matters, sign-in, invitations, web app) and Phase 2 part 1 (evidence intake, encryption, scanning, chain of custody).
**Method:** a separate reviewer that did not write the code attacked it with working exploit tests against a real database, assuming an attacker who can run any query through the app's own database connection (so a single app bug can't become a breach).
**Result:** 9 confirmed issues + 3 suspected. **All fixed**, each with a regression test (`test/security-review.test.ts`, 19 tests). All 13 of the reviewer's original exploit tests now fail to exploit. Fixes are in `db/migrations/0004_security_hardening.sql` plus app changes.

| # | Severity | Finding | Fix |
|---|---|---|---|
| H2 / F8 | High | A firm admin could link their own Microsoft account to another person's account (directly or by unlinking and re-inviting) and so get into that person's walled matters | The database refuses any change to sign-in links except through a one-time invitation; linked accounts can't be re-invited |
| F2 | High | Any staff member, even read-only, could switch off the red Privileged & Confidential folder's protection and expose it to clients | The red folder can never be un-designated or reclassified; only matter owners/editors (or admins) can change folders |
| G3 | High | An owner of one matter could re-point their membership to take over a different matter | Membership rows can't be moved; outsiders can never be owner or editor |
| F9 | High (privilege) | Moving privileged material into Client Uploads exposed it with no warning | Moving into any folder outsiders can see requires an explicit privilege-waiver acknowledgement, recorded in the chain of custody |
| F10 | Medium | A matter editor could lift an ethical wall or rewrite the Huis number | Only matter owners can change the wall, client or lead attorney; Huis numbers are always database-assigned and immutable |
| F5 | Medium | Changing a staff member to an outside role kept their owner access | Moving between staff and outside roles is blocked; remove and re-invite instead |
| J1 | Medium | Anyone could re-queue scans, and a later scan could overwrite an "infected" verdict | Only the database queues scanning (once per file); a verdict is never overwritten; only the worker holding the job (lock token) can report |
| H1 / F7 | Medium | Custody entries and receipt details (received from, date) could be forged; evidence could point at another matter's folder | The app can no longer write custody or edit evidence at all — the database writes custody itself; receipt details are immutable; folders must belong to the same matter |
| F6 / G1 | Medium | Busy firms would see false "integrity FAILED" alarms from concurrent writes | Chains are ordered by a sequence assigned under the chain lock; verified with 50 concurrent writers |
| F3 / F4 / G2 | Low–Med | Read-only users and clients could link or edit matter contacts | Outsiders can't see or change them; read-only users can't write |
| Suspected | Low | Sessions couldn't be revoked | Sessions carry a version; **signing out ends the session on every device**; admins can "Sign out everywhere" for any user; disabling a user is immediate |
| Suspected | Low | Forwarded IP headers trusted blindly; admins could edit plan/trial; error text could leak; cross-site download could write fake custody; folder lookup answered for walled matters; long scans could be double-processed | Proxy IPs trusted only when configured; billing fields locked; only user-written messages shown; cross-site requests blocked; lookups respect walls; job locks with tokens |

## Second review — Phase 2 part 2 (reading files and search)

**Scope:** text extraction, OCR, email and archive splitting, search, and the worker that opens untrusted files.
**Method:** the same independent, attack-first approach, with working exploits against a real database and real malicious files.
**Result:** 7 issues (one a regression of an earlier fix) plus 7 correctness problems. **All fixed** in `db/migrations/0006_extraction_hardening.sql` and the extraction code, each with a regression test (`test/extraction.test.ts`, "security review 2"). The reviewer's exploit scripts now fail.

| # | Severity | Finding | Fix |
|---|---|---|---|
| F1 | High (regression) | The app's own database connection could insert fake "taken out of an email" items, bypassing the worker-only rule | The database only lets the app insert ordinary uploads, column by column; contained items can only come from the worker role |
| F2 | High (privilege) | Moving an email dragged an attachment someone had filed in the red privileged area back out with it, where a client could see it | Moving a parent only carries along contained items still in the parent's folder |
| F3 | High | The file-reading process wasn't truly isolated: it could read the worker's secrets and follow planted links | Real sandbox: unprivileged user, no network, separate process space; returned files are checked to be plain files in its own folder |
| F4 | Medium | Highly compressed archives could unpack far more than the bomb check allowed, filling the disk | Per-entry compression check on anything over 1 MB, plus a database-enforced total unpacking budget per upload |
| F5 | Medium | Reading extracted text and searching left no trace | Recorded in custody and the audit log |
| F6 | Medium (privilege) | An email's searchable text listed attachment names, so a privileged attachment's name could be found by a client through the parent | Attachment names are no longer part of the parent's text |
| F7 | Low | On timeout, LibreOffice's helper process survived | Every tool runs in its own process group, killed as a whole |
| Correctness | — | OCR timeouts lost all text; very large PDFs and mailboxes could exhaust memory; an infected attachment left its email marked clean; .ppt files weren't read; crashed workers left decrypted copies in temp folders; a move during unpacking could split a family | Partial OCR results kept; large outputs streamed and capped; infected children quarantine their parents; .ppt converted via PDF; stale work folders swept on start-up; unpacking locks the parent so a concurrent move waits and then moves everything |

## Third review — Phase 2 part 3a (mailboxes, attached messages, similarity)

**Scope:** Outlook .pst/.ost splitting, emails attached inside emails, near-duplicate and version detection, the compare page.
**Result:** no privilege, ethical-wall or cross-firm leak. The reviewer tried to reach privileged and walled items through similarity links, comparisons, error messages, query plans and moves in and out of the red folder; every attempt failed. It found 4 confirmed problems and 1 suspected, about robustness and the repository. **All fixed**, each with a regression test ("security review 3" in `test/extraction.test.ts`, plus `test/repo-hygiene.test.ts`).

| # | Severity | Finding | Fix |
|---|---|---|---|
| R3-1 | Medium | Ignore rules meant for evidence *data* (`uploads/`, `evidence/`) also matched source folders, so the evidence pages, download route and upload API had never been committed to GitHub (they had been reviewed on disk) | Rules anchored to data folders at the project root; the files are committed; a test now fails if any source file is ever ignored |
| R3-2 | Medium | Near-duplicate matching slowed down with every look-alike in a matter (e.g. thousands of automated emails in a mailbox) | Matching reads at most 201 entries per fingerprint value and skips crowded ones; candidates capped at 200 and links at 50 per item; calendar entries and contacts not fingerprinted. With 100,000 look-alikes, matching one item went from 4.8 s to 11 ms |
| R3-3 | Medium/Low | Very long mailbox jobs could outlive their 6-hour lease and be picked up twice, with results silently discarded as "partial" | The worker renews its lease every 10 minutes and keeps its work folder fresh; a lost lease is a real failure, never "partial"; stored files are cleaned up if storing is interrupted |
| R3-4 | Low | Comparing two crafted files could stall the web server for ~0.7 s per request | Lines compared as integers, 1 million characters per side; the crafted case now takes 74 ms or is refused as too large |
| R3-5 | Suspected Medium | A crafted mailbox could expand to fill the worker's disk before any limit applied | Disk use is watched while a mailbox unpacks and unpacking stops past the limit; the worker checks the upload's remaining budget *before* encrypting and storing contained files |

## Fourth review — Phase 2 part 3b (viewer, marks, redacted and exhibit copies)

**Scope:** the page viewer, viewing copies, highlights/notes/redaction marks, produced (redacted / exhibit / Bates) copies.
**Result:** work product held: clients, walled-out staff and other firms could not see, add or remove marks or copy requests; read-only staff could view but not mark; Bates numbers stayed unique under 8 concurrent requests; redactions held on rotated pages; LibreOffice did not pull in linked local files. The reviewer confirmed 1 High, 2 Medium and 2 Low problems, plus suspected ones. **All fixed**, each with a regression test ("security review 4" in `test/extraction.test.ts`); the reviewer's exploit tests now fail.

| # | Severity | Finding | Fix |
|---|---|---|---|
| R4-1 | High | On PDFs with a crop area (common in scanned and Acrobat-cropped files), the viewer shows the crop but copies rendered the whole page, so redactions could land in the wrong place and content the attorney never saw could be produced | Copies render exactly the area the viewer shows (`-cropbox`); test proves the redacted word and the hidden margin are both gone |
| R4-2 | Medium | Filled-in form fields weren't drawn in the viewer but were printed into copies, so they couldn't be seen or redacted | The viewer draws form fields and annotations exactly as copies are produced (confirmed in a real browser) |
| R4-3 | Medium | A crafted document title could fake the page count, so a production was silently cut short | Page counts come from the PDF's real page tree (qpdf), never from text output; the copy maker also checks the renderer agrees there's no extra page |
| R4-4 | Low | A huge page was only refused after it was rendered (hundreds of MB to GB) | Rendering runs under memory and file-size limits |
| R4-5 | Low | A copy shared with a client revealed the privileged source's id, name, fingerprint and requester in the copy's custody record | The copy's own record says only what the copy is (labels, Bates, number of redactions); the link to the source is kept where only firm staff can see it |
| Suspected | Low | Copies could be made from a document quarantined after the request; unlimited mark sizes and counts | Requests from no-longer-clean sources fail; mark requests capped at 16 KB; 5,000 marks per document and 2,000 redactions per copy |

## Fifth review — Phase 3 part 1 (Huis Inbox: Outlook connection, sync, filing)

**Scope:** connecting mailboxes, credential storage, sync, private inbox, search, filing email into Matters, matter colors.
**Result:** firm owners, administrators, other staff, outside users and other firms could not read anyone's mail, folders or filings; the app couldn't read credentials or call worker functions; tokens were only ever sent to Microsoft; the sign-in flow (state, PKCE, nonce, user binding) held; hostile subjects couldn't escape file names or inject into pages. The reviewer confirmed 7 problems. **All fixed**, with regression tests (`test/inbox.test.ts`, "review 5"); the reviewer's attack tests now fail.

| # | Severity | Finding | Fix |
|---|---|---|---|
| R5-1 | Medium-High | Mailbox searches were written to the audit log with their search text and hit counts, which firm administrators can read | The audit log records only that a search happened; no search text, results or mailbox addresses |
| R5-2 | Medium | Disconnecting kept any email with a pending filing, permanently | Disconnecting removes every email and cancels pending filings |
| R5-3 | Medium | A filing completed even if the person had lost access to the Matter (or been removed as a delegate) before it ran | Filings are re-checked as the requester when picked up and again before completion; removing a delegate cancels their waiting filings |
| R5-4 | Medium | Mailbox access didn't follow later changes: a delegate made read-only kept reading; a departed owner's delegates kept reading and syncing continued | Access requires the owner to be active staff and delegates to be active, non-read-only staff; Huis stops syncing a departed owner's mailbox |
| R5-5 | Low-Medium | A colleague could claim someone's mailbox id first and block them from connecting (no mail exposed) | A connection that never worked, needs reconnecting or was disconnected is taken over (and wiped) by the next working sign-in |
| R5-6 | Medium | A misbehaving or spoofed mail service could keep a sync or folder listing looping forever | Every page counts against the budget, paging must move forward, folder listing is capped, and long runs of empty pages stop the sync with an error |
| R5-7 | Medium | One email with a hidden NUL character stopped the whole mailbox from syncing | NUL characters are removed, and each email is saved on its own so a bad one is skipped |
| Also | Low | Rotated Microsoft tokens during filing were dropped; large responses were read before the size check; owner-only settings didn't re-check the owner's role | Rotated tokens saved; size checked while reading; owner settings require current staff role |

## Sixth review — Phase 3 part 2 (matter suggestions, Manual / Assisted / Automatic filing)

**Scope:** suggestions, one-click and automatic filing, filing-mode settings, reasons in custody.
**Result:** suggestions only ever named Matters the person could see and add to, and revealed nothing about mailboxes they couldn't see. One-click filing went through the same checks as manual filing, and the mode settings were limited to administrators and mailbox owners. The reviewer read the code and reported 5 suspected problems (it stopped before writing attack tests). Each one was confirmed with a test and **fixed**, with regression tests (`test/inbox.test.ts`, "review 6").

| # | Severity | Finding | Fix |
|---|---|---|---|
| R6-1 | High | Automatic filing considered every Matter the owner could add to, and court case numbers were matched as loose text. A colleague could set their own Matter's case number to a common word and pull other attorneys' email into it | Automatic filing only files into Matters the owner is on. Case numbers need at least two digits and are matched as whole numbers |
| R6-2 | Medium | Turning automatic filing on would also file the whole mailbox history | Only email received after automatic filing was turned on (by the owner and by the firm) is considered |
| R6-3 | Medium | An outside sender could put another Matter's Huis or case number in an email and get it (and the attorney's replies in that conversation) filed there | Automatic filing also requires the client or a contact linked to the Matter on the email; a number alone only produces a suggestion for a person to decide |
| R6-4 | Medium | Case numbers matched inside phone numbers and longer case numbers (2:24-cv-0123 inside 2:24-cv-01234) | Matching is by whole number token |
| R6-5 | Low | Automatic filings already queued still ran after automatic filing was switched off | Automatic filings are re-checked against the firm mode, the mailbox setting and the owner's membership when picked up and before completion |
| Also | Low | Very long recipient lists made suggestions slower; with several "Correspondence" folders, which one was picked was arbitrary | Recipients considered are capped at 200; the earliest-created Correspondence folder is used. Mode changes are audited by the app (the database functions are callable only by the app) |

## Seventh review — Phase 3 part 3 (Gmail)

**Scope:** Google sign-in for mailboxes, the Gmail provider (labels, full import, change history, raw MIME), the whole-mailbox sync path, and the connect pages for both providers.
**Result:**
- **Connecting held.** A Microsoft connect request couldn't complete on the Google page or the reverse, and wrong state values and other people's requests were refused.
- **Tokens stayed with Google.** They never left Google's hosts, and redirects weren't followed.
- **Bad responses were refused.** Hostile ids, page tokens and stored positions, and responses claiming to be a different message, were all rejected.
- **Spam, Trash and Drafts stayed out** in normal syncs.

The reviewer wrote 23 attack tests and confirmed 8 problems. **All fixed**, with regression tests (`test/gmail.test.ts`, "review 7"). The reviewer's attack tests now pass, except one that expected an unreadable saved position to raise an error; it now starts a fresh import instead (R7-8).

| # | Severity | Finding | Fix |
|---|---|---|---|
| R7-1 | High | One crafted email (huge HTML of "<" characters, or a giant address header) took seconds to minutes to read, stalling all mailbox work and retrying forever | HTML is cut to 2 MB and read with linear-time scanning; address headers are split and checked piece by piece; a test confirms the same inputs now take milliseconds |
| R7-2 | Medium | Mail trashed or deleted while Gmail's history had expired (or when labels were re-chosen) stayed in Huis | Each message records when sync last saw it; when a fresh import finishes, anything it didn't see is marked removed |
| R7-3 | Medium | A very large batch of changes was cut short and the rest silently skipped | Nothing is dropped: an oversized batch triggers a fresh import instead |
| R7-4 | Low-Medium | Endless empty pages kept the worker busy | Same guard as Outlook: a long run of empty pages stops the sync with an error |
| R7-5 | Low | Error messages could quote text from the mail service (possibly mail content or a token) | Errors are fixed phrases; only Google's and Microsoft's short error codes are kept (applied to Outlook too) |
| R7-6 | Low | One malformed message stopped the whole mailbox syncing | Messages are read defensively; one Huis can't read is kept as "(message Huis couldn't read)" and can still be filed from the original |
| R7-7 | Low | With a "mail since" date, mail with no date got in | Undated mail stays out when a date is set (applied to Outlook too) |
| R7-8 | Low | An unreadable saved position failed every sync | Huis starts a fresh import instead |
| Also | Low | Long rate-limit waits; large raw-message memory; re-imports whenever a new label appeared; unverified Google email used as a fallback | Waits capped at 10 seconds; raw message limit cut to Gmail's real maximum; "whole mailbox" no longer re-imports on new labels; the email address is used only if Google verified it |

## Eighth review — Phase 4 part 1 (Matter Brain)

**Scope:** attorney notes, the Matter Brain index, Ask this Matter, saved answers, the AI Gateway and its firm setting, the AI usage log.
**Result:** other firms, ethical walls and outside users held against direct database attacks. Clients who are members of a Matter saw nothing of the Brain, even for their own uploads. The app couldn't write passages or run worker steps. The reviewer confirmed 6 problems. **All fixed**, with regression tests (`test/brain.test.ts`, "review 8"); all 7 of the reviewer's attacks now fail.

| # | Severity | Finding | Fix |
|---|---|---|---|
| R8-1 | Medium-High | A client could upload text with no real words (e.g. spelled out in single letters) whose meaning fingerprint was empty; the comparison came out as "not a number", which ranked it first, so it appeared at the top of every attorney's answer | Empty or invalid fingerprints are never stored, a comparison that isn't a normal number never ranks a passage, and a question with no meaningful words uses word matching only |
| R8-2 | Medium | "Withheld" answers were hidden only by the app; the asker could still read the answer and stored excerpts through the database | Saved answers keep references only (no copies of passages). The database itself withholds an answer once any source is unavailable to the asker. Deleting a note deletes the answers built on it |
| R8-3 | Low-Medium | Staff could write made-up rows into the AI usage log (other Matters, any text, any size) | The app can't write the log directly; Huis logs through a checked function (Matter must be visible, known provider and model only, sizes bounded) |
| R8-4 | Low | An administrator outside an ethical wall could see AI activity (who, when, how much) on the walled Matter | Administrators see usage only for Matters they can see |
| R8-5 | Low | Administrators could change the AI setting (and, from Phase 3, the mail filing mode) directly, without the audit record | These settings can only change through their audited settings |
| R8-6 | Low | Someone made read-only could still delete their old notes | Read-only staff can't delete notes |
| Also | Low | One firm's indexing backlog could hold up others (and mailbox sync); unchanged notes were re-indexed; very large documents showed as fully "ready" | Indexing takes turns between firms and runs after mailbox sync; only real changes re-index a note; very large documents are shown as "only partly included" |

**Noted:** "Expert consultant" is a firm-side role (a consulting expert retained by the firm, whose work is protected work product), so it is treated as firm staff. Outside experts (expert witnesses) are not, and never see the Brain. The built-in AI is on by default because it sends nothing outside Huis; administrators can turn it off.

## Ninth review — Phase 4 part 2 (Case DNA™)

**Scope:** the Case DNA map (people, events, claims, elements, facts, damages, links, citations), Huis's suggestions, claim templates, finding evidence for elements, and the Case DNA pages.
**Result:** outside users, read-only staff and administrators outside a wall were kept out. History couldn't be rewritten: forged decisions were overwritten with the real person and time. The worker's suggestion step resisted hostile input, the return-path field couldn't be used to redirect elsewhere, and nothing renders raw HTML. The reviewer confirmed 8 problems. **All fixed**, with regression tests (`test/dna.test.ts`, "review 9"); all 8 of the reviewer's attacks now fail.

| # | Severity | Finding | Fix |
|---|---|---|---|
| R9-1 | High | A database change with **no conditions** (e.g. "delete all citations") skips the "what can you see" rule and is checked only against "what can you change". Staff could use this to bring back items hidden because their evidence was no longer clean, or to change links whose other end they couldn't see | Every change rule now repeats the visibility rule, so even an unconditional change only reaches what the person can see. Only citations an attorney added can be removed |
| R9-2 | Medium | People suggested from a filed email stayed on the map after that email was found to be unsafe | Each suggested person is cited to every email they came from, and leaves the map when none of those emails is still clean |
| R9-3 | Medium | Staff could attach a made-up quote to a real document | A citation's quote is always taken from the source itself; a position that isn't in the source is refused |
| R9-4 | Low-Medium | Staff could reword a Huis suggestion so it still looked like Huis's | Suggestions can't be changed until someone confirms them |
| R9-5 | Low-Medium | One email with many recipients could flood people suggestions and choose their names (e.g. "Judge Reyes chambers") | At most 20 people per email and a limit per Matter; suggested people are named by email address, with the name each email gave kept beside that email |
| R9-6 | Low | A flood of suggestions could push confirmed items off the list | Confirmed items always come first, and very large maps say they are cut off |
| R9-7 | Low | Another firm could tell whether an item id existed (from different answers or error messages) | Those checks now answer the same for another firm's items as for made-up ones |
| R9-8 | Low | Finding dates in a deliberately built document took about 4 seconds | Only a fixed number of date-like matches are examined per document |

**Lesson applied going forward:** every database rule that allows a change must also include the rule for seeing the row, because PostgreSQL applies the "see" rule only when a change reads rows (a WHERE clause or a returned value). Earlier tables were checked against this: their change rules already limit people to rows they own or can see.

## Tenth review — Phase 4 part 3 (full export of a Matter)

**Scope:** the export of a whole Matter (who can export, what goes in, the ZIP itself, file names, the manifest spreadsheet, chain-of-custody and audit records, and the download route).
**Result:** walls, read-only staff, outside users and other firms were kept out, and the export never included another person's private Matter Brain questions. The reviewer confirmed 7 problems and raised 1 suspicion. **All fixed**, with regression tests (`test/export.test.ts`, "review 10"); all 10 of the reviewer's attacks now fail.

| # | Severity | Finding | Fix |
|---|---|---|---|
| R10-1 | High | Access was checked once, when the export started. Someone taken off the Matter or disabled during a long download, or a file found infected meanwhile, could still receive originals; a refused text file came back empty and the ZIP still looked complete | Before **every** item, Huis checks again (as that person, in a fresh database session) that they can still export the Matter and the item is still clean. If not, the download stops with an error. Each item's text now follows its original, and a missing text stops the download rather than producing an empty file |
| R10-2 | Medium | Invisible and direction-changing characters survived into file names (e.g. a name that displays as a PDF but is really a program) | Those characters, and broken half-characters, are removed from names in the export |
| R10-3 | Medium | Some spreadsheet cells could still run as formulas (a leading space or line break, full-width ＝＋－＠, or a `;` separator) | Every cell is quoted, and any value whose first visible character is a formula sign gets a leading apostrophe |
| R10-4 | Low-Medium | Shortening a long name could leave a trailing dot or space (which Windows drops, so two files could collide) or cut an emoji in half | Names are shortened by whole characters and tidied again afterwards; text file names get the same limit |
| R10-5 | Low | Names that Windows or macOS treat as the same (e.g. σ and ς, ﬁ and fi) weren't told apart | Names are compared the way those systems compare them, and given "(2)" when they would collide |
| R10-6 | Low | Some Windows device names (COM¹, LPT², CONIN$, CONOUT$) weren't recognised | Recognised and renamed |
| R10-7 | Low | Someone allowed to export could write "exported" chain-of-custody entries directly, with no audit record | The database step that records custody also writes the audit entry itself, so neither can exist without the other; each export number can be used once |
| R10-8 | Suspected | If saving the export records failed at the last moment, the download could in principle still start | The download starts only after the records are saved |

## Eleventh review — Phase 5 part 1 (Master Timeline)

**Scope:** the Master Timeline: the new `dna_nodes.categories` column and its database rules, the timeline service, the category rules, the category editor, the return links, the chronology download route, and the change to the export.
**Result:** no access-control break. The reviewer couldn't get the timeline, its emails, counts, people or download as a client, from outside an ethical wall, from another firm, or (for changes and the download) as read-only staff, through the service or direct SQL. Infected and duplicate email stayed off the timeline, categories couldn't be planted on Huis's suggestions, and every CSV column resisted formula tricks. The reviewer confirmed 2 problems and raised 5 suspicions; the 3 that were worth acting on are fixed. Regression tests are in `test/security-review-11.test.ts` (8 tests). Each fails without its fix.

| # | Severity | Finding | Fix |
|---|---|---|---|
| R11-1 | Medium | Reading email addresses for the timeline could take time growing with the square of an address's length. A filed mailbox whose emails each had 100 long malformed addresses made a 40-email timeline take 2.5 seconds; at the timeline's limit of 5,000 emails, every page view and download would block the server for minutes | Only the address that ends the header counts, and a bare address must be the whole value. Matching is anchored and bounded (5,000 malformed addresses take milliseconds) |
| R11-2 | Low-Medium | An email whose sender name contained someone else's address (`"Pat Smith <pat@…>" <mallory@…>`) was put on the timeline as Pat's: listed with Pat, found by the Pat filter, and filed under Plaintiff. Huis's people suggestions from email (Phase 4) had the same flaw | The same rule as R11-1, both on the timeline and in the worker's people suggestions (`0015_timeline.sql`). The person is the one the email was actually sent from or to |
| R11-3 | Suspected | The download route read the request body before checking where the request came from and who sent it | The form is read only after those checks, and anything over 64 KB, or of unknown size, is refused unread |
| R11-4 | Suspected | A very long cell (an item with many long quotes) could exceed a spreadsheet's 32,767-character cell limit and spill into the next cell, past the formula guard | Cells in the download are shortened to 32,000 characters and marked "(shortened)" |
| R11-5 | Suspected (cosmetic) | Search words containing `*` broke the link back to the timeline after Confirm or Reject | The return link accepts them |

**Accepted, not changed:**
- If an original email is later found infected, its byte-identical duplicate (itself clean) appears on the timeline. The evidence list already shows it, so nothing new is revealed.
- On extremely large Matters, the 50,000-row limits on citations and links could list an item as having no source. This is noted for Phase 5 part 2.

## Twelfth review — Phase 5 part 2 (contradiction engine)

**Scope:** the contradiction engine: the statement rules, comparison with the timeline, confidence, confirming (the Case DNA items and citations it writes), rejecting and reconsidering, the decisions table and its database rules, and the page.
**Result:** no access-control break. Clients, read-only staff, people outside a wall and other firms were kept out, in the service and in direct SQL. Keys don't travel between Matters, and nobody can record a decision as someone else. The reviewer confirmed 9 problems, mostly about Huis citing or weighing evidence wrongly, which matters as much as access for a tool attorneys rely on. **All fixed.** Regression tests are in `test/security-review-12.test.ts` (15 tests) and `test/contradictions.test.ts`. Each fails without its fix.

| # | Severity | Finding | Fix |
|---|---|---|---|
| R12-1 | High (availability) | One long document of short denials ("I don't recall…"), or a long real deposition, made the page and every decision take 24–40 seconds for everyone on the Matter | At most 500 statements per reading. Each item's words are worked out once and looked up by topic, instead of re-reading every email for every statement. A decision works out only its own statement |
| R12-2 | Medium | Indented, line-numbered transcripts were cited a few characters off, because the Matter Brain's passages (Phase 4) kept their untrimmed start | Passage positions are now exactly where their text starts and ends. Confirming checks that the database's quote is the statement's exact words, or saves nothing |
| R12-3 | Medium | Emoji or other characters outside the basic range before a statement shifted its citation, because JavaScript and the database count positions differently. Phase 4's "add as a fact" had the same flaw | Positions are converted to characters before citing (`src/services/cite.ts`), for both |
| R12-4 | Medium | An email not yet in the Matter Brain became an **uncited** fact, which then stayed in Case DNA after the email was found infected | Every email fact is cited: to its passage about the subject, or else to its subject line. An item that can't be cited is left out, and nothing is saved if no item can be cited |
| R12-5 | Medium | Confirming acted on whatever the flag had become since the attorney looked, confirming Huis's suggestions they never saw | The page sends a fingerprint of what was shown. A changed flag is refused with "please review it again", and nothing is saved |
| R12-6 | Low | A hand-made "confirmed" decision (direct SQL) could hide a flag forever | The database accepts a confirmation only for a cited statement with evidence linked "contradicts" to it. A confirmation whose statement was later deleted can be decided again |
| R12-7 | Low-Medium | The claimed date came from the first date-like phrase ("the email sent on March 3 … until May 4" read as March 3) | "until / before / prior to" always wins; "in / on" counts only after "first learned / heard …" |
| R12-8 | Low-Medium | Items with no source each counted as a separate source (three unsourced notes gave High confidence) | Only cited evidence counts toward confidence, and the explanation says how many items have no source yet |
| R12-9 | Low | An item citing both the statement's own document and another source counted the statement's document as corroboration | The statement's own document (and its versions) never counts |

Also fixed while reviewing: overlapping passages could produce a second, cut-short copy of a statement, so within a document a statement overlapping a longer one is now the same statement.

**Accepted, not changed:**
- A rejection is tied to the statement, so stronger evidence arriving later doesn't bring a rejected flag back; **Reconsider** does.
- Keys include the statement's position, so re-reading a document (for example after the R12-2 fix) can bring back a flag that was rejected before.
- "until May" takes the latest year written in the same document. The explanation shows the year it used, so a wrong guess is visible.

**Found in passing (Phase 4, tracked):** if a queued Matter Brain source stops being clean before it is indexed, one indexing pass can stop early and leave later sources waiting until the next pass. Nothing is lost or exposed; indexing is only delayed.

## Thirteenth review — Phase 6 part 1 (AI Workspace and Prompt Library)

**Scope:** saved AI conversations and sharing (including the replaced rule for who may read Matter Brain answers), the conversation-count function, the Prompt Library, the pages, and every place that reads saved answers.
**Result:** no read leak. Clients, other firms, people outside a wall (including walls added after sharing) and disabled users got nothing. "My questions" and the Matter export stayed limited to the person's own answers. Prompts kept their scope and owner, and other people's personal prompts couldn't be prefilled. The reviewer confirmed 2 integrity problems, both through direct database access as the app. **Both are fixed.** Regression tests are in `test/security-review-13.test.ts` (7 tests). Each fails without its fix.

| # | Severity | Finding | Fix |
|---|---|---|---|
| R13-1 | Medium-Low | Someone walled out of a Matter could still delete the team's shared conversations, and their answers, there with a delete that had no conditions (the Phase 4 rule for answers had the same gap, which mattered once answers could be shared). The R9-1 pattern | Both delete rules now also require being able to see the Matter |
| R13-2 | Medium | A conversation's owner could write a made-up "Matter Brain" answer straight into the database, with a fake quote cited to a real document and a backdated time, and colleagues would read it as Huis's | The database now rebuilds every saved answer's citations and sources from the passages it cites (only passages of that Matter the asker can open) and stamps the time itself. For the built-in AI, the answer must be in the built-in form and every quoted line must be words the cited passage contains. Any other provider is refused until Phase 6 part 4 adds one deliberately |

**Also fixed:** a conversation with more than 500 answers would have counted the extra ones as withheld.

**Carried into Phase 6 part 4 (outside providers):**
- Saved answers list only the passages they quote. That is right for the built-in AI, which quotes only what it cites. A provider that writes answers may draw on passages it doesn't cite, so its answers must keep every passage they were given as sources, so they are withheld when any becomes unavailable.
- Each provider also needs its own check in place of the built-in one.

**Accepted, not changed:**
- Firm prompts are visible to all firm staff, including people walled off from every Matter. The page warns against putting client details in them.
- Audit entries are written by the app, so direct database writes don't produce them (true across Huis).
- An owner removed from a Matter can no longer change or unshare their conversations there.

## Fourteenth review — Phase 6 part 2 (specialized agents)

**Scope:** the AI Router, each agent, agent turns and their database rules, the conversation page, and the timeline and contradiction services the agents reuse.
**Result:** no read leak. Agent answers only ever contained what the reader could open: walled Matters, other firms, infected or walled items and planted settings all came up empty. Turns couldn't be planted, back-dated, changed or moved, and the audit log held only the agent's name. The reviewer confirmed 10 problems, five of them misleading answers for attorneys. **All fixed.** Regression tests are in `test/security-review-14.test.ts` (14 tests) and `test/agents.test.ts`. Each fails without its fix.

| # | Severity | Finding | Fix |
|---|---|---|---|
| R14-1 | Medium | An email address in a question matched a *different* person whose address is part of it (sal@… went to "Al") | Addresses are read whole and matched exactly; if two people fit, nobody is picked |
| R14-2 | Medium | Ordinary words in names captured questions ("The Widget Company" took every question with "the"), silently narrowing results to that organization | Names match on all their words, or on a distinctive word written with a capital letter; common words ("the", "company", "bank", "price"…) never name anyone alone |
| R14-3 | Medium | "After the March 3, 2026 hearing" was read as that single day | "After / since / before / until" are read from the whole clause before the date |
| R14-4 | Low-Medium | "In March 2026" or "in 2025" was ignored, so the whole Matter's timeline came back as the answer | Months and years become date ranges; a month without a year is said in the explanation instead of being silently ignored |
| R14-5 | Medium | A non-subject word ("please", "lawsuit") narrowed the timeline to nothing, shown as "Nothing matches" | More such words are ignored. Every narrowing is now said ("Narrowed to 3 of 12 that mention …"), and if subject words would remove everything, all items are shown with a note |
| R14-6 | Medium | On very large Matters the timeline read only the first 5,000 items, oldest first, so the dates asked about could be cut off without a word | The date range is applied in the database before the read limit (this also fixes the Timeline page), and the agent says when a Matter is too large to read in full |
| R14-7 | Low-Medium | After 200 questions, newer ones disappeared | The newest questions are always listed, with a count of earlier ones |
| R14-8 | Medium (availability) | Every view re-ran every agent turn, so a conversation full of questions made each colleague's page do hundreds of full timeline or contradiction runs | Only the newest 5 turns are worked out on each view; older ones show "Show answer" and run when opened. Identical questions are worked out once, and the email text read to narrow by subject is bounded |
| R14-9 | Low | A turn's saved explanation kept a Case DNA person's name after that person's only source was found infected | The saved reason names nothing from Case DNA. Names are looked up for each reader, and one no longer available shows as "a person no longer available to you" |
| R14-10 | Low | With AI turned off for the firm, agents still answered (the page hid the box, but the action didn't check) | Agents follow the firm's AI setting like the Matter Brain |

**Accepted, not changed:**
- Slash dates are read US-style (month/day), as Huis serves US firms first.
- A question with two or more dates uses the first two as a range.
- The privilege agent lists items by where they're filed, so an item still waiting for its virus scan isn't listed yet.

## Fifteenth review — Phase 6 part 3 (Matter analysis and Reanalyze Matter)

**Scope:** the Matter analysis, Reanalyze Matter, the retry function, the analysis records and their database rules, and the Matter page's "new since" line.
**Result:** no read leak. Clients, other firms, walled-out staff (administrators included) and read-only staff were kept out, in the service and the database. The reviewer confirmed 8 problems: misleading counts or steps, unlimited retries, and free text in a "numbers only" record. **All fixed.** Regression tests are in `test/security-review-15.test.ts` (10 tests). Each fails without its fix.

| # | Severity | Finding | Fix |
|---|---|---|---|
| R15-1 | Medium | A document the Matter Brain's worker died on after its last allowed attempt showed as "Being added" forever, with no next step, and Reanalyze couldn't retry it | Such a document counts as one Huis couldn't add, gets that next step, and Reanalyze retries it |
| R15-2 | Low-Medium | The retry function retried, and counted, documents the caller can't see (no longer clean), so its count disagreed with the analysis and quarantined items were requeued | Only clean evidence of the Matter and its notes are retried |
| R15-3 | Low-Medium (availability) | Reanalyze reset a failing document's attempts with no limit, so repeated clicks kept the worker retrying it forever | At most 3 manual retries per document, ever |
| R15-4 | Medium | Items whose virus scan failed got no next step, so the page could say "nothing needs attention" about evidence never scanned or read | A next step for them (and for partly read items, claims with no elements, and AI turned off with items waiting) |
| R15-5 | Low-Medium | Claims after the 50th were silently left out | Up to 200 are checked, and a step says when there are more |
| R15-6 | Low | The "numbers only" record accepted any text as a key, so content could be written where all staff on the Matter read it, and a period could be started without retrying anything | The app can no longer write records at all. One database step (`reanalyze_matter`) retries, counts and records the moment, with only its three counts as whole numbers |
| R15-7 | Low-Medium | An item that arrived while Reanalyze was running was never counted as new | "New since" is today's count less what that analysis itself counted |
| R15-8 | Low-Medium | Counts on very large Matters were silently capped at 5,000 | Counted in the database; the contradiction check says when only part of a Matter could be checked |

**Accepted, not changed:**
- Every view of the analysis re-runs the contradiction check and each claim view. This is bounded, as in review 14, and not measured as a problem yet.
- The evidence total includes items found inside others (attachments), while "new since" counts what was added.
- An element counts as supported by a confirmed fact even when that fact has no source; the Claims matrix flags that gap separately.

## Sixteenth review — Phase 7 part 1 (claims matrix and legal authority library)

**Scope:** the legal authority library and its verification, citing authorities in Matters, the claims matrix, the pages, and the database rules for both tables.
**Result:** no confidentiality leak. Firm isolation, walls, clients and read-only staff held, in the service and in direct SQL. Links were safe (only https, and no spoofing of the official-source badge through look-alike or trick hosts). The reviewer confirmed 6 problems with verification and the integrity of citations. **All fixed.** Regression tests are in `test/security-review-16.test.ts` (11 tests) and `test/authorities.test.ts`. Each fails without its fix.

| # | Severity | Finding | Fix |
|---|---|---|---|
| R16-1 | Medium-High | Staff who aren't attorneys (billing, legal assistants, paralegals) could mark an authority "Verified" | Only attorneys, firm owners and managing partners verify, in the service and the database; others don't see the button |
| R16-2 | Medium | Changing a verified authority's name, court, year or jurisdiction kept its verification | Any change to what the authority is (everything but its note) clears it |
| R16-3 | Medium | Someone walled out of a Matter could rewrite an authority that Matter cites (told it was "cited nowhere"), so the walled Matter's proposition would sit under a different case | An authority cited in any Matter, seen or not, can't be changed into a different one; the corrected one is added as a new authority |
| R16-4 | Medium-Low | A verification landed on whatever the authority said when the button was clicked, even if it had changed since the attorney looked | The page sends what the attorney checked; if the authority changed meanwhile, nothing is verified and they're asked to check again |
| R16-5 | Low | The audit log recorded verifications that didn't happen (already verified, or nothing to withdraw) | Recorded only when something changes |
| R16-6 | Low | The same citation could be added twice by varying its spacing or characters | Citations are normalized (character forms, any whitespace) in the service, and compared that way by the database |

**Also changed:**
- An impossible year is refused rather than silently dropped.
- The note field says the whole firm sees it.
- The matrix says when a Matter has more than 200 claims to show.

**Accepted, not changed:**
- **Contrary authority:** authority cited as cutting against an element is shown, but isn't counted as a gap. An authority cited as "explains" counts as authority cited.
- **The library is firm-wide by design.** Its note field now warns, and an attempted removal can reveal (one yes/no) that a Matter you can't see cites an authority.

## Still open (tracked, not code defects)
1. **MFA enforcement** — Microsoft sign-in doesn't yet require proof of MFA. Plan: require the firm's Microsoft MFA (Conditional Access) or a Huis passkey. Part of the end-of-build Azure/hosting step.
2. **Administrator-level tampering** — someone with full database superuser access could switch off the protective rules and rewrite history consistently. The hash chains make ordinary tampering detectable, but defeating a superuser needs the chain's latest fingerprint stored outside the database (e.g. a daily signed export). Planned with production hosting.
3. **License limits** — admins can add licenses freely until billing (Phase 10) enforces seat counts.
