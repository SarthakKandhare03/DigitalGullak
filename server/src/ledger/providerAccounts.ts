import { one, run, type DB } from '../db/db';
import { nowIso, type Clock } from '../lib/clock';
import type { BankPartnerProvider } from '../providers/types';

interface ProviderAccountRow {
  user_id: string;
  provider: string;
  customer_ref: string;
  account_ref: string;
}

/** Maps app users to their partner account. Opening is idempotent at both ends. */
export class ProviderAccounts {
  constructor(
    private readonly db: DB,
    private readonly provider: BankPartnerProvider,
    private readonly clock: Clock,
  ) {}

  find(userId: string): ProviderAccountRow | undefined {
    return one<ProviderAccountRow>(this.db, 'SELECT * FROM provider_accounts WHERE user_id = ?', userId);
  }

  async ensure(userId: string): Promise<string> {
    const existing = this.find(userId);
    if (existing) return existing.account_ref;
    const account = await this.provider.openAccount({ userId });
    run(
      this.db,
      `INSERT OR IGNORE INTO provider_accounts (user_id, provider, customer_ref, account_ref, created_at) VALUES (?, ?, ?, ?, ?)`,
      userId,
      this.provider.id,
      account.customerRef,
      account.accountRef,
      nowIso(this.clock),
    );
    return this.find(userId)!.account_ref;
  }
}
