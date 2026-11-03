# Phase 3 — Huis Inbox (Email Intelligence)

**Status:** Parts 1 and 2 merged after independent security reviews 5 and 6. Part 3 (Gmail) built and tested; under independent review. Gmail works for Google test users now; connecting other firms' Gmail needs Google's verification and CASA assessment (below).

## Plan
| Part | What | Status |
|---|---|---|
| 3.1 | Connect Outlook, whole mailbox or chosen folders, continuous sync ("Let Huis manage"), email search, file email into Matters, matter colors | Merged |
| 3.2 | Matter suggestions (case numbers, Huis numbers, people, threads; AI later), Manual / Assisted / Automatic filing | Merged |
| 3.3 | Gmail, built the same way | Built, in review (live for outside firms after Google verification) |
| Later | Semantic ("meaning") search across email, with the AI layer in Phase 6 | Phase 6 |

## Part 1 — what exists

| Area | What Huis does |
|---|---|
| Connecting | **Connect Outlook** asks Microsoft for read-only access to the signed-in staff member's own mailbox (`Mail.Read`, plus `offline_access` to keep syncing). Huis can read mail but cannot send, change or delete it. The connection is tied to that Huis user and firm; the same mailbox can't be connected by someone else in the firm. Accounts are identified by Microsoft's tenant and user ids, never by email address |
| Credentials | Microsoft's refresh token is encrypted (AES-256-GCM) with a key derived per firm for mail credentials, and bound to that mailbox. The app can't read it back; only the background worker can, through one database function. Access tokens exist only in memory during a sync, and are only ever sent to Microsoft Graph: paging links from Microsoft are checked before the token is attached |
| What's brought in | The whole mailbox by default (every folder, new folders included automatically), or only chosen folders; optionally only mail received on or after a date |
| Syncing | Folder by folder using Microsoft's change ("delta") links: the first sync imports everything in batches, later syncs fetch only what changed. Deleted email is marked as removed. Progress is saved after every page. With **Let Huis manage** on, Huis syncs every 5 minutes; otherwise when someone presses **Sync now**. Throttling from Microsoft is respected. If Microsoft access expires, the mailbox shows **Needs reconnecting** |
| Privacy | **Unfiled email is visible only to the mailbox's owner and the people they choose** (e.g. an assistant). Firm owners and administrators can't see it, and the audit log they can read records only that a search happened, never what was searched. Access follows later changes: a delegate made read-only loses access, and a mailbox whose owner leaves the firm can't be read and stops syncing. Enforced by the database (row-level security) |
| Search | Words, exact phrases in quotes, `or`, `-exclude`, and addresses, across subject, people and body. Searches and opened emails are written to the audit log |
| Filing | **File email** copies the original message exactly as Outlook holds it (MIME) into a Matter folder as evidence: encrypted, fingerprinted, virus-scanned, read and searchable, with each attachment split out as its own item. Its chain of custody records the mailbox, the message's internet id, when it was received, who filed it and when it was retrieved. Filing needs permission to add to that Matter; walled Matters are refused; folders outsiders can see need the privilege acknowledgement. Permission is checked again when the filing runs, so someone who loses access in the meantime can't complete it |
| Color coding | Each Matter can have a color; filed email shows its Matter's color in the inbox |
| Disconnecting | Deletes Huis's Microsoft credentials and every unfiled email from Huis. Filed copies stay in their Matters |

**Tests:** `test/inbox.test.ts`, 19 tests against a stand-in Microsoft service (no real mail is ever used in development): connect flow and ID-token checks, encrypted and bound credentials, full and incremental sync, deletions, selected folders and date limits, token rotation and expiry, refusing to send tokens to other hosts, privacy from firm owners/other staff/clients/other firms, delegation, search, filing with custody and attachments, walls and privilege acknowledgement, disconnecting, colors. Also exercised in a real browser against a production build.

## Part 2 — matter suggestions and filing modes

**Suggestions.** Each email gets up to five suggested Matters, each with plain reasons. Only Matters the person can see *and* add to are considered (walls apply), so a suggestion never reveals a Matter someone can't access. Closed and archived Matters are skipped.

| Signal | Strength |
|---|---|
| The Matter's Huis number appears in the email | Strongest |
| The Matter's court case number appears in the email (spacing and dashes ignored) | Strong |
| An earlier email in the same conversation was filed in that Matter | Strong |
| The client is on the email | Likely |
| A contact linked to the Matter (e.g. opposing counsel) is on the email | Likely |
| Someone else from the client's or a contact's organization is on the email (Gmail, Outlook.com and other public domains don't count) | Possible |
| The Matter's title is in the subject | Possible |

**Filing modes** (set by a firm administrator on the Inbox page):
- **Manual** — suggestions are shown; people choose the Matter and folder.
- **Assisted** (default) — **File here** next to a suggestion files the email into that Matter's internal *Correspondence* folder in one click.
- **Automatic** — Huis files email by itself, but only when **all** of these hold:
  - the mailbox owner has turned on automatic filing for their own mailbox, with "Let Huis manage" on;
  - the email arrived after automatic filing was turned on (history is never filed automatically);
  - the Matter is one the owner is on (as owner or editor), not just one they could add to;
  - the match is strong (Huis number, court case number, or same conversation) **and** the client or a contact linked to the Matter is on the email, because anyone can type a case number into an email;
  - no other Matter the owner can add to scores within 10 points;
  - the target is the Matter's internal Correspondence folder, never a folder clients or other outsiders can see.

  Each filing is checked again, as the owner, when it runs. If the firm or the owner switches automatic filing off, filings already queued are dropped.

**Matching numbers.** Huis and court case numbers are matched as whole numbers, ignoring spacing and dashes. So 2:24-cv-0123 doesn't match inside 2:24-cv-01234, and a case number doesn't match inside a phone number. A court case number needs at least six letters or digits, including at least two digits.

Every one-click or automatic filing records its reasons and method in the email's chain of custody. AI-based suggestions arrive with the AI layer (Phase 6) and will add to these signals rather than replace them.

## Part 3 — Gmail

Gmail works like Outlook: the same privacy, search, suggestions, filing modes, chain of custody and permission checks. What differs:

| Area | Gmail |
|---|---|
| Connecting | **Connect Gmail** asks Google for read-only access to the signed-in staff member's own Gmail (`gmail.readonly`, plus sign-in). If someone unticks the Gmail permission on Google's consent screen, Huis refuses the connection and says why. The account is identified by Google's stable account id, never by email address |
| Labels | Labels are shown as folders: Inbox, Sent, Starred, Important, the firm's own labels (nested labels like "Clients/Smith" keep their nesting), and "No label (archived)". An email with several labels appears under the first chosen label in that order. **Spam, Trash and Drafts are never brought into Huis** |
| Syncing | The first sync imports the mailbox in pages; later syncs use Gmail's change history (new, deleted, trashed and relabelled email). If the history is too old (Gmail keeps about a week), Huis imports again. Choosing different labels starts a fresh import |
| Filing | Huis files the original message exactly as Google holds it (raw MIME), with the same custody record as Outlook |
| Safety | Every Gmail address Huis calls is built by Huis; paging tokens from Google are checked and an unexpected one stops the sync with an error rather than being followed or silently skipping mail. Tokens are sent only to Google's sign-in and Gmail hosts. An expired Google grant marks the mailbox **Needs reconnecting** |

**Tests:** `test/gmail.test.ts`, 12 tests against a stand-in Google service: consent request, ID token checks (nonce, audience, issuer), refusing connections without Gmail permission, encrypted bound credentials, labels and folder choice, Spam/Trash/Drafts excluded, HTML mail read as text, change history, expired history, chosen labels, exact original on filing, reconnect, bad paging tokens, privacy, and hostile message content. Also checked in a real browser.

**Needed from Google before outside firms can connect** (until then, up to 100 named test users can):
- A Google Cloud project with an OAuth client ("Web application"). Add the redirect `https://<huis domain>/api/mailboxes/google/callback` (and `http://localhost:3000/api/mailboxes/google/callback` for development). Store `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in the secret vault, never in code or chat.
- OAuth consent screen with the scopes above, Google's app verification, and the CASA security assessment (open item O-4: owner and budget).
- Note: while the app is in Google's "testing" mode, Google expires test users' access after 7 days, so they will be asked to reconnect weekly. This goes away once the app is verified.

## Needed from the end-of-build Azure step
- Add the redirect address `https://<huis domain>/api/mailboxes/microsoft/callback` (and `http://localhost:3000/api/mailboxes/microsoft/callback` for development) to the Huis app registration.
- Add delegated Microsoft Graph permissions **User.Read** and **Mail.Read**. Some firms' Microsoft 365 administrators must approve apps that read mail ("admin consent") — Huis should provide a one-page explanation for firm IT.
- Publisher verification (already on the deferred list) so the consent screen shows a verified publisher.

## Gmail: start Google verification now
Reading Gmail requires Google's **restricted** scopes, which require Google's app verification **and an annual CASA security assessment** by an approved assessor before any firm outside a test list can connect. This takes weeks and has a cost (open item O-4: owner and budget). Decide the scopes once, including future sending, because changing them later forces customers to re-consent and can trigger a new assessment.
