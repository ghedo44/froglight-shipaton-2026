import { defineConfig, devices } from '@playwright/test';

// Browser geometry gate for the toolbar shell.
// Uses `setContent` harnesses with real production stylesheets — no preview
// server needed. CI runs the full `test:e2e` (default config, preview
// server) which includes `tests/toolbar-geometry.spec.ts`; this config is
// for fast local iteration without building/serving the PWA.
export default defineConfig({
  testDir: './tests',
  testMatch: 'toolbar-geometry.spec.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
