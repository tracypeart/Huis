# Phase 6 — AI Legal Intelligence

**Status:** Part 1 (AI Workspace and Prompt Library) built, tested and through independent security review 13 (2 problems confirmed, both fixed). Parts 2–4 planned.

## Plan
| Part | What | Status |
|---|---|---|
| 6.1 | **AI Workspace**: saved conversations inside each Matter, by category (strategy, research, deposition, discovery, timeline, damages, motion, trial, client, miscellaneous), private unless shared with the Matter's firm staff. **Prompt Library**: personal, firm-approved and built-in prompts | Review 13 done, fixes in |
| 6.2 | **Specialized agents behind one interface**: a router that sends each question to the right agent (timeline, evidence, email, deposition, contradictions, privilege), each built on what Huis already has, with fixed rules and every answer cited | Planned |
| 6.3 | **Light analysis + Reanalyze Matter**: "N new items since the last complete analysis", and a Matter analysis by fixed, explainable rules (new evidence, potential contradictions, claim elements with no evidence, items with no source), not a made-up "case health" score | Planned |
| 6.4 | **Outside AI providers** through the AI Gateway: written answers, and two-model checking for significant outputs (one model answers, another reviews, Huis shows where they disagree). **Needs the O-3 decision first**: no client material goes to an outside provider until its zero-retention, no-training terms are signed. The provider is chosen by testing candidates on redacted legal tasks. Carried from review 13: a written answer keeps every passage it was given as a source, and each provider gets its own answer check in the database | Waiting on O-3 |

Until 6.4, all AI in Huis is the **built-in** provider: it runs inside Huis, sends nothing outside, and answers by quoting the Matter's most relevant passages with their sources rather than writing conclusions.

## Part 1 — AI Workspace and Prompt Library

| Area | What Huis does |
|---|---|
| Conversations | Inside a Matter, start a conversation with a title and category, then ask question after question. Each answer is the Matter Brain's: drawn only from this Matter, only from what the person can open, with numbered sources. Conversations are listed by category, most recent first |
| Private, or shared | A conversation is **private to its owner** by default. The owner can share it with the firm staff on the Matter: they can read it (read-only staff too), never add to, change or delete it. Stopping sharing hides it again at once |
| Sharing never reveals a source | Each answer is shown only while every source it drew on is available to the person **reading** it, checked by the database. A reader who can see a conversation but not one of its answers is told only how many answers aren't shown |
| Yours stays yours | A colleague's shared answers never appear in the reader's "My questions", and a full export of a Matter includes only the exporter's own questions and answers, as before |
| Prompt Library | **Mine**: personal prompts, private to their owner. **Firm**: approved templates that every staff member can use; only firm administrators (owner, managing partner, firm administrator) add, change or delete them. **Huis**: built-in starting points by category, not legal advice. Pick a prompt in a conversation to fill in the question, then edit it before asking |
| Who can use it | Firm staff only; clients and other outside users never see conversations or prompts. Ethical walls apply. Another firm gets "not found". In the database: a conversation's owner and Matter never change, an answer can only join its asker's own conversation in the same Matter, and firm prompts can only be written by administrators |
| Answers are Huis's | The database checks every saved answer. Its sources are rebuilt from the passages it cites (only passages of that Matter the asker can open), and its time is set by the database. A built-in answer must be in the built-in form, with every quoted line being words its passage really contains. So no one can write a made-up "Huis answer" for colleagues to read |
| Logs | The audit log records conversations created, changed, shared, unshared and deleted (with their category), and prompts created, changed and deleted (with their scope). It never records titles, questions, answers or prompt wording |

**Security review 13** (independent; see `SECURITY-REVIEW-2026-11.md`) found no read leak. It confirmed 2 integrity problems, both fixed:
- someone walled out of a Matter could still delete its shared conversations directly in the database;
- an owner could plant a made-up answer for colleagues to read.

Regression tests are in `test/security-review-13.test.ts`. After the fixes: all 262 tests, the type check, the build and the dependency scan pass, and the pre-release check is clean.

**Fixed while checking (Phase 4):** an answer that quoted nothing still listed the passages Huis had looked at as its "sources", so an answer saying "Huis didn't find passages…" could list two sources under it. Saved answers now list only the passages they quote.

**Known limit of the built-in AI:** it matches the question's words to the passages' words (lightly stemmed), so a question about "key dates" may find nothing even when the database's word search finds a "Date:" line. Rewording helps, and outside providers (6.4) will answer in writing.

**Tests:** `test/workspace.test.ts`, 5 tests:
- conversations with cited answers, in order, by category, and the audit log without content;
- private until shared, then read-only for colleagues (in the service and directly in the database), never in their "My questions" or export, and hidden again when unshared;
- staff only, walls, other firms, and planted conversations or answers refused; answers withheld once a source is found infected, with only a count shown; deleting a conversation deletes its answers;
- answers list only the sources they quote (checked to fail without the fix);
- the Prompt Library: built-in, firm and personal prompts; only administrators manage firm prompts (also directly in the database); personal prompts stay personal; clients get nothing; audit without wording.

The export check was also confirmed to fail without its fix.

**Checked in a real browser** (made-up data):
- starting from a built-in prompt, asking, and the answer being saved;
- a colleague reading a shared conversation, with no ask box or settings;
- an owner adding a firm prompt, while a paralegal sees it but can't edit it.

The pre-release check (`scripts/qa`, now with the workspace, a seeded shared conversation and a firm prompt) is clean.
