/**
 * Server entry point.
 *
 * WEB_CONCURRENCY=1 (default): a single process serves traffic and runs background jobs.
 * WEB_CONCURRENCY=N or "auto": a primary process migrates the database once,
 * then forks N workers that share the port and the SQLite file (WAL mode).
 * Worker 0 is the leader and alone runs background jobs. Crashed workers are
 * restarted with back-off; shutdown drains in-flight requests first.
 */
import cluster from 'node:cluster';
import { buildApp } from './app';
import { ConfigError, loadDotEnv, readConfig, type AppConfig } from './config';
import { closeDatabase, openDatabase } from './db/db';
import { migrate } from './db/migrate';
import { BackgroundJobs } from './jobs';

function loadConfig(): AppConfig {
  loadDotEnv();
  try {
    return readConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\nConfiguration error: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

async function runServer(config: AppConfig, leader: boolean): Promise<void> {
  const { app, mock, services, setDraining } = await buildApp({ config });
  await app.listen({ port: config.port, host: config.host });

  const jobs = new BackgroundJobs(services, mock, config, app.log);
  if (leader) {
    await mock.resumeAfterRestart();
    jobs.start();
  }
  const worker = process.env.GULLAK_WORKER_INDEX ?? '0';
  app.log.info(
    `Digital Gullak API on http://${config.host}:${config.port} — worker ${worker}${leader ? ' (leader)' : ''} — DEMO MODE: simulated money only.`,
  );

  let stopping = false;
  const shutdown = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    app.log.info({ reason }, 'shutting down: draining in-flight requests');
    setDraining(true);
    jobs.stop();
    setTimeout(() => process.exit(1), 10_000).unref();
    await app.close();
    closeDatabase(services.db);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('message', (message: { type?: string } | undefined) => {
    if (message?.type === 'shutdown') void shutdown('primary');
  });
}

function runPrimary(config: AppConfig): void {
  // Migrate exactly once, before any worker starts, so workers never race on schema changes.
  const db = openDatabase(config.databasePath, { synchronous: config.dbSynchronous });
  migrate(db, (msg) => console.log(msg));
  closeDatabase(db);

  const indexOf = new Map<number, number>();
  const restarts: number[] = [];
  let shuttingDown = false;
  const fork = (index: number) => {
    const worker = cluster.fork({ GULLAK_WORKER_INDEX: String(index), GULLAK_LEADER: index === 0 ? '1' : '0' });
    indexOf.set(worker.id, index);
  };

  console.log(`Digital Gullak: starting ${config.workers} workers on port ${config.port}…`);
  for (let i = 0; i < config.workers; i++) fork(i);

  cluster.on('exit', (worker, code, signal) => {
    const index = indexOf.get(worker.id) ?? 0;
    indexOf.delete(worker.id);
    if (shuttingDown) {
      if (indexOf.size === 0) process.exit(0);
      return;
    }
    // Crash-loop guard: slow down if workers keep dying.
    const now = Date.now();
    restarts.push(now);
    while (restarts.length && restarts[0]! < now - 60_000) restarts.shift();
    const delay = restarts.length > 5 ? 5_000 : 500;
    console.error(`worker ${index} exited (${signal ?? code}); restarting in ${delay}ms`);
    setTimeout(() => fork(index), delay);
  });

  const stop = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const worker of Object.values(cluster.workers ?? {})) worker?.send({ type: 'shutdown' });
    setTimeout(() => process.exit(0), 12_000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

const config = loadConfig();
if (cluster.isPrimary && config.workers > 1) runPrimary(config);
else void runServer(config, cluster.isPrimary || process.env.GULLAK_LEADER === '1');
