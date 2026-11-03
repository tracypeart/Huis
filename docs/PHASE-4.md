# Phase 4 — Matter Brain + Case DNA™

**Status:** Part 1 (Matter Brain) built and tested; under independent security review.

## Plan
| Part | What | Status |
|---|---|---|
| 4.1 | **Matter Brain**: each Matter's knowledge base (documents, filed email, transcripts, client uploads, attorney notes), split into passages, searchable by words and by meaning; **Ask this Matter** with cited answers; attorney notes; AI Gateway with a firm-level AI setting and a usage log | Built, in review |
| 4.2 | **Case DNA™**: the relationship map: people, organizations, events, claims, defenses, legal elements, witnesses, damages, each linked to the evidence behind it. AI suggests; attorneys confirm. Click a claim to see its elements, supporting and contradicting facts, evidence, witnesses and emails | Next |
| 4.3 | Full export of a Matter Brain (with evidence), and written answers from an outside AI provider once its zero-retention terms are signed (O-3) | After 4.2 |

PostgreSQL stays the single source of truth. Passages and meaning fingerprints live in PostgreSQL (pgvector); a separate graph database is added only if Case DNA outgrows it.

## Part 1 — Matter Brain

| Area | What Huis does |
|---|---|
| What goes in | The readable text of every clean (virus-scanned) item in the Matter: documents, OCR'd scans, filed email and attachments, audio/video transcripts, client uploads. Also **attorney notes**. Exact duplicates are left out. New items join automatically once read |
| Passages | Text is split into passages of about 1,500 characters, at paragraph or sentence breaks, with a small overlap so facts aren't cut in half. Each passage keeps its position, so answers cite exactly where they came from |
| Searching | Each question is matched by words and by meaning (pgvector), across this Matter only |
| Ask this Matter | An answer built only from passages the person can open themselves, with numbered citations linking to the source document or note. Questions and answers are **private to the person who asked**, labelled *Privileged & Confidential — Attorney Work Product* |
| Who can use it | Firm staff only. Clients, co-counsel and experts never see the Matter Brain, notes or any AI output, even for documents shared with them. Ethical walls apply: someone outside a wall can't ask that Matter or read its passages, and loses their earlier answers if removed |
| Answers stay honest | When an answer is opened, Huis re-checks every source. If one is no longer available to that person (a note deleted, evidence found infected, access removed), the answer is withheld |
| Attorney notes | Work product: firm staff on the Matter can read them; only the author can change or delete one; read-only staff can't add them |
| AI provider | A firm setting chosen by administrators. **Built-in** (default) runs entirely inside Huis and sends nothing to any outside service: meaning search uses a built-in text fingerprint, and answers are the most relevant passages with their sources rather than written conclusions. **Off** turns AI features off. Outside AI providers (for written answers) plug into the same AI Gateway once their zero-retention, no-training terms are signed (O-3) |
| Logs | The audit log records that a question was asked, never what. The AI usage log (administrators only) records provider, model, sizes and time — never questions, answers or document text |

**Tests:** `test/brain.test.ts`, 11 tests: passage splitting, meaning fingerprints, cited answers from documents and notes, other Matters and walls, outside users (including direct database queries), answer privacy and withholding, infected evidence leaving at once, note permissions, AI off, logs without content, and the app being unable to write passages or run worker steps; question text can't inject into the search. Also checked in a real browser.
