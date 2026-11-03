# Phase 3 — Huis Inbox (Email Intelligence)

**Status:** Part 1 (Outlook connection, sync, search, filing, color coding) built and tested; under independent security review.

## Plan
| Part | What | Status |
|---|---|---|
| 3.1 | Connect Outlook, whole mailbox or chosen folders, continuous sync ("Let Huis manage"), email search, file email into Matters, matter colors | Built, in review |
| 3.2 | Matter suggestions (case numbers, Huis numbers, people, threads, then AI), Manual / Assisted / Automatic filing, court-notice detection hooks | Next |
| 3.3 | Gmail, built the same way | After Google verification (see below) |
| Later | Semantic ("meaning") search across email, with the AI layer in Phase 6 | Phase 6 |

## Part 1 — what exists

| Area | What Huis does |
|---|---|
| Connecting | **Connect Outlook** asks Microsoft for read-only access to the signed-in staff member's own mailbox (`Mail.Read`, plus `offline_access` to keep syncing). Huis can read mail but cannot send, change or delete it. The connection is tied to that Huis user and firm; the same mailbox can't be connected by someone else in the firm. Accounts are identified by Microsoft's tenant and user ids, never by email address |
| Credentials | Microsoft's refresh token is encrypted (AES-256-GCM) with a key derived per firm for mail credentials, and bound to that mailbox. The app can't read it back; only the background worker can, through one database function. Access tokens exist only in memory during a sync, and are only ever sent to Microsoft Graph: paging links from Microsoft are checked before the token is attached |
| What's brought in | The whole mailbox by default (every folder, new folders included automatically), or only chosen folders; optionally only mail received on or after a date |
| Syncing | Folder by folder using Microsoft's change ("delta") links: the first sync imports everything in batches, later syncs fetch only what changed. Deleted email is marked as removed. Progress is saved after every page. With **Let Huis manage** on, Huis syncs every 5 minutes; otherwise when someone presses **Sync now**. Throttling from Microsoft is respected. If Microsoft access expires, the mailbox shows **Needs reconnecting** |
| Privacy | **Unfiled email is visible only to the mailbox's owner and the people they choose** (e.g. an assistant). Firm owners and administrators can't see it. Enforced by the database (row-level security) |
| Search | Words, exact phrases in quotes, `or`, `-exclude`, and addresses, across subject, people and body. Searches and opened emails are written to the audit log |
| Filing | **File email** copies the original message exactly as Outlook holds it (MIME) into a Matter folder as evidence: encrypted, fingerprinted, virus-scanned, read and searchable, with each attachment split out as its own item. Its chain of custody records the mailbox, the message's internet id, when it was received, who filed it and when it was retrieved. Filing needs permission to add to that Matter; walled Matters are refused; folders outsiders can see need the privilege acknowledgement |
| Color coding | Each Matter can have a color; filed email shows its Matter's color in the inbox |
| Disconnecting | Deletes Huis's Microsoft credentials and every unfiled email from Huis. Filed copies stay in their Matters |

**Tests:** `test/inbox.test.ts`, 12 tests against a stand-in Microsoft service (no real mail is ever used in development): connect flow and ID-token checks, encrypted and bound credentials, full and incremental sync, deletions, selected folders and date limits, token rotation and expiry, refusing to send tokens to other hosts, privacy from firm owners/other staff/clients/other firms, delegation, search, filing with custody and attachments, walls and privilege acknowledgement, disconnecting, colors. Also exercised in a real browser against a production build.

## Needed from the end-of-build Azure step
- Add the redirect address `https://<huis domain>/api/mailboxes/microsoft/callback` (and `http://localhost:3000/api/mailboxes/microsoft/callback` for development) to the Huis app registration.
- Add delegated Microsoft Graph permissions **User.Read** and **Mail.Read**. Some firms' Microsoft 365 administrators must approve apps that read mail ("admin consent") — Huis should provide a one-page explanation for firm IT.
- Publisher verification (already on the deferred list) so the consent screen shows a verified publisher.

## Gmail: start Google verification now
Reading Gmail requires Google's **restricted** scopes, which require Google's app verification **and an annual CASA security assessment** by an approved assessor before any firm outside a test list can connect. This takes weeks and has a cost (open item O-4: owner and budget). Decide the scopes once, including future sending, because changing them later forces customers to re-consent and can trigger a new assessment.
