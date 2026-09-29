import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/packages/runtime',
  resolve: {
    // Match the workspace custom condition so package exports resolve to
    // source files during tests (see tsconfig.base.json customConditions).
    conditions: ['froglight'],
  },
  ssr: {
    resolve: {
      // Vitest 4 (Vite >= 6) reads conditions from ssr.resolve for worker
      // module resolution; without this the workspace exports condition is
      // not applied and @froglight/runtime cannot be resolved.
      conditions: ['froglight'],
    },
  },
  test: {
    name: 'runtime',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
