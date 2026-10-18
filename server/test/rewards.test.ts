import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COIN_CATCH, coinCatchLayout, scoreFor } from '../../shared/rewards';
import { one, run } from '../src/db/db';
import { QUIZ_BANK } from '../src/rewards/quizBank';
import { createTestApp, key, type TestApp } from './helpers';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.app.close();
});

type As = Awaited<ReturnType<TestApp['signIn']>>['as'];

async function goal(as: As, targetPaise = 2_000_00) {
  const res = await as({ method: 'POST', url: '/api/goals', headers: { 'idempotency-key': key() }, payload: { name: 'Phone', icon: '📱', targetPaise, targetDate: null } });
  return res.body.id as string;
}

async function save(as: As, goalId: string, amountPaise: number) {
  await as({ method: 'POST', url: `/api/goals/${goalId}/contributions`, headers: { 'idempotency-key': key() }, payload: { amountPaise } });
  await t.scheduler.runAll();
}

function grant(userId: string, points: number) {
  run(t.db, `INSERT INTO reward_points (user_id, points, source, source_ref, note, created_at) VALUES (?, ?, 'quest', ?, 'test grant', ?)`, userId, points, key(), new Date().toISOString());
}

describe('achievements and quests', () => {
  it('awards achievements once and only from real (non-sample) saving', async () => {
    const { as } = await t.signIn('9876543210');
    const g = await goal(as);
    await save(as, g, 600_00);

    const first = await as({ method: 'GET', url: '/api/rewards' });
    expect(first.body.newlyUnlocked.sort()).toEqual(['first_goal', 'first_save', 'goal_quarter'].sort());
    expect(first.body.points.balance).toBe(50 + 100 + 100);
    const again = await as({ method: 'GET', url: '/api/rewards' });
    expect(again.body.newlyUnlocked).toEqual([]);
    expect(again.body.points.balance).toBe(250);
    expect(again.body.level.name).toBe('Bronze');
  });

  it('lets a completed weekly quest be claimed exactly once, and not before it is complete', async () => {
    const { as } = await t.signIn('9876543210');
    const g = await goal(as);
    const early = await as({ method: 'POST', url: '/api/rewards/quests/save_3_times/claim', payload: {} });
    expect(early.status).toBe(409);

    for (let i = 0; i < 3; i++) await save(as, g, 150_00);
    const summary = await as({ method: 'GET', url: '/api/rewards' });
    expect(summary.body.quests.find((q: { id: string }) => q.id === 'save_3_times').status).toBe('claimable');
    const before = summary.body.points.balance;

    const [a, b] = await Promise.all([
      as({ method: 'POST', url: '/api/rewards/quests/save_3_times/claim', payload: {} }),
      as({ method: 'POST', url: '/api/rewards/quests/save_3_times/claim', payload: {} }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const after = await as({ method: 'GET', url: '/api/rewards' });
    expect(after.body.points.balance).toBe(before + 150);
    expect(after.body.quests.find((q: { id: string }) => q.id === 'save_3_times').status).toBe('claimed');
    expect(after.body.streak).toEqual({ weeks: 1, savedThisWeek: true });
  });

  it('does not count deposits that were withdrawn again (no point farming)', async () => {
    const { as } = await t.signIn('9876543210');
    const g = await goal(as);
    for (let i = 0; i < 3; i++) await save(as, g, 100_00);
    await as({ method: 'POST', url: `/api/goals/${g}/withdrawals`, headers: { 'idempotency-key': key() }, payload: { amountPaise: 300_00 } });
    await t.scheduler.runAll();
    const summary = await as({ method: 'GET', url: '/api/rewards' });
    const quest = summary.body.quests.find((q: { id: string }) => q.id === 'save_3_times');
    expect(quest.status).toBe('in_progress');
    expect(quest.progress).toBe(0);
  });
});

describe('money quiz', () => {
  it('grades on the server, never leaks answers early, and rewards once a day', async () => {
    const { as } = await t.signIn('9876543210');
    const start = await as({ method: 'POST', url: '/api/rewards/quiz/start', payload: {} });
    expect(start.body.questions).toHaveLength(5);
    expect(JSON.stringify(start.body)).not.toMatch(/"answer"|explanation/);
    // Re-opening returns the same questions (no re-rolling).
    const reopen = await as({ method: 'POST', url: '/api/rewards/quiz/start', payload: {} });
    expect(reopen.body.sessionId).toBe(start.body.sessionId);

    const answers = start.body.questions.map((q: { id: string }) => QUIZ_BANK.find((x) => x.id === q.id)!.answer);
    const result = await as({ method: 'POST', url: `/api/rewards/quiz/${start.body.sessionId}/submit`, payload: { answers } });
    expect(result.body).toMatchObject({ correct: 5, total: 5, pointsAwarded: 100 });

    const resubmit = await as({ method: 'POST', url: `/api/rewards/quiz/${start.body.sessionId}/submit`, payload: { answers } });
    expect(resubmit.status).toBe(409);
    const tomorrowOnly = await as({ method: 'POST', url: '/api/rewards/quiz/start', payload: {} });
    expect(tomorrowOnly.status).toBe(409);

    const summary = await as({ method: 'GET', url: '/api/rewards' });
    expect(summary.body.achievements.find((a: { id: string }) => a.id === 'quiz_ace').unlocked).toBe(true);
  });
});

describe('coin catch', () => {
  it('recomputes the score on the server and rejects early or impossible results', async () => {
    const { as } = await t.signIn('9876543210');
    const start = await as({ method: 'POST', url: '/api/rewards/coin-catch/start', payload: {} });
    expect(start.body).toMatchObject({ durationMs: COIN_CATCH.durationMs, rewarded: true });
    const layout = coinCatchLayout(start.body.seed);
    const coins = layout.filter((i) => i.kind !== 'trap').map((i) => i.index);

    const tooEarly = await as({ method: 'POST', url: `/api/rewards/coin-catch/${start.body.sessionId}/finish`, payload: { caught: coins } });
    expect(tooEarly.status).toBe(422);

    t.clock.advance(COIN_CATCH.durationMs);
    const dupes = await as({ method: 'POST', url: `/api/rewards/coin-catch/${start.body.sessionId}/finish`, payload: { caught: [coins[0], coins[0]] } });
    expect(dupes.status).toBe(422);
    const bogus = await as({ method: 'POST', url: `/api/rewards/coin-catch/${start.body.sessionId}/finish`, payload: { caught: [499] } });
    expect(bogus.status).toBe(422);

    const finish = await as({ method: 'POST', url: `/api/rewards/coin-catch/${start.body.sessionId}/finish`, payload: { caught: coins } });
    const expected = scoreFor(layout, coins);
    expect(finish.body.score).toBe(expected);
    expect(finish.body.pointsAwarded).toBe(Math.min(expected, COIN_CATCH.maxPointsPerGame));
    const twice = await as({ method: 'POST', url: `/api/rewards/coin-catch/${start.body.sessionId}/finish`, payload: { caught: coins } });
    expect(twice.status).toBe(409);
  });

  it('only rewards a limited number of plays per day', async () => {
    const { as } = await t.signIn('9876543210');
    const awarded: number[] = [];
    for (let i = 0; i < COIN_CATCH.rewardedPlaysPerDay + 1; i++) {
      const s = await as({ method: 'POST', url: '/api/rewards/coin-catch/start', payload: {} });
      t.clock.advance(COIN_CATCH.durationMs);
      const caught = coinCatchLayout(s.body.seed).filter((x) => x.kind === 'coin').map((x) => x.index);
      const f = await as({ method: 'POST', url: `/api/rewards/coin-catch/${s.body.sessionId}/finish`, payload: { caught } });
      awarded.push(f.body.pointsAwarded);
    }
    expect(awarded.slice(0, -1).every((p) => p > 0)).toBe(true);
    expect(awarded.at(-1)).toBe(0);
  });
});

describe('points redemption', () => {
  it('turns points into a simulated reward credit, idempotently, through the partner', async () => {
    const { as, user } = await t.signIn('9876543210');
    const g = await goal(as);
    grant(user.id, 1_200);
    const k = key();
    const send = () => as({ method: 'POST', url: '/api/rewards/redeem', headers: { 'idempotency-key': k }, payload: { goalId: g, points: 1_000 } });
    const [a, b] = await Promise.all([send(), send()]);
    expect(a.body.transaction.id).toBe(b.body.transaction.id);
    expect(a.body.transaction).toMatchObject({ origin: 'reward', amountPaise: 100_00, status: 'pending', simulated: true });
    await t.scheduler.runAll();

    const summary = await as({ method: 'GET', url: '/api/rewards' });
    expect(summary.body.points.balance).toBe(1_200 - 1_000 + 50); // + "Dream it" achievement for the goal
    const goalRes = await as({ method: 'GET', url: `/api/goals/${g}` });
    expect(goalRes.body.balance.postedPaise).toBe(100_00);

    const tooMany = await as({ method: 'POST', url: '/api/rewards/redeem', headers: { 'idempotency-key': key() }, payload: { goalId: g, points: 500 } });
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.error.code).toBe('insufficient_points');
    // Reward credits never earn more points.
    expect(summary.body.achievements.find((x: { id: string }) => x.id === 'first_save').unlocked).toBe(false);
  });

  it('enforces minimums and the daily cap, and refunds points if the partner declines', async () => {
    const { as, user } = await t.signIn('9876543210');
    const g = await goal(as);
    grant(user.id, 5_000);
    const small = await as({ method: 'POST', url: '/api/rewards/redeem', headers: { 'idempotency-key': key() }, payload: { goalId: g, points: 100 } });
    expect(small.status).toBe(422);
    const overCap = await as({ method: 'POST', url: '/api/rewards/redeem', headers: { 'idempotency-key': key() }, payload: { goalId: g, points: 2_010 } });
    expect(overCap.body.error.code).toBe('daily_cap');

    const ok = await as({ method: 'POST', url: '/api/rewards/redeem', headers: { 'idempotency-key': key() }, payload: { goalId: g, points: 1_000 } });
    // Partner declines the credit: points come back automatically.
    const transfer = one<{ id: string }>(t.db, `SELECT id FROM mockbank_transfers WHERE reference = ?`, ok.body.transaction.id)!;
    run(t.db, `UPDATE mockbank_transfers SET scenario = 'decline' WHERE id = ?`, transfer.id);
    await t.scheduler.runAll();
    const txn = await as({ method: 'GET', url: `/api/transactions/${ok.body.transaction.id}` });
    expect(txn.body.status).toBe('failed');
    const summary = await as({ method: 'GET', url: '/api/rewards' });
    expect(summary.body.points.balance).toBe(5_000 + 50); // refunded in full, plus the "Dream it" achievement
  });
});

describe('savings history', () => {
  it('returns a daily series of confirmed savings', async () => {
    const { as } = await t.signIn('9876543210');
    const g = await goal(as);
    await save(as, g, 250_00);
    const res = await as({ method: 'GET', url: '/api/insights/savings?range=1m' });
    expect(res.body.points).toHaveLength(30);
    expect(res.body).toMatchObject({ startBalancePaise: 0, endBalancePaise: 250_00, changePaise: 250_00 });
  });
});

describe('security hardening', () => {
  it('sends strict security headers', async () => {
    const res = await t.call(undefined, { method: 'GET', url: '/api/config' });
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('rejects cross-site and foreign-origin state changes, and unknown body fields', async () => {
    const { as } = await t.signIn('9876543210');
    const cross = await as({ method: 'POST', url: '/api/goals', headers: { 'idempotency-key': key(), 'sec-fetch-site': 'cross-site' }, payload: {} });
    expect(cross.status).toBe(403);
    const foreign = await as({ method: 'POST', url: '/api/goals', headers: { 'idempotency-key': key(), origin: 'https://evil.example' }, payload: {} });
    expect(foreign.status).toBe(403);
    const form = await as({ method: 'POST', url: '/api/goals', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'name=x' });
    expect(form.status).toBe(415);
    const extra = await as({
      method: 'POST',
      url: '/api/goals',
      headers: { 'idempotency-key': key() },
      payload: { name: 'X', icon: '🛟', targetPaise: 100_00, targetDate: null, userId: 'someone-else' },
    });
    expect(extra.status).toBe(400);
  });

  it('expires idle sessions and rate-limits OTP requests', async () => {
    const { as } = await t.signIn('9876543210');
    expect((await as({ method: 'GET', url: '/api/me' })).status).toBe(200);
    t.clock.advance(31 * 60_000);
    expect((await as({ method: 'GET', url: '/api/me' })).status).toBe(401);

    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await t.call(undefined, { method: 'POST', url: '/api/auth/otp/request', payload: { phone: `90000000${String(i).padStart(2, '0')}` } })).status);
    }
    expect(statuses).toContain(429);
  });
});
