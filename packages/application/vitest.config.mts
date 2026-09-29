import { defineConfig } from 'vitest/config';
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/packages/application',
  resolve: { conditions: ['froglight'] },
  ssr: { resolve: { conditions: ['froglight'] } },
  test: {
    name: 'application',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
  },
}));
