import { defineConfig, devices } from '@playwright/test';

const PORT = 8788;
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * End-to-end check of the main demo flows against the production build.
 * Uses an installed browser (Edge by default on Windows; set E2E_CHANNEL=chrome
 * or run `npx playwright install chromium` and E2E_CHANNEL= to use bundled Chromium).
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: BASE,
    channel: process.env.E2E_CHANNEL ?? 'msedge',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'mobile', use: { ...devices['Pixel 7'], channel: process.env.E2E_CHANNEL ?? 'msedge' } },
    { name: 'desktop', use: { viewport: { width: 1280, height: 860 } } },
  ],
  webServer: {
    command: 'node e2e/start-server.mjs',
    url: `${BASE}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      DATABASE_PATH: './data/e2e.db',
      APP_ORIGINS: BASE,
      MOCK_PROVIDER_SETTLE_MS: '900',
      LOG_LEVEL: 'warn',
      OPERATOR_PASSCODE: 'e2e-operator-passcode',
    },
  },
});
