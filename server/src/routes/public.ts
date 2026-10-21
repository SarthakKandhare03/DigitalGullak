import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MAX_SCHEDULE_PAISE, MAX_TARGET_PAISE, MAX_TRANSFER_PAISE, MIN_TRANSFER_PAISE } from '../../../shared/money';
import type { PublicConfigDTO } from '../../../shared/types';
import { clearSessionCookie, cookieNames, parse, setSessionCookie } from '../lib/http';
import { WebhookVerificationError } from '../providers/types';
import type { Services } from '../services';

export async function publicRoutes(app: FastifyInstance, { services }: { services: Services }) {
  const { auth, config, provider, events, securityEvents } = services;
  const cookies = cookieNames(config.cookieSecure);

  app.get('/api/config', async (): Promise<PublicConfigDTO> => ({
    demoMode: true,
    liveMoneyEnabled: false,
    provider: { id: provider.id, displayName: provider.displayName, simulated: provider.isSimulated },
    limits: {
      minTransferPaise: MIN_TRANSFER_PAISE,
      maxTransferPaise: MAX_TRANSFER_PAISE,
      maxSchedulePaise: MAX_SCHEDULE_PAISE,
      maxTargetPaise: MAX_TARGET_PAISE,
    },
  }));

  app.post('/api/auth/otp/request', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    const body = parse(z.object({ phone: z.string().max(20) }).strict(), request.body);
    const challenge = auth.requestOtp(body.phone);
    return {
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt,
      phoneLast4: challenge.phoneLast4,
      // Present only because DEMO_MODE is enforced on. A live build would send the code via an approved SMS provider.
      demoOtp: challenge.demoOtp,
      demoNotice: 'Demo mode: no SMS was sent. Use the code shown on screen.',
    };
  });

  app.post('/api/auth/otp/verify', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = parse(z.object({ challengeId: z.string().max(100), code: z.string().max(10) }).strict(), request.body);
    const result = await auth.verifyOtp(body.challengeId, body.code.trim(), request.ip);
    setSessionCookie(reply, cookies.user, result.token, config.cookieSecure, 7 * 24 * 60 * 60);
    return { user: result.user, isNew: result.isNew };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    auth.revokeSession(request.cookies[cookies.user]);
    clearSessionCookie(reply, cookies.user, config.cookieSecure);
    return { ok: true };
  });

  /**
   * Partner webhooks. Authenticated by signature (not cookies). The raw body
   * is verified before anything is stored; duplicates and stale events are
   * acknowledged with 200 so the partner stops retrying.
   */
  app.post('/api/provider/webhooks/:providerId', async (request, reply) => {
    const { providerId } = request.params as { providerId: string };
    if (providerId !== provider.id) return reply.code(404).send({ error: { code: 'not_found', message: 'Unknown provider.' } });
    let event;
    try {
      event = provider.verifyAndParseWebhook(request.rawBody ?? '', request.headers);
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        securityEvents.recordThrottled('webhook_rejected', securityEvents.subjectForIp(request.ip), error.message, 5_000);
        request.log.warn({ reason: error.message }, 'rejected partner webhook');
        return reply.code(401).send({ error: { code: 'invalid_signature', message: 'Webhook verification failed.' } });
      }
      throw error;
    }
    const outcome = events.process(event, request.rawBody ?? '');
    return { received: true, outcome };
  });
}
