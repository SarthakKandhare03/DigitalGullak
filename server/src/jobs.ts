import type { AppConfig } from './config';
import { maintainDatabase, run, tx, type DB } from './db/db';
import type { Clock } from './lib/clock';
import type { MockBankProvider } from './providers/mock/mockBankProvider';
import type { Services } from './services';

const DAY_MS = 24 * 60 * 60_000;

export interface RetentionReport {
  otpChallenges: number;
  sessions: number;
  idempotencyRecords: number;
  securityEvents: number;
  abandonedGameSessions: number;
}

/**
 * Data retention (DPDP-style minimisation): removes short-lived security data
 * once it has served its purpose. Financial records (transactions, ledger,
 * events, audit log) are never deleted.
 */
export function runRetention(db: DB, clock: Clock): RetentionReport {
  const now = clock.now().getTime();
  const before = (ms: number) => new Date(now - ms).toISOString();
  return tx(db, () => ({
    otpChallenges: run(db, 'DELETE FROM otp_challenges WHERE created_at < ?', before(DAY_MS)).changes,
    sessions: run(db, 'DELETE FROM sessions WHERE expires_at < ?1 OR (revoked_at IS NOT NULL AND revoked_at < ?1)', before(7 * DAY_MS)).changes,
    // Create-endpoint retries are honoured for 7 days. Money movements stay
    // idempotent forever because their keys live on the transactions themselves.
    idempotencyRecords: run(db, 'DELETE FROM idempotency_records WHERE created_at < ?', before(7 * DAY_MS)).changes,
    securityEvents: run(db, 'DELETE FROM security_events WHERE created_at < ?', before(90 * DAY_MS)).changes,
    abandonedGameSessions: run(db, 'DELETE FROM game_sessions WHERE finished_at IS NULL AND started_at < ?', before(2 * DAY_MS)).changes,
  }));
}

interface JobLogger {
  info: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

/**
 * Background work for the leader process only (one per deployment), so jobs
 * never run twice when several worker processes serve traffic.
 */
export class BackgroundJobs {
  private timers: NodeJS.Timeout[] = [];
  private readonly running = new Set<string>();

  constructor(
    private readonly services: Services,
    private readonly mock: MockBankProvider,
    private readonly config: AppConfig,
    private readonly log: JobLogger,
  ) {}

  private every(name: string, ms: number, job: () => unknown, firstRunMs = ms): void {
    const tick = async () => {
      if (this.running.has(name)) return; // never overlap a slow run
      this.running.add(name);
      try {
        await job();
      } catch (error) {
        this.log.error({ job: name, err: (error as Error).message }, 'background job failed');
      } finally {
        this.running.delete(name);
      }
    };
    const first = setTimeout(() => void tick(), firstRunMs);
    const repeat = setInterval(() => void tick(), ms);
    first.unref();
    repeat.unref();
    this.timers.push(first, repeat);
  }

  start(): void {
    const { services } = this;
    this.every('partner-sweep', 15_000, async () => {
      const result = await this.mock.sweep();
      if (result.settled || result.redelivered) this.log.info({ job: 'partner-sweep', ...result }, 'recovered partner work');
    });
    this.every('integrity', 60_000, () => {
      const report = services.integrity.verify('incremental');
      if (!report.ledger.ok || !report.audit.ok || !report.balanceCache.ok) {
        this.log.error({ job: 'integrity', report }, 'INTEGRITY CHECK FAILED — see operator exceptions');
      }
    }, 5_000);
    this.every('maintenance', 10 * 60_000, () => {
      const removed = runRetention(services.db, services.clock);
      maintainDatabase(services.db);
      this.log.info({ job: 'maintenance', removed }, 'retention and database maintenance done');
    }, 30_000);
    if (this.config.reconcileIntervalMs > 0) {
      this.every('reconciliation', this.config.reconcileIntervalMs, () => services.recon.run('system:scheduler'));
    }
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }
}
