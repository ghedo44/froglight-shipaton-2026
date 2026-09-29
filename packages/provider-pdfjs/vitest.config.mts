import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/packages/provider-pdfjs',
  resolve: { conditions: ['froglight'] },
  ssr: { resolve: { conditions: ['froglight'] } },
  test: {
    name: 'provider-pdfjs',
    watch: false,
    environment: 'node',
    include: ['src/**/*.spec.{ts,tsx}'],
    reporters: ['default'],
    css: true,
  },
}));
