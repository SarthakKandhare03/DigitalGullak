import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GOAL_ICONS } from '../../../shared/types';
import { unauthorized } from '../lib/errors';
import { USER_COOKIE, parse, userIdOf } from '../lib/http';
import { requireIdempotencyKey, withIdempotency } from '../lib/idempotency';
import type { Services } from '../services';

const id = z.string().min(1).max(64);
const paise = z.number().int().safe();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const demoScenario = z.enum(['confirm', 'decline', 'slow']).optional();

const goalBody = z.strictObject({
  name: z.string().max(80),
  icon: z.enum(GOAL_ICONS),
  targetPaise: paise,
  targetDate: isoDate.nullable(),
});

const transferBody = z.object({ amountPaise: paise, demoScenario }).strict();

/** Every route here requires a signed-in user and scopes data to that user. */
export async function userRoutes(app: FastifyInstance, { services }: { services: Services }) {
  const { auth, account, goals, ledger, schedules, activity, db, clock, rewards, insights } = services;

  app.addHook('preHandler', async (request) => {
    const userId = auth.resolveSession(request.cookies[USER_COOKIE], 'user');
    if (!userId) throw unauthorized();
    request.userId = userId;
  });

  // --- Me / account --------------------------------------------------------
  app.get('/api/me', async (request) => auth.getUser(userIdOf(request)));

  app.patch('/api/me', async (request) => {
    const body = parse(z.object({ displayName: z.string().max(60).nullable() }), request.body);
    return account.updateProfile(userIdOf(request), body.displayName);
  });

  app.post('/api/me/onboarding', async (request) => {
    const body = parse(z.object({ choice: z.enum(['examples', 'empty']) }), request.body);
    return account.completeOnboarding(userIdOf(request), body.choice);
  });

  app.get('/api/me/export', async (request, reply) => {
    reply.header('content-disposition', 'attachment; filename="digital-gullak-demo-export.json"');
    return account.exportData(userIdOf(request));
  });

  app.get('/api/me/closure', async (request) => ({ blockers: account.closureBlockers(userIdOf(request)) }));

  app.post('/api/me/close', async (request, reply) => {
    parse(z.object({ confirm: z.literal(true) }), request.body);
    await account.close(userIdOf(request));
    reply.clearCookie(USER_COOKIE, { path: '/' });
    return { closed: true };
  });

  app.get('/api/dashboard', async (request) => account.dashboard(userIdOf(request)));
  app.get('/api/partner/account', async (request) => account.partnerAccount(userIdOf(request)));

  // --- Goals ---------------------------------------------------------------
  app.get('/api/goals', async (request) => {
    const query = parse(z.object({ status: z.enum(['active', 'archived']).default('active') }), request.query);
    return goals.list(userIdOf(request), query.status);
  });

  app.post('/api/goals', async (request, reply) => {
    const userId = userIdOf(request);
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    const body = parse(goalBody, request.body);
    const result = withIdempotency(db, clock, `goal:${userId}`, key, body, () => goals.createInTx(userId, body));
    reply.code(result.status);
    return result.body;
  });

  app.get('/api/goals/:goalId', async (request) => {
    const { goalId } = parse(z.object({ goalId: id }), request.params);
    const userId = userIdOf(request);
    const goal = goals.get(userId, goalId);
    return { ...goal, archiveBlockers: goal.status === 'active' ? goals.archiveBlockers(goal.id) : [] };
  });

  app.patch('/api/goals/:goalId', async (request) => {
    const { goalId } = parse(z.object({ goalId: id }), request.params);
    const body = parse(goalBody.partial(), request.body);
    return goals.update(userIdOf(request), goalId, body);
  });

  app.post('/api/goals/:goalId/archive', async (request) => {
    const { goalId } = parse(z.object({ goalId: id }), request.params);
    return goals.archive(userIdOf(request), goalId);
  });

  app.post('/api/goals/:goalId/restore', async (request) => {
    const { goalId } = parse(z.object({ goalId: id }), request.params);
    return goals.restore(userIdOf(request), goalId);
  });

  // --- Simulated transfers -------------------------------------------------
  for (const kind of ['contribution', 'withdrawal'] as const) {
    app.post(`/api/goals/:goalId/${kind}s`, async (request, reply) => {
      const { goalId } = parse(z.object({ goalId: id }), request.params);
      const key = requireIdempotencyKey(request.headers['idempotency-key']);
      const body = parse(transferBody, request.body);
      const result = await ledger.createTransfer({
        userId: userIdOf(request),
        goalId,
        kind,
        amountPaise: body.amountPaise,
        idempotencyKey: key,
        origin: 'manual',
        demoScenario: body.demoScenario,
      });
      // 202: accepted, but not complete until the partner confirms.
      reply.code(result.transaction.status === 'pending' ? 202 : 200);
      return result;
    });
  }

  app.get('/api/transactions/:transactionId', async (request) => {
    const { transactionId } = parse(z.object({ transactionId: id }), request.params);
    return ledger.getForUser(userIdOf(request), transactionId);
  });

  app.get('/api/activity', async (request) => {
    const query = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(100).optional(),
        before: z.string().max(40).optional(),
        type: z.enum(['all', 'contribution', 'withdrawal', 'schedule']).optional(),
        status: z.enum(['pending', 'completed', 'failed', 'reversed']).optional(),
        goalId: id.optional(),
      }),
      request.query,
    );
    return activity.list(userIdOf(request), query);
  });

  // --- Schedules -----------------------------------------------------------
  app.get('/api/schedules', async (request) => schedules.list(userIdOf(request)));

  app.post('/api/schedules', async (request, reply) => {
    const userId = userIdOf(request);
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    const body = parse(
      z.object({
        goalId: id,
        amountPaise: paise,
        frequency: z.enum(['daily', 'weekly', 'monthly']),
        startDate: isoDate,
        consent: z.boolean(),
      }),
      request.body,
    );
    const result = withIdempotency(db, clock, `schedule:${userId}`, key, body, () => schedules.createInTx(userId, body));
    reply.code(result.status);
    return result.body;
  });

  for (const action of ['pause', 'resume', 'cancel'] as const) {
    app.post(`/api/schedules/:scheduleId/${action}`, async (request) => {
      const { scheduleId } = parse(z.object({ scheduleId: id }), request.params);
      return schedules[action](userIdOf(request), scheduleId);
    });
  }

  // --- Insights ------------------------------------------------------------
  app.get('/api/insights/savings', async (request) => {
    const query = parse(z.object({ range: z.enum(['1m', '3m', '6m', '1y']).default('3m') }), request.query);
    return insights.savingsHistory(userIdOf(request), query.range);
  });

  // --- Rewards (gamification) ----------------------------------------------
  const gameLimit = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  app.get('/api/rewards', async (request) => rewards.summary(userIdOf(request)));

  app.post('/api/rewards/quests/:questId/claim', gameLimit, async (request) => {
    const { questId } = parse(z.object({ questId: z.string().max(40) }), request.params);
    return rewards.claimQuest(userIdOf(request), questId);
  });

  app.post('/api/rewards/quiz/start', gameLimit, async (request) => rewards.startQuiz(userIdOf(request)));

  app.post('/api/rewards/quiz/:sessionId/submit', gameLimit, async (request) => {
    const { sessionId } = parse(z.object({ sessionId: id }), request.params);
    const body = parse(z.object({ answers: z.array(z.number().int().min(0).max(9)).max(10) }).strict(), request.body);
    return rewards.submitQuiz(userIdOf(request), sessionId, body.answers);
  });

  app.post('/api/rewards/coin-catch/start', gameLimit, async (request) => rewards.startCoinCatch(userIdOf(request)));

  app.post('/api/rewards/coin-catch/:sessionId/finish', gameLimit, async (request) => {
    const { sessionId } = parse(z.object({ sessionId: id }), request.params);
    const body = parse(z.object({ caught: z.array(z.number().int().min(0).max(500)).max(200) }).strict(), request.body);
    return rewards.finishCoinCatch(userIdOf(request), sessionId, body.caught);
  });

  app.post('/api/rewards/redeem', gameLimit, async (request, reply) => {
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    const body = parse(z.object({ goalId: id, points: z.number().int().safe() }).strict(), request.body);
    const result = await rewards.redeem(userIdOf(request), body.goalId, body.points, key);
    reply.code(result.transaction.status === 'pending' ? 202 : 200);
    return result;
  });

  app.post('/api/schedules/:scheduleId/simulate-run', async (request, reply) => {
    const { scheduleId } = parse(z.object({ scheduleId: id }), request.params);
    const body = parse(z.object({ demoScenario }), request.body ?? {});
    const result = await schedules.simulateNextRun(userIdOf(request), scheduleId, body.demoScenario);
    reply.code(result.transaction.status === 'pending' ? 202 : 200);
    return result;
  });
}
