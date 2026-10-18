import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from './config';
import { openDatabase, type DB } from './db/db';
import { migrate } from './db/migrate';
import { systemClock, type Clock } from './lib/clock';
import { AppError, forbidden } from './lib/errors';
import type { ReconciliationOptions } from './ops/reconciliation';
import { MockBankProvider } from './providers/mock/mockBankProvider';
import { timerScheduler, type Scheduler } from './providers/mock/scheduler';
import { opsRoutes } from './routes/ops';
import { publicRoutes } from './routes/public';
import { userRoutes } from './routes/user';
import { createServices, type Services } from './services';

export interface BuildOptions {
  config: AppConfig;
  db?: DB;
  clock?: Clock;
  scheduler?: Scheduler;
  reconciliation?: ReconciliationOptions;
  serveWeb?: boolean;
}

export interface BuiltApp {
  app: FastifyInstance;
  services: Services;
  mock: MockBankProvider;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function buildApp(options: BuildOptions): Promise<BuiltApp> {
  const { config } = options;
  const clock = options.clock ?? systemClock;
  const db = options.db ?? openDatabase(config.databasePath);
  migrate(db);

  const app = Fastify({
    logger:
      config.logLevel === 'silent'
        ? false
        : {
            level: config.logLevel,
            // Never log auth secrets: cookies, signatures and OTP bodies are redacted / not logged.
            redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-mockbank-signature"]', 'res.headers["set-cookie"]'],
          },
    bodyLimit: 64 * 1024,
  });
  app.decorateRequest('userId', null);
  app.decorateRequest('operatorId', null);

  const scheduler = options.scheduler ?? timerScheduler((error) => app.log.error({ err: (error as Error).message }, 'scheduled task failed'));
  const mock = new MockBankProvider(db, {
    webhookSecret: config.mockWebhookSecret,
    settleMs: config.mockSettleMs,
    clock,
    scheduler,
    log: app.log,
  });
  const services = createServices({ db, config, clock, provider: mock, log: app.log, reconciliation: options.reconciliation });

  // The mock partner delivers its signed webhooks through the full Fastify
  // request pipeline (routing, raw-body capture, signature check) in-process.
  mock.setTransport(async (rawBody, headers) => {
    const response = await app.inject({ method: 'POST', url: `/api/provider/webhooks/${mock.id}`, payload: rawBody, headers });
    return response.statusCode;
  });

  // Keep the raw body for webhook signature verification.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    request.rawBody = text;
    if (text.trim() === '') return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new AppError(400, 'invalid_json', 'The request body is not valid JSON.'), undefined);
    }
  });

  await app.register(fastifyCookie);

  // CSRF defence in depth: SameSite=Strict cookies plus an Origin allow-list for state changes.
  app.addHook('onRequest', async (request) => {
    if (SAFE_METHODS.has(request.method) || !request.url.startsWith('/api/')) return;
    if (request.url.startsWith('/api/provider/webhooks/')) return;
    const origin = request.headers.origin;
    if (origin && !config.allowedOrigins.includes(origin)) throw forbidden('Request origin not allowed.');
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-Demo-Mode', 'simulated-money-only');
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.status).send({ error: { code: error.code, message: error.message, details: error.details } });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: 'bad_request', message: 'The request could not be processed.' } });
    }
    request.log.error({ err: { message: (error as Error).message, stack: (error as Error).stack } }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Something went wrong on our side. Nothing was changed.' } });
  });

  await app.register(publicRoutes, { services });
  await app.register(userRoutes, { services });
  await app.register(opsRoutes, { services });

  const serveWeb = options.serveWeb ?? true;
  if (serveWeb && existsSync(path.join(config.webDistDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: config.webDistDir, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.method !== 'GET') {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } });
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } }));
  }

  return { app, services, mock };
}
