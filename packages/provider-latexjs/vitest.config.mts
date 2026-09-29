import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/packages/provider-latexjs',
  resolve: { conditions: ['froglight'] },
  ssr: { resolve: { conditions: ['froglight'] } },
  test: {
    name: 'provider-latexjs',
    watch: false,
    environment: 'jsdom',
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
  },
}));
