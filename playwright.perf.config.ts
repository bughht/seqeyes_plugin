import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/performance',
  testMatch: /browser-performance\.spec\.ts/,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/performance' }]]
    : [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command: 'node test/browser/serve-web.cjs',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
