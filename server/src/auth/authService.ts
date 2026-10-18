import type { MeDTO } from '../../../shared/types';
import type { AppConfig } from '../config';
import { one, run, tx, type DB } from '../db/db';
import type { ProviderAccounts } from '../ledger/providerAccounts';
import { nowIso, type Clock } from '../lib/clock';
import { hmacHex, newId, randomDigits, randomToken, safeEqual, sha256Hex } from '../lib/crypto';
import { badRequest, tooManyRequests, unauthorized } from '../lib/errors';

const OTP_TTL_MS = 5 * 60_000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_PER_WINDOW = 5;
const OTP_WINDOW_MS = 15 * 60_000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
const OPERATOR_SESSION_TTL_MS = 8 * 60 * 60_000;
const IDLE_TIMEOUT_MS = 30 * 60_000;
const MAX_SESSIONS = 5;

export const OPERATOR_ID = 'op_demo';

interface UserRow {
  id: string;
  phone_hash: string | null;
  phone_last4: string;
  display_name: string | null;
  status: 'active' | 'closed';
  onboarded_at: string | null;
  created_at: string;
}

interface ChallengeRow {
  id: string;
  phone_hash: string;
  phone_last4: string;
  code_hash: string;
  attempts: number;
  expires_at: string;
  consumed_at: string | null;
}

/** Accepts "98765 43210", "+91 98765-43210", "098765…" and returns 10 digits, or null. */
export function normaliseIndianMobile(input: string): string | null {
  let digits = input.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

export function toMeDTO(row: UserRow): MeDTO {
  return {
    id: row.id,
    displayName: row.display_name,
    phoneLast4: row.phone_last4,
    onboarded: row.onboarded_at !== null,
    createdAt: row.created_at,
  };
}

/**
 * Demo sign-in with a mock OTP. No SMS is ever sent: in demo mode the code is
 * returned to the client and shown on screen with a clear label. Phone numbers
 * are stored only as a keyed hash plus the last four digits.
 */
export class AuthService {
  private operatorAttempts: number[] = [];

  constructor(
    private readonly db: DB,
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly accounts: ProviderAccounts,
  ) {}

  private phoneHash(phone: string): string {
    return hmacHex(this.config.authHmacSecret, `phone:${phone}`);
  }

  private codeHash(challengeId: string, code: string): string {
    return hmacHex(this.config.authHmacSecret, `otp:${challengeId}:${code}`);
  }

  requestOtp(phoneInput: string): { challengeId: string; expiresAt: string; phoneLast4: string; demoOtp: string } {
    const phone = normaliseIndianMobile(phoneInput);
    if (!phone) throw badRequest('invalid_phone', 'Enter a 10-digit Indian mobile number.');
    const phoneHash = this.phoneHash(phone);
    const now = this.clock.now();
    const windowStart = new Date(now.getTime() - OTP_WINDOW_MS).toISOString();
    const recent = one<{ n: number }>(
      this.db,
      'SELECT COUNT(*) AS n FROM otp_challenges WHERE phone_hash = ? AND created_at > ?',
      phoneHash,
      windowStart,
    )!.n;
    if (recent >= OTP_MAX_PER_WINDOW) throw tooManyRequests('Too many codes requested. Please wait 15 minutes and try again.');

    const id = newId('otp');
    const code = randomDigits(6);
    const expiresAt = new Date(now.getTime() + OTP_TTL_MS).toISOString();
    run(
      this.db,
      `INSERT INTO otp_challenges (id, phone_hash, phone_last4, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      phoneHash,
      phone.slice(-4),
      this.codeHash(id, code),
      expiresAt,
      now.toISOString(),
    );
    // Demo mode only (enforced by config): the code goes back to the screen, never to SMS or logs.
    return { challengeId: id, expiresAt, phoneLast4: phone.slice(-4), demoOtp: code };
  }

  async verifyOtp(challengeId: string, code: string): Promise<{ user: MeDTO; token: string; isNew: boolean }> {
    const result = tx(this.db, () => {
      const now = nowIso(this.clock);
      const challenge = one<ChallengeRow>(this.db, 'SELECT * FROM otp_challenges WHERE id = ?', challengeId);
      if (!challenge || challenge.consumed_at || challenge.expires_at < now) {
        return { error: badRequest('otp_expired', 'This code has expired. Request a new one.') };
      }
      if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
        return { error: tooManyRequests('Too many incorrect attempts. Request a new code.') };
      }
      if (!/^\d{6}$/.test(code) || !safeEqual(this.codeHash(challenge.id, code), challenge.code_hash)) {
        run(this.db, 'UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ?', challenge.id);
        const left = OTP_MAX_ATTEMPTS - challenge.attempts - 1;
        return { error: badRequest('otp_incorrect', left > 0 ? `That code is not right. ${left} attempt${left === 1 ? '' : 's'} left.` : 'That code is not right. Request a new code.') };
      }
      run(this.db, 'UPDATE otp_challenges SET consumed_at = ? WHERE id = ?', now, challenge.id);

      let user = one<UserRow>(this.db, `SELECT * FROM users WHERE phone_hash = ? AND status = 'active'`, challenge.phone_hash);
      let isNew = false;
      if (!user) {
        const id = newId('usr');
        run(
          this.db,
          `INSERT INTO users (id, phone_hash, phone_last4, created_at) VALUES (?, ?, ?, ?)`,
          id,
          challenge.phone_hash,
          challenge.phone_last4,
          now,
        );
        user = one<UserRow>(this.db, 'SELECT * FROM users WHERE id = ?', id)!;
        isNew = true;
      }
      const token = this.createSession('user', user.id, SESSION_TTL_MS);
      return { user, token, isNew };
    });
    if ('error' in result) throw result.error;
    // Opens the (simulated) partner account. Real KYC/onboarding is the partner's flow, not ours.
    await this.accounts.ensure(result.user.id);
    return { user: toMeDTO(result.user), token: result.token, isNew: result.isNew };
  }

  private createSession(type: 'user' | 'operator', subjectId: string, ttlMs: number): string {
    const token = randomToken(32);
    const now = this.clock.now();
    // Keep at most MAX_SESSIONS active sessions per subject; the oldest are signed out.
    run(
      this.db,
      `UPDATE sessions SET revoked_at = ? WHERE id IN (
         SELECT id FROM sessions WHERE subject_type = ? AND subject_id = ? AND revoked_at IS NULL AND expires_at > ?
         ORDER BY created_at DESC LIMIT -1 OFFSET ?)`,
      now.toISOString(),
      type,
      subjectId,
      now.toISOString(),
      MAX_SESSIONS - 1,
    );
    run(
      this.db,
      `INSERT INTO sessions (id, subject_type, subject_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
      sha256Hex(token),
      type,
      subjectId,
      now.toISOString(),
      new Date(now.getTime() + ttlMs).toISOString(),
    );
    return token;
  }

  /** Returns the subject id for a valid session token, or null. */
  resolveSession(token: string | undefined, type: 'user' | 'operator'): string | null {
    if (!token || token.length > 100) return null;
    const id = sha256Hex(token);
    const row = one<{ subject_id: string; expires_at: string; revoked_at: string | null; created_at: string; last_seen_at: string | null }>(
      this.db,
      'SELECT subject_id, expires_at, revoked_at, created_at, last_seen_at FROM sessions WHERE id = ? AND subject_type = ?',
      id,
      type,
    );
    const now = this.clock.now();
    if (!row || row.revoked_at || row.expires_at < now.toISOString()) return null;
    // Sliding idle timeout, as banking apps do. last_seen_at is refreshed at most once a minute.
    const idleMs = now.getTime() - Date.parse(row.last_seen_at ?? row.created_at);
    if (idleMs > IDLE_TIMEOUT_MS) {
      run(this.db, 'UPDATE sessions SET revoked_at = ? WHERE id = ?', now.toISOString(), id);
      return null;
    }
    if (idleMs > 60_000) run(this.db, 'UPDATE sessions SET last_seen_at = ? WHERE id = ?', now.toISOString(), id);
    if (type === 'user') {
      const user = one<{ status: string }>(this.db, 'SELECT status FROM users WHERE id = ?', row.subject_id);
      if (!user || user.status !== 'active') return null;
    }
    return row.subject_id;
  }

  revokeSession(token: string | undefined): void {
    if (!token) return;
    run(this.db, 'UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', nowIso(this.clock), sha256Hex(token));
  }

  revokeAllForUser(userId: string): void {
    run(
      this.db,
      `UPDATE sessions SET revoked_at = ? WHERE subject_type = 'user' AND subject_id = ? AND revoked_at IS NULL`,
      nowIso(this.clock),
      userId,
    );
  }

  getUser(userId: string): MeDTO {
    const row = one<UserRow>(this.db, 'SELECT * FROM users WHERE id = ?', userId);
    if (!row) throw unauthorized();
    return toMeDTO(row);
  }

  operatorSignIn(passcode: string): string {
    const now = this.clock.now().getTime();
    this.operatorAttempts = this.operatorAttempts.filter((t) => now - t < OTP_WINDOW_MS);
    if (this.operatorAttempts.length >= 10) throw tooManyRequests('Too many attempts. Try again later.');
    this.operatorAttempts.push(now);
    const given = hmacHex(this.config.authHmacSecret, `operator:${passcode}`);
    const expected = hmacHex(this.config.authHmacSecret, `operator:${this.config.operatorPasscode}`);
    if (!safeEqual(given, expected)) throw unauthorized('That passcode is not right.');
    return this.createSession('operator', OPERATOR_ID, OPERATOR_SESSION_TTL_MS);
  }
}
