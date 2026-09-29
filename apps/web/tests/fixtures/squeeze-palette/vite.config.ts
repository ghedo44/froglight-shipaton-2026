import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Chromium harness config (build tooling only): bundles the
// squeeze-palette fixture (real overlay source + real CSS modules) for the
// headless-Chromium dismissal proof. Invoked by the Playwright spec through
// the vite CLI; never imported by app source. Uses esbuild automatic JSX
// (no babel) so the fixture build stays a fast hermetic step.
//
// The overlay is intentionally internal to `@froglight/ui` (no package
// export); the harness reaches the real source through this fixture-local
// alias so the proof tracks the tree instead of a stale bundle. The
// `@froglight/ui/src/*` specifier shape keeps cross-project imports
// scope-prefixed per the module-boundary rule.
const uiSrc = fileURLToPath(
  new URL('../../../../../packages/ui/src', import.meta.url),
);

export default defineConfig({
  resolve: {
    conditions: ['froglight'],
    alias: [{ find: '@froglight/ui/src', replacement: uiSrc }],
  },
  esbuild: { jsx: 'automatic' },
  build: {
    outDir: 'dist-t2',
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
  },
  logLevel: 'silent',
});
