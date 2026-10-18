import { buildApp } from './app';
import { ConfigError, loadDotEnv, readConfig } from './config';

async function main() {
  loadDotEnv();
  let config;
  try {
    config = readConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\nConfiguration error: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const { app, mock } = await buildApp({ config });
  await app.listen({ port: config.port, host: config.host });
  await mock.resumeAfterRestart();
  app.log.info(
    `Digital Gullak API on http://${config.host}:${config.port} — DEMO MODE: simulated money only, provider "${mock.displayName}".`,
  );

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
