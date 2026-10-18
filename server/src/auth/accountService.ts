import { formatINR } from '../../../shared/money';
import type { DashboardDTO, MeDTO, PartnerAccountDTO } from '../../../shared/types';
import { all, one, run, tx, type DB } from '../db/db';
import type { DemoDataService } from '../demo/demoData';
import type { GoalService } from '../goals/goalService';
import type { ActivityService } from '../ledger/activityService';
import type { LedgerService } from '../ledger/ledgerService';
import type { ProviderAccounts } from '../ledger/providerAccounts';
import { TXN_SELECT, toTransactionDTO, type TxnRow } from '../ledger/rows';
import { nowIso, type Clock } from '../lib/clock';
import { conflict, unprocessable } from '../lib/errors';
import type { BankPartnerProvider } from '../providers/types';
import type { ScheduleService } from '../schedules/scheduleService';
import type { AuthService } from './authService';

export class AccountService {
  constructor(
    private readonly db: DB,
    private readonly auth: AuthService,
    private readonly provider: BankPartnerProvider,
    private readonly accounts: ProviderAccounts,
    private readonly goals: GoalService,
    private readonly ledger: LedgerService,
    private readonly schedules: ScheduleService,
    private readonly activity: ActivityService,
    private readonly demo: DemoDataService,
    private readonly clock: Clock,
  ) {}

  async completeOnboarding(userId: string, choice: 'examples' | 'empty'): Promise<MeDTO> {
    const me = this.auth.getUser(userId);
    if (me.onboarded) return me;
    // Claim onboarding first so a double submit cannot create sample data twice.
    const claimed = run(this.db, 'UPDATE users SET onboarded_at = ? WHERE id = ? AND onboarded_at IS NULL', nowIso(this.clock), userId);
    if (claimed.changes === 1 && choice === 'examples') await this.demo.createExampleData(userId);
    return this.auth.getUser(userId);
  }

  updateProfile(userId: string, displayName: string | null): MeDTO {
    const name = displayName?.trim() || null;
    if (name && name.length > 40) throw unprocessable('invalid_name', 'Names can be up to 40 characters.');
    run(this.db, 'UPDATE users SET display_name = ? WHERE id = ?', name, userId);
    return this.auth.getUser(userId);
  }

  async partnerAccount(userId: string): Promise<PartnerAccountDTO> {
    const link = this.accounts.find(userId);
    if (!link) {
      return {
        status: 'not_opened',
        partnerDisplayName: this.provider.displayName,
        maskedAccountNumber: null,
        linkedBankAccountLabel: null,
        simulated: this.provider.isSimulated,
        interest: null,
      };
    }
    const [status, terms] = await Promise.all([
      this.provider.getAccountStatus(link.account_ref),
      this.provider.getInterestTerms(link.account_ref),
    ]);
    return {
      status: status.status,
      partnerDisplayName: status.partnerDisplayName,
      maskedAccountNumber: status.maskedAccountNumber,
      linkedBankAccountLabel: status.payoutDestinationLabel,
      simulated: status.simulated,
      interest: terms ? { annualRateText: terms.annualRateText, source: terms.termsUrl } : null,
    };
  }

  async dashboard(userId: string): Promise<DashboardDTO> {
    return {
      totals: this.ledger.userTotals(userId),
      goals: this.goals.list(userId, 'active'),
      schedules: this.schedules.list(userId, false),
      recentActivity: this.activity.list(userId, { limit: 6 }).items,
      partner: await this.partnerAccount(userId),
    };
  }

  /** Everything the demo stores about the user, as JSON (data-portability). */
  exportData(userId: string) {
    const me = this.auth.getUser(userId);
    return {
      notice: 'Digital Gullak demo export. All balances and transactions are simulated; no real money was held or moved.',
      exportedAt: nowIso(this.clock),
      profile: { ...me, phone: `••••••${me.phoneLast4}` },
      goals: [...this.goals.list(userId, 'active'), ...this.goals.list(userId, 'archived')],
      schedules: this.schedules.list(userId, true),
      transactions: all<TxnRow>(this.db, `${TXN_SELECT} WHERE t.user_id = ? ORDER BY t.created_at`, userId).map(toTransactionDTO),
    };
  }

  closureBlockers(userId: string): string[] {
    const totals = this.ledger.userTotals(userId);
    const reasons: string[] = [];
    if (totals.postedPaise !== 0) reasons.push(`Your goals still hold ${formatINR(totals.postedPaise)} (simulated). Withdraw it first.`);
    if (totals.pendingInPaise || totals.pendingOutPaise) reasons.push('Some transactions are still waiting for partner confirmation.');
    return reasons;
  }

  /**
   * Closes the demo account. Transaction records are retained (append-only);
   * the phone hash and name are removed so the number can start afresh.
   */
  async close(userId: string): Promise<void> {
    const blockers = this.closureBlockers(userId);
    if (blockers.length) throw conflict('closure_blocked', 'Your account cannot be closed yet.', { reasons: blockers });
    tx(this.db, () => {
      this.schedules.cancelAllForUser(userId, 'Account closed');
      const now = nowIso(this.clock);
      run(this.db, `UPDATE users SET status = 'closed', phone_hash = NULL, display_name = NULL, closed_at = ? WHERE id = ?`, now, userId);
      this.auth.revokeAllForUser(userId);
    });
    const link = this.accounts.find(userId);
    if (link) await this.provider.closeAccount(link.account_ref);
  }

  isActive(userId: string): boolean {
    return one<{ status: string }>(this.db, 'SELECT status FROM users WHERE id = ?', userId)?.status === 'active';
  }
}
