# Digital Gullak — demo

An India-first, INR goal-based savings app: set aside small amounts for an emergency fund, rent, a phone, education or travel.

> **This build is a working demo with simulated money only.** It connects to no bank, UPI, payment, KYC or investment service. Every balance and transaction is simulated and labelled as such. The server refuses to start in any live-money configuration.

## Quick start

Requirements: **Node.js 22.13 or newer** (uses the built-in `node:sqlite`; tested on Node 25). No database server or Docker needed.

```bash
npm install
npm run setup     # creates .env with random demo secrets, runs migrations, seeds demo users
npm run dev       # API on :8787, web app on http://localhost:5173
```

Open http://localhost:5173 and sign in with any 10-digit Indian mobile number. The **mock OTP is shown on screen** — no SMS is sent.

| Demo account | Mobile | What you get |
| --- | --- | --- |
| Asha | `98765 43210` | Three example goals with simulated history, one active and one paused schedule |
| Ravi | `91234 56780` | Empty account (useful for checking that users can't see each other's data) |
| Any other number | — | New user; choose example goals or start fresh |

**Operator console:** http://localhost:5173/ops — passcode `gullak-ops-demo` (set by `OPERATOR_PASSCODE` in `.env`).

### Production-style run (single port)

```bash
npm run build     # builds the web app into web/dist
npm start         # serves API + web app on http://127.0.0.1:8787
```

### Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | API (tsx watch) + Vite dev server with `/api` proxy |
| `npm test` | Unit and API tests (Vitest, in-memory SQLite) |
| `npm run e2e` | Browser tests of the main flows on mobile and desktop viewports (Playwright, uses installed Edge; set `E2E_CHANNEL=chrome` for Chrome) |
| `npm run e2e -- -g rewards` | Only the rewards end-to-end test (it includes a full 30-second Coin Catch round) |
| `npm run typecheck` | TypeScript check for server, shared code and web app |
| `npm run db:migrate` / `db:seed` / `db:reset` | Database management (`reset` deletes and recreates the demo database) |

### Configuration

See [.env.example](.env.example). Notes:

- `DEMO_MODE` must be `true`, `LIVE_MONEY_ENABLED` must be `false` and `BANK_PROVIDER` must be `mock`, or the server exits with an explanation.
- Secrets (`AUTH_HMAC_SECRET`, `MOCK_PROVIDER_WEBHOOK_SECRET`, `OPERATOR_PASSCODE`) come from the environment only. `npm run setup` generates random values; the example file contains placeholders that the server rejects.
- This folder is inside OneDrive. If you see file-locking issues, point `DATABASE_PATH` at a folder that isn't synced.

## Stack

| Layer | Choice |
| --- | --- |
| Language | TypeScript throughout (shared money/date/API types in `shared/`) |
| API | Fastify 5, Zod validation, cookie sessions |
| Database | SQLite (Node's built-in `node:sqlite`), hand-written SQL migrations with integrity triggers. The schema is portable to PostgreSQL for production. |
| Web | React 19, React Router 7, TanStack Query, Vite 7, plain CSS with design tokens (light/dark) |
| Tests | Vitest (shared + API), Playwright (end-to-end) |

## Project layout

```
shared/                 money (integer paise), IST dates, API types — used by server and web
server/src/
  app.ts                Fastify setup: raw-body JSON, CSRF origin check, security headers, routes
  config.ts             env parsing + the simulated-money guard
  db/                   SQLite helpers, migration runner, migrations/*.sql, CLI (migrate/seed/reset)
  auth/                 mock-OTP sign-in, sessions, account (onboarding, export, closure)
  goals/                goal pockets
  ledger/               transaction journal, double-entry ledger, activity feed, provider-account link
  schedules/            simulated recurring contributions
  providers/            BankPartnerProvider interface, webhook event processor
  providers/mock/       the mock partner bank (simulation only)
  ops/                  reconciliation, exceptions, operator audit log, ops read models
  routes/               public (auth, config, webhooks), user, ops
server/test/            API tests
web/src/                React app (pages/, components/, lib/)
e2e/                    Playwright specs
docs/                   architecture note and implementation plan
```

## What works

- Mock-OTP sign-in (rate-limited, codes hashed, only phone hash + last 4 digits stored)
- First-run choice of example goals (labelled *Sample*) or a fresh start; nothing preselected
- Goals: create, rename, edit, archive (blocked until empty), restore; progress and a suggested monthly amount
- Add savings and withdraw: amount → review (amount in words, from/to, "does not move money") → pending → confirmed or failed, driven by signed webhooks from the mock partner
- Savings schedules: daily/weekly/monthly, explicit unticked consent, pause, resume, cancel, "Simulate next run"
- Activity feed of contributions, withdrawals and schedule events with Pending / Completed / Failed / Reversed / Simulated states, plus a per-transaction history timeline
- Help & FAQs; account settings with data export (JSON) and account closure
- **Gullak Rewards:** points, levels, a weekly saving streak, 10 achievements, weekly quests, a daily Money Quiz (financial literacy and fraud safety), the Coin Catch mini-game (scores checked on the server), and redemption of points as a *simulated* reward credit into a goal. All games are free to play, with no stakes.
- **Savings over time** chart (1M/3M/6M/1Y) showing the user's own confirmed balance. It never shows prices or returns.
- **"Midnight Gold" UI:** a dark premium theme with animated count-ups, page transitions, staggered cards, gold sheen, confetti and toasts. All animation respects `prefers-reduced-motion`.
- Operator console: KPIs, reconciliation, exceptions with audited resolutions, partner event log, webhook replay, demo drift tools

## Live-money features that are disabled

Disabled or not built: real bank accounts, payments of any kind (UPI collect/intent, mandates or UPI AutoPay, NEFT/IMPS payouts), KYC, real SMS OTP, interest, deposit-insurance wording, round-ups and real support ticketing. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for what a regulated partner must supply before any of these can be enabled.
