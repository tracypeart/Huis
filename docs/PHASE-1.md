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

## Sign-in (Microsoft)

| Piece | Where | Guarantee |
|---|---|---|
| Sign-in flow | `src/auth/microsoft.ts`, `app/api/auth/*` | OpenID Connect authorization code + PKCE, state and nonce; works for any Microsoft 365 organization or personal Microsoft account |
| Token checks | `verifyMicrosoftIdToken` | Signature (Microsoft's published keys), audience = Huis app, issuer must match the token's own tenant, nonce, expiry |
| Account key | `<tenant id>:<object id>` | **Never the email address.** Email claims are not a safe account key, so accounts are never found or linked by email |
| Invitations | `db/migrations/0002_invitations.sql` | One-time link (only a hash stored), 7-day expiry, reissuing revokes the old link, audited |
| Session | `src/auth/tokens.ts` | Encrypted cookie (AES-256-GCM), HttpOnly, SameSite=Lax, Secure on HTTPS, 8-hour lifetime; user re-checked as active on every request |
| Multi-firm users | `/select-firm` | A person licensed at two firms picks one; firms stay fully separate |

Sign-in asks Microsoft only for `openid profile email offline_access`. **No mailbox permissions yet** — those come in Phase 3.

## Web app (Next.js)

Pages: sign-in, firm set-up (7-day trial), choose firm, invitation, dashboard, matters (search), new matter (ethical wall option), matter overview (numbers, red Privileged & Confidential folder, access list with privilege-waiver acknowledgement, linked judges/witnesses), clients, people & contacts, users & access (invite, new link, change role, remove access), audit log with live integrity check.

Security headers on every page: Content-Security-Policy, frame blocking, no-sniff, `Referrer-Policy: same-origin` (keeps invitation links out of other sites' logs), HSTS in production. Pages a role may not use return "not found".

Settings are listed in `.env.example`. The Microsoft client secret goes only into Replit Secrets or the cloud vault.

## Still to do in Phase 1

1. **Google sign-in** (needs a Google Cloud OAuth client).
2. **Production hosting and database** (decision O-2), then add the production redirect URI in Entra.
3. **Move the Entra registration to a Huis Law IP business tenant and complete Microsoft publisher verification** before real firms sign in.
4. **MFA enforcement check**: require Microsoft's MFA claim, or a Huis passkey, for every sign-in.
