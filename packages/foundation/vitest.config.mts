import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/packages/foundation',
  resolve: {
    // Match the workspace custom condition so package exports resolve to
    // source files during tests (see tsconfig.base.json customConditions).
    conditions: ['froglight'],
  },
  ssr: {
    resolve: {
      conditions: ['froglight'],
    },
  },
  test: {
    name: 'foundation',
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
