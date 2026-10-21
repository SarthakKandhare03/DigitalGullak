import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { AppConfig } from './config';
import zlib from 'node:zlib';
import { one, openDatabase, type DB } from './db/db';
import { migrate } from './db/migrate';
import { systemClock, type Clock } from './lib/clock';
import { AppError, forbidden } from './lib/errors';
import { cookieNames } from './lib/http';
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
  /** Marks the instance as draining so load balancers stop routing to it before shutdown. */
  setDraining: (draining: boolean) => void;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** No inline scripts, no third-party origins, no framing. Inline style attributes are needed by React style props. */
function contentSecurityPolicy(secure: boolean): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
    ...(secure ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

export async function buildApp(options: BuildOptions): Promise<BuiltApp> {
  const { config } = options;
  const clock = options.clock ?? systemClock;
  const db = options.db ?? openDatabase(config.databasePath, { synchronous: config.dbSynchronous });
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
    trustProxy: config.trustProxy,
    genReqId: () => randomUUID(),
    // One log line per request (see onResponse below) instead of two.
    logController: new LogController({ disableRequestLogging: true }),
    // Slow-client (slowloris) protection; keep-alive outlives typical load-balancer idle timeouts.
    connectionTimeout: 30_000,
    requestTimeout: 30_000,
    keepAliveTimeout: 65_000,
  });
  app.server.headersTimeout = 20_000;
  app.decorateRequest('userId', null);
  app.decorateRequest('operatorId', null);
  const state = { draining: false };
  const CSP = contentSecurityPolicy(config.cookieSecure);
  const cookies = cookieNames(config.cookieSecure);

  const scheduler = options.scheduler ?? timerScheduler((error) => app.log.error({ err: (error as Error).message }, 'scheduled task failed'));
  const mock = new MockBankProvider(db, {
    webhookSecret: config.mockWebhookSecret,
    previousWebhookSecret: config.mockWebhookSecretPrevious,
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

  // API compression: synchronous gzip (level 6) on serialised JSON. For these
  // small payloads it is ~3.5x cheaper than Brotli at almost the same size, and
  // far cheaper than a zlib stream per response. Static assets are compressed
  // once at build time (Brotli + gzip) and served pre-compressed instead.
  app.addHook('onSend', async (request, reply, payload) => {
    if (!request.url.startsWith('/api/') || reply.hasHeader('content-encoding')) return payload;
    if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) return payload;
    if (Buffer.byteLength(payload) < 1024) return payload;
    reply.header('Vary', 'Accept-Encoding');
    if (!/\bgzip\b/.test(String(request.headers['accept-encoding'] ?? ''))) return payload;
    reply.header('Content-Encoding', 'gzip');
    reply.removeHeader('content-length');
    return zlib.gzipSync(payload, { level: 6 });
  });

  // Rate limits: signed-in users are limited per account, everyone else per IP.
  // Per-account keys matter in India, where carrier-grade NAT puts thousands of
  // mobile users behind one IP. Signed partner webhooks are exempt (a live
  // partner would also be IP allow-listed or use mTLS).
  const { securityEvents } = services;
  await app.register(fastifyRateLimit, {
    global: true,
    max: config.rateLimitPerMinute,
    timeWindow: '1 minute',
    allowList: (request) => request.url.startsWith('/api/provider/webhooks/'),
    keyGenerator: (request) => {
      if (!request.url.startsWith('/api/')) return `ip:${request.ip}`;
      const userId = services.auth.resolveSession(request.cookies?.[cookies.user], 'user');
      request.sessionUserId = userId;
      return userId ? `user:${userId}` : `ip:${request.ip}`;
    },
    onExceeded: (request, key) => {
      securityEvents.recordThrottled('rate_limited', key.startsWith('ip:') ? securityEvents.subjectForIp(request.ip) : key, request.routeOptions.url);
    },
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: { code: 'rate_limited', message: `Too many requests. Please wait ${Math.ceil(context.ttl / 1000)} seconds and try again.` },
    }),
  });

  // CSRF defence in depth: SameSite=Strict cookies, JSON-only bodies, an Origin
  // allow-list, and Fetch Metadata (browsers label cross-site requests).
  app.addHook('onRequest', async (request) => {
    if (SAFE_METHODS.has(request.method) || !request.url.startsWith('/api/')) return;
    if (request.url.startsWith('/api/provider/webhooks/')) return;
    const origin = request.headers.origin;
    const blocked = origin && !config.allowedOrigins.includes(origin) ? 'origin' : request.headers['sec-fetch-site'] === 'cross-site' ? 'cross-site' : null;
    if (blocked) {
      securityEvents.recordThrottled('csrf_blocked', securityEvents.subjectForIp(request.ip), blocked);
      throw forbidden(blocked === 'origin' ? 'Request origin not allowed.' : 'Cross-site requests are not allowed.');
    }
  });

  app.addHook('onResponse', async (request, reply) => {
    // Route patterns (not raw URLs) keep IDs and query strings out of the logs.
    request.log.info(
      { method: request.method, route: request.routeOptions.url ?? 'unmatched', status: reply.statusCode, ms: Math.round(reply.elapsedTime) },
      'request',
    );
  });

  // Liveness (process is up) and readiness (database reachable, not draining).
  app.get('/api/health', { config: { rateLimit: false } }, async () => ({ ok: true, demoMode: true }));
  app.get('/api/health/ready', { config: { rateLimit: false } }, async (_request, reply) => {
    if (state.draining) return reply.code(503).send({ ready: false, reason: 'draining' });
    one(db, 'SELECT 1 AS ok');
    return { ready: true };
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', CSP);
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    if (config.cookieSecure) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    reply.header('X-Request-Id', request.id);
    reply.header('X-Demo-Mode', 'simulated-money-only');
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.status).send({ error: { code: error.code, message: error.message, details: error.details } });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 429) {
      const body = (error as { error?: { code: string; message: string } }).error;
      return reply.code(429).send({ error: body ?? { code: 'rate_limited', message: 'Too many requests. Please wait and try again.' } });
    }
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
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      wildcard: false,
      // Serves the .br / .gz files written by scripts/precompress.mjs at build time.
      preCompressed: true,
      // Hashed build assets never change, so browsers may cache them for a year; the HTML shell always revalidates.
      setHeaders: (res, filePath) => {
        res.header('Cache-Control', /[\\/]assets[\\/]/.test(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.method !== 'GET') {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } });
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } }));
  }

  return { app, services, mock, setDraining: (draining) => (state.draining = draining) };
}
