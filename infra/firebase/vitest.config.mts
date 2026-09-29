import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: 'firebase-rules',
    watch: false,
    globals: false,
    environment: 'node',
    include: ['tests/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}'],
    testTimeout: 30000,
    hookTimeout: 60000,
    reporters: ['default'],
    // One emulator project serves the whole suite: spec files must not run
    // in parallel workers against it (rules reloads and clearStorage race).
    pool: 'forks',
    forks: { singleFork: true },
  },
});
