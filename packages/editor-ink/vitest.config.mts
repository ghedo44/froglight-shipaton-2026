import { defineConfig } from 'vitest/config';
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/packages/editor-ink',
  resolve: { conditions: ['froglight'] },
  ssr: { resolve: { conditions: ['froglight'] } },
  test: {
    name: 'editor-ink',
    watch: false,
    globals: true,
    environment: 'jsdom',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    css: true,
  },
}));
