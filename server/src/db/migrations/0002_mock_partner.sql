-- MOCK PARTNER BANK — SIMULATION ONLY.
-- These tables stand in for the bank partner's own systems so the demo can
-- exercise the provider interface, signed webhooks and reconciliation.
-- The app never reads them directly; it only talks to the mock through the
-- BankPartnerProvider interface and the webhook endpoint. A real integration
-- drops these tables entirely.

CREATE TABLE mockbank_accounts (
  account_ref        TEXT PRIMARY KEY,
  customer_ref       TEXT NOT NULL UNIQUE,
  external_user_id   TEXT NOT NULL UNIQUE,     -- the app's user id, as the partner would store a client reference
  masked_number      TEXT NOT NULL,
  linked_bank_last4  TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('active', 'closed')),
  created_at         TEXT NOT NULL
);

CREATE TABLE mockbank_transfers (
  id               TEXT PRIMARY KEY,
  idempotency_key  TEXT NOT NULL UNIQUE,
  reference        TEXT NOT NULL,
  account_ref      TEXT NOT NULL REFERENCES mockbank_accounts (account_ref),
  direction        TEXT NOT NULL CHECK (direction IN ('collect', 'payout')),
  amount_paise     INTEGER NOT NULL CHECK (amount_paise > 0),
  status           TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'reversed')),
  version          INTEGER NOT NULL,
  scenario         TEXT NOT NULL CHECK (scenario IN ('confirm', 'decline', 'slow')),
  failure_reason   TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX mockbank_transfers_account ON mockbank_transfers (account_ref, created_at);

CREATE TABLE mockbank_events (
  id                    TEXT PRIMARY KEY,
  type                  TEXT NOT NULL,
  transfer_id           TEXT,
  payload               TEXT NOT NULL,
  delivery_status       TEXT NOT NULL CHECK (delivery_status IN ('pending', 'delivered', 'failed', 'suppressed')),
  attempts              INTEGER NOT NULL DEFAULT 0,
  last_attempt_at       TEXT,
  last_response_status  INTEGER,
  created_at            TEXT NOT NULL
);
