import type { ActivityItemDTO, ActivityPageDTO, ScheduleEventDTO, TxnKind, TxnStatus } from '../../../shared/types';
import { all, type DB } from '../db/db';
import { TXN_SELECT, toTransactionDTO, type TxnRow } from './rows';

export interface ActivityFilter {
  limit?: number;
  before?: string;
  type?: 'all' | TxnKind | 'schedule';
  status?: TxnStatus;
  goalId?: string;
}

interface ScheduleEventRow {
  id: number;
  schedule_id: string;
  type: ScheduleEventDTO['type'];
  transaction_id: string | null;
  note: string | null;
  created_at: string;
  goal_name: string;
  goal_icon: string;
  amount_paise: number;
  frequency: ScheduleEventDTO['frequency'];
}

/** A single feed of transactions and schedule lifecycle events, newest first. */
export class ActivityService {
  constructor(private readonly db: DB) {}

  list(userId: string, filter: ActivityFilter = {}): ActivityPageDTO {
    const limit = Math.min(Math.max(filter.limit ?? 30, 1), 100);
    const before = filter.before ?? '9999-12-31T00:00:00.000Z';
    const items: ActivityItemDTO[] = [];

    if (filter.type !== 'schedule') {
      const conditions = ['t.user_id = ?', 't.created_at < ?'];
      const params: string[] = [userId, before];
      if (filter.type && filter.type !== 'all') {
        conditions.push('t.kind = ?');
        params.push(filter.type);
      }
      if (filter.status) {
        conditions.push('t.status = ?');
        params.push(filter.status);
      }
      if (filter.goalId) {
        conditions.push('t.goal_id = ?');
        params.push(filter.goalId);
      }
      const rows = all<TxnRow>(this.db, `${TXN_SELECT} WHERE ${conditions.join(' AND ')} ORDER BY t.created_at DESC LIMIT ?`, ...params, limit);
      for (const row of rows) items.push({ type: 'transaction', at: row.created_at, transaction: toTransactionDTO(row) });
    }

    // Schedule runs already appear as transactions, so only lifecycle events are added here.
    if ((!filter.type || filter.type === 'all' || filter.type === 'schedule') && !filter.status) {
      const conditions = ['e.user_id = ?', 'e.created_at < ?', `e.type <> 'simulated_run'`];
      const params: string[] = [userId, before];
      if (filter.goalId) {
        conditions.push('s.goal_id = ?');
        params.push(filter.goalId);
      }
      const rows = all<ScheduleEventRow>(
        this.db,
        `SELECT e.*, g.name AS goal_name, g.icon AS goal_icon, s.amount_paise, s.frequency
         FROM schedule_events e JOIN schedules s ON s.id = e.schedule_id JOIN goals g ON g.id = s.goal_id
         WHERE ${conditions.join(' AND ')} ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
        ...params,
        limit,
      );
      for (const row of rows) {
        items.push({
          type: 'schedule_event',
          at: row.created_at,
          event: {
            id: row.id,
            scheduleId: row.schedule_id,
            type: row.type,
            transactionId: row.transaction_id,
            note: row.note,
            createdAt: row.created_at,
            goalName: row.goal_name,
            goalIcon: row.goal_icon,
            amountPaise: row.amount_paise,
            frequency: row.frequency,
          },
        });
      }
    }

    items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const page = items.slice(0, limit);
    return { items: page, nextCursor: items.length > limit || page.length === limit ? (page.at(-1)?.at ?? null) : null };
  }
}
