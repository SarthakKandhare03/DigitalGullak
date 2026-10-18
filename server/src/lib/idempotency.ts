import { one, run, tx, type DB } from '../db/db';
import { nowIso, type Clock } from './clock';
import { sha256Hex } from './crypto';
import { badRequest, conflict } from './errors';

const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,100}$/;

export function requireIdempotencyKey(value: string | string[] | undefined): string {
  const key = Array.isArray(value) ? value[0] : value;
  if (!key || !KEY_PATTERN.test(key)) {
    throw badRequest('idempotency_key_required', 'An Idempotency-Key header (8–100 characters) is required for this request.');
  }
  return key;
}

/**
 * Runs a synchronous create operation at most once per (scope, key) and
 * returns the stored response on retries. Reusing a key with a different
 * request body is rejected.
 */
export function withIdempotency<T>(
  db: DB,
  clock: Clock,
  scope: string,
  key: string,
  request: unknown,
  fn: () => T,
  status = 201,
): { status: number; body: T; replayed: boolean } {
  const requestHash = sha256Hex(JSON.stringify(request));
  return tx(db, () => {
    const existing = one<{ request_hash: string; response_status: number; response_body: string }>(
      db,
      'SELECT request_hash, response_status, response_body FROM idempotency_records WHERE scope = ? AND key = ?',
      scope,
      key,
    );
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw conflict('idempotency_key_reused', 'This request key was already used with different details.');
      }
      return { status: existing.response_status, body: JSON.parse(existing.response_body) as T, replayed: true };
    }
    const body = fn();
    run(
      db,
      'INSERT INTO idempotency_records (scope, key, request_hash, response_status, response_body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      scope,
      key,
      requestHash,
      status,
      JSON.stringify(body),
      nowIso(clock),
    );
    return { status, body, replayed: false };
  });
}
