# Phase 2 — Universal Intake & Evidence Engine

**Status:** Part 1 (secure intake) merged after independent review. Part 2 (readable & searchable) built and tested — under independent review.

## Deferred to the end of the build (Tracy, Nov 1 2026)
Hosting, the production database, Replit Secrets, the production Microsoft redirect address and a real ClamAV server are set up together at the end. Until then everything runs and is tested locally.

## What exists

| Area | Where | Guarantee |
|---|---|---|
| Upload anything | `app/(app)/matters/[id]/uploader.tsx`, `app/api/uploads/*` | Drag-and-drop files or **whole folders / thumb drives** (folder structure kept). 8 MB parts, 3 in parallel, automatic retries; any order; up to 100 GB per file (configurable) |
| Encryption at rest | `src/storage/encryption.ts` | Every file has its own AES-256 key, wrapped with a per-firm key. Encrypted in 1 MiB authenticated segments bound to the file's location — tampering, truncation, swapping files or using another firm's key is detected. Upload parts are encrypted too |
| Fingerprint | `assembleOriginal` | SHA-256 computed while the file is assembled; re-verified by the worker against the stored copy |
| Originals never change | `db/migrations/0003_evidence.sql`, `0004` | The app can't edit evidence at all; the database refuses edits to the original record (filename, size, fingerprint, storage location, uploader, time, received from, date received) and deletion, even for the table owner. Moves go through one recorded database function |
| Malware scanning | `src/storage/scanner.ts`, `src/worker/` | ClamAV (clamd). **Fails closed:** files are held and cannot be opened until scanned clean; threats are quarantined; the worker refuses to run without a scanner; a scanner outage leaves files held and retries |
| Real file type | `src/storage/filetype.ts` | Identified from content, not the name; programs disguised as documents are flagged |
| Duplicates | `huis.worker_complete` | Exact duplicates within a matter linked to the first copy (e.g. "Agreement.pdf" vs "Agreement FINAL.pdf" with the same bytes) |
| Chain of custody | `evidence_custody_events` | Received (who, from whom, date received, source, fingerprint) → integrity verified → scan result → downloads → moves. Append-only and hash-chained; integrity shown on screen |
| Safe downloads | `app/api/evidence/[id]/download` | Only clean files; always downloaded as an attachment (never opened inside Huis), sandboxed; each download recorded |
| Client portal uploads | `startUpload`, RLS policies | Clients upload only into **Client Uploads** and see only those files — never firm evidence or the red privileged area |
| Worker isolation | role `huis_worker` | The background worker can't read any table; it can only call three narrow functions |
| Request safety | `lib/api.ts` | Upload API rejects cross-site requests and unsigned requests; errors never leak internals |

## Independent security review
All findings fixed — see [`SECURITY-REVIEW-2026-11.md`](SECURITY-REVIEW-2026-11.md).

## Tests
`npm test` — 76 tests (including 19 security-review regression tests). Phase 2 adds 19, including: encrypted storage never contains plaintext; tampering/truncation/swap/wrong-firm-key detection; out-of-order chunked uploads; held-until-scanned; EICAR malware quarantined; disguised executable flagged; duplicates; scanner outage keeps files held; altered stored file caught; immutable originals and custody; firm isolation; ethical walls; client folder restrictions; worker cannot read tables.

End-to-end check: a 20 MB file uploaded in three parts in reverse order through the web API, scanned, downloaded — the downloaded SHA-256 matched the original exactly.

## Running it
```
npm run dev       # web app
npm run worker    # evidence worker (needs ClamAV: HUIS_CLAMAV_HOST)
```
Settings are in `.env.example`.

## Part 2 — readable and searchable

After a file scans clean, Huis reads it in an **isolated process** (no database access, no encryption keys, its own private temporary folder that is always deleted, memory and time limits). Damaged or malicious files fail safely.

| File | What Huis does |
|---|---|
| PDF | Extracts the text; if pages are scanned images, reads them with **OCR** (up to 300 pages per file) |
| Photos / scans (PNG, JPEG, TIFF, GIF) | OCR |
| Word (.docx, .doc), Excel (.xlsx, .xls), PowerPoint (.pptx, .ppt), RTF | Extracts the text (spreadsheets keep rows and columns) |
| Email (.eml) and Outlook (.msg) | Reads From / To / Cc / Bcc / Subject / Date and the body; **each attachment becomes its own evidence item** |
| Mailbox exports (.mbox) | Splits into one email item per message |
| ZIP archives and discovery productions | **Each file inside becomes its own evidence item**, with its path inside the archive recorded. Zip bombs and oversize entries are refused; nothing is ever written using a name taken from the archive |
| Audio and video | Held until an approved, zero-retention transcription service is connected (provider decision pending) |
| Text, HTML, CSV | Text extracted |

Every item taken out of an email or archive gets its own fingerprint, virus scan and chain of custody ("taken out of …"), and the parent records it too. Items live in the same folder as their parent, and **moving an email moves its attachments with it**, so they always share the same protection.

**Search** (`/search`, and a search box on every matter): searches the words inside every document, email, scan and attachment the person is allowed to see. Phrases in quotes, `or`, and `-exclude` work. The database applies firm isolation, ethical walls, the red privileged area and client restrictions to search results and to extracted text. Matches are highlighted without ever treating document text as HTML.

**Storage note:** extracted text is stored in the database so it can be searched. It is protected by the same row-level rules as the evidence itself and by database encryption at rest in production; originals stay in the per-firm encrypted vault.

**Tests:** 92 in total; part 2 adds 16, using real generated files (text PDF, scanned PDF, photo, Word, Excel, email with attachments, mailbox, ZIP with a path-traversal name, a zip bomb, audio) plus public sample Outlook files, including a deliberately damaged one.

## Next in Phase 2
1. **Outlook .pst mailboxes** (large exports) and messages attached inside messages.
2. **Near-duplicates and versions** (e.g. FINAL vs FINAL2 with edits).
3. **Working copies**: annotate, highlight, redact and exhibit-stamp without touching the original.
4. **Transcription provider** for audio/video (needs a provider decision with zero-data-retention terms).
