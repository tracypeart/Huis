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

## Still open (tracked, not code defects)
1. **MFA enforcement** — Microsoft sign-in doesn't yet require proof of MFA. Plan: require the firm's Microsoft MFA (Conditional Access) or a Huis passkey. Part of the end-of-build Azure/hosting step.
2. **Administrator-level tampering** — someone with full database superuser access could switch off the protective rules and rewrite history consistently. The hash chains make ordinary tampering detectable, but defeating a superuser needs the chain's latest fingerprint stored outside the database (e.g. a daily signed export). Planned with production hosting.
3. **License limits** — admins can add licenses freely until billing (Phase 10) enforces seat counts.
