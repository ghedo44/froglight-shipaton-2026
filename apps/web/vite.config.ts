import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA, type ManifestOptions } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';
import { pwaManifest } from './src/pwa-manifest.js';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [
        'favicon.svg',
        'favicon.ico',
        'apple-touch-icon.png',
        'icons/*.png',
      ],
      manifest: { ...pwaManifest } as ManifestOptions,
      workbox: {
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,woff2,wasm}'],
        // The LaTeX provider bundle (latexjs + vendored CSS) pushes the main
        // chunk past 3 MiB; offline startup requires it to be precached.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        // Vault bytes stay in OPFS — never precached
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/cdn\./,
            handler: 'CacheFirst',
            options: { cacheName: 'cdn-cache' },
          },
        ],
      },
      // Serve the real manifest + SW in dev too; without this the
      // /manifest.webmanifest request falls through to index.html and the
      // browser reports a manifest syntax error.
      devOptions: { enabled: true },
    }),
  ],
  resolve: { conditions: ['froglight'] },
  build: {
    rollupOptions: {
      // Production app + the real-Canvas release benchmark page
      // (apps/web/tests/ink-release-bench.spec.ts drives it in Chromium).
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        bench: fileURLToPath(new URL('./bench/index.html', import.meta.url)),
        databaseBench: fileURLToPath(
          new URL('./bench/database.html', import.meta.url),
        ),
        databasePluginLifecycle: fileURLToPath(
          new URL('./bench/database-plugin-lifecycle.html', import.meta.url),
        ),
      },
    },
  },
  optimizeDeps: {
    // latex.js ships .keep placeholders inside its dynamic-require package
    // directories; esbuild needs an explicit empty loader for them.
    esbuildOptions: { loader: { '.keep': 'empty' } },
  },
  ssr: { resolve: { conditions: ['froglight'] } },
  server: { port: 5173 },
});
