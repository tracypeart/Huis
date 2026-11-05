# Phase 9 — Integration Hub

**Status:** Part 1 (the hub, and OneDrive / SharePoint import) merged after independent security review 19. Part 2a (Dropbox) merged after independent security review 20 (1 problem confirmed, fixed for Dropbox and OneDrive). Part 2b (Google Drive, with Google's own file picker) built, tested and through independent security review 21 (2 problems confirmed, both fixed). Review 22 re-checked Dropbox and the shared hub code (1 Medium and 2 Low problems confirmed, all fixed for Dropbox, OneDrive and Google Drive; see below). Part 3 (Filevine, Clio, StrongSuit) needs partner or developer access.

## Plan
| Part | What | Status |
|---|---|---|
| 9.1 | **Integration Hub** (connections, sync records, imports into Matters with chain of custody) and **OneDrive / SharePoint**: browse your OneDrive and the SharePoint sites you follow, import chosen files into a Matter as evidence | Review 19 done, fixes in |
| 9.2a | **Dropbox**: browse your Dropbox and import chosen files into a Matter, like OneDrive | Merged after review 20 |
| 9.2b | **Google Drive**: Google's own file picker now (the `drive.file` permission: Huis can only open the files picked); full browsing like OneDrive once Google's restricted-scope security assessment is done (the same assessment Gmail needs) | Review 21 done |
| 9.3 | **Filevine, Clio and StrongSuit** adapters: link Matters, bring in documents, contacts and deadlines; StrongSuit's API connection and interface merger (O-1) | Needs partner or developer access |

## Security review 22 (Dropbox, Google Drive and the hub)

See `SECURITY-REVIEW-2026-11.md`; regression tests in `test/security-review-22.test.ts` (6 tests). What changed for people using it:
- An imported file's *Received from* says only the system ("Dropbox", "OneDrive / SharePoint", "Google Drive"); the account it came from is in the chain of custody, which only firm staff see.
- Huis imports the version you saw when you chose the file. If the file changed since, the import stops and asks you to choose it again.
- Every call to Dropbox, Microsoft and Google has a time limit, and a download that stops sending data is stopped, so one stuck connection can't hold up the rest of Huis.

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
- **Google Drive (9.2b):** see Part 2b below.
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

## Part 2b — Google Drive

| Area | What Huis does |
|---|---|
| Connecting | A staff member connects **their own** Google account through the firm's Google app (the same one Gmail uses). Huis asks only for `openid`, `email` and **`drive.file`**, Google's narrowest file permission: Huis can open only the files the person chooses for it, never the rest of their Drive, and never asks Drive to change, move, share or delete anything. A sign-in without `drive.file`, or carrying any other permission (such as Gmail or full Drive access), isn't kept; the Drive sign-in never picks up permissions given to the firm's app for Gmail. Sign-in uses PKCE, a nonce and Google's signed ID token, and is bound to the person and firm |
| Whose account | Google's stable account id (`sub`), from the verified ID token, checked against the account the token itself reports. Before every listing or import the worker checks again that the token belongs to that account (review 20, R20-1) and that it still carries only the permissions above |
| Choosing files | **Choose files in Google Drive** opens Google's own file picker on a page that is a document of its own (outside the app's pages, entered and left with full page loads). The picker runs in the person's browser with a short-lived token Google gives that browser for `drive.file` only, with any permissions given to the firm's Google app before (such as Gmail) explicitly left out; a token carrying anything more isn't used (review 21). It never reaches Huis's server, and Huis's server-side token is never sent to the browser. Choosing a file is what lets Huis's connection open it; the page then posts back (from this site only) so the worker lists the chosen files. That one page allows Google's picker and sign-in hosts in its security policy; every other page keeps the strict policy |
| The list | The worker lists the files chosen for Huis (one list, not folders): names, sizes, dates, types and revisions only, up to 1,000. **Google Docs, Sheets and Slides aren't listed**: they have no stored file to copy, so the person downloads them as a file (such as PDF or Word) and imports that. Files in the Drive trash aren't listed |
| Importing | Exactly as OneDrive and Dropbox (Matter folder, privilege acknowledgement, scanning, fingerprint, custody, sync record, the same version once, checks again when the worker runs). Huis downloads the **exact revision it recorded** (Drive's head revision), so the custody record and the bytes always match. Only files the worker listed can be named; ids are Drive's own shape (`gdrive:<id>`) and are never used as folders. If Google answers a download with a redirect, Huis follows it only to Google's content hosts over HTTPS, without the token |
| Custody | *Imported from a connected system*: Google Drive, the account, the file's id and revision, its last-modified date, who imported it and when. There is no folder path: `drive.file` doesn't let Huis see the folders around a chosen file |
| Errors | A refused sign-in, or one that now carries other permissions, needs reconnecting; a file that was removed, un-shared from Huis or turned into a Google Doc fails just that import |
| Not yet | Importing Google Docs, Sheets and Slides (as a recorded export); browsing the whole Drive (needs Google's restricted-scope security assessment) |

### Before it can be used
In the firm's Google Cloud project (the one with the Gmail app): turn on the **Google Drive API** and **Google Picker API**; add the `drive.file` scope to the OAuth consent screen (it is a *non-sensitive* scope, so no security assessment is needed for it); add the redirect URI `<base URL>/api/integrations/google_drive/callback` and the JavaScript origin `<base URL>` to the OAuth client; create a **browser API key** restricted to the Picker API and to `<base URL>/*`. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (already set for Gmail) for the app and the worker, and `GOOGLE_PICKER_API_KEY` and `GOOGLE_CLOUD_PROJECT_NUMBER` (Project settings → Project number) for the app.

**Security review 21:** see `SECURITY-REVIEW-2026-11.md`; 2 problems confirmed (both in the browser side of the picker), both fixed; regression tests in `test/security-review-21.test.ts` (2 tests).

**Tests:** `test/google-drive.test.ts`, 15 tests: `drive.file`-only, offline, PKCE sign-in with no other permissions folded in; the account identified by Google's id, missing or extra permissions, mismatched accounts and a wrong nonce refused; available on the hub, token sealed under its own label (not a Gmail mailbox's); only chosen files listed (no Google Docs or trash, names and revisions only, token only to Google); importing the exact revision with custody and a sync record, and the same revision once; a file saved again mid-copy; only listed files can be named; one listing, ids kept apart from other systems; the connection is its owner's alone; a file un-shared or turned into a Google Doc fails just that import; extra permissions or a refused sign-in need reconnecting; a token for another account refused before anything is listed; paged lists; download redirects only to Google's content hosts; ids of the wrong shape refused before asking Google.

**Tests:** `test/dropbox.test.ts`, 9 tests: read-only, offline, PKCE sign-in; the account identified by Dropbox's id, missing permissions and mismatched accounts refused; available on the hub, token sealed under the integration label; browsing with the way up (names and revisions only, token only to Dropbox); importing the exact revision with custody and a sync record; a file saved again mid-copy; each system's ids kept apart; reconnecting vs a missing file; paged folders.
