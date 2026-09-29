import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/web',
  resolve: {
    conditions: ['froglight'],
  },
  ssr: {
    resolve: {
      conditions: ['froglight'],
    },
  },
  test: {
    name: 'web',
    watch: false,
    globals: true,
    environment: 'node',
    // Playwright specs live in tests/ and run via `test:e2e`, never vitest.
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
  },
}));
