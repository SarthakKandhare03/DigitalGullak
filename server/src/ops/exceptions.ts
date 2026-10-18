import { all, one, run, type DB } from '../db/db';
import { nowIso, type Clock } from '../lib/clock';
import { newId } from '../lib/crypto';

export type ExceptionKind =
  | 'status_mismatch'
  | 'missing_at_partner'
  | 'missing_in_app'
  | 'amount_mismatch'
  | 'not_submitted'
  | 'stuck_pending'
  | 'balance_mismatch'
  | 'unmatched_event'
  | 'event_mismatch'
  | 'event_conflict';

/** Kinds produced by reconciliation runs (and auto-closed when no longer detected). */
export const RECONCILIATION_KINDS: ExceptionKind[] = [
  'status_mismatch',
  'missing_at_partner',
  'missing_in_app',
  'amount_mismatch',
  'not_submitted',
  'stuck_pending',
  'balance_mismatch',
];

export interface ExceptionRow {
  id: string;
  dedupe_key: string;
  kind: ExceptionKind;
  user_id: string | null;
  transaction_id: string | null;
  details: string;
  status: 'open' | 'escalated' | 'resolved';
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

export interface ExceptionDTO {
  id: string;
  kind: ExceptionKind;
  userId: string | null;
  transactionId: string | null;
  details: Record<string, unknown>;
  status: ExceptionRow['status'];
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
}

export function toExceptionDTO(row: ExceptionRow): ExceptionDTO {
  return {
    id: row.id,
    kind: row.kind,
    userId: row.user_id,
    transactionId: row.transaction_id,
    details: JSON.parse(row.details) as Record<string, unknown>,
    status: row.status,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolutionNote: row.resolution_note,
  };
}

export interface RaiseInput {
  kind: ExceptionKind;
  dedupeKey: string;
  userId?: string | null;
  transactionId?: string | null;
  details: Record<string, unknown>;
}

export class ExceptionStore {
  constructor(
    private readonly db: DB,
    private readonly clock: Clock,
  ) {}

  /** Opens an exception, or refreshes the open one with the same dedupe key. */
  raise(input: RaiseInput): { id: string; created: boolean } {
    const now = nowIso(this.clock);
    const open = one<{ id: string }>(
      this.db,
      `SELECT id FROM reconciliation_exceptions WHERE dedupe_key = ? AND status <> 'resolved'`,
      input.dedupeKey,
    );
    if (open) {
      run(this.db, 'UPDATE reconciliation_exceptions SET last_seen_at = ?, details = ? WHERE id = ?', now, JSON.stringify(input.details), open.id);
      return { id: open.id, created: false };
    }
    const id = newId('exc');
    run(
      this.db,
      `INSERT INTO reconciliation_exceptions (id, dedupe_key, kind, user_id, transaction_id, details, status, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      id,
      input.dedupeKey,
      input.kind,
      input.userId ?? null,
      input.transactionId ?? null,
      JSON.stringify(input.details),
      now,
      now,
    );
    return { id, created: true };
  }

  get(id: string): ExceptionRow | undefined {
    return one<ExceptionRow>(this.db, 'SELECT * FROM reconciliation_exceptions WHERE id = ?', id);
  }

  list(filter: 'unresolved' | 'resolved' | 'all' = 'unresolved', limit = 200): ExceptionRow[] {
    const where = filter === 'unresolved' ? `WHERE status <> 'resolved'` : filter === 'resolved' ? `WHERE status = 'resolved'` : '';
    return all<ExceptionRow>(this.db, `SELECT * FROM reconciliation_exceptions ${where} ORDER BY last_seen_at DESC LIMIT ?`, limit);
  }

  unresolvedByKinds(kinds: ExceptionKind[]): ExceptionRow[] {
    return all<ExceptionRow>(
      this.db,
      `SELECT * FROM reconciliation_exceptions WHERE status <> 'resolved' AND kind IN (${kinds.map(() => '?').join(',')})`,
      ...kinds,
    );
  }

  setStatus(id: string, status: 'escalated' | 'resolved', by: string, note: string): void {
    const now = nowIso(this.clock);
    run(
      this.db,
      `UPDATE reconciliation_exceptions SET status = ?, resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE NULL END,
         resolved_by = ?, resolution_note = ? WHERE id = ?`,
      status,
      status,
      now,
      by,
      note,
      id,
    );
  }

  countUnresolved(): number {
    return one<{ n: number }>(this.db, `SELECT COUNT(*) AS n FROM reconciliation_exceptions WHERE status <> 'resolved'`)!.n;
  }
}
