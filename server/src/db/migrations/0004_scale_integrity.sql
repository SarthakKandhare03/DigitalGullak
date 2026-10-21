-- Scale and integrity: cached balances, tamper-evident hash chains,
-- security events, and indexes for retention jobs.

-- ---------------------------------------------------------------------------
-- 1. Cached posted balance per goal, maintained by a trigger in the same
-- transaction as every ledger insert. The ledger stays the source of truth;
-- reconciliation verifies the cache against SUM(ledger_entries).
-- ---------------------------------------------------------------------------
CREATE TABLE goal_balances (
  goal_id       TEXT PRIMARY KEY REFERENCES goals (id),
  user_id       TEXT NOT NULL REFERENCES users (id),
  posted_paise  INTEGER NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX goal_balances_user ON goal_balances (user_id);

INSERT INTO goal_balances (goal_id, user_id, posted_paise, updated_at)
SELECT goal_id, user_id, SUM(amount_paise), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM ledger_entries WHERE account_type = 'pocket' GROUP BY goal_id, user_id;

CREATE TRIGGER ledger_entries_cache_balance AFTER INSERT ON ledger_entries
WHEN NEW.account_type = 'pocket'
BEGIN
  INSERT INTO goal_balances (goal_id, user_id, posted_paise, updated_at)
  VALUES (NEW.goal_id, NEW.user_id, NEW.amount_paise, NEW.created_at)
  ON CONFLICT (goal_id) DO UPDATE SET posted_paise = posted_paise + excluded.posted_paise, updated_at = excluded.updated_at;
END;

CREATE INDEX transactions_user_status ON transactions (user_id, status);

-- ---------------------------------------------------------------------------
-- 2. Tamper-evident HMAC hash chains. Each row stores the previous row's hash
-- and its own keyed hash, so editing, deleting or inserting rows anywhere
-- breaks verification — even for someone who can bypass the triggers.
-- The only UPDATE ever allowed is sealing a legacy row whose hash is NULL.
-- ---------------------------------------------------------------------------
DROP TRIGGER ledger_entries_no_update;
ALTER TABLE ledger_entries ADD COLUMN prev_hash TEXT;
ALTER TABLE ledger_entries ADD COLUMN row_hash TEXT;
CREATE TRIGGER ledger_entries_no_update BEFORE UPDATE ON ledger_entries
WHEN NOT (
  OLD.row_hash IS NULL AND NEW.row_hash IS NOT NULL
  AND NEW.id = OLD.id AND NEW.transaction_id = OLD.transaction_id AND NEW.user_id = OLD.user_id
  AND NEW.account_type = OLD.account_type AND NEW.goal_id IS OLD.goal_id AND NEW.amount_paise = OLD.amount_paise
  AND NEW.entry_type = OLD.entry_type AND NEW.created_at = OLD.created_at
)
BEGIN SELECT RAISE(ABORT, 'ledger_entries is append-only'); END;

DROP TRIGGER operator_audit_log_no_update;
ALTER TABLE operator_audit_log ADD COLUMN prev_hash TEXT;
ALTER TABLE operator_audit_log ADD COLUMN row_hash TEXT;
CREATE TRIGGER operator_audit_log_no_update BEFORE UPDATE ON operator_audit_log
WHEN NOT (
  OLD.row_hash IS NULL AND NEW.row_hash IS NOT NULL
  AND NEW.id = OLD.id AND NEW.operator_id = OLD.operator_id AND NEW.action = OLD.action
  AND NEW.target_type = OLD.target_type AND NEW.target_id = OLD.target_id AND NEW.reason = OLD.reason
  AND NEW.before_json IS OLD.before_json AND NEW.after_json IS OLD.after_json AND NEW.created_at = OLD.created_at
)
BEGIN SELECT RAISE(ABORT, 'operator_audit_log is append-only'); END;

-- Incremental verification: periodic jobs verify only rows added since the last checkpoint.
CREATE TABLE integrity_checkpoints (
  chain        TEXT PRIMARY KEY,
  last_rowid   INTEGER NOT NULL,
  last_hash    TEXT NOT NULL,
  verified_at  TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 3. Security events (shared across worker processes). Subjects are keyed
-- hashes, never raw IP addresses or phone numbers.
-- ---------------------------------------------------------------------------
CREATE TABLE security_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,
  subject     TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX security_events_lookup ON security_events (type, subject, created_at);
CREATE INDEX security_events_time ON security_events (created_at);

-- TOTP replay protection: the last accepted 30-second time step.
ALTER TABLE operators ADD COLUMN totp_last_step INTEGER;

-- ---------------------------------------------------------------------------
-- 4. Indexes for retention clean-up.
-- ---------------------------------------------------------------------------
CREATE INDEX sessions_expiry ON sessions (expires_at);
CREATE INDEX otp_challenges_created ON otp_challenges (created_at);
CREATE INDEX idempotency_records_created ON idempotency_records (created_at);

-- Fast lookup of rows not yet sealed into their hash chain.
CREATE INDEX ledger_entries_unsealed ON ledger_entries (id) WHERE row_hash IS NULL;
CREATE INDEX operator_audit_log_unsealed ON operator_audit_log (created_at) WHERE row_hash IS NULL;

-- Mock partner (simulation only): indexes for the leader's recovery sweep and reference lookups.
CREATE INDEX mockbank_transfers_pending ON mockbank_transfers (created_at) WHERE status = 'pending';
CREATE INDEX mockbank_transfers_reference ON mockbank_transfers (reference);
CREATE INDEX mockbank_events_undelivered ON mockbank_events (created_at) WHERE delivery_status = 'pending';

-- Operator overview: count pending transfers without scanning the journal.
CREATE INDEX transactions_pending ON transactions (created_at) WHERE status = 'pending';
