import { addDays, todayInIST } from '../../../shared/dates';
import type { SavingsHistoryDTO } from '../../../shared/rewards';
import { all, one, type DB } from '../db/db';
import type { Clock } from '../lib/clock';

const RANGE_DAYS: Record<SavingsHistoryDTO['range'], number> = { '1m': 30, '3m': 91, '6m': 182, '1y': 365 };

/** The user's own confirmed savings over time (never prices or returns). */
export class InsightsService {
  constructor(
    private readonly db: DB,
    private readonly clock: Clock,
  ) {}

  savingsHistory(userId: string, range: SavingsHistoryDTO['range']): SavingsHistoryDTO {
    const today = todayInIST(this.clock.now());
    const firstDay = addDays(today, -(RANGE_DAYS[range] - 1));
    const fromIso = new Date(`${firstDay}T00:00:00+05:30`).toISOString();

    const start = one<{ total: number }>(
      this.db,
      `SELECT COALESCE(SUM(amount_paise), 0) AS total FROM ledger_entries WHERE user_id = ? AND account_type = 'pocket' AND created_at < ?`,
      userId,
      fromIso,
    )!.total;
    const entries = all<{ created_at: string; amount_paise: number }>(
      this.db,
      `SELECT created_at, amount_paise FROM ledger_entries WHERE user_id = ? AND account_type = 'pocket' AND created_at >= ? ORDER BY created_at`,
      userId,
      fromIso,
    );

    const byDay = new Map<string, number>();
    for (const e of entries) {
      const day = todayInIST(new Date(e.created_at));
      byDay.set(day, (byDay.get(day) ?? 0) + e.amount_paise);
    }

    const points: SavingsHistoryDTO['points'] = [];
    let balance = start;
    for (let day = firstDay; day <= today; day = addDays(day, 1)) {
      balance += byDay.get(day) ?? 0;
      points.push({ date: day, balancePaise: balance });
    }
    return { range, points, startBalancePaise: start, endBalancePaise: balance, changePaise: balance - start };
  }
}
