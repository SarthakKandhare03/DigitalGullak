import {
  addDays,
  anchorFor,
  formatDateIN,
  isISODate,
  maxDate,
  occurrenceAfter,
  occurrenceOnOrAfter,
  type Frequency,
} from '../../../shared/dates';
import { MAX_SCHEDULE_PAISE, MIN_TRANSFER_PAISE, formatINR } from '../../../shared/money';
import type { CreateTransferResponse, DemoScenario, ScheduleDTO, ScheduleStatus } from '../../../shared/types';
import { all, one, run, tx, type DB } from '../db/db';
import type { LedgerService } from '../ledger/ledgerService';
import { nowIso, todayIST, type Clock } from '../lib/clock';
import { newId } from '../lib/crypto';
import { conflict, notFound, unprocessable } from '../lib/errors';

/** Versioned consent wording stored with every schedule. */
export const SCHEDULE_CONSENT_TEXT_V1 =
  'Demo consent v1: I understand this savings schedule is simulated. No money will be debited and no mandate is created. ' +
  'In a real version I would approve a mandate with my bank, receive a notice at least 24 hours before each debit, ' +
  'and could pause or cancel at any time.';

interface ScheduleRow {
  id: string;
  user_id: string;
  goal_id: string;
  amount_paise: number;
  frequency: Frequency;
  anchor: number | null;
  start_date: string;
  next_run_date: string | null;
  status: ScheduleStatus;
  origin: 'user' | 'sample';
  consent_at: string;
  runs_count: number;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  goal_name: string;
  goal_icon: string;
  goal_status: string;
}

const SELECT = `SELECT s.*, g.name AS goal_name, g.icon AS goal_icon, g.status AS goal_status
                FROM schedules s JOIN goals g ON g.id = s.goal_id`;

function toDTO(row: ScheduleRow): ScheduleDTO {
  return {
    id: row.id,
    goalId: row.goal_id,
    goalName: row.goal_name,
    goalIcon: row.goal_icon,
    amountPaise: row.amount_paise,
    frequency: row.frequency,
    anchor: row.anchor,
    startDate: row.start_date,
    nextRunDate: row.next_run_date,
    status: row.status,
    origin: row.origin,
    simulated: true,
    runsCount: row.runs_count,
    consentAt: row.consent_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cancelledAt: row.cancelled_at,
  };
}

export interface CreateScheduleInput {
  goalId: string;
  amountPaise: number;
  frequency: Frequency;
  startDate: string;
  consent: boolean;
}

/**
 * Simulated recurring contributions. Nothing runs on a timer: in demo mode no
 * automatic debit happens, and a run only occurs when the user explicitly
 * presses "Simulate next run". A live version would execute through a
 * partner-approved mandate and record the partner's debit events instead.
 */
export class ScheduleService {
  constructor(
    private readonly db: DB,
    private readonly ledger: LedgerService,
    private readonly clock: Clock,
  ) {}

  private owned(userId: string, scheduleId: string): ScheduleRow {
    const row = one<ScheduleRow>(this.db, `${SELECT} WHERE s.id = ? AND s.user_id = ?`, scheduleId, userId);
    if (!row) throw notFound('Schedule not found.');
    return row;
  }

  list(userId: string, includeCancelled = true): ScheduleDTO[] {
    const filter = includeCancelled ? '' : `AND s.status <> 'cancelled'`;
    return all<ScheduleRow>(
      this.db,
      `${SELECT} WHERE s.user_id = ? ${filter} ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, s.created_at DESC`,
      userId,
    ).map(toDTO);
  }

  get(userId: string, scheduleId: string): ScheduleDTO {
    return toDTO(this.owned(userId, scheduleId));
  }

  private event(row: { id: string; user_id: string }, type: string, note: string | null, transactionId: string | null = null, at?: string) {
    run(
      this.db,
      `INSERT INTO schedule_events (schedule_id, user_id, type, transaction_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      row.id,
      row.user_id,
      type,
      transactionId,
      note,
      at ?? nowIso(this.clock),
    );
  }

  /** Must run inside a DB transaction. */
  createInTx(userId: string, input: CreateScheduleInput, options: { origin?: 'user' | 'sample'; createdAt?: string } = {}): ScheduleDTO {
    if (input.consent !== true) {
      throw unprocessable('consent_required', 'Please confirm that you understand how this simulated schedule works.');
    }
    if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise < MIN_TRANSFER_PAISE || input.amountPaise > MAX_SCHEDULE_PAISE) {
      throw unprocessable('invalid_amount', `Scheduled amounts must be between ${formatINR(MIN_TRANSFER_PAISE)} and ${formatINR(MAX_SCHEDULE_PAISE)}.`);
    }
    const today = todayIST(this.clock);
    if (!isISODate(input.startDate)) throw unprocessable('invalid_date', 'Enter a valid start date.');
    if (options.origin !== 'sample' && (input.startDate < today || input.startDate > addDays(today, 365))) {
      throw unprocessable('invalid_date', 'The start date must be between today and one year from now.');
    }
    const goal = one<{ status: string }>(this.db, 'SELECT status FROM goals WHERE id = ? AND user_id = ?', input.goalId, userId);
    if (!goal) throw notFound('Goal not found.');
    if (goal.status !== 'active') throw conflict('goal_archived', 'Schedules can only be added to active goals.');

    const id = newId('sch');
    const now = options.createdAt ?? nowIso(this.clock);
    const anchor = anchorFor(input.frequency, input.startDate);
    const next = occurrenceOnOrAfter(input.frequency, anchor, input.startDate, maxDate(input.startDate, today));
    run(
      this.db,
      `INSERT INTO schedules (id, user_id, goal_id, amount_paise, frequency, anchor, start_date, next_run_date, status, origin,
         consent_text, consent_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      id,
      userId,
      input.goalId,
      input.amountPaise,
      input.frequency,
      anchor,
      input.startDate,
      next,
      options.origin ?? 'user',
      SCHEDULE_CONSENT_TEXT_V1,
      now,
      now,
      now,
    );
    this.event({ id, user_id: userId }, 'created', options.origin === 'sample' ? 'Sample data' : null, null, now);
    return this.get(userId, id);
  }

  pause(userId: string, scheduleId: string): ScheduleDTO {
    return tx(this.db, () => {
      const row = this.owned(userId, scheduleId);
      if (row.status === 'paused') return toDTO(row);
      if (row.status !== 'active') throw conflict('schedule_cancelled', 'A cancelled schedule cannot be paused.');
      run(this.db, `UPDATE schedules SET status = 'paused', updated_at = ? WHERE id = ?`, nowIso(this.clock), row.id);
      this.event(row, 'paused', null);
      return this.get(userId, scheduleId);
    });
  }

  resume(userId: string, scheduleId: string): ScheduleDTO {
    return tx(this.db, () => {
      const row = this.owned(userId, scheduleId);
      if (row.status === 'active') return toDTO(row);
      if (row.status !== 'paused') throw conflict('schedule_cancelled', 'A cancelled schedule cannot be resumed. Create a new one.');
      if (row.goal_status !== 'active') throw conflict('goal_archived', 'Restore the goal before resuming this schedule.');
      // Missed dates while paused are skipped, never caught up.
      const today = todayIST(this.clock);
      const next = occurrenceOnOrAfter(row.frequency, row.anchor, row.start_date, maxDate(row.next_run_date ?? today, today));
      run(this.db, `UPDATE schedules SET status = 'active', next_run_date = ?, updated_at = ? WHERE id = ?`, next, nowIso(this.clock), row.id);
      this.event(row, 'resumed', `Next simulated date ${formatDateIN(next)}`);
      return this.get(userId, scheduleId);
    });
  }

  cancel(userId: string, scheduleId: string, note: string | null = null): ScheduleDTO {
    return tx(this.db, () => {
      const row = this.owned(userId, scheduleId);
      if (row.status === 'cancelled') return toDTO(row);
      const now = nowIso(this.clock);
      run(this.db, `UPDATE schedules SET status = 'cancelled', next_run_date = NULL, cancelled_at = ?, updated_at = ? WHERE id = ?`, now, now, row.id);
      this.event(row, 'cancelled', note);
      return this.get(userId, scheduleId);
    });
  }

  /**
   * Demo only: pretends the next scheduled date has arrived and records a
   * simulated contribution. The idempotency key is derived from the schedule
   * and run date, so the same run can never be recorded twice.
   */
  async simulateNextRun(userId: string, scheduleId: string, demoScenario?: DemoScenario): Promise<CreateTransferResponse> {
    const row = this.owned(userId, scheduleId);
    if (row.status !== 'active' || !row.next_run_date) {
      throw conflict('schedule_not_active', 'Only active schedules can simulate a run.');
    }
    const runDate = row.next_run_date;
    return this.ledger.createTransfer({
      userId,
      goalId: row.goal_id,
      kind: 'contribution',
      amountPaise: row.amount_paise,
      idempotencyKey: `schedule:${row.id}:${runDate}`,
      origin: 'schedule',
      scheduleId: row.id,
      memo: `Simulated scheduled contribution for ${formatDateIN(runDate)}`,
      maxPaise: MAX_SCHEDULE_PAISE,
      demoScenario,
      inTx: (transactionId) => {
        const next = occurrenceAfter(row.frequency, row.anchor, row.start_date, runDate);
        run(
          this.db,
          `UPDATE schedules SET next_run_date = ?, runs_count = runs_count + 1, updated_at = ? WHERE id = ? AND status = 'active'`,
          next,
          nowIso(this.clock),
          row.id,
        );
        this.event(row, 'simulated_run', `Simulated run for ${formatDateIN(runDate)}`, transactionId);
      },
    });
  }

  /** Cancels every open schedule (account closure). Must run inside a DB transaction. */
  cancelAllForUser(userId: string, note: string): void {
    for (const row of all<ScheduleRow>(this.db, `${SELECT} WHERE s.user_id = ? AND s.status <> 'cancelled'`, userId)) {
      this.cancel(userId, row.id, note);
    }
  }
}
