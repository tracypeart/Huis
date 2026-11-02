# Huis Law IP

The Legal Intelligence Operating System: an AI-powered platform that connects the communications, evidence, documents, people, deadlines, research and strategy behind every legal matter.

**Status:** Phase 1 security core built and tested. See [`docs/PHASE-1.md`](docs/PHASE-1.md).

## Start here
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the master architecture: decisions, non-negotiables, the 10 phases, and open questions. **This is the authority.**
- [`docs/PHASE-1.md`](docs/PHASE-1.md) — what Phase 1 guarantees and how code must access data.

## Run locally
Requires Node 22+ and PostgreSQL 16.
```
npm install
npm run typecheck
HUIS_TEST_ADMIN_URL=postgres://postgres:<password>@localhost:5432/postgres npm test
```
- [`docs/source/`](docs/source/) — original specs (ChatGPT architecture with Tracy's answers; Phase 11 Case Outcome Intelligence).

## Ground rules for everyone building Huis (people, Codex, Claude Code, Replit)
1. Attorney-client privilege and security come first. Read §2 of the architecture before writing code.
2. Never commit real client data, privileged documents, API keys or tokens to this repository.
3. Work on a branch; merge to `main` only after review and passing tests.
