# Phase 1 — Identity, Firm, Matter & Security

**Status:** Security core built and tested (Build 1, part 1). Sign-in screens and the web app come next.

## What exists

| Area | Where | What it guarantees |
|---|---|---|
| Database schema | `db/migrations/0001_foundation.sql` | Firms, locations, users, licenses, clients, contacts, matters, members, folders, audit log |
| Firm isolation | Row-level security on every table | A firm's data is invisible to every other firm, even to raw SQL through the app's connection. No context = no rows |
| Ethical walls | `matters.restricted` + `huis.can_see_matter` | A walled matter is visible only to its explicit members — not even the firm owner |
| External users | Roles `client`, `co_counsel`, `expert_witness`, `authorized_third_party` | See only matters they're added to, view-only, never the red privileged area, client list or staff list |
| Privilege-waiver warning | `addMatterMember` | Adding someone outside the firm requires an explicit acknowledgement, recorded in the audit log |
| Red privileged area | `huis.matter_after_insert` trigger | Every matter gets "Privileged & Confidential" (red) plus standard folders |
| Matter numbers | `huis.assign_matter_number` trigger | `HUIS-UT-ARIVERA-2026-000001` per firm per year; court case number and firm number kept separately |
| Roles | `src/security/permissions.ts` + database policies | 14 roles; admin-only actions enforced in both the app and the database |
| Licensing | `licenses` table | One active license per user; one account per firm (decision #4) |
| Audit log | `audit_events` | Append-only (even a database superuser is blocked), hash-chained so tampering is detectable; client names never written to it |
| Sign-up / sign-in lookup | `huis.bootstrap_firm`, `huis.resolve_identity` | New firm on a 7-day trial; sign-in returns only firm and user ids |

## How application code must access data

Always through `HuisDb.withFirm(ctx, fn)`. It opens a transaction, sets the firm and user for row-level security, verifies the user is active in that firm, runs your code, and commits. The app's database login **must** be a member of `huis_app` and must not be a superuser or table owner — a test checks this.

## Tests

`npm test` runs 25 tests against a real PostgreSQL 16 database, including:
- firm A cannot read or write firm B's data
- missing context returns nothing
- forged context (user from another firm) is rejected
- walled matters hidden from non-members, including the owner
- clients see only their matters and never privileged folders
- paralegals cannot add users, in the app or by direct SQL
- the last firm owner cannot be removed
- audit log cannot be edited or deleted; tampering is detected

Removing row-level security from the matters table makes 4 of these tests fail, confirming they guard the real protections.

CI (`.github/workflows/ci.yml`) runs type checks, these tests and a dependency vulnerability scan on every pull request.

## Next in Phase 1

1. **Sign-in:** Microsoft and Google single sign-on with MFA. Needs app registrations in Microsoft Entra and Google Cloud (Tracy's accounts).
2. **Web app shell:** Next.js dashboard — firm setup, users, clients, matters list, matter overview with folders.
3. **Production database:** managed PostgreSQL with encryption and backups (hosting decision O-2).
