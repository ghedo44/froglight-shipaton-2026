import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: host || false,
    port: 5174,
    strictPort: true,
    // Tauri regenerates files under src-tauri/ during Android builds; watching
    // them reloads the page mid-build (tauri-apps/tauri#12141).
    watch: {
      ignored: ['**/src-tauri/**'],
    },
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 5174,
        }
      : undefined,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  resolve: { conditions: ['froglight'] },
  optimizeDeps: {
    // latex.js ships .keep placeholders inside its dynamic-require package
    // directories; esbuild needs an explicit empty loader for them.
    esbuildOptions: { loader: { '.keep': 'empty' } },
  },
  ssr: { resolve: { conditions: ['froglight'] } },
  build: { target: 'esnext', rollupOptions: { external: [/^node:.*/] } },
});
