import { isISODate } from '../../../shared/dates';
import { MAX_TARGET_PAISE, MIN_TRANSFER_PAISE, formatINR } from '../../../shared/money';
import { GOAL_ICONS, type GoalDTO, type GoalStatus } from '../../../shared/types';
import { all, one, run, tx, type DB } from '../db/db';
import type { LedgerService } from '../ledger/ledgerService';
import { nowIso, todayIST, type Clock } from '../lib/clock';
import { newId } from '../lib/crypto';
import { conflict, notFound, unprocessable } from '../lib/errors';

const MAX_ACTIVE_GOALS = 20;

interface GoalRow {
  id: string;
  user_id: string;
  name: string;
  icon: string;
  target_paise: number;
  target_date: string | null;
  status: GoalStatus;
  is_example: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface GoalInput {
  name: string;
  icon: string;
  targetPaise: number;
  targetDate: string | null;
}

export class GoalService {
  constructor(
    private readonly db: DB,
    private readonly ledger: LedgerService,
    private readonly clock: Clock,
  ) {}

  private toDTO(row: GoalRow): GoalDTO {
    return {
      id: row.id,
      name: row.name,
      icon: row.icon,
      targetPaise: row.target_paise,
      targetDate: row.target_date,
      status: row.status,
      isExample: row.is_example === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at,
      balance: this.ledger.goalBalance(row.id),
    };
  }

  private ownedRow(userId: string, goalId: string): GoalRow {
    const row = one<GoalRow>(this.db, 'SELECT * FROM goals WHERE id = ? AND user_id = ?', goalId, userId);
    if (!row) throw notFound('Goal not found.');
    return row;
  }

  list(userId: string, status: GoalStatus = 'active'): GoalDTO[] {
    return all<GoalRow>(this.db, 'SELECT * FROM goals WHERE user_id = ? AND status = ? ORDER BY created_at, id', userId, status).map((r) =>
      this.toDTO(r),
    );
  }

  get(userId: string, goalId: string): GoalDTO {
    return this.toDTO(this.ownedRow(userId, goalId));
  }

  private validate(input: Partial<GoalInput>): void {
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name.length < 1 || name.length > 60) throw unprocessable('invalid_name', 'Give the goal a name of up to 60 characters.');
    }
    if (input.icon !== undefined && !(GOAL_ICONS as readonly string[]).includes(input.icon)) {
      throw unprocessable('invalid_icon', 'Choose one of the listed icons.');
    }
    if (input.targetPaise !== undefined) {
      if (!Number.isSafeInteger(input.targetPaise) || input.targetPaise < MIN_TRANSFER_PAISE || input.targetPaise > MAX_TARGET_PAISE) {
        throw unprocessable('invalid_target', `Target must be between ${formatINR(MIN_TRANSFER_PAISE)} and ${formatINR(MAX_TARGET_PAISE)}.`);
      }
    }
    if (input.targetDate !== undefined && input.targetDate !== null) {
      if (!isISODate(input.targetDate)) throw unprocessable('invalid_date', 'Enter a valid target date.');
      if (input.targetDate < todayIST(this.clock)) throw unprocessable('date_in_past', 'The target date cannot be in the past.');
    }
  }

  /** Must run inside a DB transaction (used by the idempotent create route and demo data). */
  createInTx(userId: string, input: GoalInput, options: { isExample?: boolean; createdAt?: string } = {}): GoalDTO {
    this.validate(input);
    const active = one<{ n: number }>(this.db, `SELECT COUNT(*) AS n FROM goals WHERE user_id = ? AND status = 'active'`, userId)!.n;
    if (active >= MAX_ACTIVE_GOALS) throw conflict('too_many_goals', `You can have up to ${MAX_ACTIVE_GOALS} active goals.`);
    const id = newId('gol');
    const now = options.createdAt ?? nowIso(this.clock);
    run(
      this.db,
      `INSERT INTO goals (id, user_id, name, icon, target_paise, target_date, is_example, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      userId,
      input.name.trim(),
      input.icon,
      input.targetPaise,
      input.targetDate,
      options.isExample ?? false,
      now,
      now,
    );
    return this.get(userId, id);
  }

  update(userId: string, goalId: string, patch: Partial<GoalInput>): GoalDTO {
    return tx(this.db, () => {
      const row = this.ownedRow(userId, goalId);
      if (row.status !== 'active') throw conflict('goal_archived', 'Restore this goal before editing it.');
      this.validate(patch);
      run(
        this.db,
        `UPDATE goals SET name = ?, icon = ?, target_paise = ?, target_date = ?, updated_at = ? WHERE id = ?`,
        patch.name !== undefined ? patch.name.trim() : row.name,
        patch.icon ?? row.icon,
        patch.targetPaise ?? row.target_paise,
        patch.targetDate !== undefined ? patch.targetDate : row.target_date,
        nowIso(this.clock),
        row.id,
      );
      return this.get(userId, goalId);
    });
  }

  /** Reasons a goal cannot be archived yet (empty when it can). */
  archiveBlockers(goalId: string): string[] {
    const reasons: string[] = [];
    const balance = this.ledger.goalBalance(goalId);
    if (balance.postedPaise !== 0) reasons.push(`It still holds ${formatINR(balance.postedPaise)}. Withdraw it first.`);
    if (balance.pendingInPaise || balance.pendingOutPaise) reasons.push('It has transactions waiting for partner confirmation.');
    const schedules = one<{ n: number }>(
      this.db,
      `SELECT COUNT(*) AS n FROM schedules WHERE goal_id = ? AND status IN ('active', 'paused')`,
      goalId,
    )!.n;
    if (schedules) reasons.push(`It has ${schedules} savings schedule${schedules > 1 ? 's' : ''}. Cancel ${schedules > 1 ? 'them' : 'it'} first.`);
    return reasons;
  }

  archive(userId: string, goalId: string): GoalDTO {
    return tx(this.db, () => {
      const row = this.ownedRow(userId, goalId);
      if (row.status === 'archived') return this.toDTO(row);
      const blockers = this.archiveBlockers(goalId);
      if (blockers.length) throw conflict('archive_blocked', 'This goal cannot be archived yet.', { reasons: blockers });
      const now = nowIso(this.clock);
      run(this.db, `UPDATE goals SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?`, now, now, goalId);
      return this.get(userId, goalId);
    });
  }

  restore(userId: string, goalId: string): GoalDTO {
    return tx(this.db, () => {
      const row = this.ownedRow(userId, goalId);
      if (row.status === 'active') return this.toDTO(row);
      const active = one<{ n: number }>(this.db, `SELECT COUNT(*) AS n FROM goals WHERE user_id = ? AND status = 'active'`, userId)!.n;
      if (active >= MAX_ACTIVE_GOALS) throw conflict('too_many_goals', `You can have up to ${MAX_ACTIVE_GOALS} active goals.`);
      run(this.db, `UPDATE goals SET status = 'active', archived_at = NULL, updated_at = ? WHERE id = ?`, nowIso(this.clock), goalId);
      return this.get(userId, goalId);
    });
  }
}
