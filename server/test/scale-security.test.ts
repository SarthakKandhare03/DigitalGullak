import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { all, one, run, tx } from '../src/db/db';
import { runRetention } from '../src/jobs';
import { hmacHex } from '../src/lib/crypto';
import { generateTotpSecret, totpCode, totpStep } from '../src/lib/totp';
import { createTestApp, key, type TestApp } from './helpers';

const apps: TestApp[] = [];
async function make(...args: Parameters<typeof createTestApp>) {
  const t = await createTestApp(...args);
  apps.push(t);
  return t;
}
afterEach(async () => {
  while (apps.length) await apps.pop()!.app.close();
});

async function depositAndSettle(t: TestApp, amountPaise = 1_000_00) {
  const { as, user } = await t.signIn('9876543210');
  const goal = await as({ method: 'POST', url: '/api/goals', headers: { 'idempotency-key': key() }, payload: { name: 'Rent', icon: '🏠', targetPaise: 10_000_00, targetDate: null } });
  const dep = await as({ method: 'POST', url: `/api/goals/${goal.body.id}/contributions`, headers: { 'idempotency-key': key() }, payload: { amountPaise } });
  await t.scheduler.runAll();
  return { as, user, goalId: goal.body.id as string, transactionId: dep.body.transaction.id as string };
}

describe('tamper-evident hash chains', () => {
  it('verifies an untouched ledger and detects an edited row, even with triggers dropped', async () => {
    const t = await make();
    await depositAndSettle(t);
    const clean = t.services.integrity.verify('full');
    expect(clean.ledger).toMatchObject({ ok: true });
    expect(clean.ledger.checked).toBeGreaterThan(0);
    expect(clean.balanceCache.ok).toBe(true);

    // An attacker with raw database access removes the guard and edits an amount.
    t.db.exec('DROP TRIGGER ledger_entries_no_update');
    run(t.db, `UPDATE ledger_entries SET amount_paise = amount_paise + 500 WHERE account_type = 'pocket'`);
    const report = t.services.integrity.verify('full');
    expect(report.ledger.ok).toBe(false);
    expect(report.ledger.reason).toMatch(/edited/);
    expect(report.balanceCache.ok).toBe(false); // cache no longer matches the ledger either
    const kinds = t.services.exceptions.list('unresolved').map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['ledger_chain_broken', 'balance_cache_drift']));
  });

  it('detects a deleted ledger row and an edited audit entry', async () => {
    const t = await make();
    await depositAndSettle(t);
    await depositAndSettle(t, 2_000_00).catch(() => undefined);
    tx(t.db, () => {
      t.services.audit.record({ operatorId: 'op_demo', action: 'test.first', targetType: 'x', targetId: '1', reason: 'first entry' });
      t.services.audit.record({ operatorId: 'op_demo', action: 'test.second', targetType: 'x', targetId: '2', reason: 'second entry' });
    });
    expect(t.services.integrity.verify('full').audit.ok).toBe(true);

    t.db.exec('DROP TRIGGER ledger_entries_no_delete');
    const first = one<{ id: number }>(t.db, 'SELECT id FROM ledger_entries ORDER BY id LIMIT 1')!;
    run(t.db, 'DELETE FROM ledger_entries WHERE id = ?', first.id + 1);
    t.db.exec('DROP TRIGGER operator_audit_log_no_update');
    run(t.db, `UPDATE operator_audit_log SET reason = 'covering my tracks' WHERE action = 'test.first'`);

    const report = t.services.integrity.verify('full');
    expect(report.ledger.ok).toBe(false);
    expect(report.ledger.reason).toMatch(/link/);
    expect(report.audit.ok).toBe(false);
  });

  it('checks only new rows in incremental mode', async () => {
    const t = await make();
    await depositAndSettle(t);
    const first = t.services.integrity.verify('incremental');
    expect(first.ledger.checked).toBeGreaterThan(0);
    expect(t.services.integrity.verify('incremental').ledger.checked).toBe(0);
  });
});

describe('cached balances', () => {
  it('keeps goal balances equal to the ledger through deposits, withdrawals and reversals', async () => {
    const t = await make();
    const { as, goalId, transactionId } = await depositAndSettle(t, 3_000_00);
    await as({ method: 'POST', url: `/api/goals/${goalId}/withdrawals`, headers: { 'idempotency-key': key() }, payload: { amountPaise: 1_000_00 } });
    await t.scheduler.runAll();
    const ops = await t.opsSignIn();
    await ops({ method: 'POST', url: '/api/ops/demo/missed-reversal', payload: { transactionId, reason: 'cache drill' } });
    t.clock.advance(60_000);
    await ops({ method: 'POST', url: '/api/ops/reconciliation/run', payload: {} });
    const ex = (await ops({ method: 'GET', url: '/api/ops/exceptions' })).body.find((e: { kind: string }) => e.kind === 'status_mismatch');
    await ops({ method: 'POST', url: `/api/ops/exceptions/${ex.id}/resolve`, payload: { action: 'apply_partner_status', reason: 'partner statement' } });

    const cached = one<{ p: number }>(t.db, 'SELECT posted_paise AS p FROM goal_balances WHERE goal_id = ?', goalId)!.p;
    const ledger = one<{ p: number }>(t.db, `SELECT SUM(amount_paise) AS p FROM ledger_entries WHERE goal_id = ? AND account_type = 'pocket'`, goalId)!.p;
    expect(cached).toBe(ledger);
    expect(cached).toBe(3_000_00 - 1_000_00 - 3_000_00);
    expect(t.services.integrity.verify('full').balanceCache.ok).toBe(true);
  });
});

describe('operator sign-in hardening', () => {
  it('requires a TOTP code when configured and rejects a replayed code', async () => {
    const secret = generateTotpSecret();
    const t = await make({ env: { OPERATOR_TOTP_SECRET: secret } });
    const opts = await t.call(undefined, { method: 'GET', url: '/api/ops/login-options' });
    expect(opts.body).toEqual({ mfaRequired: true });

    const noCode = await t.call(undefined, { method: 'POST', url: '/api/ops/session', payload: { passcode: 'test-operator-passcode' } });
    expect(noCode.status).toBe(401);
    const code = totpCode(secret, totpStep(t.clock.now()));
    const ok = await t.call(undefined, { method: 'POST', url: '/api/ops/session', payload: { passcode: 'test-operator-passcode', code } });
    expect(ok.status).toBe(200);
    const replay = await t.call(undefined, { method: 'POST', url: '/api/ops/session', payload: { passcode: 'test-operator-passcode', code } });
    expect(replay.status).toBe(401);
    expect(t.services.securityEvents.summary().operator_totp_replay).toBe(1);

    t.clock.advance(30_000);
    const next = totpCode(secret, totpStep(t.clock.now()));
    expect((await t.call(undefined, { method: 'POST', url: '/api/ops/session', payload: { passcode: 'test-operator-passcode', code: next } })).status).toBe(200);
  });

  it('locks operator sign-in after repeated failures, across restarts and worker processes', async () => {
    const t = await make();
    for (let i = 0; i < 5; i++) {
      expect((await t.call(undefined, { method: 'POST', url: '/api/ops/session', payload: { passcode: `wrong-${i}` } })).status).toBe(401);
    }
    const locked = await t.call(undefined, { method: 'POST', url: '/api/ops/session', payload: { passcode: 'test-operator-passcode' } });
    expect(locked.status).toBe(429);

    // A second process on the same database sees the same lockout.
    const other = await make({ db: t.db, clock: t.clock });
    expect((await other.call(undefined, { method: 'POST', url: '/api/ops/session', payload: { passcode: 'test-operator-passcode' } })).status).toBe(429);

    t.clock.advance(16 * 60_000);
    expect((await other.call(undefined, { method: 'POST', url: '/api/ops/session', payload: { passcode: 'test-operator-passcode' } })).status).toBe(200);
  });

  it('expires idle operator sessions after 15 minutes', async () => {
    const t = await make();
    const ops = await t.opsSignIn();
    expect((await ops({ method: 'GET', url: '/api/ops/overview' })).status).toBe(200);
    t.clock.advance(16 * 60_000);
    expect((await ops({ method: 'GET', url: '/api/ops/overview' })).status).toBe(401);
  });
});

describe('HTTPS-only protections', () => {
  it('uses __Host- cookies, HSTS and upgrade-insecure-requests when COOKIE_SECURE=true', async () => {
    const t = await make({ env: { COOKIE_SECURE: 'true' } });
    const otp = await t.call(undefined, { method: 'POST', url: '/api/auth/otp/request', payload: { phone: '9876543210' } });
    const verify = await t.app.inject({ method: 'POST', url: '/api/auth/otp/verify', payload: { challengeId: otp.body.challengeId, code: otp.body.demoOtp } });
    const cookie = String(verify.headers['set-cookie']);
    expect(cookie).toMatch(/^__Host-gullak_session=/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/Path=\//);
    const res = await t.call(cookie.split(';')[0], { method: 'GET', url: '/api/me' });
    expect(res.status).toBe(200);
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(res.headers['content-security-policy']).toContain('upgrade-insecure-requests');
  });
});

describe('partner webhooks', () => {
  it('accepts the previous secret during rotation and records rejected signatures', async () => {
    const t = await make({ env: { MOCK_PROVIDER_WEBHOOK_SECRET: 'new-secret-123456', MOCK_PROVIDER_WEBHOOK_SECRET_PREVIOUS: 'old-secret-123456' } });
    const raw = JSON.stringify({ id: 'evt_rot', type: 'account.status_changed', created_at: '2026-10-18T05:30:00.000Z', data: { account_ref: 'mba_x' } });
    const ts = Math.floor(t.clock.now().getTime() / 1000);
    const send = (secret: string) =>
      t.call(undefined, {
        method: 'POST',
        url: '/api/provider/webhooks/mock',
        payload: raw,
        headers: { 'content-type': 'application/json', 'x-mockbank-signature': `t=${ts},v1=${hmacHex(secret, `${ts}.${raw}`)}` },
      });
    expect((await send('old-secret-123456')).status).toBe(200);
    expect((await send('attacker-secret-1')).status).toBe(401);
    expect(t.services.securityEvents.summary().webhook_rejected).toBe(1);
  });

  it('recovers transfers whose settlement timer was lost, and two processes never settle twice', async () => {
    const t = await make();
    const second = await make({ db: t.db, clock: t.clock }); // e.g. the leader in another worker process
    const { as } = await t.signIn('9876543210');
    const goal = await as({ method: 'POST', url: '/api/goals', headers: { 'idempotency-key': key() }, payload: { name: 'Rent', icon: '🏠', targetPaise: 10_000_00, targetDate: null } });
    const dep = await as({ method: 'POST', url: `/api/goals/${goal.body.id}/contributions`, headers: { 'idempotency-key': key() }, payload: { amountPaise: 500_00 } });
    expect(dep.body.transaction.status).toBe('pending');

    t.clock.advance(15_000);
    // Both the original timer and the other process's recovery sweep fire.
    await Promise.all([t.scheduler.runAll(), second.mock.sweep()]);
    await second.scheduler.runAll();

    const txn = await as({ method: 'GET', url: `/api/transactions/${dep.body.transaction.id}` });
    expect(txn.body.status).toBe('completed');
    const completions = all(t.db, `SELECT id FROM mockbank_events WHERE type = 'transfer.completed'`);
    expect(completions).toHaveLength(1);
    // A process that read the transfer as "pending" before the other committed loses the race:
    const transferId = txn.body.providerRef as string;
    const lateSettle = (second.mock as unknown as { changeStatus: (...a: unknown[]) => unknown }).changeStatus(transferId, 'pending', 'completed', null, true);
    expect(lateSettle).toBeNull();
    expect(all(t.db, `SELECT id FROM mockbank_events WHERE type = 'transfer.completed'`)).toHaveLength(1);
    expect(one<{ n: number }>(t.db, `SELECT COUNT(*) AS n FROM ledger_entries WHERE transaction_id = ?`, dep.body.transaction.id)!.n).toBe(2);
  });
});

describe('scaling behaviour', () => {
  it('rate-limits signed-in users per account, not per shared IP (carrier-grade NAT)', async () => {
    const t = await make({ env: { RATE_LIMIT_PER_MINUTE: '6' } });
    const asha = await t.signIn('9876543210');
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await asha.as({ method: 'GET', url: '/api/me' })).status);
    expect(statuses).toContain(429);
    const ravi = await t.signIn('9123456780'); // same IP as Asha
    expect((await ravi.as({ method: 'GET', url: '/api/me' })).status).toBe(200);
    expect(t.services.securityEvents.summary().rate_limited).toBeGreaterThan(0);
  });

  it('serves the rewards summary without writing when nothing new was earned', async () => {
    const t = await make();
    const { as } = await t.signIn('9876543210');
    await as({ method: 'GET', url: '/api/rewards' });
    const before = one<{ n: number }>(t.db, 'SELECT total_changes() AS n')!.n;
    await as({ method: 'GET', url: '/api/rewards' });
    expect(one<{ n: number }>(t.db, 'SELECT total_changes() AS n')!.n).toBe(before);
  });

  it('gzips large API responses only when the client accepts it', async () => {
    const t = await make();
    const { cookie } = await depositAndSettle(t).then(async (r) => ({ ...r, cookie: (await t.signIn('9876543210')).cookie }));
    const zipped = await t.app.inject({ method: 'GET', url: '/api/dashboard', headers: { cookie, 'accept-encoding': 'gzip, br' } });
    expect(zipped.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(gunzipSync(zipped.rawPayload).toString()).goals).toHaveLength(1);
    const plain = await t.app.inject({ method: 'GET', url: '/api/dashboard', headers: { cookie } });
    expect(plain.headers['content-encoding']).toBeUndefined();
    const small = await t.app.inject({ method: 'GET', url: '/api/config', headers: { 'accept-encoding': 'gzip' } });
    expect(small.headers['content-encoding']).toBeUndefined();
  });

  it('reports readiness and stops when draining', async () => {
    const t = await make();
    expect((await t.call(undefined, { method: 'GET', url: '/api/health/ready' })).body).toEqual({ ready: true });
    t.setDraining(true);
    expect((await t.call(undefined, { method: 'GET', url: '/api/health/ready' })).status).toBe(503);
  });

  it('purges expired security data but never financial records', async () => {
    const t = await make();
    await depositAndSettle(t);
    const old = new Date(t.clock.now().getTime() - 100 * 24 * 60 * 60_000).toISOString();
    run(t.db, `INSERT INTO otp_challenges (id, phone_hash, phone_last4, code_hash, expires_at, created_at) VALUES ('otp_old', 'h', '0000', 'c', ?, ?)`, old, old);
    run(t.db, `INSERT INTO sessions (id, subject_type, subject_id, created_at, expires_at) VALUES ('s_old', 'user', 'u', ?, ?)`, old, old);
    run(t.db, `INSERT INTO idempotency_records (scope, key, request_hash, response_status, response_body, created_at) VALUES ('x', 'k', 'h', 201, '{}', ?)`, old);
    run(t.db, `INSERT INTO security_events (type, subject, created_at) VALUES ('csrf_blocked', 'ip:x', ?)`, old);
    const txnsBefore = one<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM transactions')!.n;

    const removed = runRetention(t.db, t.clock);
    expect(removed).toMatchObject({ otpChallenges: 1, sessions: 1, idempotencyRecords: 1, securityEvents: 1 });
    expect(one<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM transactions')!.n).toBe(txnsBefore);
    // Live sessions survive.
    expect(one<{ n: number }>(t.db, `SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL`)!.n).toBeGreaterThan(0);
  });
});
