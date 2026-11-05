# Phase 9 — Integration Hub

**Status:** Part 1 (the hub, and OneDrive / SharePoint import) merged after independent security review 19. Part 2a (Dropbox) built, tested and through independent security review 20 (1 problem confirmed, fixed for Dropbox and OneDrive). Part 2b (Google Drive) next.

## Plan
| Part | What | Status |
|---|---|---|
| 9.1 | **Integration Hub** (connections, sync records, imports into Matters with chain of custody) and **OneDrive / SharePoint**: browse your OneDrive and the SharePoint sites you follow, import chosen files into a Matter as evidence | Review 19 done, fixes in |
| 9.2a | **Dropbox**: browse your Dropbox and import chosen files into a Matter, like OneDrive | Review 20 done, fix in |
| 9.2b | **Google Drive**: Google's own file picker now (the `drive.file` permission: Huis can only open the files picked); full browsing like OneDrive once Google's restricted-scope security assessment is done (the same assessment Gmail needs) | Next |
| 9.3 | **Filevine, Clio and StrongSuit** adapters: link Matters, bring in documents, contacts and deadlines; StrongSuit's API connection and interface merger (O-1) | Needs partner or developer access |

## Part 1 — the hub and OneDrive / SharePoint

| Area | What Huis does |
|---|---|
| The hub | **Integrations** (in the menu, firm staff only) lists every system Huis plans to connect, what it would do, what access it needs and where it stands: *Available*, *Coming next*, or *Needs an agreement*. Every outside system plugs in through one adapter (`src/integrations/`); connections, sync records and imports are shared |
| Connecting | A staff member connects **their own** Microsoft 365 account. Huis asks Microsoft for read-only file access (`Files.Read.All`, delegated, plus sign-in basics) — never mail, never write access. The sign-in token is encrypted under a label of its own (a mailbox token can't stand in for it, or the reverse), stored where the web app can't read it back, and used only by the background worker |
| Private to its owner | Only the person who connected an account can browse it or import from it — not colleagues, not the firm's owner or administrators. The database enforces this. A connection Microsoft has accepted can't be taken over by a colleague; one that never worked goes to whoever really signs in with the account. Read-only staff and clients can't connect |
| Browsing | My files, folders, the SharePoint sites the person follows and their document libraries. The worker fetches each folder when it's opened (the page refreshes itself while it waits) and Huis keeps **only names, sizes, dates and versions** — never contents — for at most a few hundred folders per connection. Folder ids must be Microsoft's own shape, so nothing else can be asked of Graph |
| Importing | Choose a Matter and one of its folders, tick files, **Import**. Only files the worker listed in this connection can be named, so nothing else can be pulled in. Each file is copied exactly as stored, then **scanned, fingerprinted (SHA-256) and read like any upload**. A folder people outside the firm can see needs the same privilege-waiver acknowledgement as everywhere else |
| Chain of custody | *Imported from a connected system*: which system, account and organization, the file's own id, its version and last-modified date, where it lived ("/Documents/Smith/memo.docx"), who imported it, whether it went to a folder shared outside the firm, and when it was retrieved. The version recorded is checked again after copying, so it is the version whose bytes were copied. Where it lived (which can name other clients), the organization and the outside ids are shown only to firm staff |
| Sync records | Every imported file has a sync record linking the outside file (system, organization, id, version) to the Huis evidence, its direction (import) and status. **The same version of a file is imported into a Matter once**; a changed file comes in as its new version. Firm staff who can see the Matter (and the item) can see its sync records |
| Checked again | When the worker runs an import it checks again that the requester still owns the connection, is active staff, can add to the Matter (walls applied) and that the folder's sharing hasn't changed since the request. Disconnecting deletes the sign-in token and the listings and cancels waiting imports; files already imported stay in their Matters |
| Downloads | Microsoft answers a download with a short-lived link. Huis follows it only to Microsoft's own file hosts (SharePoint and OneDrive) over HTTPS and **never sends the sign-in token there**. Paging links must stay on Graph. Files up to the upload limit |
| Tokens | Microsoft may replace the refresh token; the worker saves the new one, only for the job it holds. A token Microsoft refuses marks the connection *Needs reconnecting* |
| Logs | The audit log records connecting, disconnecting and import requests (system, folder, how many files) — never file names, folder names or account addresses |

### Before it can be used
- **Microsoft:** the firm's existing Microsoft sign-in app needs the delegated `Files.Read.All` permission added (and admin consent in tenants that require it). Redirect URI: `<base URL>/api/integrations/onedrive/callback`.
- **Google Drive (9.2):** Google Cloud project with the Picker API and the `drive.file` scope.
- **Dropbox (9.2):** a Dropbox app (scoped access, `files.content.read`), production approval from Dropbox.
- **Filevine, Clio (9.3):** developer accounts / partner access.
- **StrongSuit (9.3):** discussions under way (O-1); StrongSuit supports an API connection and a user-interface merger.

**Security review 19:** see `SECURITY-REVIEW-2026-11.md`; regression tests in `test/security-review-19.test.ts` (12 tests).

**Tests:** `test/integrations.test.ts`, 13 tests: the hub (systems and status, clients refused); read-only file scopes; sealed tokens under the integration label, unreadable by the app, connections private to their owner (not the firm owner), no takeover of a working connection, read-only staff can't connect, no direct writes; browsing My files, folders, followed sites and their libraries (names and sizes only); folder ids of the wrong shape refused (service and database); importing as evidence with custody details and a sync record, download without the token; the same version once and a changed file again; only listed files (not folders or invented ids); edit access and the privilege acknowledgement; re-checks when the worker runs (lost Matter access, disconnecting); the app can't create integration evidence or sync records; the download-host check; rotated and refused tokens.

## Part 2a — Dropbox

| Area | What Huis does |
|---|---|
| Connecting | A staff member connects **their own** Dropbox. Huis asks for read-only permissions only (`account_info.read`, `files.metadata.read`, `files.content.read`); a sign-in that carries anything more isn't kept, and every access token is narrowed to those three. Sign-in uses PKCE and is bound to the person and firm |
| Whose account | The account is identified by Dropbox's own id, as Dropbox reports it. Before every listing or import the worker checks that the token still belongs to that account (also for OneDrive), so nobody can file a token under a colleague's account |
| Browsing | Folders and files from the top of the Dropbox, with the way up; names, sizes, dates and revisions only, up to 1,000 entries a folder |
| Importing | Exactly as OneDrive (Matter folder, privilege acknowledgement, scanning, fingerprint, custody, sync record, the same version once, checks again when the worker runs). Huis downloads the **exact revision it recorded**, so the custody record and the bytes always match. Errors: a refused sign-in needs reconnecting; a file that no longer exists fails just that import |
| Not yet | Dropbox team spaces (folders shared through a Dropbox Business team root) — only the person's own space for now |

### Before it can be used
A Dropbox app for the firm (scoped access, permissions `account_info.read`, `files.metadata.read`, `files.content.read`), with redirect URI `<base URL>/api/integrations/dropbox/callback`, approved for production by Dropbox. Set `DROPBOX_APP_KEY` and `DROPBOX_APP_SECRET` for the app and the worker.

**Security review 20:** see `SECURITY-REVIEW-2026-11.md`; regression tests in `test/security-review-20.test.ts` (6 tests).

**Tests:** `test/dropbox.test.ts`, 9 tests: read-only, offline, PKCE sign-in; the account identified by Dropbox's id, missing permissions and mismatched accounts refused; available on the hub, token sealed under the integration label; browsing with the way up (names and revisions only, token only to Dropbox); importing the exact revision with custody and a sync record; a file saved again mid-copy; each system's ids kept apart; reconnecting vs a missing file; paged folders.
