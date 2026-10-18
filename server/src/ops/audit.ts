import { all, run, type DB } from '../db/db';
import { nowIso, type Clock } from '../lib/clock';
import { newId } from '../lib/crypto';
import { badRequest } from '../lib/errors';

export interface AuditEntryDTO {
  id: string;
  operatorId: string;
  action: string;
  targetType: string;
  targetId: string;
  reason: string;
  before: unknown;
  after: unknown;
  createdAt: string;
}

interface AuditRow {
  id: string;
  operator_id: string;
  action: string;
  target_type: string;
  target_id: string;
  reason: string;
  before_json: string | null;
  after_json: string | null;
  created_at: string;
}

/** Append-only record of every operator action. Callers write it in the same DB transaction as the change. */
export class AuditLog {
  constructor(
    private readonly db: DB,
    private readonly clock: Clock,
  ) {}

  record(entry: {
    operatorId: string;
    action: string;
    targetType: string;
    targetId: string;
    reason: string;
    before?: unknown;
    after?: unknown;
  }): string {
    const reason = entry.reason.trim();
    if (reason.length < 5) throw badRequest('reason_required', 'Give a reason of at least 5 characters for the audit log.');
    const id = newId('aud');
    run(
      this.db,
      `INSERT INTO operator_audit_log (id, operator_id, action, target_type, target_id, reason, before_json, after_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      entry.operatorId,
      entry.action,
      entry.targetType,
      entry.targetId,
      reason,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      nowIso(this.clock),
    );
    return id;
  }

  list(limit = 100): AuditEntryDTO[] {
    return all<AuditRow>(this.db, 'SELECT * FROM operator_audit_log ORDER BY created_at DESC, rowid DESC LIMIT ?', limit).map((r) => ({
      id: r.id,
      operatorId: r.operator_id,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      reason: r.reason,
      before: r.before_json ? JSON.parse(r.before_json) : null,
      after: r.after_json ? JSON.parse(r.after_json) : null,
      createdAt: r.created_at,
    }));
  }
}
