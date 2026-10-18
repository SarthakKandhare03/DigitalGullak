# Implementation plan and decisions

## Research findings that shaped the build

| Finding | Effect on the product |
| --- | --- |
| SEBI cautioned the public about digital gold (Nov 2025); gold-based "gullak" apps then saw a surge in withdrawals. | INR-only, bank-partner savings. No gold, funds, stocks, crypto or wallet. |
| RBI's consolidated e-mandate framework (2026): a one-time additional factor of authentication (AFA) at registration, a pre-debit alert at least 24 hours before each debit, and up to ₹15,000 per debit without AFA for most categories. | Schedules are simulations. The consent copy describes the real mandate flow. The demo caps scheduled amounts at ₹15,000. |
| DICGC cover is still ₹5 lakh per depositor per bank. Raising it has been discussed, but no change is confirmed. | No insurance claim anywhere. Wording is left to the partner. |
| DPDP Rules 2025 were notified in Nov 2025, with phased compliance due by May 2027. | Minimal data: phone stored as an HMAC plus last 4 digits, optional first name. Data export included. |
| RBI Integrated Ombudsman Scheme: complain to the regulated entity first; after 30 days, go to cms.rbi.org.in (revised scheme from 1 July 2026). | Complaints FAQ describes the escalation path. |
| Payment-system practice: append-only double-entry ledger, idempotency keys, event-id dedupe, version numbers against reordering, reconciliation against the provider. | Core ledger and webhook design. |

## Options considered

| Decision | Chosen | Alternatives and why not |
| --- | --- | --- |
| Web stack | Fastify API + React/Vite SPA, all TypeScript | Next.js: heavier, and a less clear server/client split for a ledger. |
| Database | SQLite via built-in `node:sqlite` (Node ≥ 22.13) | Postgres/Docker are not installed on this machine. `better-sqlite3` needs native builds. The SQL stays portable to Postgres. |
| ORM | Hand-written SQL + triggers | Prisma/Drizzle: triggers that enforce immutability would be harder to read and audit. |
| Balance model | Derived from double-entry `ledger_entries` | A mutable balance column: easy to drift, hard to audit. |
| Partner callbacks | Signed webhooks with version checks, delivered by the mock through Fastify's request pipeline | Polling only: less realistic, and it skips the duplicate and reorder handling. |
| Schedules | Run only when the user presses "Simulate next run" | Background timer: could look like an automatic debit, which the brief rules out in demo mode. |

## Phases

1. **Foundations:** config guard, SQLite helpers, migrations, shared money and date utilities.
2. **Provider boundary:** `BankPartnerProvider` interface; mock partner with idempotent transfers, async settlement, HMAC-signed webhooks with retries, and its own ledger.
3. **Core domain:**
   - ledger: state machine, holds, postings, reversals
   - goals
   - schedules
   - activity feed
   - mock-OTP auth with sessions
   - account: onboarding, export, closure
4. **Operations:** event processor (dedupe, stale or unmatched events), reconciliation, exceptions, audit log, demo drift tools.
5. **API:** Zod-validated routes, ownership scoping, idempotency headers, CSRF origin check, security headers.
6. **Web app:**
   - design tokens with a light and dark theme
   - shell: demo banner, top nav on desktop, bottom nav on mobile, focus management
   - screens: welcome and sign-in, onboarding, home, goals, goal detail and form, add/withdraw flow, schedules, activity, transaction detail, help, account, operator console
7. **Verification:**
   - Vitest API tests covering: idempotency, ownership, immutability, webhook dedupe and staleness, overdraw holds, schedules, reconciliation and audit
   - Playwright end-to-end tests of every main flow on mobile and desktop

## Next steps toward production

See [ARCHITECTURE.md §6](ARCHITECTURE.md#6-what-a-regulated-partner-must-supply-before-live-money).
