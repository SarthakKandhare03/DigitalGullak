// One-time setup: creates .env with random demo secrets, then migrates and seeds the database.
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Node ${process.versions.node} is too old. Digital Gullak needs Node 22.13+ (built-in node:sqlite).`);
  process.exit(1);
}

if (!existsSync('.env')) {
  const secret = () => randomBytes(32).toString('base64url');
  const env = readFileSync('.env.example', 'utf8')
    .replace('AUTH_HMAC_SECRET=replace-with-a-long-random-string', `AUTH_HMAC_SECRET=${secret()}`)
    .replace('MOCK_PROVIDER_WEBHOOK_SECRET=replace-with-a-long-random-string', `MOCK_PROVIDER_WEBHOOK_SECRET=${secret()}`)
    .replace('OPERATOR_PASSCODE=replace-with-a-demo-operator-passcode', 'OPERATOR_PASSCODE=gullak-ops-demo');
  writeFileSync('.env', env);
  console.log('Created .env with random demo secrets (operator passcode: gullak-ops-demo).');
} else {
  console.log('.env already exists — leaving it unchanged.');
}

execSync('npm run db:migrate', { stdio: 'inherit' });
execSync('npm run db:seed', { stdio: 'inherit' });
console.log('\nSetup complete. Run "npm run dev" and open http://localhost:5173');
