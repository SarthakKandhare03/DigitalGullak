import { all, one, run, type DB } from '../db/db';
import type { Clock } from './clock';
import { hmacHex, safeEqual } from './crypto';

export interface ChainSpec {
  name: 'ledger' | 'audit';
  table: 'ledger_entries' | 'operator_audit_log';
  /** Columns covered by the hash, in a fixed order. */
  fields: string[];
}

export const LEDGER_CHAIN: ChainSpec = {
  name: 'ledger',
  table: 'ledger_entries',
  fields: ['id', 'transaction_id', 'user_id', 'account_type', 'goal_id', 'amount_paise', 'entry_type', 'created_at'],
};

export const AUDIT_CHAIN: ChainSpec = {
  name: 'audit',
  table: 'operator_audit_log',
  fields: ['id', 'operator_id', 'action', 'target_type', 'target_id', 'reason', 'before_json', 'after_json', 'created_at'],
};

const GENESIS = 'genesis';

export interface VerifyResult {
  chain: string;
  ok: boolean;
  checked: number;
  /** rowid of the first row that failed verification. */
  brokenAt: number | null;
  reason: string | null;
}

/**
 * Tamper-evident HMAC hash chain over an append-only table. Each row stores
 * the previous row's hash and HMAC(key, [prev, ...fields]). Because the key
 * lives outside the database, someone who edits the file directly cannot
 * recompute a valid chain. Sealing must happen inside the inserting write
 * transaction, which serialises it across worker processes.
 */
export class HashChain {
  private readonly key: string;

  constructor(
    private readonly db: DB,
    secret: string,
    private readonly spec: ChainSpec,
    private readonly clock: Clock,
  ) {
    this.key = hmacHex(secret, `integrity-chain:${spec.name}`);
  }

  private hash(prev: string, row: Record<string, unknown>): string {
    return hmacHex(this.key, JSON.stringify([prev, ...this.spec.fields.map((f) => row[f] ?? null)]));
  }

  /** Seals one freshly inserted row. Its predecessor must already be sealed. */
  seal(rowid: number): void {
    if (!this.db.isTransaction) throw new Error('HashChain.seal must run inside the inserting transaction');
    const { table, fields } = this.spec;
    const prev = one<{ row_hash: string | null }>(this.db, `SELECT row_hash FROM ${table} WHERE rowid < ? ORDER BY rowid DESC LIMIT 1`, rowid);
    if (prev && !prev.row_hash) {
      this.sealPending();
      return;
    }
    const row = one<Record<string, unknown>>(this.db, `SELECT ${fields.join(', ')} FROM ${table} WHERE rowid = ?`, rowid);
    if (!row) throw new Error(`Row ${rowid} not found in ${table}`);
    const prevHash = prev?.row_hash ?? GENESIS;
    run(this.db, `UPDATE ${table} SET prev_hash = ?, row_hash = ? WHERE rowid = ? AND row_hash IS NULL`, prevHash, this.hash(prevHash, row), rowid);
  }

  /** Seals every unsealed row in order (used once for rows written before chains existed). */
  sealPending(): number {
    const { table, fields } = this.spec;
    const pending = all<Record<string, unknown> & { rid: number }>(
      this.db,
      `SELECT rowid AS rid, ${fields.join(', ')} FROM ${table} WHERE row_hash IS NULL ORDER BY rowid`,
    );
    for (const row of pending) {
      const prev = one<{ row_hash: string | null }>(this.db, `SELECT row_hash FROM ${table} WHERE rowid < ? ORDER BY rowid DESC LIMIT 1`, row.rid);
      const prevHash = prev?.row_hash ?? GENESIS;
      run(this.db, `UPDATE ${table} SET prev_hash = ?, row_hash = ? WHERE rowid = ? AND row_hash IS NULL`, prevHash, this.hash(prevHash, row), row.rid);
    }
    return pending.length;
  }

  /**
   * Verifies the chain. Incremental mode starts from the last verified
   * checkpoint so routine checks stay cheap as the table grows.
   */
  verify(mode: 'incremental' | 'full' = 'incremental'): VerifyResult {
    const { table, fields, name } = this.spec;
    const checkpoint =
      mode === 'incremental'
        ? one<{ last_rowid: number; last_hash: string }>(this.db, 'SELECT last_rowid, last_hash FROM integrity_checkpoints WHERE chain = ?', name)
        : undefined;
    let expectedPrev = checkpoint?.last_hash ?? GENESIS;
    let lastRowid = checkpoint?.last_rowid ?? 0;
    const rows = all<Record<string, unknown> & { rid: number; prev_hash: string | null; row_hash: string | null }>(
      this.db,
      `SELECT rowid AS rid, prev_hash, row_hash, ${fields.join(', ')} FROM ${table} WHERE rowid > ? ORDER BY rowid`,
      lastRowid,
    );
    for (const row of rows) {
      const fail = (reason: string): VerifyResult => ({ chain: name, ok: false, checked: rows.indexOf(row), brokenAt: row.rid, reason });
      if (!row.row_hash || !row.prev_hash) return fail('row is not sealed');
      if (!safeEqual(row.prev_hash, expectedPrev)) return fail('link to the previous row is broken (row removed, reordered or inserted)');
      if (!safeEqual(row.row_hash, this.hash(row.prev_hash, row))) return fail('row contents do not match their hash (row edited)');
      expectedPrev = row.row_hash;
      lastRowid = row.rid;
    }
    if (rows.length) {
      run(
        this.db,
        `INSERT INTO integrity_checkpoints (chain, last_rowid, last_hash, verified_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (chain) DO UPDATE SET last_rowid = excluded.last_rowid, last_hash = excluded.last_hash, verified_at = excluded.verified_at`,
        name,
        lastRowid,
        expectedPrev,
        this.clock.now().toISOString(),
      );
    }
    return { chain: name, ok: true, checked: rows.length, brokenAt: null, reason: null };
  }
}
