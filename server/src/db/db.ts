import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

export type DB = DatabaseSync;
type Param = SQLInputValue | undefined | boolean;

export interface OpenOptions {
  /**
   * 'normal' (WAL): commits are not fsynced; a power cut may lose the last few
   * transactions but never corrupts the file. 'full': every commit is fsynced.
   * Use 'full' for anything that moves real money.
   */
  synchronous?: 'normal' | 'full';
}

const statementCache = new WeakMap<DB, Map<string, StatementSync>>();
const txDepth = new WeakMap<DB, number>();

export function openDatabase(file: string, options: OpenOptions = {}): DB {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -32000;
  `);
  if (file !== ':memory:') {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = ${options.synchronous === 'full' ? 'FULL' : 'NORMAL'};
      PRAGMA mmap_size = 268435456;
      PRAGMA journal_size_limit = 67108864;
      PRAGMA wal_autocheckpoint = 2000;
    `);
  }
  return db;
}

/** Periodic housekeeping: refresh query-planner statistics and fold the WAL back into the database. */
export function maintainDatabase(db: DB): void {
  db.exec('PRAGMA optimize');
  db.exec('PRAGMA wal_checkpoint(PASSIVE)');
}

export function closeDatabase(db: DB): void {
  try {
    db.exec('PRAGMA optimize');
  } finally {
    statementCache.delete(db);
    db.close();
  }
}

function prepare(db: DB, sql: string): StatementSync {
  let cache = statementCache.get(db);
  if (!cache) statementCache.set(db, (cache = new Map()));
  let stmt = cache.get(sql);
  if (!stmt) cache.set(sql, (stmt = db.prepare(sql)));
  return stmt;
}

function normalise(params: Param[]): SQLInputValue[] {
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

export function one<T>(db: DB, sql: string, ...params: Param[]): T | undefined {
  return prepare(db, sql).get(...normalise(params)) as T | undefined;
}

export function all<T>(db: DB, sql: string, ...params: Param[]): T[] {
  return prepare(db, sql).all(...normalise(params)) as T[];
}

export function run(db: DB, sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
  const result = prepare(db, sql).run(...normalise(params));
  return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
}

/**
 * Runs `fn` inside a write transaction (BEGIN IMMEDIATE). `fn` must be
 * synchronous: Node runs it to completion without interleaving other
 * requests, and BEGIN IMMEDIATE takes SQLite's write lock up front, so balance
 * checks and their writes are atomic even with several worker processes
 * sharing one database file. Nested calls join the outer transaction.
 */
export function tx<T>(db: DB, fn: () => T): T {
  const depth = txDepth.get(db) ?? 0;
  if (depth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  txDepth.set(db, 1);
  try {
    const result = fn();
    if (result instanceof Promise) throw new Error('tx() callbacks must be synchronous');
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    txDepth.set(db, 0);
  }
}
