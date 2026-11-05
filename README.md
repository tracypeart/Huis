# Huis Law IP

The Legal Intelligence Operating System: an AI-powered platform that connects the communications, evidence, documents, people, deadlines, research and strategy behind every legal matter.

**Status:** Phase 1 complete (hosting deferred to the end). Phase 2 (secure evidence intake, reading, search, viewer and copies) complete. Phase 3 (Huis Inbox for Outlook and Gmail, matter suggestions, filing modes) merged; Gmail opens to outside firms after Google verification. Phase 4 (Matter Brain, Case DNA™ and full export) merged. Phase 5 (Timeline + Evidence Intelligence) in progress: part 1, the Master Timeline, is through independent review 11; part 2, the contradiction engine, is through independent review 12. Phase 6 (AI Legal Intelligence) in progress: part 1, the AI Workspace and Prompt Library, is through independent review 13; part 2, the specialized agents, is through independent review 14; part 3, Matter analysis and Reanalyze Matter, is through independent review 15. Phase 6 parts 1–3 and Phase 7 part 1 merged; Phase 6 part 4 (outside AI providers) waits on O-3 and Phase 7 part 2 (research connectors) on O-1 and O-6. Phase 7 (Claims, Elements & Case Law): part 1, the claims matrix and legal authority library, is through independent review 16. Phase 8 (Court Intelligence) in progress: part 1, the court calendar and federal court notices, merged after independent review 17; parts 2 (Utah court notices, unverified until O-7 samples) and 3 (reminders and court connections) through independent review 18. Phase 9 (Integration Hub) in progress: part 1, the hub and OneDrive / SharePoint import, merged after independent review 19; part 2a, Dropbox, merged after independent review 20; part 2b, Google Drive (Google's file picker, `drive.file` only), is through independent review 21; part 3 (Filevine, Clio, StrongSuit) needs partner or developer access. Every part merged after an independent security review. See [`docs/PHASE-2.md`](docs/PHASE-2.md), [`docs/PHASE-3.md`](docs/PHASE-3.md), [`docs/PHASE-4.md`](docs/PHASE-4.md) , [`docs/PHASE-5.md`](docs/PHASE-5.md) , [`docs/PHASE-6.md`](docs/PHASE-6.md), [`docs/PHASE-7.md`](docs/PHASE-7.md), [`docs/PHASE-8.md`](docs/PHASE-8.md) and [`docs/PHASE-9.md`](docs/PHASE-9.md).

## Start here
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the master architecture: decisions, non-negotiables, the 10 phases, and open questions. **This is the authority.**
- [`docs/PHASE-1.md`](docs/PHASE-1.md) — what Phase 1 guarantees and how code must access data.
- [`docs/PHASE-2.md`](docs/PHASE-2.md) — evidence intake, encryption, scanning and chain of custody.
- [`docs/PHASE-3.md`](docs/PHASE-3.md) — Huis Inbox: connecting Outlook, private sync, search and filing email into Matters.
- [`docs/PHASE-4.md`](docs/PHASE-4.md) — Matter Brain, Case DNA™ and full export of a Matter.
- [`docs/PHASE-5.md`](docs/PHASE-5.md) — Master Timeline (part 1) and the contradiction engine (part 2).
- [`docs/PHASE-6.md`](docs/PHASE-6.md) — AI Legal Intelligence: AI Workspace and Prompt Library (part 1), specialized agents (part 2), and what's planned.
- [`docs/PHASE-7.md`](docs/PHASE-7.md) — Claims, Elements & Case Law: claims matrix and legal authority library (part 1).
- [`docs/PHASE-8.md`](docs/PHASE-8.md) — Court Intelligence: court calendar and federal court notices (part 1), Utah court notices (part 2), reminders and court connections (part 3).
- [`docs/PHASE-9.md`](docs/PHASE-9.md) — Integration Hub: OneDrive / SharePoint (part 1), Dropbox (part 2a) and Google Drive (part 2b).
- [`docs/FAQ.md`](docs/FAQ.md) — plain-language FAQ for attorneys and firms: safety, privilege and search.
- [`docs/SECURITY-REVIEW-2026-11.md`](docs/SECURITY-REVIEW-2026-11.md) — independent security reviews (1–18) and fixes.
- [`docs/source/`](docs/source/) — original specs (ChatGPT architecture with Tracy's answers; Phase 11 Case Outcome Intelligence).

## Run locally
Requires Node 22+ and PostgreSQL 16.
```
npm install
cp .env.example .env.local        # then fill in the values (never commit it)
npm run migrate                   # needs HUIS_MIGRATION_DATABASE_URL in your environment
npm run dev                       # http://localhost:3000
npm run worker                    # evidence worker (needs ClamAV)
```
Tests: `HUIS_TEST_ADMIN_URL=postgres://postgres:<password>@localhost:5432/postgres npm test`

## Ground rules for everyone building Huis (people, Codex, Claude Code, Replit)
1. Attorney-client privilege and security come first. Read §2 of the architecture before writing code.
2. Never commit real client data, privileged documents, API keys or tokens to this repository.
3. Work on a branch; merge to `main` only after review and passing tests.
4. **Before any step or phase is called complete, and before moving on to the next one:**
   1. **Test:** every automated test, the type check, the production build and the dependency vulnerability scan pass, and new work comes with its own tests.
   2. **Check it works:** try it in a real browser on made-up data, then run the pre-release check (`scripts/qa`). It opens every page as owner, attorney, paralegal, read-only staff and a client, and reports errors and broken links. Also check the links in the documentation.
   3. **Check for bugs:** an independent reviewer who didn't write the code attacks it with working tests. Every confirmed problem is fixed, with a test so it can't come back.
   4. **Review:** update the docs, FAQ and security-review record. Merge only once GitHub's automated tests pass on the final version.
