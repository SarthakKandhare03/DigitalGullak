/**
 * Regenerates the README screenshots in docs/screenshots.
 * Run: README_SHOTS=1 npx playwright test readme-shots
 * Reduced motion is emulated so every capture is fully rendered (no mid-animation frames).
 */
import { expect, test, type Page } from '@playwright/test';
import { QUIZ_BANK } from '../server/src/rewards/quizBank';

test.skip(!process.env.README_SHOTS, 'Set README_SHOTS=1 to regenerate README screenshots');
test.use({ reducedMotion: 'reduce' });

const out = (name: string) => `docs/screenshots/${name}.png`;

async function signIn(page: Page, phone: string, choice: RegExp) {
  await page.goto('/welcome');
  await page.getByLabel('Mobile number').fill(phone);
  await page.getByRole('button', { name: 'Get demo code' }).click();
  const code = (await page.locator('.otp-demo__code').textContent())!.trim();
  await page.getByLabel(/6-digit code/).fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: choice }).click();
  await expect(page.locator('.hero__amount')).toBeVisible();
}

async function addSavings(page: Page, goalName: string, rupees: string) {
  await page.goto('/add');
  await page.getByRole('link', { name: new RegExp(goalName) }).click();
  await page.getByLabel('Amount in rupees').fill(rupees);
  await page.getByRole('button', { name: 'Review' }).click();
  await page.getByRole('button', { name: 'Confirm simulated deposit' }).click();
  await expect(page.getByRole('heading', { name: 'Simulated deposit confirmed' })).toBeVisible({ timeout: 15_000 });
}

async function aceQuiz(page: Page) {
  await page.goto('/rewards/quiz');
  for (let i = 0; i < 5; i++) {
    const prompt = (await page.locator('#q-title').textContent())!.trim();
    const q = QUIZ_BANK.find((x) => x.prompt === prompt)!;
    await page.getByRole('button', { name: q.options[q.answer]!, exact: false }).click();
    await page.getByRole('button', { name: i < 4 ? /Next/ : /Submit answers/ }).click();
  }
  await expect(page.getByRole('heading', { name: '5 of 5 correct' })).toBeVisible();
}

test('readme screenshots', async ({ page }, info) => {
  test.setTimeout(180_000);

  if (info.project.name === 'desktop') {
    await page.setViewportSize({ width: 1360, height: 860 });
    await page.goto('/welcome');
    await page.screenshot({ path: out('welcome') });

    await signIn(page, '9876501234', /Explore with example goals/);
    await page.goto('/goals/new');
    await page.getByLabel('Goal name').fill('New laptop');
    await page.getByRole('radio', { name: 'Laptop' }).check();
    await page.getByLabel('Target amount').fill('8000');
    await page.getByRole('button', { name: 'Create goal' }).click();
    await expect(page.getByRole('heading', { name: 'New laptop' })).toBeVisible();
    await addSavings(page, 'New laptop', '2500');
    await aceQuiz(page);

    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Savings over time/ })).toBeVisible();
    await page.waitForTimeout(600);
    await page.screenshot({ path: out('home-desktop'), fullPage: true });

    await page.goto('/rewards');
    await expect(page.getByRole('heading', { name: 'Achievements' })).toBeVisible();
    await page.waitForTimeout(600);
    await page.screenshot({ path: out('rewards'), fullPage: true });

    await page.goto('/rewards/coin-catch');
    await page.getByRole('button', { name: 'Play' }).click();
    await expect(page.locator('.game-hud .chip')).toHaveText(/\d+s/, { timeout: 10_000 });
    const stage = (await page.locator('.game-stage').boundingBox())!;
    for (let i = 0; i < 9; i++) {
      await page.mouse.move(stage.x + stage.width * (0.25 + 0.5 * ((i % 4) / 3)), stage.y + stage.height / 2);
      await page.waitForTimeout(1000);
    }
    await page.locator('.game-stage').screenshot({ path: out('coin-catch') });

    await page.goto('/ops');
    await page.getByLabel('Demo passcode').fill('e2e-operator-passcode');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('tab', { name: 'Transactions' }).click();
    await page.getByRole('button', { name: 'Simulate missed reversal' }).first().click();
    await page.getByLabel(/Reason/).fill('Rehearsing a lost partner webhook');
    await page.getByRole('dialog').getByRole('button', { name: 'Simulate reversal' }).click();
    await page.waitForTimeout(31_000); // past the reconciliation grace period for in-flight webhooks
    await page.getByRole('button', { name: 'Run reconciliation' }).click();
    await expect(page.getByText(/Reconciliation finished: [1-9]/)).toBeVisible();
    await page.getByRole('tab', { name: 'Exceptions' }).click();
    await expect(page.getByText('status_mismatch')).toBeVisible();
    await page.screenshot({ path: out('ops'), fullPage: true });
  }

  if (info.project.name === 'mobile') {
    await signIn(page, '9876505678', /Explore with example goals/);
    await page.waitForTimeout(400);
    await page.screenshot({ path: out('home-mobile') });

    await page.goto('/add');
    await page.getByRole('link', { name: /Emergency fund/ }).click();
    await page.getByRole('button', { name: '₹500' }).click();
    await page.getByRole('button', { name: 'Review' }).click();
    await expect(page.getByText('This demo transaction does not move money')).toBeVisible();
    await page.screenshot({ path: out('review-mobile') });

    await page.goto('/rewards/quiz');
    await page.locator('.quiz-option').nth(1).click();
    await page.screenshot({ path: out('quiz-mobile') });
  }
});
