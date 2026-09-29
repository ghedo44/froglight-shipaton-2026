import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/packages/surface-default',
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
    name: 'surface-default',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
  },
}));
