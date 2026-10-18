/**
 * Sample data for first-time demo users. Everything created here is marked
 * as sample/simulated and is recorded on both sides (app journal and mock
 * partner) so reconciliation stays balanced.
 */

import { addDays, addMonths, todayInIST } from '../../../shared/dates';
import type { GoalIcon, TxnKind } from '../../../shared/types';
import { tx, type DB } from '../db/db';
import type { GoalService } from '../goals/goalService';
import type { LedgerService } from '../ledger/ledgerService';
import type { ProviderAccounts } from '../ledger/providerAccounts';
import type { Clock } from '../lib/clock';
import { newId } from '../lib/crypto';
import { MockBankProvider } from '../providers/mock/mockBankProvider';
import type { BankPartnerProvider } from '../providers/types';
import type { ScheduleService } from '../schedules/scheduleService';

interface ExampleGoal {
  name: string;
  icon: GoalIcon;
  targetPaise: number;
  targetMonths: number;
  /** [days ago, kind, paise] in chronological order. */
  history: Array<[number, TxnKind, number]>;
}

const EXAMPLES: ExampleGoal[] = [
  {
    name: 'Emergency fund',
    icon: '🛟',
    targetPaise: 50_000_00,
    targetMonths: 9,
    history: [
      [62, 'contribution', 5_000_00],
      [48, 'contribution', 2_500_00],
      [34, 'contribution', 2_500_00],
      [27, 'withdrawal', 1_200_00],
      [20, 'contribution', 2_500_00],
      [6, 'contribution', 2_500_00],
    ],
  },
  {
    name: 'New phone',
    icon: '📱',
    targetPaise: 18_000_00,
    targetMonths: 4,
    history: [
      [40, 'contribution', 1_500_00],
      [25, 'contribution', 2_000_00],
      [11, 'contribution', 1_500_00],
      [3, 'contribution', 750_50],
    ],
  },
  {
    name: 'Festival gifts',
    icon: '🎁',
    targetPaise: 6_000_00,
    targetMonths: 2,
    history: [
      [15, 'contribution', 1_000_00],
      [5, 'contribution', 800_00],
    ],
  },
];

const DAY_MS = 24 * 60 * 60_000;

export class DemoDataService {
  constructor(
    private readonly db: DB,
    private readonly provider: BankPartnerProvider,
    private readonly accounts: ProviderAccounts,
    private readonly goals: GoalService,
    private readonly ledger: LedgerService,
    private readonly schedules: ScheduleService,
    private readonly clock: Clock,
  ) {}

  async createExampleData(userId: string): Promise<void> {
    if (!(this.provider instanceof MockBankProvider)) throw new Error('Sample data is only available with the mock provider.');
    const mock = this.provider;
    const accountRef = await this.accounts.ensure(userId);
    const account = await mock.getAccountStatus(accountRef);
    const now = this.clock.now();
    const today = todayInIST(now);
    // Offset each sample by a few minutes so timestamps are distinct and realistic.
    const at = (daysAgo: number, index: number) => new Date(now.getTime() - daysAgo * DAY_MS - (index + 1) * 7 * 60_000).toISOString();

    tx(this.db, () => {
      const created: string[] = [];
      EXAMPLES.forEach((example, goalIndex) => {
        const goal = this.goals.createInTx(
          userId,
          { name: example.name, icon: example.icon, targetPaise: example.targetPaise, targetDate: addMonths(today, example.targetMonths) },
          { isExample: true, createdAt: at(70, goalIndex) },
        );
        created.push(goal.id);
        example.history.forEach(([daysAgo, kind, amountPaise], i) => {
          const transactionId = newId('txn');
          const when = at(daysAgo, goalIndex * 10 + i);
          const transfer = mock.seedSettledTransfer({
            accountRef,
            reference: transactionId,
            direction: kind === 'contribution' ? 'collect' : 'payout',
            amountPaise,
            at: when,
          });
          this.ledger.recordSampleTransaction({
            userId,
            goalId: goal.id,
            kind,
            amountPaise,
            at: when,
            providerRef: transfer.id,
            transactionId,
            counterpartyLabel: kind === 'contribution' ? account.fundingSourceLabel : account.payoutDestinationLabel,
          });
        });
      });

      this.schedules.createInTx(
        userId,
        { goalId: created[0]!, amountPaise: 200_00, frequency: 'weekly', startDate: addDays(today, -14), consent: true },
        { origin: 'sample', createdAt: at(14, 50) },
      );
      const paused = this.schedules.createInTx(
        userId,
        { goalId: created[1]!, amountPaise: 1_000_00, frequency: 'monthly', startDate: addDays(today, -30), consent: true },
        { origin: 'sample', createdAt: at(30, 51) },
      );
      this.schedules.pause(userId, paused.id);
    });
  }
}
