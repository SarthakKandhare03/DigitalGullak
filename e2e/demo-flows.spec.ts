import { expect, test, type Page } from '@playwright/test';

const shots = (page: Page, project: string) => async (name: string) => {
  await page.screenshot({ path: `e2e/.artifacts/${project}-${name}.png`, fullPage: true });
};

async function signIn(page: Page, phone: string) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/welcome/);
  await expect(page.getByText('Simulated money only.')).toBeVisible();
  await page.getByLabel('Mobile number').fill(phone);
  await page.getByRole('button', { name: 'Get demo code' }).click();
  const code = (await page.locator('.otp-demo__code').textContent())!.trim();
  expect(code).toMatch(/^\d{6}$/);
  await page.getByLabel(/6-digit code/).fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('main demo flows: sign in, goal, add, withdraw, schedule, activity, ops', async ({ page }, info) => {
  const shot = shots(page, info.project.name);
  const phone = info.project.name === 'mobile' ? '9000011111' : '9000022222';

  // 1. Sign in with the mock OTP
  await page.goto('/welcome');
  await shot('01-welcome');
  await signIn(page, phone);

  // 2. First-time choice (nothing preselected), start fresh
  await expect(page.getByRole('heading', { name: 'How would you like to start?' })).toBeVisible();
  await page.getByRole('button', { name: /Start fresh/ }).click();

  // 3. Create a goal
  await expect(page.getByRole('heading', { name: 'New goal' })).toBeVisible();
  await page.getByRole('button', { name: /Emergency fund/ }).click();
  await page.getByLabel('Target amount').fill('25,000');
  await shot('02-new-goal');
  await page.getByRole('button', { name: 'Create goal' }).click();
  await expect(page.getByRole('heading', { name: 'Emergency fund' })).toBeVisible();

  // 4. Add simulated savings: amount -> review -> pending -> confirmed
  await page.getByRole('link', { name: 'Add savings' }).click();
  await page.getByRole('button', { name: '₹500' }).click();
  await page.getByRole('button', { name: 'Review' }).click();
  await expect(page.getByText('This demo transaction does not move money')).toBeVisible();
  await expect(page.getByText('Five hundred rupees')).toBeVisible();
  await shot('03-review-deposit');
  await page.getByRole('button', { name: 'Confirm simulated deposit' }).click();
  await expect(page.getByRole('heading', { name: 'Waiting for confirmation' })).toBeVisible();
  await shot('04-pending');
  await expect(page.getByRole('heading', { name: 'Simulated deposit confirmed' })).toBeVisible({ timeout: 15_000 });
  await shot('05-confirmed');
  await page.getByRole('link', { name: 'Back to goal' }).click();
  await expect(page.locator('.goal-icon--lg + div').getByText('₹500', { exact: true })).toBeVisible();

  // 5. Withdraw simulated savings, with destination shown before confirming
  await page.getByRole('link', { name: 'Withdraw' }).click();
  await page.getByLabel('Amount in rupees').fill('200');
  await page.getByRole('button', { name: 'Review' }).click();
  await expect(page.getByText(/Your bank account ••\d{4} \(simulated\)/)).toBeVisible();
  await shot('06-review-withdraw');
  await page.getByRole('button', { name: 'Confirm simulated withdrawal' }).click();
  await expect(page.getByRole('heading', { name: 'Simulated withdrawal confirmed' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('link', { name: 'Back to goal' }).click();
  await expect(page.locator('.goal-icon--lg + div').getByText('₹300', { exact: true })).toBeVisible();

  // 6. Create a schedule (consent unchecked by default), then cancel it
  await page.getByRole('link', { name: 'Set up a schedule' }).click();
  await page.getByLabel('Amount each time').fill('100');
  await page.getByRole('radio', { name: /Weekly/ }).check();
  const consent = page.getByRole('checkbox');
  await expect(consent).not.toBeChecked();
  await page.getByRole('button', { name: 'Create simulated schedule' }).click();
  await expect(page.getByText('Please confirm you understand how this simulated schedule works.')).toBeVisible();
  await consent.check();
  await shot('07-new-schedule');
  await page.getByRole('button', { name: 'Create simulated schedule' }).click();
  await expect(page.getByRole('heading', { name: 'Savings schedules' })).toBeVisible();
  await expect(page.getByText('No automatic debit will occur in demo mode.')).toBeVisible();
  await expect(page.getByText(/₹100 every/)).toBeVisible();
  await shot('08-schedules');
  await page.getByRole('button', { name: 'Cancel schedule' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel schedule' }).click();
  await expect(page.getByText(/Cancelled the schedule for Emergency fund/)).toBeVisible();

  // 7. Activity shows contributions, withdrawals and schedule events with statuses
  await page.goto('/activity');
  await expect(page.getByText('Added to Emergency fund')).toBeVisible();
  await expect(page.getByText('Withdrew from Emergency fund')).toBeVisible();
  await expect(page.getByText('Schedule cancelled · Emergency fund')).toBeVisible();
  await expect(page.locator('.badge--completed').first()).toBeVisible();
  await shot('09-activity');

  // 8. Home dashboard reflects the simulated total
  await page.goto('/');
  await expect(page.locator('.hero__amount')).toHaveText('₹300');
  await shot('10-home');

  // 9. A declined transfer shows a failure and leaves the balance unchanged
  await page.goto('/add');
  await page.getByRole('link', { name: /Emergency fund/ }).click();
  await page.getByLabel('Amount in rupees').fill('50');
  await page.getByRole('button', { name: 'Review' }).click();
  await page.getByText('Demo testing options').click();
  await page.getByRole('radio', { name: /Declines/ }).check();
  await page.getByRole('button', { name: 'Confirm simulated deposit' }).click();
  await expect(page.getByRole('heading', { name: 'Not completed' })).toBeVisible({ timeout: 15_000 });
  await shot('11-failed');

  // 10. Operator console: reconciliation is clean
  if (info.project.name === 'desktop') {
    await page.goto('/ops');
    await page.getByLabel('Demo passcode').fill('e2e-operator-passcode');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'Run reconciliation' }).click();
    await expect(page.getByText(/Reconciliation finished: 0 finding/)).toBeVisible();
    await shot('12-ops');
  }
});

test('sample account and help are clearly labelled as simulated', async ({ page }, info) => {
  const shot = shots(page, info.project.name);
  await signIn(page, info.project.name === 'mobile' ? '9000033333' : '9000044444');
  await page.getByRole('button', { name: /Explore with example goals/ }).click();
  await expect(page.locator('.hero__amount')).toHaveText('₹21,350.50');
  await expect(page.locator('.hero').getByText('Simulated')).toBeVisible();
  await shot('13-home-sample');
  await page.goto('/help');
  await expect(page.getByText('Everything here is simulated.')).toBeVisible();
  await shot('14-help');
});

test('rewards: quiz, coin catch and points', async ({ page }, info) => {
  test.setTimeout(120_000);
  const shot = shots(page, info.project.name);
  await signIn(page, info.project.name === 'mobile' ? '9000055555' : '9000066666');
  await page.getByRole('button', { name: /Start fresh/ }).click();
  await page.getByRole('button', { name: /Emergency fund/ }).click();
  await page.getByLabel('Target amount').fill('10000');
  await page.getByRole('button', { name: 'Create goal' }).click();
  await expect(page.getByRole('heading', { name: 'Emergency fund' })).toBeVisible();

  // Home shows the chart and rewards teaser
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Savings over time/ })).toBeVisible();
  await shot('15-home-gold');

  // Rewards hub: creating a goal unlocked "Dream it"
  await page.goto('/rewards');
  await expect(page.getByRole('heading', { name: 'Weekly quests' })).toBeVisible();
  await expect(page.getByText('Unlocked · +50')).toBeVisible();
  await shot('16-rewards');

  // Money Quiz: answer every question, see graded results
  await page.goto('/rewards/quiz');
  for (let i = 0; i < 5; i++) {
    await page.locator('.quiz-option').first().click();
    await page.getByRole('button', { name: i < 4 ? /Next/ : /Submit answers/ }).click();
  }
  await expect(page.getByRole('heading', { name: /of 5 correct/ })).toBeVisible();
  await shot('17-quiz-result');

  // Coin Catch: a full 30-second round, verified by the server
  if (info.project.name === 'desktop') {
    await page.goto('/rewards/coin-catch');
    await page.getByRole('button', { name: 'Play' }).click();
    const stage = page.locator('.game-stage');
    await expect(page.locator('.game-hud .chip')).toHaveText(/\d+s/, { timeout: 10_000 });
    const box = (await stage.boundingBox())!;
    for (let i = 0; i < 30; i++) {
      await page.mouse.move(box.x + box.width * (0.2 + 0.6 * ((i % 6) / 5)), box.y + box.height / 2);
      await page.waitForTimeout(1000);
    }
    await shot('18-coin-catch-playing');
    await expect(page.getByRole('heading', { name: /Score: \d+/ })).toBeVisible({ timeout: 20_000 });
    await shot('19-coin-catch-done');
  }
});
