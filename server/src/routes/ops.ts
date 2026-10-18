import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { unauthorized } from '../lib/errors';
import { OPERATOR_COOKIE, operatorIdOf, parse, setSessionCookie } from '../lib/http';
import { toExceptionDTO } from '../ops/exceptions';
import type { Services } from '../services';

const reason = z.string().min(5, 'Give a reason of at least 5 characters').max(500);

/** Operator console API (demo support and reconciliation). */
export async function opsRoutes(app: FastifyInstance, { services }: { services: Services }) {
  const { auth, ops, recon, exceptions, audit, config, ledger } = services;

  app.post('/api/ops/session', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = parse(z.object({ passcode: z.string().min(1).max(200) }), request.body);
    const token = auth.operatorSignIn(body.passcode);
    setSessionCookie(reply, OPERATOR_COOKIE, token, config.cookieSecure, 8 * 60 * 60);
    return { ok: true };
  });

  app.post('/api/ops/logout', async (request, reply) => {
    auth.revokeSession(request.cookies[OPERATOR_COOKIE]);
    reply.clearCookie(OPERATOR_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.register(async (scoped) => {
    scoped.addHook('preHandler', async (request) => {
      const operatorId = auth.resolveSession(request.cookies[OPERATOR_COOKIE], 'operator');
      if (!operatorId) throw unauthorized('Operator sign-in required.');
      request.operatorId = operatorId;
    });

    scoped.get('/api/ops/overview', async () => ops.overview());
    scoped.get('/api/ops/users', async () => ops.users());
    scoped.get('/api/ops/users/:userId', async (request) => {
      const { userId } = parse(z.object({ userId: z.string().max(64) }), request.params);
      return ops.userDetail(userId);
    });
    scoped.get('/api/ops/transactions', async (request) => {
      const query = parse(z.object({ status: z.enum(['pending', 'completed', 'failed', 'reversed']).optional() }), request.query);
      return ops.transactions(query);
    });
    scoped.get('/api/ops/transactions/:transactionId', async (request) => {
      const { transactionId } = parse(z.object({ transactionId: z.string().max(64) }), request.params);
      return ledger.getAny(transactionId);
    });
    scoped.get('/api/ops/events', async () => ({ received: ops.providerEvents(), partnerOutbox: ops.mockEvents() }));
    scoped.get('/api/ops/audit', async () => audit.list());

    scoped.get('/api/ops/exceptions', async (request) => {
      const query = parse(z.object({ filter: z.enum(['unresolved', 'resolved', 'all']).default('unresolved') }), request.query);
      return exceptions.list(query.filter).map(toExceptionDTO);
    });

    scoped.post('/api/ops/reconciliation/run', async (request) => recon.run(`operator:${operatorIdOf(request)}`));

    scoped.post('/api/ops/exceptions/:exceptionId/resolve', async (request) => {
      const { exceptionId } = parse(z.object({ exceptionId: z.string().max(64) }), request.params);
      const body = parse(
        z.object({ action: z.enum(['apply_partner_status', 'retry_submission', 'escalate', 'mark_resolved']), reason }),
        request.body,
      );
      return recon.resolve(operatorIdOf(request), exceptionId, body.action, body.reason);
    });

    // --- Demo tools (mock partner only; every use is audited) -------------
    scoped.post('/api/ops/demo/replay-event', async (request) => {
      const body = parse(z.object({ eventId: z.string().max(64), reason }), request.body);
      return ops.replayEvent(operatorIdOf(request), body.eventId, body.reason);
    });
    scoped.post('/api/ops/demo/settle-slow', async (request) => {
      const body = parse(z.object({ reason }), request.body);
      return ops.settleSlowTransfers(operatorIdOf(request), body.reason);
    });
    scoped.post('/api/ops/demo/missed-reversal', async (request) => {
      const body = parse(z.object({ transactionId: z.string().max(64), reason }), request.body);
      return ops.simulateMissedReversal(operatorIdOf(request), body.transactionId, body.reason);
    });
  });
}
