import { randomUUID } from 'node:crypto';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app';
import { readConfig } from '../src/config';
import { openDatabase, type DB } from '../src/db/db';
import { ManualClock } from '../src/lib/clock';
import { ManualScheduler } from '../src/providers/mock/scheduler';

export interface TestAppOptions {
  /** Extra environment variables for readConfig (e.g. COOKIE_SECURE, OPERATOR_TOTP_SECRET). */
  env?: Record<string, string>;
  /** Reuse a database (and clock) to simulate a restart or a second worker process. */
  db?: DB;
  clock?: ManualClock;
}

export async function createTestApp(options: TestAppOptions = {}) {
  const config = readConfig({ NODE_ENV: 'test', OPERATOR_PASSCODE: 'test-operator-passcode', ...options.env } as NodeJS.ProcessEnv);
  const clock = options.clock ?? new ManualClock('2026-10-18T05:30:00.000Z');
  const scheduler = new ManualScheduler();
  const db = options.db ?? openDatabase(':memory:');
  const built = await buildApp({ config, db, clock, scheduler, serveWeb: false, reconciliation: { graceMs: 30_000, stuckMs: 600_000 } });
  const { app } = built;

  async function call(cookie: string | undefined, options: InjectOptions) {
    const headers = { ...(options.headers ?? {}), ...(cookie ? { cookie } : {}) };
    const response = await app.inject({ ...options, headers });
    return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null, headers: response.headers };
  }

  async function signIn(phone: string) {
    const otp = await call(undefined, { method: 'POST', url: '/api/auth/otp/request', payload: { phone } });
    const verify = await app.inject({
      method: 'POST',
      url: '/api/auth/otp/verify',
      payload: { challengeId: otp.body.challengeId, code: otp.body.demoOtp },
    });
    const setCookie = verify.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0]! : String(setCookie);
    const cookie = raw.split(';')[0]!;
    const user = JSON.parse(verify.body).user as { id: string };
    const as = (options: InjectOptions) => call(cookie, options);
    await as({ method: 'POST', url: '/api/me/onboarding', payload: { choice: 'empty' } });
    return { cookie, user, as };
  }

  async function opsSignIn() {
    const response = await app.inject({ method: 'POST', url: '/api/ops/session', payload: { passcode: 'test-operator-passcode' } });
    const setCookie = response.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(';')[0]!;
    return (options: InjectOptions) => call(cookie, options);
  }

  return { ...built, db, clock, scheduler, call, signIn, opsSignIn };
}

export const key = () => randomUUID();

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;
