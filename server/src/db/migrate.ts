import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '../lib/crypto';
import { all, run, tx, type DB } from './db';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Applies pending SQL migrations in filename order. Applied files must not change. */
export function migrate(db: DB, log: (msg: string) => void = () => {}): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
  )`);
  const applied = new Map(
    all<{ name: string; checksum: string }>(db, 'SELECT name, checksum FROM schema_migrations').map((r) => [r.name, r.checksum]),
  );
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const newlyApplied: string[] = [];
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const checksum = sha256Hex(sql.replace(/\r\n/g, '\n'));
    const existing = applied.get(file);
    if (existing) {
      if (existing !== checksum) throw new Error(`Migration ${file} was changed after it was applied. Add a new migration instead.`);
      continue;
    }
    tx(db, () => {
      db.exec(sql);
      run(db, 'INSERT INTO schema_migrations (name, checksum, applied_at) VALUES (?, ?, ?)', file, checksum, new Date().toISOString());
    });
    log(`applied migration ${file}`);
    newlyApplied.push(file);
  }
  return newlyApplied;
}
