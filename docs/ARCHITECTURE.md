# Architecture note: the simulated-money boundary

## 1. The principle

Digital Gullak is a **record of intentions and allocations**. The bank partner is the **record of money**.

- The app owns identity (demo sign-in), goals, schedules, and a journal of instructions ("add ₹500 to Emergency fund").
- The partner owns the account, the funds, KYC, the legal protection that applies, and the final status of every transfer.
- Goal "pockets" are allocations inside the app: ledger sub-accounts whose total must equal the partner's balance. They are not separate bank deposits unless a partner confirms otherwise.

In this build the partner is a **mock** (`server/src/providers/mock/`). Nothing else in the app knows that.

## 2. How the boundary is enforced

| Layer | Mechanism |
| --- | --- |
| Configuration | `server/src/config.ts` refuses to start unless `DEMO_MODE=true`, `LIVE_MONEY_ENABLED=false` and `BANK_PROVIDER=mock`. No live provider exists, so there is nothing to switch on by accident. |
| Data | Every transaction row has `simulated = 1` (immutable) and the mock's display name says "(simulated)". Sample data is `origin = 'sample'`. |
| API | `/api/config` returns `demoMode: true, liveMoneyEnabled: false`; every response carries `X-Demo-Mode: simulated-money-only`. |
| UI | A persistent DEMO banner on every screen, a *Simulated* chip next to every balance and transaction, and explicit copy on each confirmation ("This demo transaction does not move money"; "No automatic debit will occur in demo mode"). The mock OTP sits in a box labelled "Mock OTP · demo only". |
| Code | The app reaches the partner only through `BankPartnerProvider` (`server/src/providers/types.ts`) and the signed webhook endpoint. The mock's tables use a separate `mockbank_` prefix and the app never queries them. |

## 3. Money flow in the demo

```
User confirms ──► POST /api/goals/:id/contributions  (Idempotency-Key header)
                    │  one synchronous DB transaction:
                    │   • replay check on (user, key)
                    │   • ownership + goal active + amount limits
                    │   • withdrawals: amount ≤ posted − pending withdrawals (hold)
                    │   • INSERT transactions (status = pending) + event 'created'
                    ▼
                  provider.createTransfer({ idempotencyKey: txn.id, reference: txn.id, … })
                    │  partner returns { id, status: pending, version: 1 }
                    ▼
                  journal: provider_ref set, event 'submitted'          ◄── UI shows "Waiting for confirmation"
                    ⋮  (mock partner settles after MOCK_PROVIDER_SETTLE_MS)
Partner ──► POST /api/provider/webhooks/mock   (HMAC-SHA256 over "t.rawBody", 5-min tolerance)
                    │  • verify signature on the raw body, then parse
                    │  • store the event once (UNIQUE provider + event_id) → duplicates are acknowledged, not reapplied
                    │  • match by provider_ref or reference
                    │  • apply only if version > recorded version (stale/out-of-order events are ignored)
                    │  • state machine: pending → completed | failed; completed → reversed
                    ▼
                  completed ⇒ two ledger entries (+pocket, −external) that sum to zero
                                                                         ◄── UI shows "Simulated deposit confirmed"
```

The UI never shows success until the partner's confirmation has been applied. It polls `GET /api/transactions/:id` while the status is pending.

## 4. Integrity guarantees

- **Integer paise everywhere.** `shared/money.ts` parses "1,250.50" into `125050` using string handling only. Formatting splits rupees and paise with integer remainder. SQLite columns are `INTEGER`.
- **Append-only journal.** SQLite triggers in `0001_core.sql` reject:
  - deleting `transactions`, `transaction_events`, `ledger_entries`, `schedule_events` or `operator_audit_log` rows
  - editing amounts, owners, goals or keys
  - any status change outside the allowed state machine
  - lowering `provider_version`

  Corrections are new ledger rows (`entry_type = 'reversal'`), never edits.
- **Balances are derived** from `ledger_entries`, never stored as mutable numbers.
- **Idempotency** works at three levels:
  - Client keys on create and transfer endpoints.
  - Deterministic keys for schedule runs (`schedule:<id>:<date>`).
  - The partner call uses the transaction id as its idempotency key.

  Retrying a request can never add or withdraw money twice.
- **Ownership:** every user query includes `user_id = ?`. Other users' resources return 404, so the API does not reveal whether they exist.
- **Atomicity:** `node:sqlite` is synchronous and every check-then-write runs in one `BEGIN IMMEDIATE` transaction with no `await` inside.

## 5. Reconciliation and operations

`ReconciliationService` (`server/src/ops/reconciliation.ts`) compares, per user:

- app transactions vs. partner transfers: missing on either side, amount or direction mismatch, status mismatch (after a grace period for in-flight webhooks), stuck pending, never submitted
- the sum of goal pockets vs. the partner's ledger balance

Findings become de-duplicated **exceptions**. Exceptions that no longer reproduce are closed automatically. Operators resolve the rest with *apply partner status* (the partner is authoritative), *retry submission*, *escalate to partner* or *mark resolved*. Each action requires a reason and writes an `operator_audit_log` row, with before and after state, in the same database transaction as the change.

Demo tools let you rehearse failure modes against the mock partner, and each is audited:

- settle "slow" transfers
- reverse a transfer while "losing" its webhook
- replay a webhook to show duplicate handling

## 6. What a regulated partner must supply before live money

1. **A signed agreement** with a bank or authorised provider, with a reviewed fund flow. The fund flow sets:
   - whose name the account is in
   - whether pockets are app allocations or partner sub-accounts
   - how funds come in (UPI collect/intent, mandate) and go out (payout to a verified account)
   - who is responsible for KYC
2. **Partner APIs** that implement `BankPartnerProvider`:
   - account opening and status (after the partner's own KYC)
   - balances and transfer listing for reconciliation
   - idempotent transfer creation and transfer lookup
   - interest terms, if any
3. **Webhook specification:**
   - signing scheme and key rotation
   - event types
   - per-transfer versions or sequence numbers
   - retry policy
   - IP allow-list or mTLS
4. **Settlement statements and reconciliation files**, with the cut-off times and formats the partner uses.
5. **A recurring-payment mandate flow** (for example UPI AutoPay or e-mandate) run by the partner or their payment provider. It must provide:
   - visible consent, amount, frequency and limits
   - pre-debit notifications at least 24 hours before each debit
   - pause, revoke and status events

   Only then can schedules become real. Under RBI's e-mandate framework, recurring debits above ₹15,000 generally need extra authentication, so the demo caps schedules at ₹15,000.
6. **Approved customer disclosures:**
   - where money is held
   - fees
   - interest (shown only from partner terms and credits)
   - withdrawal timelines
   - deposit-insurance wording, only if the exact account structure qualifies under DICGC and the partner approves the text
7. **Grievance redressal:** the partner's grievance officer, escalation timelines, and the RBI Integrated Ombudsman route (cms.rbi.org.in).
8. **Data obligations:** retention periods (KYC and PMLA versus DPDP minimisation), data localisation, breach notification and consent records.

Production hardening that this demo leaves out:

- PostgreSQL with row-level security
- a real SMS OTP provider (DLT-registered templates)
- staff SSO with MFA for the operator console
- secrets management, rate limiting at the edge
- scheduled reconciliation jobs, alerting, and a support ticketing system

### References (verify current versions with the partner)

- RBI Master Directions on Prepaid Payment Instruments — https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id=12156
- DICGC information booklet — https://www.dicgc.org.in/sites/default/files/2025-02/dicgc-information-booklet.pdf
- NPCI BHIM / UPI AutoPay — https://www.npci.org.in/product/bhim
- SEBI caution on digital gold (Nov 2025) — https://www.sebi.gov.in/media-and-notifications/press-releases/nov-2025/caution-to-public-regarding-dealing-in-digital-gold-_97676.html
- RBI Digital Payments – E-mandate Framework, 2026 (consolidated rules on AFA limits and pre-debit alerts)
- Digital Personal Data Protection Rules, 2025 (phased compliance by May 2027)
- RBI Integrated Ombudsman Scheme (revised scheme effective 1 July 2026)

## 7. Gullak Rewards (gamification)

**Principle:** reward saving habits and learning. Nobody pays, deposits or stakes anything to play, so no game is an "online money game" under the Promotion and Regulation of Online Gaming Act, 2025. There are no games of chance: no spins, scratch cards or lotteries.

| Piece | How it works | Abuse controls |
| --- | --- | --- |
| Points ledger | `reward_points` is append-only (triggers block edits and deletes). Balance = SUM(points). Each award is unique on (user, source, source_ref), so retries and double claims do nothing. | Sample-data and reward-funded transactions never earn points. |
| Achievements | Evaluated on the server whenever the rewards summary is read, and awarded once. | Example goals don't count. Thresholds need both a current balance and real deposits. Goal-based badges need a ₹500 or ₹1,000+ target. |
| Weekly quests | Progress is computed from completed transactions in the IST week (Mon–Sun). Claiming is idempotent. | "Save 3 times" requires net savings to cover the deposits, so a deposit followed by a withdrawal doesn't count. |
| Streak | Consecutive IST weeks with a qualifying saving (₹100 or more). | Weekly rather than daily, to avoid pressure. |
| Money Quiz | Answers stay on the server. Questions come from a server seed, re-opening returns the same quiz, and one quiz is rewarded per day. | 30-minute session expiry, single submit. |
| Coin Catch | The server issues a seed and the client renders a deterministic layout (`shared/rewards.ts`). The client sends back only the indices it caught; the server checks timing, uniqueness and fall plausibility, then recomputes the score. | Up to 60 points per game, 3 rewarded plays and 15 sessions per day, 30 requests per minute per IP. A client could still claim every coin, but the caps limit any gain. |
| Redemption | 10 points = ₹1. The points debit and a `reward`-origin contribution are written in **one DB transaction**, then submitted to the partner like any other transfer. If the partner fails or reverses it, the points are refunded automatically. | At least 500 points, in steps of 10. Capped at ₹200 per day. Requires an idempotency key. |

**Before going live:** reward credits need to be funded by the partner bank or a sponsor, with published terms covering expiry, eligibility, tax treatment of promotional income, and grievance handling. Legal review is needed against consumer-protection rules (dark patterns) and the Online Gaming Act and Rules. Until then, the rewards stay simulated.

## 8. Security hardening

- **Sessions:** cookies are httpOnly and SameSite=Strict (Secure when `COOKIE_SECURE=true`). The server stores only the SHA-256 hash of the token. Sessions expire after 30 minutes of inactivity, with an absolute limit of 7 days for users and 8 hours for operators. Each user can have at most 5 active sessions; signing out revokes the session on the server.
- **CSRF:**
  - SameSite=Strict cookies
  - JSON-only bodies (any other content type gets a 415)
  - an Origin allow-list (`APP_ORIGINS`)
  - Fetch Metadata: requests marked `Sec-Fetch-Site: cross-site` are refused
- **Rate limits:** per IP, using `@fastify/rate-limit`.
  - 600 requests per minute globally
  - OTP request: 10 per minute; OTP verify: 20 per minute
  - operator sign-in: 10 per minute
  - games and claims: 30 per minute

  These sit on top of the per-phone OTP limits and the operator lockout. Signed partner webhooks are exempt from rate limits.
- **Headers:**
  - a strict CSP: no inline scripts, no third-party origins, `frame-ancestors 'none'`
  - X-Frame-Options DENY, nosniff and Referrer-Policy: no-referrer
  - Permissions-Policy, COOP and CORP
  - HSTS when the app is served over HTTPS
  - an `X-Request-Id` on every response for support tracing
  - `Cache-Control: no-store` on every API response
- **Input:** Zod validation everywhere, with strict schemas that reject unknown fields on money and reward endpoints. Request bodies are capped at 64 KB. Unknown or another user's resources return 404.
- **Secrets and logs:** secrets come only from the environment. The server refuses placeholder values. Cookies, signatures and OTP codes are never logged.
- **Data integrity:** the following tables are append-only, enforced by database triggers:
  - transactions
  - transaction events
  - ledger entries
  - schedule events
  - reward points
  - the operator audit log
- **Performance:**
  - lazy-loaded routes, with the vendor code (React, TanStack Query) split into long-cached chunks
  - immutable caching for hashed assets
  - Brotli/gzip compression
  - batched goal-balance queries
  - covering indexes for history and points queries
