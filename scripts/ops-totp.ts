/**
 * Operator MFA helper.
 *   npm run ops:totp            → generate a new TOTP secret and an otpauth:// link for an authenticator app
 *   npm run ops:totp -- --code  → print the current code for OPERATOR_TOTP_SECRET (demo/testing convenience only)
 */
import { loadDotEnv } from '../server/src/config';
import { generateTotpSecret, otpauthUri, totpCode, totpStep } from '../server/src/lib/totp';

loadDotEnv();

if (process.argv.includes('--code')) {
  const secret = process.env.OPERATOR_TOTP_SECRET;
  if (!secret) {
    console.error('OPERATOR_TOTP_SECRET is not set in .env.');
    process.exit(1);
  }
  const now = new Date();
  const remaining = 30 - (Math.floor(now.getTime() / 1000) % 30);
  console.log(`Current operator code: ${totpCode(secret, totpStep(now))} (valid ~${remaining}s). Demo convenience only — real staff use an authenticator app.`);
} else {
  const secret = generateTotpSecret();
  console.log('\nNew operator TOTP secret generated.\n');
  console.log('1) Add this line to .env (then restart the server):');
  console.log(`   OPERATOR_TOTP_SECRET=${secret}\n`);
  console.log('2) Add it to an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…):');
  console.log(`   ${otpauthUri(secret, 'operator')}\n`);
  console.log('Operator sign-in will then ask for the 6-digit code as well as the passcode.');
}
