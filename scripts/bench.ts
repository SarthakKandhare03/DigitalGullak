/**
 * Load benchmark: seeds users into a fresh database, starts the production
 * server in a child process and measures the hottest endpoints with autocannon.
 *
 *   npm run bench                         # 1 worker
 *   WEB_CONCURRENCY=4 npm run bench       # cluster mode
 *   BENCH_SECONDS=20 BENCH_CONNECTIONS=100 npm run bench -- --out docs/benchmarks/run.json
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import autocannon from 'autocannon';
import { buildApp } from '../server/src/app';
import { PROJECT_ROOT, loadDotEnv, readConfig } from '../server/src/config';
import { ManualScheduler } from '../server/src/providers/mock/scheduler';

const PORT = Number(process.env.BENCH_PORT ?? 8790);
const BASE = `http://127.0.0.1:${PORT}`;
const SECONDS = Number(process.env.BENCH_SECONDS ?? 10);
const CONNECTIONS = Number(process.env.BENCH_CONNECTIONS ?? 50);
const USERS = Number(process.env.BENCH_USERS ?? 25);
const DB_PATH = path.join(PROJECT_ROOT, 'data', 'bench.db');
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;

interface BenchUser {
  cookie: string;
  goalId: string;
}

async function seedUsers(): Promise<BenchUser[]> {
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(DB_PATH + suffix)) rmSync(DB_PATH + suffix);
  const config = readConfig({ ...process.env, DATABASE_PATH: DB_PATH, LOG_LEVEL: 'silent' });
  const { services, app } = await buildApp({ config, scheduler: new ManualScheduler(), serveWeb: false });
  const users: BenchUser[] = [];
  for (let i = 0; i < USERS; i++) {
    const phone = `9${String(100000000 + i).padStart(9, '0')}`;
    const challenge = services.auth.requestOtp(phone);
    const { user, token } = await services.auth.verifyOtp(challenge.challengeId, challenge.demoOtp);
    await services.account.completeOnboarding(user.id, 'examples');
    const goal = services.goals.list(user.id)[0]!;
    users.push({ cookie: `gullak_session=${token}`, goalId: goal.id });
  }
  await app.close();
  services.db.close();
  return users;
}

function startServer(): Promise<() => Promise<void>> {
  const child = spawn(process.execPath, [...(process.env.BENCH_NODE_ARGS?.split(' ').filter(Boolean) ?? []), '--import', 'tsx', process.env.BENCH_ENTRY ?? 'server/src/index.ts'], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT),
      DATABASE_PATH: DB_PATH,
      LOG_LEVEL: 'warn',
      RATE_LIMIT_PER_MINUTE: '100000000',
      MOCK_PROVIDER_SETTLE_MS: '200',
      RECONCILE_INTERVAL_MINUTES: '0',
    },
  });
  const stop = () =>
    new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      // Graceful IPC shutdown (Windows has no real SIGTERM): drains requests and lets --cpu-prof flush.
      child.send({ type: 'shutdown' });
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    });
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000;
    const poll = async () => {
      try {
        const res = await fetch(`${BASE}/api/health/ready`);
        if (res.ok) return resolve(stop);
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) return reject(new Error('server did not become ready'));
      setTimeout(poll, 250);
    };
    child.once('exit', (code) => reject(new Error(`server exited early (${code})`)));
    void poll();
  });
}

interface Scenario {
  name: string;
  method: 'GET' | 'POST';
  path: (u: BenchUser) => string;
  body?: () => string;
  idempotent?: boolean;
}

const ALL_SCENARIOS: Scenario[] = [
  { name: 'GET /api/health', method: 'GET', path: () => '/api/health' },
  { name: 'GET /api/dashboard', method: 'GET', path: () => '/api/dashboard' },
  { name: 'GET /api/rewards', method: 'GET', path: () => '/api/rewards' },
  { name: 'GET /api/activity', method: 'GET', path: () => '/api/activity?limit=20' },
  {
    name: 'POST contribution (write)',
    method: 'POST',
    path: (u) => `/api/goals/${u.goalId}/contributions`,
    body: () => JSON.stringify({ amountPaise: 100_00 }),
    idempotent: true,
  },
];

// BENCH_ONLY=dashboard,rewards runs a subset.
const SCENARIOS = process.env.BENCH_ONLY
  ? ALL_SCENARIOS.filter((s) => process.env.BENCH_ONLY!.split(',').some((k) => s.name.toLowerCase().includes(k)))
  : ALL_SCENARIOS;

async function runScenario(s: Scenario, users: BenchUser[]) {
  let n = 0;
  const result = await autocannon({
    url: BASE,
    connections: CONNECTIONS,
    duration: SECONDS,
    requests: [
      {
        method: s.method,
        setupRequest: (req: Record<string, unknown>) => {
          const u = users[n++ % users.length]!;
          // Browsers always ask for compression, so the benchmark does too.
          const headers: Record<string, string> = { cookie: u.cookie };
          if (!process.env.BENCH_NO_COMPRESSION) headers['accept-encoding'] = 'br, gzip';
          if (s.body) headers['content-type'] = 'application/json';
          if (s.idempotent) headers['idempotency-key'] = randomUUID();
          return { ...req, path: s.path(u), headers, body: s.body?.() };
        },
      },
    ],
  });
  return {
    scenario: s.name,
    reqPerSec: Math.round(result.requests.average),
    p50ms: result.latency.p50,
    p99ms: result.latency.p99,
    total: result.requests.total,
    non2xx: result.non2xx,
    errors: result.errors + result.timeouts,
  };
}

async function main() {
  loadDotEnv();
  console.log(`Seeding ${USERS} users…`);
  const users = await seedUsers();
  const workers = process.env.WEB_CONCURRENCY ?? '1';
  console.log(`Starting server (WEB_CONCURRENCY=${workers})…`);
  const stop = await startServer();
  const rows = [];
  try {
    for (const s of SCENARIOS) {
      console.log(`→ ${s.name} (${SECONDS}s, ${CONNECTIONS} connections)`);
      rows.push(await runScenario(s, users));
    }
  } finally {
    await stop();
  }
  console.table(rows);
  if (out) {
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), workers, seconds: SECONDS, connections: CONNECTIONS, rows }, null, 2));
    console.log(`Saved ${out}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
