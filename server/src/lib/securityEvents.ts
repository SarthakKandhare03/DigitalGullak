import { all, one, run, type DB } from '../db/db';
import type { Clock } from './clock';
import { hmacHex } from './crypto';

export type SecurityEventType =
  | 'operator_login_failed'
  | 'operator_locked'
  | 'operator_totp_replay'
  | 'otp_failed'
  | 'webhook_rejected'
  | 'csrf_blocked'
  | 'rate_limited';

/**
 * Security events shared by every worker process (unlike in-memory counters).
 * Subjects are keyed hashes of IP addresses, so no raw IPs are stored.
 */
export class SecurityEvents {
  private readonly lastWrite = new Map<string, number>();

  constructor(
    private readonly db: DB,
    private readonly clock: Clock,
    private readonly secret: string,
  ) {}

  subjectForIp(ip: string): string {
    return `ip:${hmacHex(this.secret, `ip:${ip}`).slice(0, 16)}`;
  }

  record(type: SecurityEventType, subject: string | null, detail?: string): void {
    run(
      this.db,
      'INSERT INTO security_events (type, subject, detail, created_at) VALUES (?, ?, ?, ?)',
      type,
      subject,
      detail?.slice(0, 200) ?? null,
      this.clock.now().toISOString(),
    );
  }

  /** Records at most one event per (type, subject) per window, so floods can't amplify into DB writes. */
  recordThrottled(type: SecurityEventType, subject: string | null, detail?: string, windowMs = 60_000): void {
    const key = `${type}|${subject}`;
    const now = this.clock.now().getTime();
    if ((this.lastWrite.get(key) ?? 0) > now - windowMs) return;
    if (this.lastWrite.size > 10_000) this.lastWrite.clear();
    this.lastWrite.set(key, now);
    this.record(type, subject, detail);
  }

  count(type: SecurityEventType, subject: string | null, windowMs: number): number {
    const since = new Date(this.clock.now().getTime() - windowMs).toISOString();
    if (subject === null) {
      return one<{ n: number }>(this.db, 'SELECT COUNT(*) AS n FROM security_events WHERE type = ? AND created_at > ?', type, since)!.n;
    }
    return one<{ n: number }>(
      this.db,
      'SELECT COUNT(*) AS n FROM security_events WHERE type = ? AND subject = ? AND created_at > ?',
      type,
      subject,
      since,
    )!.n;
  }

  summary(windowMs = 24 * 60 * 60_000): Record<string, number> {
    const since = new Date(this.clock.now().getTime() - windowMs).toISOString();
    return Object.fromEntries(
      all<{ type: string; n: number }>(this.db, 'SELECT type, COUNT(*) AS n FROM security_events WHERE created_at > ? GROUP BY type', since).map((r) => [
        r.type,
        r.n,
      ]),
    );
  }

  recent(limit = 50) {
    return all<{ id: number; type: string; subject: string | null; detail: string | null; created_at: string }>(
      this.db,
      'SELECT id, type, subject, detail, created_at FROM security_events ORDER BY id DESC LIMIT ?',
      limit,
    ).map((r) => ({ id: r.id, type: r.type, subject: r.subject, detail: r.detail, createdAt: r.created_at }));
  }
}
