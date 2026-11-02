# Independent security review — Phases 1 & 2 (November 2026)

**Scope:** everything in Phase 1 (firms, roles, matters, sign-in, invitations, web app) and Phase 2 part 1 (evidence intake, encryption, scanning, chain of custody).
**Method:** a separate reviewer that did not write the code attacked it with working exploit tests against a real database, assuming an attacker who can run any query through the app's own database connection (so a single app bug can't become a breach).
**Result:** 9 confirmed issues + 3 suspected. **All fixed**, each with a regression test (`test/security-review.test.ts`, 19 tests). All 13 of the reviewer's original exploit tests now fail to exploit. Fixes are in `db/migrations/0004_security_hardening.sql` plus app changes.

| # | Severity | Finding | Fix |
|---|---|---|---|
| H2 / F8 | High | A firm admin could link their own Microsoft account to another person's account (directly or by unlinking and re-inviting) and so get into that person's walled matters | The database refuses any change to sign-in links except through a one-time invitation; linked accounts can't be re-invited |
| F2 | High | Any staff member, even read-only, could switch off the red Privileged & Confidential folder's protection and expose it to clients | The red folder can never be un-designated or reclassified; only matter owners/editors (or admins) can change folders |
| G3 | High | An owner of one matter could re-point their membership to take over a different matter | Membership rows can't be moved; outsiders can never be owner or editor |
| F9 | High (privilege) | Moving privileged material into Client Uploads exposed it with no warning | Moving into any folder outsiders can see requires an explicit privilege-waiver acknowledgement, recorded in the chain of custody |
| F10 | Medium | A matter editor could lift an ethical wall or rewrite the Huis number | Only matter owners can change the wall, client or lead attorney; Huis numbers are always database-assigned and immutable |
| F5 | Medium | Changing a staff member to an outside role kept their owner access | Moving between staff and outside roles is blocked; remove and re-invite instead |
| J1 | Medium | Anyone could re-queue scans, and a later scan could overwrite an "infected" verdict | Only the database queues scanning (once per file); a verdict is never overwritten; only the worker holding the job (lock token) can report |
| H1 / F7 | Medium | Custody entries and receipt details (received from, date) could be forged; evidence could point at another matter's folder | The app can no longer write custody or edit evidence at all — the database writes custody itself; receipt details are immutable; folders must belong to the same matter |
| F6 / G1 | Medium | Busy firms would see false "integrity FAILED" alarms from concurrent writes | Chains are ordered by a sequence assigned under the chain lock; verified with 50 concurrent writers |
| F3 / F4 / G2 | Low–Med | Read-only users and clients could link or edit matter contacts | Outsiders can't see or change them; read-only users can't write |
| Suspected | Low | Sessions couldn't be revoked | Sessions carry a version; **signing out ends the session on every device**; admins can "Sign out everywhere" for any user; disabling a user is immediate |
| Suspected | Low | Forwarded IP headers trusted blindly; admins could edit plan/trial; error text could leak; cross-site download could write fake custody; folder lookup answered for walled matters; long scans could be double-processed | Proxy IPs trusted only when configured; billing fields locked; only user-written messages shown; cross-site requests blocked; lookups respect walls; job locks with tokens |

## Still open (tracked, not code defects)
1. **MFA enforcement** — Microsoft sign-in doesn't yet require proof of MFA. Plan: require the firm's Microsoft MFA (Conditional Access) or a Huis passkey. Part of the end-of-build Azure/hosting step.
2. **Administrator-level tampering** — someone with full database superuser access could switch off the protective rules and rewrite history consistently. The hash chains make ordinary tampering detectable, but defeating a superuser needs the chain's latest fingerprint stored outside the database (e.g. a daily signed export). Planned with production hosting.
3. **License limits** — admins can add licenses freely until billing (Phase 10) enforces seat counts.
