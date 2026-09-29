import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5198',
    trace: 'on-first-retry',
  },
  webServer: {
    command:
      'pnpm --filter @froglight/web preview --host 127.0.0.1 --port 5198 --strictPort',
    url: 'http://127.0.0.1:5198/',
    // An acceptance run must own its production preview. Probing an absent
    // loopback listener can be black-holed by host firewalls, and reusing a
    // stray server could certify assets from a different checkout.
    reuseExistingServer: process.env.PW_REUSE_SERVER === '1',
    timeout: 120000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
