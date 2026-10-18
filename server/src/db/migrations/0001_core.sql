-- Digital Gullak core schema.
-- Money columns are INTEGER paise. Timestamps are ISO-8601 UTC text;
-- calendar dates are 'YYYY-MM-DD' in India Standard Time.

-- ---------------------------------------------------------------------------
-- Identity (minimum data: keyed phone hash + last 4 digits, optional name)
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  phone_hash    TEXT UNIQUE,                 -- HMAC of the mobile number; NULL after closure
  phone_last4   TEXT NOT NULL CHECK (length(phone_last4) = 4),
  display_name  TEXT CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 40),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  onboarded_at  TEXT,
  created_at    TEXT NOT NULL,
  closed_at     TEXT
);

CREATE TABLE operators (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

INSERT INTO operators (id, name, created_at) VALUES ('op_demo', 'Demo operator', '2026-01-01T00:00:00.000Z');

CREATE TABLE otp_challenges (
  id           TEXT PRIMARY KEY,
  phone_hash   TEXT NOT NULL,
  phone_last4  TEXT NOT NULL,
  code_hash    TEXT NOT NULL,                -- HMAC of the code; the code itself is never stored
  attempts     INTEGER NOT NULL DEFAULT 0,
  expires_at   TEXT NOT NULL,
  consumed_at  TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX otp_challenges_phone ON otp_challenges (phone_hash, created_at);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,            -- SHA-256 of the cookie token; the token is never stored
  subject_type  TEXT NOT NULL CHECK (subject_type IN ('user', 'operator')),
  subject_id    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT
);
CREATE INDEX sessions_subject ON sessions (subject_type, subject_id);

-- ---------------------------------------------------------------------------
-- Goals ("pockets" are app-side allocations, not separate bank deposits)
-- ---------------------------------------------------------------------------
CREATE TABLE goals (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id),
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  icon          TEXT NOT NULL,
  target_paise  INTEGER NOT NULL CHECK (target_paise > 0),
  target_date   TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  is_example    INTEGER NOT NULL DEFAULT 0 CHECK (is_example IN (0, 1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  archived_at   TEXT
);
CREATE INDEX goals_user ON goals (user_id, status);

-- Link between an app user and their account at the bank partner.
-- Kept apart from identity so a partner integration never touches auth data.
CREATE TABLE provider_accounts (
  user_id       TEXT PRIMARY KEY REFERENCES users (id),
  provider      TEXT NOT NULL,
  customer_ref  TEXT NOT NULL,
  account_ref   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (provider, account_ref)
);

-- ---------------------------------------------------------------------------
-- Schedules (simulated in the demo; a real one needs a partner mandate)
-- ---------------------------------------------------------------------------
CREATE TABLE schedules (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users (id),
  goal_id        TEXT NOT NULL REFERENCES goals (id),
  amount_paise   INTEGER NOT NULL CHECK (amount_paise > 0),
  frequency      TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  anchor         INTEGER,                     -- weekday (0-6) or day of month (1-31)
  start_date     TEXT NOT NULL,
  next_run_date  TEXT,
  status         TEXT NOT NULL CHECK (status IN ('active', 'paused', 'cancelled')),
  origin         TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'sample')),
  consent_text   TEXT NOT NULL,
  consent_at     TEXT NOT NULL,
  mandate_ref    TEXT,                        -- partner mandate id; always NULL in the demo
  runs_count     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  cancelled_at   TEXT
);
CREATE INDEX schedules_user ON schedules (user_id, status);

CREATE TRIGGER schedules_no_delete BEFORE DELETE ON schedules
BEGIN SELECT RAISE(ABORT, 'schedules are retained for audit and cannot be deleted'); END;

CREATE TRIGGER schedules_cancelled_is_final BEFORE UPDATE OF status ON schedules
WHEN OLD.status = 'cancelled' AND NEW.status <> 'cancelled'
BEGIN SELECT RAISE(ABORT, 'a cancelled schedule cannot be reactivated'); END;

CREATE TABLE schedule_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id     TEXT NOT NULL REFERENCES schedules (id),
  user_id         TEXT NOT NULL REFERENCES users (id),
  type            TEXT NOT NULL CHECK (type IN ('created', 'paused', 'resumed', 'cancelled', 'simulated_run')),
  transaction_id  TEXT,
  note            TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX schedule_events_user ON schedule_events (user_id, created_at);

CREATE TRIGGER schedule_events_no_update BEFORE UPDATE ON schedule_events
BEGIN SELECT RAISE(ABORT, 'schedule_events is append-only'); END;
CREATE TRIGGER schedule_events_no_delete BEFORE DELETE ON schedule_events
BEGIN SELECT RAISE(ABORT, 'schedule_events is append-only'); END;

-- ---------------------------------------------------------------------------
-- Transaction journal
-- A transaction records an instruction to move (simulated) money and its
-- lifecycle. Allowed status changes: pending -> completed | failed,
-- completed -> reversed. Balances come only from ledger_entries, which are
-- written when the partner confirms.
-- ---------------------------------------------------------------------------
CREATE TABLE transactions (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users (id),
  goal_id            TEXT NOT NULL REFERENCES goals (id),
  kind               TEXT NOT NULL CHECK (kind IN ('contribution', 'withdrawal')),
  amount_paise       INTEGER NOT NULL CHECK (amount_paise > 0),
  status             TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'reversed')),
  origin             TEXT NOT NULL CHECK (origin IN ('manual', 'schedule', 'sample')),
  schedule_id        TEXT REFERENCES schedules (id),
  idempotency_key    TEXT NOT NULL,
  provider           TEXT NOT NULL,
  provider_ref       TEXT,
  provider_version   INTEGER NOT NULL DEFAULT 0,
  counterparty_label TEXT NOT NULL,           -- source (contribution) or destination (withdrawal)
  memo               TEXT,
  failure_reason     TEXT,
  simulated          INTEGER NOT NULL CHECK (simulated IN (0, 1)),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  settled_at         TEXT,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX transactions_user ON transactions (user_id, created_at);
CREATE INDEX transactions_goal ON transactions (goal_id, status);
CREATE UNIQUE INDEX transactions_provider_ref ON transactions (provider, provider_ref) WHERE provider_ref IS NOT NULL;

CREATE TRIGGER transactions_no_delete BEFORE DELETE ON transactions
BEGIN SELECT RAISE(ABORT, 'transactions are append-only and cannot be deleted'); END;

CREATE TRIGGER transactions_immutable_fields BEFORE UPDATE ON transactions
WHEN NEW.id IS NOT OLD.id
  OR NEW.user_id IS NOT OLD.user_id
  OR NEW.goal_id IS NOT OLD.goal_id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.amount_paise IS NOT OLD.amount_paise
  OR NEW.origin IS NOT OLD.origin
  OR NEW.schedule_id IS NOT OLD.schedule_id
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.provider IS NOT OLD.provider
  OR NEW.counterparty_label IS NOT OLD.counterparty_label
  OR NEW.simulated IS NOT OLD.simulated
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.provider_ref IS NOT NULL AND NEW.provider_ref IS NOT OLD.provider_ref)
  OR NEW.provider_version < OLD.provider_version
BEGIN SELECT RAISE(ABORT, 'recorded transaction fields are immutable'); END;

CREATE TRIGGER transactions_valid_transition BEFORE UPDATE OF status ON transactions
WHEN NEW.status IS NOT OLD.status AND NOT (
  (OLD.status = 'pending' AND NEW.status IN ('completed', 'failed')) OR
  (OLD.status = 'completed' AND NEW.status = 'reversed')
)
BEGIN SELECT RAISE(ABORT, 'invalid transaction status transition'); END;

CREATE TABLE transaction_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id  TEXT NOT NULL REFERENCES transactions (id),
  type            TEXT NOT NULL CHECK (type IN ('created', 'submitted', 'submission_error', 'status_changed')),
  from_status     TEXT,
  to_status       TEXT,
  actor           TEXT NOT NULL,              -- 'user', 'system', 'provider:<id>', 'operator:<id>'
  note            TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX transaction_events_txn ON transaction_events (transaction_id, id);

CREATE TRIGGER transaction_events_no_update BEFORE UPDATE ON transaction_events
BEGIN SELECT RAISE(ABORT, 'transaction_events is append-only'); END;
CREATE TRIGGER transaction_events_no_delete BEFORE DELETE ON transaction_events
BEGIN SELECT RAISE(ABORT, 'transaction_events is append-only'); END;

-- Double-entry ledger. Each posting writes two rows that sum to zero:
-- the goal pocket and the user's external (outside-the-app) account.
-- Corrections are new rows (entry_type = 'reversal'), never edits.
CREATE TABLE ledger_entries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id  TEXT NOT NULL REFERENCES transactions (id),
  user_id         TEXT NOT NULL REFERENCES users (id),
  account_type    TEXT NOT NULL CHECK (account_type IN ('pocket', 'external')),
  goal_id         TEXT REFERENCES goals (id),
  amount_paise    INTEGER NOT NULL CHECK (amount_paise <> 0),
  entry_type      TEXT NOT NULL CHECK (entry_type IN ('posting', 'reversal')),
  created_at      TEXT NOT NULL,
  CHECK ((account_type = 'pocket') = (goal_id IS NOT NULL))
);
CREATE INDEX ledger_entries_goal ON ledger_entries (goal_id) WHERE goal_id IS NOT NULL;
CREATE INDEX ledger_entries_user ON ledger_entries (user_id, account_type);
CREATE UNIQUE INDEX ledger_entries_once ON ledger_entries (transaction_id, account_type, entry_type);

CREATE TRIGGER ledger_entries_no_update BEFORE UPDATE ON ledger_entries
BEGIN SELECT RAISE(ABORT, 'ledger_entries is append-only'); END;
CREATE TRIGGER ledger_entries_no_delete BEFORE DELETE ON ledger_entries
BEGIN SELECT RAISE(ABORT, 'ledger_entries is append-only'); END;

-- Stored responses for client retries of create endpoints (goals, schedules).
CREATE TABLE idempotency_records (
  scope            TEXT NOT NULL,
  key              TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  response_status  INTEGER NOT NULL,
  response_body    TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

-- ---------------------------------------------------------------------------
-- Partner events, reconciliation and operator audit
-- ---------------------------------------------------------------------------
CREATE TABLE provider_events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  provider           TEXT NOT NULL,
  event_id           TEXT NOT NULL,
  type               TEXT NOT NULL,
  transfer_ref       TEXT,
  reference          TEXT,
  payload            TEXT NOT NULL,           -- verified payload (no customer PII)
  processing_status  TEXT NOT NULL CHECK (processing_status IN
                       ('received', 'processed', 'ignored_stale', 'unmatched', 'mismatch', 'conflict', 'unsupported')),
  processing_note    TEXT,
  delivery_count     INTEGER NOT NULL DEFAULT 1,
  occurred_at        TEXT NOT NULL,
  received_at        TEXT NOT NULL,
  last_received_at   TEXT NOT NULL,
  processed_at       TEXT,
  UNIQUE (provider, event_id)
);
CREATE INDEX provider_events_reference ON provider_events (provider, reference);

CREATE TABLE reconciliation_runs (
  id                 TEXT PRIMARY KEY,
  triggered_by       TEXT NOT NULL,
  started_at         TEXT NOT NULL,
  finished_at        TEXT NOT NULL,
  accounts_checked   INTEGER NOT NULL,
  transfers_checked  INTEGER NOT NULL,
  exceptions_opened  INTEGER NOT NULL,
  exceptions_closed  INTEGER NOT NULL
);

CREATE TABLE reconciliation_exceptions (
  id               TEXT PRIMARY KEY,
  dedupe_key       TEXT NOT NULL,
  kind             TEXT NOT NULL,
  user_id          TEXT,
  transaction_id   TEXT,
  details          TEXT NOT NULL,             -- JSON
  status           TEXT NOT NULL CHECK (status IN ('open', 'escalated', 'resolved')),
  first_seen_at    TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL,
  resolved_at      TEXT,
  resolved_by      TEXT,
  resolution_note  TEXT
);
CREATE UNIQUE INDEX reconciliation_exceptions_open ON reconciliation_exceptions (dedupe_key) WHERE status <> 'resolved';

CREATE TABLE operator_audit_log (
  id           TEXT PRIMARY KEY,
  operator_id  TEXT NOT NULL REFERENCES operators (id),
  action       TEXT NOT NULL,
  target_type  TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  reason       TEXT NOT NULL CHECK (length(reason) >= 5),
  before_json  TEXT,
  after_json   TEXT,
  created_at   TEXT NOT NULL
);

CREATE TRIGGER operator_audit_log_no_update BEFORE UPDATE ON operator_audit_log
BEGIN SELECT RAISE(ABORT, 'operator_audit_log is append-only'); END;
CREATE TRIGGER operator_audit_log_no_delete BEFORE DELETE ON operator_audit_log
BEGIN SELECT RAISE(ABORT, 'operator_audit_log is append-only'); END;
