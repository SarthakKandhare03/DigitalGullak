-- migrate:foreign-keys-off
-- Rewards (gamification), session idle timeout and reward-funded transactions.

-- ---------------------------------------------------------------------------
-- 1. Allow origin = 'reward' on transactions.
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt using
-- SQLite's documented procedure: the runner disables foreign keys for this
-- migration and runs PRAGMA foreign_key_check before committing. Dropping a
-- table does not fire its triggers; all triggers are recreated below as before.
-- ---------------------------------------------------------------------------

CREATE TABLE transactions_v2 (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users (id),
  goal_id            TEXT NOT NULL REFERENCES goals (id),
  kind               TEXT NOT NULL CHECK (kind IN ('contribution', 'withdrawal')),
  amount_paise       INTEGER NOT NULL CHECK (amount_paise > 0),
  status             TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'reversed')),
  origin             TEXT NOT NULL CHECK (origin IN ('manual', 'schedule', 'sample', 'reward')),
  schedule_id        TEXT REFERENCES schedules (id),
  idempotency_key    TEXT NOT NULL,
  provider           TEXT NOT NULL,
  provider_ref       TEXT,
  provider_version   INTEGER NOT NULL DEFAULT 0,
  counterparty_label TEXT NOT NULL,
  memo               TEXT,
  failure_reason     TEXT,
  simulated          INTEGER NOT NULL CHECK (simulated IN (0, 1)),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  settled_at         TEXT,
  UNIQUE (user_id, idempotency_key),
  CHECK (origin <> 'reward' OR kind = 'contribution')
);

INSERT INTO transactions_v2 SELECT
  id, user_id, goal_id, kind, amount_paise, status, origin, schedule_id, idempotency_key, provider, provider_ref,
  provider_version, counterparty_label, memo, failure_reason, simulated, created_at, updated_at, settled_at
FROM transactions;

DROP TABLE transactions;
ALTER TABLE transactions_v2 RENAME TO transactions;

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

CREATE INDEX ledger_entries_user_time ON ledger_entries (user_id, account_type, created_at);

-- ---------------------------------------------------------------------------
-- 2. Sessions: sliding idle timeout.
-- ---------------------------------------------------------------------------
ALTER TABLE sessions ADD COLUMN last_seen_at TEXT;

-- ---------------------------------------------------------------------------
-- 3. Gullak points: append-only points ledger. Balance = SUM(points).
-- (user_id, source, source_ref) is unique, so every award is idempotent.
-- ---------------------------------------------------------------------------
CREATE TABLE reward_points (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users (id),
  points      INTEGER NOT NULL CHECK (points <> 0),
  source      TEXT NOT NULL CHECK (source IN ('achievement', 'quest', 'quiz', 'game', 'redemption', 'redemption_refund')),
  source_ref  TEXT NOT NULL,
  note        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (user_id, source, source_ref)
);
CREATE INDEX reward_points_user ON reward_points (user_id, created_at);

CREATE TRIGGER reward_points_no_update BEFORE UPDATE ON reward_points
BEGIN SELECT RAISE(ABORT, 'reward_points is append-only'); END;
CREATE TRIGGER reward_points_no_delete BEFORE DELETE ON reward_points
BEGIN SELECT RAISE(ABORT, 'reward_points is append-only'); END;

-- Server-issued game/quiz sessions. Scores are recomputed on the server.
CREATE TABLE game_sessions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users (id),
  game            TEXT NOT NULL CHECK (game IN ('quiz', 'coin_catch')),
  seed            INTEGER NOT NULL,
  payload         TEXT NOT NULL,            -- JSON: quiz question ids, or coin layout parameters
  day             TEXT NOT NULL,            -- IST calendar day the session started
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  score           INTEGER,
  points_awarded  INTEGER
);
CREATE INDEX game_sessions_user_day ON game_sessions (user_id, game, day);
