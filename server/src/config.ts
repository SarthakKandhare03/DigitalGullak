import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface AppConfig {
  env: 'development' | 'production' | 'test';
  port: number;
  host: string;
  allowedOrigins: string[];
  databasePath: string;
  /** Always true in this build: every balance and transaction is simulated. */
  demoMode: true;
  bankProvider: 'mock';
  authHmacSecret: string;
  operatorPasscode: string;
  mockWebhookSecret: string;
  mockSettleMs: number;
  cookieSecure: boolean;
  /** Trust X-Forwarded-* only when behind a known reverse proxy (affects client IPs for rate limits). */
  trustProxy: boolean;
  logLevel: string;
  webDistDir: string;
}

export class ConfigError extends Error {}

const PLACEHOLDER = /^replace-with/;

export function loadDotEnv(file = path.join(PROJECT_ROOT, '.env')): void {
  if (existsSync(file)) process.loadEnvFile(file);
}

function secret(env: NodeJS.ProcessEnv, name: string, mode: AppConfig['env']): string {
  const value = env[name];
  if (mode === 'test') return value || `test-${name.toLowerCase()}`;
  if (!value || PLACEHOLDER.test(value)) {
    throw new ConfigError(`${name} is missing or still a placeholder. Run "npm run setup" to generate demo secrets.`);
  }
  if (value.length < 12) throw new ConfigError(`${name} must be at least 12 characters.`);
  return value;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<AppConfig> = {}): AppConfig {
  const mode = (env.NODE_ENV === 'production' || env.NODE_ENV === 'test' ? env.NODE_ENV : 'development') as AppConfig['env'];

  // --- Simulated-money boundary. These checks are deliberately strict. ---
  if ((env.LIVE_MONEY_ENABLED ?? 'false') !== 'false') {
    throw new ConfigError(
      'LIVE_MONEY_ENABLED must be false. Live money needs a signed bank/authorised-provider agreement, ' +
        'a reviewed fund flow and a real provider implementation — none of which exist in this build.',
    );
  }
  if ((env.BANK_PROVIDER ?? 'mock') !== 'mock') {
    throw new ConfigError('BANK_PROVIDER must be "mock". No live partner provider is implemented.');
  }
  if ((env.DEMO_MODE ?? 'true') !== 'true') {
    throw new ConfigError('DEMO_MODE must be true while the mock provider is in use, so simulated balances are always labelled.');
  }

  const port = Number(env.PORT ?? 8787);
  const settle = Number(env.MOCK_PROVIDER_SETTLE_MS ?? 1800);
  const databasePath = env.DATABASE_PATH ?? './data/gullak.db';

  return {
    env: mode,
    port: Number.isInteger(port) ? port : 8787,
    host: env.HOST ?? '127.0.0.1',
    allowedOrigins: (env.APP_ORIGINS ?? 'http://localhost:5173,http://localhost:8787')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    databasePath: databasePath === ':memory:' ? databasePath : path.resolve(PROJECT_ROOT, databasePath),
    demoMode: true,
    bankProvider: 'mock',
    authHmacSecret: secret(env, 'AUTH_HMAC_SECRET', mode),
    operatorPasscode: secret(env, 'OPERATOR_PASSCODE', mode),
    mockWebhookSecret: secret(env, 'MOCK_PROVIDER_WEBHOOK_SECRET', mode),
    mockSettleMs: Number.isFinite(settle) && settle >= 0 ? settle : 1800,
    cookieSecure: env.COOKIE_SECURE === 'true',
    trustProxy: env.TRUST_PROXY === 'true',
    logLevel: env.LOG_LEVEL ?? (mode === 'test' ? 'silent' : 'info'),
    webDistDir: path.join(PROJECT_ROOT, 'web', 'dist'),
    ...overrides,
  };
}
