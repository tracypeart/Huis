# Phase 7 — Claims, Elements & Case Law

**Status:** Part 1 (claims matrix and legal authority library) built and tested; independent review pending. Part 2 (research connectors) waits on agreements (O-6 CourtListener commercial terms and a statutes source; O-1 StrongSuit).

## Plan
| Part | What | Status |
|---|---|---|
| 7.1 | **Claims matrix**: every claim and defense in a Matter, each element with its supporting and contradicting facts, sources and cited law, and the gaps by fixed rules. **Legal authority library**: cases, statutes, regulations and rules entered by attorneys, each linked to its real record and unverified until an attorney checks it; cite them for claims and elements with the proposition each stands for | Built, review pending |
| 7.2 | **Research connectors** behind one `ResearchConnector` interface: CourtListener / RECAP (needs a commercial agreement: free access may not power a paid product), a licensed statutes source, StrongSuit (if partner access is granted). Results become library entries only when an attorney adds and verifies them | Waiting on O-6, O-1 |

## Part 1 — Claims matrix and legal authorities

| Area | What Huis does |
|---|---|
| Claims matrix | For each claim and defense (from Case DNA): every element with how many confirmed facts support it, how many contradict it, how many separate sources stand behind them, and the authorities cited for it. **Gaps** use fixed rules: no confirmed supporting fact; supporting facts with no source; no legal authority cited; authority not yet verified; contradicting facts. Elements link to Case DNA, where facts are added |
| Legal authority library | Firm-wide (public law, not client data). Each authority has a type, citation, name, court, year, jurisdiction and a **secure link to the authority itself**. Official public sources get a badge (CourtListener, Cornell LII, GovInfo, the U.S. Code, eCFR, Federal Register, the Supreme Court, U.S. courts, Congress, Utah's legislature and courts, EEOC, DOL, NLRB); other links (Westlaw, Lexis…) are accepted. The same citation can't be added twice |
| Verification | **Huis never cites from memory and generates nothing here.** An authority is *unverified* until an attorney confirms it against its record. The database records who verified it and when, and can't be told otherwise. Changing the citation, type or link clears the verification. Unverified authorities are flagged wherever they're cited |
| Citing | Cite an authority for a confirmed claim, defense or element, saying whether it supports, cuts against or explains, with a pinpoint and the proposition it stands for. An authority a Matter cites can't be removed from the library until those citations are removed. Only whoever added an authority, or a firm administrator, can remove it |
| Who can use it | The library: all firm staff can read it; staff who can change work (not read-only staff) add, edit and verify. Citations in a Matter are work product under the Case DNA rules: firm staff on the Matter (read-only staff read only); clients and outside users never; walls apply; nothing is cited across Matters or firms (also in the database) |
| Logs | The audit log records the kind of authority and the stance of a citation, never citations, propositions or notes |

**Tests:** `test/authorities.test.ts`, 3 tests:
- the library: secure real links only (also in the database), no duplicates, safe search, verification recorded by the database and cleared when the citation or link changes, who-added and who-verified unforgeable, read-only staff, clients and other firms, audit without citations;
- the matrix: gaps by fixed rules, closing as facts are added and authorities are cited and verified; cited authorities can't be deleted, and only their adder or an administrator removes them;
- citations as work product: walls, other Matters and other firms refused (in the service and the database), and clients and read-only staff.

All 288 tests, the type check, the build and the dependency scan pass.
