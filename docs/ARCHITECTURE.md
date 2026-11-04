# Huis Law IP — Master Architecture (v0.2)

**Status:** Working master spec, November 1, 2026.
**How this file fits:** The full product spec drafted with ChatGPT, and Tracy's answers to its 38 questions, are kept unchanged in `docs/source/chatgpt-architecture-and-answers.md`. The premium module is in `docs/source/phase-11-case-outcome-intelligence.md`. **This file is the authority**: it records the decisions, corrects the source spec where research found problems, and lists what is still open. Where this file and the source spec disagree, this file wins.

---

## 1. Product in one paragraph

Huis Law IP is the **Legal Intelligence Operating System**: a subscription platform, licensed to attorneys and firms of every size and practice area, that pulls everything a matter touches (email, cloud drives, client uploads, thumb drives, discovery, audio/video, financial records, court records, research) into one secure Matter, then uses AI to organize it, map it to claims and evidence, build timelines, find contradictions, research case law and track court deadlines. Connected services (StrongSuit, Filevine, Clio, PACER, Gmail, Outlook, Dropbox) plug in through adapters; Huis is never dependent on any one of them.

**Positioning against Filevine:** Filevine is strong case management, but reviewers cite alert noise in the activity feed, weak Outlook/calendar sync, complexity, and paid add-ons to unlock AI and document features. Huis leads with intake, organization and explainable AI, and can also run *beside* Filevine or Clio rather than replacing them.

---

## 2. Non-negotiables (override everything else)

### 2.1 Attorney-client privilege
1. Each firm's data is isolated at the **database layer** (row-level security), with per-firm encryption keys.
2. Huis staff cannot see client content. Support access requires firm-granted, time-limited, logged permission.
3. Every Matter has a **🔴 Privileged & Confidential** area. Huis never claims that placing an item there *creates* privilege; it is "designated by authorized legal personnel as potentially privileged, work product, confidential or restricted." The attorney decides.
4. **Privilege-waiver warnings:** before anything marked privileged is shared with a client-portal user, co-counsel, expert or other third party, Huis warns the user and logs the decision. Sharing with third parties can waive privilege.
5. AI providers must contractually commit to **no training on customer data and zero data retention**. Same requirement for StrongSuit, OCR and transcription vendors.
6. AI learning from attorney feedback stays within the firm. No cross-firm models, no customer data in "benchmark" analytics.
7. AI output is **attorney-facing only**. Clients can upload and message in the portal, but never receive AI legal analysis directly.
8. All AI reports and exports are labeled **Privileged & Confidential — Attorney Work Product**.
9. **The law firm owns its data. Huis Law IP processes it on the firm's behalf.** Full export of a Matter Brain and evidence at any time.
10. No real client data in development. Codex, Claude Code and Replit work with fake or redacted data only; privileged documents never go into source-code repositories.

### 2.2 Built-in cybersecurity
MFA and passkeys; SSO/SAML for enterprise; RBAC down to firm → location → matter → folder → document → field; TLS in transit; encryption at rest; field-level encryption for the most sensitive values; immutable audit logs; session, IP and login-alert monitoring; remote logout; malware scanning on every upload; encrypted backups and tested disaster recovery; retention policies, legal holds, deletion workflows; API access logs; secrets in a managed vault. Target: **SOC 2 Type II**, Google **CASA** (required for Gmail), and passing law-firm vendor security questionnaires.

### 2.3 AI guardrails
- Every AI statement is labeled **Fact / Inference / AI Suggestion / Legal Authority / Unknown**.
- Every fact links to its exact source (email, page, timestamp). Every legal authority links to a real record. **No citations from AI memory.**
- AI suggests; the attorney decides. Huis never silently creates a court deadline, files an item to a matter (unless the firm has turned on automatic rules), or sends anything.
- Scores are computed by fixed rules from attorney-confirmed evidence, not invented by the model, so the same facts always produce the same score.

---

## 3. Decisions recorded (from Tracy's answers)

| # | Topic | Decision |
|---|---|---|
| 1–2 | Customers | All attorneys, all practice areas, solo through enterprise |
| 3 | Portal | Attorneys, staff **and clients** (clients upload their information) |
| 4 | Licensing | One attorney license = one firm/location; more locations = more licenses |
| 5 | White label | Yes, for large firms ("Powered by Huis Law IP" unless contract allows full private label) |
| 6 | Matter creation | Attorney creates the Matter; AI assists |
| 7 | Numbering | Court case number **and** Huis number (e.g. `HUIS-UT-JSMITH-2026-000124`); firm conventions allowed; permanent internal UUIDs underneath |
| 8 | Contacts | Reusable profiles for opposing counsel, judges, witnesses, experts |
| 9 | Mailbox | Whole mailbox by default; option for folders, labels, date ranges, correspondents; **color-coded organization**, firm-customizable |
| 10 | Monitoring | Continuous after authorization, if the user turns on "Let Huis manage" |
| 11–12 | Filing | AI suggests the matter; firm chooses Manual / Assisted / Automatic |
| 13 | Sending | Eventually send email from Huis |
| 14 | Editing evidence | **Original is never modified**; attorneys edit a working copy (annotate, redact, highlight, exhibit-mark). Red privileged folder per matter |
| 15–17 | Integrity | Chain of custody, SHA-256 hashing, exact/near-duplicate and version detection |
| 18 | Upload size | Built for the largest: resumable, chunked, multipart uploads; terabyte-scale matters |
| 19 | AI analysis | Automatic light analysis on arrival; **Reanalyze Matter** button for deep analysis |
| 21 | AI conversations | Saved inside the Matter under privilege and access rules |
| 22–23 | Prompts | Personal, firm-wide and built-in prompt libraries |
| 24–25 | Legal outputs | Memos, claims/defenses, deposition questions, discovery, RFAs, interrogatories, chronologies, witness summaries, trial outlines, settlement analysis; **claims-to-elements-to-evidence mapping** |
| 26 | Courts | Utah state + federal first, then other states via connectors |
| 27 | E-filing | Display first; design for e-filing later |
| 28–29 | Calendar | Built-in calendar; court events become proposed deadlines; alerts by dashboard, email, SMS, push |
| 30 | Financial | **Both** firm billing/timekeeping **and** financial evidence analysis |
| 31 | Integrations | All on the list (order adjusted in §5) |
| 32 | StrongSuit | StrongSuit supports an **API connection and a user-interface merger** with Huis. Plan for a two-way integration through an adapter (Phase 7 research, Phase 9 Integration Hub), with the merged interface in scope; Huis still works without it (never a dependency) |
| 33 | StrongSuit contact | Tracy is holding discussions with StrongSuit about the API connection and interface merger |
| 34–36 | Pricing | Combination model; **$237/user/month**; enterprise pricing for firms; **7-day free trial** (limited: 1 attorney, 3 matters, 5 GB, capped AI) |
| 37–38 | Data ownership | Firm owns its data; full export any time |
| — | Case DNA™ | Yes: relationship graph of people, events, evidence, claims, elements, law, damages |
| — | Phase 11 | Yes: Case Outcome Intelligence™ premium add-on |

---

## 4. Corrections to the source spec (from research)

1. **Gmail is the hardest connection, not the first.** Reading Gmail requires restricted scopes, which means full Google verification plus an **annual CASA security assessment**; Huis qualifies as a productivity-enhancement app. Scopes must be chosen once, since changing them later forces customers to re-consent and can trigger a new assessment. Sending mail later (Q13) means planning the send/compose scopes into that first verification. **Build Outlook first, start Google verification on day one of the email phase.**
2. **Google Drive should use the `drive.file` scope with the Google Picker.** The user picks files; Huis sees only those. It is a non-sensitive scope with lighter review, versus restricted full-Drive scopes.
3. **Dropbox needs production approval** once about 50 users link the app, and the app name freezes after approval. Pick the final app name before submitting.
4. **Utah: the attorney's inbox is the primary court feed.** The source spec's five Utah options miss the best one. Utah e-filing is mandatory for attorneys, and filing receipts and case notices arrive by email. Huis reads those notices (with the attorney's mailbox already connected), extracts hearings and deadlines, and asks the attorney to confirm. The public two-week district/justice calendar is a cross-check; XChange (paid per search) is for manual lookups; a licensed data partnership with Utah Courts is the longer-term goal. **No scraping, and no use of attorneys' e-filing credentials** — Utah prohibits giving third parties access to e-filing accounts.
5. **Federal notices:** CM/ECF Notice of Electronic Filing emails include case number, docket text and a document link, and each recipient gets **one free look** at the document within 15 days. Huis should capture the document on that first look to save PACER fees.
6. **CourtListener cannot be used free inside a paid product.** Free and membership access may not power a revenue-generating product; Huis needs a **commercial agreement**. Free tier limits are also small (about 125 requests/day). CourtListener has no statutes, so statutes need a separate licensed source.
7. **50-state court data:** licensed vendors exist — UniCourt (3,000+ courts in 40+ states, hearing-date updates), Trellis (45 jurisdictions, Utah unconfirmed), Docket Alarm (federal plus many state courts, docket tracking). Build the `CourtConnector` framework so a vendor can plug in per state.
8. **Filevine API:** the source spec says Filevine documents OAuth 2.0/OIDC third-party integrations. Research independently confirmed an OAuth2 API exposing matters (projects), billing items and users; **verify the full scope directly with Filevine before building.**
9. **"Case Health 72%" on the main dashboard** has the same problem as Phase 11 scores. Show it only if it is computed by fixed, explainable rules; otherwise show counts (new evidence, contradictions, missing evidence) instead.
10. **Client portal and AI:** clients upload and message; they do not see AI analysis (see 2.1 #7).
11. **Phase 11 adjustments:** fixed-rule scoring, verified citations only, everything marked work product, feedback stays within the firm, and Benchmark Intelligence only from public/licensed data with firm opt-in — never customer data.

---

## 5. The 10 phases (+ premium Phase 11)

Phase names follow the source spec Tracy approved. Changes from §4 are folded in.

| Phase | Name | Includes | Key change |
|---|---|---|---|
| 1 | Identity, Firm, Matter & Security | Tenants, locations, users, roles, licensing, matter + client creation, numbering, audit log, privilege classifications, red folder | Database-level isolation from the first commit |
| 2 | Universal Intake & Evidence Engine | Upload Center, external-drive import, resumable mass upload, malware scan, hashing, chain of custody, originals + working copies, duplicates/versions, background processing | — |
| 3 | Huis Inbox — Email Intelligence | Outlook first, then Gmail; mailbox/folder/label options; color coding; AI matter suggestions; Manual/Assisted/Automatic filing; email search (exact, full-text, semantic) | Outlook before Gmail; Google verification + CASA started immediately |
| 4 | Matter Brain + Case DNA™ | Per-matter AI knowledge base, source-linked facts, relationship graph in PostgreSQL | Graph database only if needed later |
| 5 | Timeline + Evidence Intelligence | Master timeline, filters, contradiction engine | AI suggests, attorney decides |
| 6 | AI Legal Intelligence | AI Gateway, specialized agents, prompt libraries, saved AI workspace, automatic light analysis + Reanalyze | Provider choice by evaluation (see §7) |
| 7 | Claims, Elements & Case Law | Claims matrix, element-to-evidence mapping, research abstraction (CourtListener, RECAP, StrongSuit, licensed sources) | CourtListener commercial agreement; statutes source needed |
| 8 | Court Intelligence | Federal (PACER, RECAP, NEF parsing), Utah (email notices first), built-in calendar + alerts, CourtConnector framework, e-filing-ready design | Utah via inbox notices; no scraping |
| 9 | Integration Hub | Adapters for Google Drive, Dropbox, OneDrive/SharePoint, Filevine, Clio, StrongSuit, others; sync records (external IDs, direction, status) | Drive uses `drive.file`; Dropbox approval |
| 10 | Commercial SaaS, Enterprise & White Label | Subscriptions, trial limits, usage metering, firm billing/timekeeping/invoices, financial evidence analysis, white label, admin licensing portal, production security audit | Firm billing and financial evidence both in scope |
| 11 | Case Outcome Intelligence™ (premium) | Case strength, gaps, priorities, value ranges, what-if, readiness | See §4 #11 |

**Client portal** (source spec Build 4) ships with Phase 2 intake, since clients upload evidence.

---

## 6. Build order

Follows the source spec's Build 1–10 sequence, with two changes: Outlook before Gmail in Build 5, and Google Drive / Dropbox connectors pulled forward into Build 5–6 if early customers need them for intake.

**Working method:** one GitHub repo (`tracypeart/Huis`) is the single source of truth. **Claude Code is the builder** (decided by Tracy, November 2026, replacing the source spec's Codex-builds / Claude-reviews split). Each part's independent review is still done by a separate reviewer (a fresh Claude Code agent or a person) who didn't write the code; never two builders changing the same branch at once. Replit for development, demos and staging. Production client data lives in managed infrastructure (managed PostgreSQL, encrypted object storage, key management, backups), not in Replit or the repo. Every change: plan → review → implement → automated tests and security scan → review → human approval → merge. **No step or phase is complete until it has been tested, checked in a real browser, run through the pre-release check of every page and role (`scripts/qa`), independently reviewed for bugs and security problems with every confirmed problem fixed, and documented** (README, "Ground rules" 4).

---

## 7. Technology (agreed starting stack)

Next.js + React + TypeScript + Tailwind; TypeScript backend (Python services only where document/AI processing needs it); PostgreSQL with row-level security; pgvector for semantic search, with OpenSearch later; S3-compatible encrypted object storage (originals / working / OCR / transcripts / exhibits per matter); Redis + BullMQ queues (Temporal later); REST APIs + webhooks; Huis AI Gateway with interchangeable model providers.

**AI provider (Q20):** The source spec recommends OpenAI as primary and Anthropic as secondary behind the gateway. The gateway itself is the decision that matters, and it is agreed. The primary provider should be chosen by **testing candidates on a set of redacted legal tasks** (email-to-matter matching, timeline extraction, contradiction finding, citation-grounded research) and confirming each provider's zero-data-retention terms in writing. *(Note: this review was written by Claude, made by Anthropic, so it deliberately does not pick its own maker; the evaluation should decide.)*

---

## 8. Still open

| ID | Question | Owner |
|---|---|---|
| O-1 | StrongSuit API connection and interface merger (confirmed available): terms, zero-retention/no-training commitment, scope of the merged interface — use the 20-question list in the source spec | Tracy |
| O-2 | Production hosting provider (Azure, Google Cloud or AWS) for privileged data | Tracy + build team |
| O-3 | AI provider evaluation and zero-retention agreements | Build team |
| O-4 | Owner and budget for Google CASA assessment and annual renewal | Tracy |
| O-5 | Utah-licensed attorney advisor to review privilege, ethics and AI disclaimers | Tracy |
| O-6 | Commercial agreement with CourtListener; statutes source | Tracy |
| O-7 | Redacted sample Utah e-filing notices, hearing notices and federal NEFs for building parsers | Tracy |
| O-8 | Trademark search for "Huis Law IP," Case DNA™, Case Gaps™, What-If Analysis™ | Tracy |
| O-9 | Launch targets: demo date, first paying firm | Tracy |
| O-10 | Trust/IOLTA money: integrate a legal payment processor rather than holding client funds | Build team |

---

## 9. Sources

- Filevine reviews: https://www.softwareadvice.com/enterprise-legal-management/filevine-profile/
- Filevine API (via Unified): https://docs.unified.to/integrations/filevine.md
- StrongSuit integrations FAQ: https://strongsuit.com/faq/integration-workflow/
- StrongSuit 2.0: https://pr.davisjournal.com/article/StrongSuit-20-Reimagines-the-Litigation-Workflow-with-a-Fully-Connected-AI-Platform/6a4fbe13ba2819000268044b
- Gmail scopes and CASA: https://docs.unified.to/skills/gmail-oauth-app/SKILL.md
- Google Drive scopes: https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- Microsoft Graph Outlook change notifications: https://learn.microsoft.com/da-dk/Graph/outlook-change-notifications-overview
- Dropbox app setup and approval: https://docs.unified.to/skills/dropbox-oauth-app/SKILL.md
- Utah Courts attorney resources: https://www.utcourts.gov/en/court-records-publications/resources/other-resources/attorney.html
- Utah XChange: https://utcourts.gov/xchange/ · https://www.utcourts.gov/xchange/help/
- Utah eFiling: https://www.utcourts.gov/en/self-help/legal-help/procedures/filing/efiling/district.html
- Utah eFiling FAQ: https://www.utcourts.gov/content/dam/howto/filing/efiling/district/docs/eFiling_FAQ-Attorneys.pdf
- District of Utah ECF manual: https://www.utd.uscourts.gov/sites/utd/files/ECF%20Procedures%20Manual%20FINAL%20250314_1.pdf
- ECF notification emails: https://parseur.com/blog/ecf-emails
- CourtListener API: https://www.vaquill.ai/blog/how-to-use-courtlistener-api-2026
- Docket Alarm API: https://www.docketalarm.com/api/v1/
- UniCourt docket tracking: https://www.businesswire.com/news/home/20250307362939/en/UniCourt-Launches-New-Docket-Tracking-Feature
- Trellis API: https://www.vaquill.ai/blog/trellis-api-state-court-data-what-it-offers
- LawPay API notes: https://supergood.ai/docs/lawpay-api
