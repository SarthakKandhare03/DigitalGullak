import { AccountService } from './auth/accountService';
import { AuthService } from './auth/authService';
import type { AppConfig } from './config';
import type { DB } from './db/db';
import { DemoDataService } from './demo/demoData';
import { GoalService } from './goals/goalService';
import { ActivityService } from './ledger/activityService';
import { InsightsService } from './ledger/insightsService';
import { RewardsService } from './rewards/rewardsService';
import { LedgerService } from './ledger/ledgerService';
import { ProviderAccounts } from './ledger/providerAccounts';
import type { Clock } from './lib/clock';
import { AuditLog } from './ops/audit';
import { ExceptionStore } from './ops/exceptions';
import { OpsService } from './ops/opsService';
import { ReconciliationService, type ReconciliationOptions } from './ops/reconciliation';
import { ProviderEventProcessor } from './providers/eventProcessor';
import type { BankPartnerProvider } from './providers/types';
import { ScheduleService } from './schedules/scheduleService';

export interface Logger {
  warn: (obj: object, msg: string) => void;
}

export function createServices(deps: {
  db: DB;
  config: AppConfig;
  clock: Clock;
  provider: BankPartnerProvider;
  log: Logger;
  reconciliation?: ReconciliationOptions;
}) {
  const { db, config, clock, provider, log } = deps;
  const accounts = new ProviderAccounts(db, provider, clock);
  const ledger = new LedgerService(db, provider, accounts, clock, log);
  const goals = new GoalService(db, ledger, clock);
  const schedules = new ScheduleService(db, ledger, clock);
  const activity = new ActivityService(db);
  const auth = new AuthService(db, config, clock, accounts);
  const demo = new DemoDataService(db, provider, accounts, goals, ledger, schedules, clock);
  const account = new AccountService(db, auth, provider, accounts, goals, ledger, schedules, activity, demo, clock);
  const exceptions = new ExceptionStore(db, clock);
  const audit = new AuditLog(db, clock);
  const events = new ProviderEventProcessor(db, provider, ledger, exceptions, clock);
  const recon = new ReconciliationService(db, provider, ledger, exceptions, audit, clock, deps.reconciliation);
  const ops = new OpsService(db, provider, ledger, exceptions, recon, audit);
  const rewards = new RewardsService(db, ledger, clock);
  const insights = new InsightsService(db, clock);
  return { db, config, clock, provider, accounts, ledger, goals, schedules, activity, auth, demo, account, exceptions, audit, events, recon, ops, rewards, insights };
}

export type Services = ReturnType<typeof createServices>;
