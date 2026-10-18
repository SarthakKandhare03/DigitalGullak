// Starts the production server on a fresh E2E database.
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

const db = process.env.DATABASE_PATH ?? './data/e2e.db';
for (const suffix of ['', '-wal', '-shm']) if (existsSync(db + suffix)) rmSync(db + suffix);

const child = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], { stdio: 'inherit', env: process.env });
const stop = () => child.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
