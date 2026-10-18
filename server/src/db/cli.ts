/**
 * Database CLI: `migrate`, `seed`, `reset`.
 * Seeding creates two demo users with simulated sample data:
 *   Asha  — 98765 43210 (example goals, schedules, history)
 *   Ravi  — 91234 56780 (empty, for ownership checks)
 */
import { existsSync, rmSync } from 'node:fs';
import { buildApp } from '../app';
import { loadDotEnv, readConfig } from '../config';
import { ManualScheduler } from '../providers/mock/scheduler';
import { one } from './db';
import { migrate } from './migrate';
import { openDatabase } from './db';

async function seed() {
  const config = readConfig();
  const { services, app } = await buildApp({ config, scheduler: new ManualScheduler(), serveWeb: false });
  const { auth, account, db } = services;

  const users = [
    { phone: '9876543210', name: 'Asha', examples: true },
    { phone: '9123456780', name: 'Ravi', examples: false },
  ];
  for (const u of users) {
    const existing = one<{ id: string }>(db, `SELECT id FROM users WHERE phone_last4 = ? AND display_name = ? AND status = 'active'`, u.phone.slice(-4), u.name);
    if (existing) {
      console.log(`- ${u.name} already exists, skipping`);
      continue;
    }
    const challenge = auth.requestOtp(u.phone);
    const { user } = await auth.verifyOtp(challenge.challengeId, challenge.demoOtp);
    account.updateProfile(user.id, u.name);
    await account.completeOnboarding(user.id, u.examples ? 'examples' : 'empty');
    console.log(`- created demo user ${u.name} (mobile ${u.phone}${u.examples ? ', with simulated sample data' : ''})`);
  }
  await services.recon.run('seed');
  await app.close();
}

async function main() {
  loadDotEnv();
  const command = process.argv[2];
  const config = readConfig();
  if (command === 'migrate') {
    const db = openDatabase(config.databasePath);
    const applied = migrate(db, console.log);
    console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.');
    db.close();
  } else if (command === 'seed') {
    await seed();
    console.log('Seed complete. All seeded balances are simulated.');
  } else if (command === 'reset') {
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${config.databasePath}${suffix}`;
      if (existsSync(file)) rmSync(file);
    }
    console.log(`Deleted ${config.databasePath}. Recreating…`);
    const db = openDatabase(config.databasePath);
    migrate(db, console.log);
    db.close();
    await seed();
    console.log('Reset complete.');
  } else {
    console.log('Usage: tsx server/src/db/cli.ts <migrate|seed|reset>');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
