import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readConfig } from '../src/config';
import { one, run } from '../src/db/db';
import { createTestApp, key, type TestApp } from './helpers';

let t: TestApp;

beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.app.close();
});

async function newGoal(as: Awaited<ReturnType<TestApp['signIn']>>['as'], name = 'Emergency fund', targetPaise = 50_000_00) {
  const res = await as({
    method: 'POST',
    url: '/api/goals',
    headers: { 'idempotency-key': key() },
    payload: { name, icon: '🛟', targetPaise, targetDate: null },
  });
  expect(res.status).toBe(201);
  return res.body as { id: string };
}

async function deposit(as: Awaited<ReturnType<TestApp['signIn']>>['as'], goalId: string, amountPaise: number, extra: object = {}) {
  return as({
    method: 'POST',
    url: `/api/goals/${goalId}/contributions`,
    headers: { 'idempotency-key': key() },
    payload: { amountPaise, ...extra },
  });
}

describe('simulated-money boundary', () => {
  it('refuses to start with live money, a non-mock provider or demo mode off', () => {
    expect(() => readConfig({ NODE_ENV: 'test', LIVE_MONEY_ENABLED: 'true' } as NodeJS.ProcessEnv)).toThrow(/LIVE_MONEY_ENABLED/);
    expect(() => readConfig({ NODE_ENV: 'test', BANK_PROVIDER: 'somebank' } as NodeJS.ProcessEnv)).toThrow(/mock/);
    expect(() => readConfig({ NODE_ENV: 'test', DEMO_MODE: 'false' } as NodeJS.ProcessEnv)).toThrow(/DEMO_MODE/);
  });

  it('labels the public config and every transaction as simulated', async () => {
    const config = await t.call(undefined, { method: 'GET', url: '/api/config' });
    expect(config.body).toMatchObject({ demoMode: true, liveMoneyEnabled: false, provider: { simulated: true } });
    const { as } = await t.signIn('9876543210');
    const goal = await newGoal(as);
    const res = await deposit(as, goal.id, 500_00);
    expect(res.body.transaction.simulated).toBe(true);
  });
});

describe('demo sign-in', () => {
  it('issues a mock OTP, rejects wrong codes and creates a session', async () => {
    const otp = await t.call(undefined, { method: 'POST', url: '/api/auth/otp/request', payload: { phone: '+91 98765 43210' } });
    expect(otp.status).toBe(200);
    expect(otp.body.demoOtp).toMatch(/^\d{6}$/);
    expect(otp.body.phoneLast4).toBe('3210');

    const wrong = await t.call(undefined, { method: 'POST', url: '/api/auth/otp/verify', payload: { challengeId: otp.body.challengeId, code: '000000' === otp.body.demoOtp ? '111111' : '000000' } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('otp_incorrect');

    const ok = await t.call(undefined, { method: 'POST', url: '/api/auth/otp/verify', payload: { challengeId: otp.body.challengeId, code: otp.body.demoOtp } });
    expect(ok.status).toBe(200);
    expect(ok.body.isNew).toBe(true);
    expect(String(ok.headers['set-cookie'])).toMatch(/HttpOnly/i);
    expect(String(ok.headers['set-cookie'])).toMatch(/SameSite=Strict/i);

    const reuse = await t.call(undefined, { method: 'POST', url: '/api/auth/otp/verify', payload: { challengeId: otp.body.challengeId, code: otp.body.demoOtp } });
    expect(reuse.status).toBe(400);
  });

  it('stores only a phone hash and the last four digits', async () => {
    await t.signIn('9876543210');
    const row = one<{ phone_hash: string; phone_last4: string }>(t.db, 'SELECT phone_hash, phone_last4 FROM users')!;
    expect(row.phone_last4).toBe('3210');
    expect(row.phone_hash).not.toContain('9876543210');
    const otpRow = one<{ code_hash: string }>(t.db, 'SELECT code_hash FROM otp_challenges')!;
    expect(otpRow.code_hash).toHaveLength(64);
  });

  it('rejects invalid numbers and unauthenticated requests', async () => {
    const bad = await t.call(undefined, { method: 'POST', url: '/api/auth/otp/request', payload: { phone: '12345' } });
    expect(bad.status).toBe(400);
    const anon = await t.call(undefined, { method: 'GET', url: '/api/dashboard' });
    expect(anon.status).toBe(401);
  });
});

describe('goals', () => {
  it('creates idempotently and rejects key reuse with a different body', async () => {
    const { as } = await t.signIn('9876543210');
    const k = key();
    const payload = { name: 'Rent', icon: '🏠', targetPaise: 12_000_00, targetDate: '2027-01-01' };
    const first = await as({ method: 'POST', url: '/api/goals', headers: { 'idempotency-key': k }, payload });
    const again = await as({ method: 'POST', url: '/api/goals', headers: { 'idempotency-key': k }, payload });
    expect(again.body.id).toBe(first.body.id);
    const list = await as({ method: 'GET', url: '/api/goals' });
    expect(list.body).toHaveLength(1);
    const reused = await as({ method: 'POST', url: '/api/goals', headers: { 'idempotency-key': k }, payload: { ...payload, name: 'Other' } });
    expect(reused.status).toBe(409);
    const noKey = await as({ method: 'POST', url: '/api/goals', payload });
    expect(noKey.status).toBe(400);
  });

  it('renames, edits and archives only when empty', async () => {
    const { as } = await t.signIn('9876543210');
    const goal = await newGoal(as);
    const renamed = await as({ method: 'PATCH', url: `/api/goals/${goal.id}`, payload: { name: 'Rainy day', targetPaise: 40_000_00 } });
    expect(renamed.body).toMatchObject({ name: 'Rainy day', targetPaise: 40_000_00 });

    await deposit(as, goal.id, 100_00);
    await t.scheduler.runAll();
    const blocked = await as({ method: 'POST', url: `/api/goals/${goal.id}/archive`, payload: {} });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details.reasons[0]).toMatch(/Withdraw/);

    await as({ method: 'POST', url: `/api/goals/${goal.id}/withdrawals`, headers: { 'idempotency-key': key() }, payload: { amountPaise: 100_00 } });
    await t.scheduler.runAll();
    const archived = await as({ method: 'POST', url: `/api/goals/${goal.id}/archive`, payload: {} });
    expect(archived.body.status).toBe('archived');
    const restored = await as({ method: 'POST', url: `/api/goals/${goal.id}/restore`, payload: {} });
    expect(restored.body.status).toBe('active');
  });
});

describe('simulated transfers', () => {
  it('stays pending until the partner confirms, then posts balanced ledger entries', async () => {
    const { as } = await t.signIn('9876543210');
    const goal = await newGoal(as);
    const res = await deposit(as, goal.id, 1_250_50);
    expect(res.status).toBe(202);
    expect(res.body.transaction.status).toBe('pending');

    let detail = await as({ method: 'GET', url: `/api/goals/${goal.id}` });
    expect(detail.body.balance).toEqual({ postedPaise: 0, pendingInPaise: 1_250_50, pendingOutPaise: 0, availablePaise: 0 });

    await t.scheduler.runAll(); // mock partner settles and sends a signed webhook
    const txn = await as({ method: 'GET', url: `/api/transactions/${res.body.transaction.id}` });
    expect(txn.body.status).toBe('completed');
    expect(txn.body.events.map((e: { type: string }) => e.type)).toEqual(['created', 'submitted', 'status_changed']);

    detail = await as({ method: 'GET', url: `/api/goals/${goal.id}` });
    expect(detail.body.balance.postedPaise).toBe(1_250_50);
    const sum = one<{ s: number }>(t.db, 'SELECT SUM(amount_paise) AS s FROM ledger_entries')!.s;
    expect(sum).toBe(0);
  });

  it('is idempotent: a retried request never adds money twice', async () => {
    const { as } = await t.signIn('9876543210');
    const goal = await newGoal(as);
    const k = key();
    const send = () => as({ method: 'POST', url: `/api/goals/${goal.id}/contributions`, headers: { 'idempotency-key': k }, payload: { amountPaise: 500_00 } });
    const [a, b] = await Promise.all([send(), send()]);
    await t.scheduler.runAll();
    const c = await send();
    expect(new Set([a.body.transaction.id, b.body.transaction.id, c.body.transaction.id]).size).toBe(1);
    expect(c.body.replayed).toBe(true);
    const detail = await as({ method: 'GET', url: `/api/goals/${goal.id}` });
    expect(detail.body.balance.postedPaise).toBe(500_00);
    const mismatch = await as({ method: 'POST', url: `/api/goals/${goal.id}/contributions`, headers: { 'idempotency-key': k }, payload: { amountPaise: 900_00 } });
    expect(mismatch.status).toBe(409);
  });

  it('holds pending withdrawals and prevents overdrawing', async () => {
    const { as } = await t.signIn('9876543210');
    const goal = await newGoal(as);
    await deposit(as, goal.id, 1_000_00);
    await t.scheduler.runAll();

    const tooMuch = await as({ method: 'POST', url: `/api/goals/${goal.id}/withdrawals`, headers: { 'idempotency-key': key() }, payload: { amountPaise: 1_000_01 } });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error.code).toBe('insufficient_balance');

    const first = await as({ method: 'POST', url: `/api/goals/${goal.id}/withdrawals`, headers: { 'idempotency-key': key() }, payload: { amountPaise: 700_00 } });
    expect(first.status).toBe(202);
    expect(first.body.transaction.counterpartyLabel).toMatch(/simulated/);
    const second = await as({ method: 'POST', url: `/api/goals/${goal.id}/withdrawals`, headers: { 'idempotency-key': key() }, payload: { amountPaise: 400_00 } });
    expect(second.status).toBe(422); // only ₹300 available while ₹700 is held

    await t.scheduler.runAll();
    const detail = await as({ method: 'GET', url: `/api/goals/${goal.id}` });
    expect(detail.body.balance).toMatchObject({ postedPaise: 300_00, availablePaise: 300_00 });
  });

  it('shows failures without changing the balance', async () => {
    const { as } = await t.signIn('9876543210');
    const goal = await newGoal(as);
    const res = await deposit(as, goal.id, 500_00, { demoScenario: 'decline' });
    await t.scheduler.runAll();
    const txn = await as({ method: 'GET', url: `/api/transactions/${res.body.transaction.id}` });
    expect(txn.body.status).toBe('failed');
    expect(txn.body.failureReason).toMatch(/Declined/);
    const detail = await as({ method: 'GET', url: `/api/goals/${goal.id}` });
    expect(detail.body.balance.postedPaise).toBe(0);
  });
});

describe('ownership', () => {
  it('never exposes or changes another user’s data', async () => {
    const asha = await t.signIn('9876543210');
    const ravi = await t.signIn('9123456780');
    const goal = await newGoal(asha.as);
    const dep = await deposit(asha.as, goal.id, 500_00);
    await t.scheduler.runAll();
    const schedule = await asha.as({
      method: 'POST',
      url: '/api/schedules',
      headers: { 'idempotency-key': key() },
      payload: { goalId: goal.id, amountPaise: 100_00, frequency: 'weekly', startDate: '2026-10-20', consent: true },
    });

    const attempts = [
      ravi.as({ method: 'GET', url: `/api/goals/${goal.id}` }),
      ravi.as({ method: 'PATCH', url: `/api/goals/${goal.id}`, payload: { name: 'Mine now' } }),
      ravi.as({ method: 'POST', url: `/api/goals/${goal.id}/withdrawals`, headers: { 'idempotency-key': key() }, payload: { amountPaise: 100_00 } }),
      ravi.as({ method: 'POST', url: `/api/goals/${goal.id}/contributions`, headers: { 'idempotency-key': key() }, payload: { amountPaise: 100_00 } }),
      ravi.as({ method: 'GET', url: `/api/transactions/${dep.body.transaction.id}` }),
      ravi.as({ method: 'POST', url: `/api/schedules/${schedule.body.id}/cancel`, payload: {} }),
      ravi.as({ method: 'POST', url: '/api/schedules', headers: { 'idempotency-key': key() }, payload: { goalId: goal.id, amountPaise: 100_00, frequency: 'daily', startDate: '2026-10-20', consent: true } }),
    ];
    for (const res of await Promise.all(attempts)) expect(res.status).toBe(404);
    const raviActivity = await ravi.as({ method: 'GET', url: '/api/activity' });
    expect(raviActivity.body.items).toHaveLength(0);
  });
});

describe('append-only journal', () => {
  it('blocks edits, deletes and invalid status changes at the database level', async () => {
    const { as } = await t.signIn('9876543210');
    const goal = await newGoal(as);
    const res = await deposit(as, goal.id, 500_00);
    await t.scheduler.runAll();
    const id = res.body.transaction.id;
    expect(() => run(t.db, 'UPDATE transactions SET amount_paise = 1 WHERE id = ?', id)).toThrow(/immutable/);
    expect(() => run(t.db, `UPDATE transactions SET status = 'pending' WHERE id = ?`, id)).toThrow(/invalid transaction status/);
    expect(() => run(t.db, 'DELETE FROM transactions WHERE id = ?', id)).toThrow(/append-only/);
    expect(() => run(t.db, 'UPDATE ledger_entries SET amount_paise = 1')).toThrow(/append-only/);
    expect(() => run(t.db, 'DELETE FROM transaction_events')).toThrow(/append-only/);
  });
});

describe('partner webhooks', () => {
  it('rejects bad signatures and ignores duplicate and stale deliveries', async () => {
    const { as } = await t.signIn('9876543210');
    const goal = await newGoal(as);
    const res = await deposit(as, goal.id, 500_00);
    const txnId = res.body.transaction.id;
    const providerRef = res.body.transaction.providerRef;

    const forged = JSON.stringify({ id: 'evt_forged', type: 'transfer.completed', created_at: new Date().toISOString(), data: {} });
    const bad = await t.call(undefined, { method: 'POST', url: '/api/provider/webhooks/mock', payload: forged, headers: { 'content-type': 'application/json', 'x-mockbank-signature': 't=1,v1=abc' } });
    expect(bad.status).toBe(401);

    const transfer = (status: string, version: number) => ({
      id: providerRef, reference: txnId, account_ref: 'x', direction: 'collect', amount_paise: 500_00, status, version,
      failure_reason: null, created_at: '2026-10-18T05:30:00.000Z', updated_at: '2026-10-18T05:30:00.000Z',
    });
    const send = (body: object) => {
      const raw = JSON.stringify(body);
      return t.call(undefined, { method: 'POST', url: '/api/provider/webhooks/mock', payload: raw, headers: t.mock.signForTest(raw) });
    };

    const completed = { id: 'evt_2', type: 'transfer.completed', created_at: '2026-10-18T05:31:00.000Z', data: { transfer: transfer('completed', 2) } };
    expect((await send(completed)).body.outcome).toBe('processed');
    expect((await send(completed)).body.outcome).toBe('duplicate');
    // An older "pending" event arriving late must not regress the transaction.
    const stale = { id: 'evt_1', type: 'transfer.pending', created_at: '2026-10-18T05:30:30.000Z', data: { transfer: transfer('pending', 1) } };
    expect((await send(stale)).body.outcome).toBe('ignored_stale');

    await t.scheduler.runAll(); // the mock's own completion event is also stale now
    const detail = await as({ method: 'GET', url: `/api/goals/${goal.id}` });
    expect(detail.body.balance.postedPaise).toBe(500_00);

    const unknown = { id: 'evt_x', type: 'transfer.completed', created_at: '2026-10-18T05:32:00.000Z', data: { transfer: { ...transfer('completed', 2), id: 'mbt_unknown', reference: 'txn_unknown' } } };
    expect((await send(unknown)).body.outcome).toBe('unmatched');
    const ops = await t.opsSignIn();
    const exceptions = await ops({ method: 'GET', url: '/api/ops/exceptions' });
    expect(exceptions.body.map((e: { kind: string }) => e.kind)).toContain('unmatched_event');
  });
});

describe('schedules', () => {
  it('requires explicit consent and supports pause, resume, simulated runs and cancel', async () => {
    const { as } = await t.signIn('9876543210');
    const goal = await newGoal(as);
    const base = { goalId: goal.id, amountPaise: 500_00, frequency: 'monthly', startDate: '2026-10-31' };

    const noConsent = await as({ method: 'POST', url: '/api/schedules', headers: { 'idempotency-key': key() }, payload: { ...base, consent: false } });
    expect(noConsent.status).toBe(422);
    const overLimit = await as({ method: 'POST', url: '/api/schedules', headers: { 'idempotency-key': key() }, payload: { ...base, amountPaise: 15_000_01, consent: true } });
    expect(overLimit.status).toBe(422);

    const created = await as({ method: 'POST', url: '/api/schedules', headers: { 'idempotency-key': key() }, payload: { ...base, consent: true } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'active', nextRunDate: '2026-10-31', simulated: true });
    const id = created.body.id;

    const paused = await as({ method: 'POST', url: `/api/schedules/${id}/pause`, payload: {} });
    expect(paused.body.status).toBe('paused');
    const blockedRun = await as({ method: 'POST', url: `/api/schedules/${id}/simulate-run`, payload: {} });
    expect(blockedRun.status).toBe(409);
    const resumed = await as({ method: 'POST', url: `/api/schedules/${id}/resume`, payload: {} });
    expect(resumed.body.status).toBe('active');

    const simulated = await as({ method: 'POST', url: `/api/schedules/${id}/simulate-run`, payload: {} });
    expect(simulated.body.transaction).toMatchObject({ origin: 'schedule', amountPaise: 500_00, status: 'pending' });
    await t.scheduler.runAll();
    const after = (await as({ method: 'GET', url: '/api/schedules' })).body[0];
    expect(after).toMatchObject({ nextRunDate: '2026-11-30', runsCount: 1 });

    const cancelled = await as({ method: 'POST', url: `/api/schedules/${id}/cancel`, payload: {} });
    expect(cancelled.body).toMatchObject({ status: 'cancelled', nextRunDate: null });
    const resumeCancelled = await as({ method: 'POST', url: `/api/schedules/${id}/resume`, payload: {} });
    expect(resumeCancelled.status).toBe(409);

    const activity = await as({ method: 'GET', url: '/api/activity' });
    const kinds = activity.body.items.map((i: { type: string; event?: { type: string } }) => (i.type === 'schedule_event' ? i.event!.type : i.type));
    expect(kinds).toEqual(expect.arrayContaining(['created', 'paused', 'resumed', 'cancelled', 'transaction']));
  });
});

describe('reconciliation and operator actions', () => {
  it('detects a missed partner reversal and lets an operator apply the partner status with an audit record', async () => {
    const { as, user } = await t.signIn('9876543210');
    const goal = await newGoal(as);
    const dep = await deposit(as, goal.id, 2_000_00);
    await t.scheduler.runAll();
    const ops = await t.opsSignIn();

    const clean = await ops({ method: 'POST', url: '/api/ops/reconciliation/run', payload: {} });
    expect(clean.body.findings).toBe(0);

    const reason = 'Demo: partner reversal with lost webhook';
    const drift = await ops({ method: 'POST', url: '/api/ops/demo/missed-reversal', payload: { transactionId: dep.body.transaction.id, reason } });
    expect(drift.body.partnerStatus).toBe('reversed');
    // The app has not been told yet.
    expect((await as({ method: 'GET', url: `/api/goals/${goal.id}` })).body.balance.postedPaise).toBe(2_000_00);

    t.clock.advance(60_000);
    const runResult = await ops({ method: 'POST', url: '/api/ops/reconciliation/run', payload: {} });
    expect(runResult.body.exceptionsOpened).toBe(2);
    const open = (await ops({ method: 'GET', url: '/api/ops/exceptions' })).body as Array<{ id: string; kind: string; userId: string }>;
    expect(open.map((e) => e.kind).sort()).toEqual(['balance_mismatch', 'status_mismatch']);

    const statusEx = open.find((e) => e.kind === 'status_mismatch')!;
    const noReason = await ops({ method: 'POST', url: `/api/ops/exceptions/${statusEx.id}/resolve`, payload: { action: 'apply_partner_status', reason: '' } });
    expect(noReason.status).toBe(400);
    const resolved = await ops({ method: 'POST', url: `/api/ops/exceptions/${statusEx.id}/resolve`, payload: { action: 'apply_partner_status', reason: 'Partner statement confirms reversal' } });
    expect(resolved.body.status).toBe('resolved');

    const txn = await as({ method: 'GET', url: `/api/transactions/${dep.body.transaction.id}` });
    expect(txn.body.status).toBe('reversed');
    expect((await as({ method: 'GET', url: `/api/goals/${goal.id}` })).body.balance.postedPaise).toBe(0);

    const audit = (await ops({ method: 'GET', url: '/api/ops/audit' })).body as Array<{ action: string; reason: string }>;
    expect(audit.map((a) => a.action)).toEqual(['reconciliation.apply_partner_status', 'demo.simulate_missed_partner_reversal']);

    const rerun = await ops({ method: 'POST', url: '/api/ops/reconciliation/run', payload: {} });
    expect(rerun.body).toMatchObject({ findings: 0, exceptionsClosed: 1 });
    expect(user.id).toBeTruthy();
  });

  it('protects operator routes', async () => {
    expect((await t.call(undefined, { method: 'GET', url: '/api/ops/overview' })).status).toBe(401);
    const wrong = await t.call(undefined, { method: 'POST', url: '/api/ops/session', payload: { passcode: 'nope' } });
    expect(wrong.status).toBe(401);
    const { as } = await t.signIn('9876543210');
    expect((await as({ method: 'GET', url: '/api/ops/overview' })).status).toBe(401);
  });
});

describe('example data and account', () => {
  it('creates labelled sample goals that reconcile cleanly', async () => {
    const otp = await t.call(undefined, { method: 'POST', url: '/api/auth/otp/request', payload: { phone: '9988776655' } });
    const verify = await t.app.inject({ method: 'POST', url: '/api/auth/otp/verify', payload: { challengeId: otp.body.challengeId, code: otp.body.demoOtp } });
    const cookie = String(verify.headers['set-cookie']).split(';')[0]!;
    const onboard = await t.call(cookie, { method: 'POST', url: '/api/me/onboarding', payload: { choice: 'examples' } });
    expect(onboard.body.onboarded).toBe(true);
    // A second submit must not duplicate sample data.
    await t.call(cookie, { method: 'POST', url: '/api/me/onboarding', payload: { choice: 'examples' } });

    const dash = await t.call(cookie, { method: 'GET', url: '/api/dashboard' });
    expect(dash.body.goals).toHaveLength(3);
    expect(dash.body.goals.every((g: { isExample: boolean }) => g.isExample)).toBe(true);
    expect(dash.body.totals.postedPaise).toBe(13_800_00 + 5_750_50 + 1_800_00);
    expect(dash.body.partner).toMatchObject({ simulated: true, interest: null });
    expect(dash.body.schedules.map((s: { status: string }) => s.status).sort()).toEqual(['active', 'paused']);

    const ops = await t.opsSignIn();
    const recon = await ops({ method: 'POST', url: '/api/ops/reconciliation/run', payload: {} });
    expect(recon.body.findings).toBe(0);
  });

  it('blocks closure while money is allocated, then closes and frees the number', async () => {
    const { as } = await t.signIn('9876543210');
    const goal = await newGoal(as);
    await deposit(as, goal.id, 100_00);
    await t.scheduler.runAll();
    const blocked = await as({ method: 'POST', url: '/api/me/close', payload: { confirm: true } });
    expect(blocked.status).toBe(409);
    await as({ method: 'POST', url: `/api/goals/${goal.id}/withdrawals`, headers: { 'idempotency-key': key() }, payload: { amountPaise: 100_00 } });
    await t.scheduler.runAll();
    const closed = await as({ method: 'POST', url: '/api/me/close', payload: { confirm: true } });
    expect(closed.body.closed).toBe(true);
    expect((await as({ method: 'GET', url: '/api/me' })).status).toBe(401);
    // Records are kept for audit.
    expect(one<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM transactions')!.n).toBe(2);
  });
});
