/**
 * Built-package CSS gate (sequencing gate).
 *
 * Proves a consumer using ONLY built `dist/` output receives the same
 * component styles as the source/Vite workspace build:
 *
 * 1. Runs the CSS asset copy (`copy-package-css.mjs`) — the pipeline step
 *    the TypeScript build alone does not perform.
 * 2. Asserts every required colocated stylesheet exists in `dist/`.
 * 3. Scaffolds a minimal Vite consumer that imports React components from
 *    the `dist/` entries (never `src/`), plus the shipped layer-order
 *    source exactly once.
 * 4. Builds it with Vite and asserts the production CSS bundle carries the
 *    component hooks and the canonical layer declaration.
 * 5. Asserts the production bundle emits the KaTeX `KaTeX_*.woff2` font
 *    assets (pulled in through the `dist/` math preview path) and that the
 *  bundled CSS references resolve to those emitted files.
 *
 * Usage: `node scripts/verify-dist-css-consumer.mjs [--keep]`
 * Exit non-zero with a diagnostic on the first missing asset or hook.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyPackageCss, STYLED_PACKAGES } from './copy-package-css.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');

const fail = (message) => {
  console.error(`verify-dist-css-consumer: FAIL: ${message}`);
  process.exit(1);
};

/** [package dir, dist-relative css, description] */
const REQUIRED_CSS = [
  ['packages/ui', 'react/Button.module.css', 'ui button module'],
  ['packages/ui', 'react/WorkspaceView.module.css', 'ui workspace module'],
  [
    'packages/ui',
    'react/MarkdownReaderView.module.css',
    'ui markdown reader module',
  ],
  ['packages/ui', 'styles/layers.css', 'canonical layer order source'],
  [
    'packages/editor-ink',
    'react/InkSurfaceSkeleton.css',
    'ink skeleton stylesheet',
  ],
  [
    'packages/editor-notebook',
    'react/NotebookChrome.css',
    'notebook chrome stylesheet',
  ],
  [
    'packages/editor-blockpage',
    'react/BlockpageHost.module.css',
    'blockpage host module',
  ],
  [
    'packages/editor-blockpage',
    'styles/prose-mirror.css',
    'blockpage provider stylesheet',
  ],
  [
    'packages/editor-codemirror',
    'react/CodemirrorHost.module.css',
    'codemirror host module',
  ],
  [
    'packages/editor-codemirror',
    'react/LatexEditorSkeleton.css',
    'latex editor skeleton stylesheet',
  ],
  [
    'packages/editor-codemirror',
    'react/LatexReaderSkeleton.css',
    'latex reader skeleton stylesheet',
  ],
  [
    'packages/provider-pdfjs',
    'react/PdfReaderSkeleton.css',
    'pdf reader skeleton stylesheet',
  ],
];

/** Hooks the production consumer CSS bundle must carry. */
const REQUIRED_HOOKS = [
  '.fl-ink-root',
  '.fl-ink-page',
  '.fl-nb',
  '.flbp-host',
  '.ProseMirror',
  'froglight-latex-reader',
  '.fl-pdf-reader',
  'cm-editor',
  '.katex',
];

/**
 * Cascade layers the bundle must declare. LightningCSS minifies and splits
 * the order statement per use (`@layer tokens,globals;…`), so each name is
 * asserted inside an @layer statement rather than as one literal string.
 */
const REQUIRED_LAYERS = [
  'tokens',
  'globals',
  'components',
  'platform',
  'theme-overrides',
];

// 1–2. Copy assets, then assert every required file exists in dist.
for (const packageName of STYLED_PACKAGES) {
  copyPackageCss(packageName);
}
for (const [packageDir, relative, description] of REQUIRED_CSS) {
  const path = join(root, packageDir, 'dist', relative);
  if (!existsSync(path)) {
    fail(`missing ${description} at ${packageDir}/dist/${relative}`);
  }
  console.log(`ok dist asset: ${packageDir}/dist/${relative}`);
}

// Every dist JS entry the consumer touches must exist (built via tsc -b
// before this gate; nx test already depends on ^build).
const REQUIRED_JS = [
  ['packages/ui', 'dist/react/index.js'],
  ['packages/ui', 'dist/react/Button.js'],
  ['packages/editor-ink', 'dist/react/InkSurfaceSkeleton.js'],
  ['packages/editor-notebook', 'dist/react/NotebookChrome.js'],
  ['packages/editor-blockpage', 'dist/react/BlockpageHostSkeleton.js'],
  ['packages/editor-blockpage', 'dist/math-diagram-view.js'],
  ['packages/editor-codemirror', 'dist/react/CodemirrorMarkdownSkeleton.js'],
  ['packages/editor-codemirror', 'dist/react/LatexReaderSkeleton.js'],
  ['packages/provider-pdfjs', 'dist/react/PdfReaderSkeleton.js'],
];
for (const [packageDir, relative] of REQUIRED_JS) {
  if (!existsSync(join(root, packageDir, relative))) {
    fail(
      `missing built entry ${packageDir}/${relative} — run the package build first`,
    );
  }
}

// 3. Scaffold a minimal consumer importing ONLY dist outputs. The consumer
// lives under packages/ui/test-output (resolved through the ui package's
// react install for bare `react` imports) and references dist files by
// absolute path so no src/ file can leak in. The whole directory is
// removed at the end (kept only with --keep), so no repo pollution remains.
const consumerDir = join(
  root,
  'packages',
  'ui',
  'test-output',
  'dist-consumer',
);
rmSync(consumerDir, { recursive: true, force: true });
mkdirSync(consumerDir, { recursive: true });
// Normalize for import specifiers on Windows (backslashes break Vite).
const distPath = (...parts) =>
  join(root, ...parts)
    .split('\\')
    .join('/');
writeFileSync(
  join(consumerDir, 'package.json'),
  JSON.stringify({ name: 'dist-consumer', private: true, type: 'module' }),
);
writeFileSync(
  join(consumerDir, 'index.html'),
  '<!doctype html><html><head><meta charset="utf-8"></head>' +
    '<body><div id="root"></div>' +
    '<script type="module" src="/main.js"></script>' +
    '</body></html>',
);
writeFileSync(
  join(consumerDir, 'main.js'),
  [
    "import { createElement } from 'react';",
    "import { createRoot } from 'react-dom/client';",
    // Layer order first, exactly as a dist consumer wires it: the shipped
    // single source, imported once.
    `import '${distPath('packages/ui/dist/styles/layers.css')}';`,
    `import { Button } from '${distPath('packages/ui/dist/react/index.js')}';`,
    `import { InkSurfaceSkeleton } from '${distPath('packages/editor-ink/dist/react/InkSurfaceSkeleton.js')}';`,
    `import { NotebookChrome } from '${distPath('packages/editor-notebook/dist/react/NotebookChrome.js')}';`,
    `import { BlockpageHostSkeleton } from '${distPath('packages/editor-blockpage/dist/react/BlockpageHostSkeleton.js')}';`,
    // Math preview path: owns the bundled KaTeX stylesheet
    // import (`katex/dist/katex.min.css`), so the consumer production build
    // must carry the KaTeX CSS and emit its fonts. The binding is stashed
    // below so the module stays in the production module graph.
    `import { MAX_MATH_DIAGRAM_SOURCE_BYTES } from '${distPath('packages/editor-blockpage/dist/math-diagram-view.js')}';`,
    `import '${distPath('packages/editor-blockpage/dist/styles/prose-mirror.css')}';`,
    `import { CodemirrorMarkdownSkeleton } from '${distPath('packages/editor-codemirror/dist/react/CodemirrorMarkdownSkeleton.js')}';`,
    `import { LatexReaderSkeleton } from '${distPath('packages/editor-codemirror/dist/react/LatexReaderSkeleton.js')}';`,
    `import { PdfReaderSkeleton } from '${distPath('packages/provider-pdfjs/dist/react/PdfReaderSkeleton.js')}';`,
    'const refs = { ink: { current: null }, nb: { current: null }, bp: { current: null }, md: { current: null }, latex: { current: null }, pdf: { current: null } };',
    'function App() {',
    '  return createElement("div", null,',
    '    createElement(Button, { variant: "primary" }, "dist"),',
    '    createElement(InkSurfaceSkeleton, { presentation: "paint-stage", navigationMode: "standalone", skeletonRef: refs.ink }),',
    '    createElement(NotebookChrome, { chromeRef: refs.nb }),',
    '    createElement(BlockpageHostSkeleton, { skeletonRef: refs.bp }),',
    '    createElement(CodemirrorMarkdownSkeleton, { skeletonRef: refs.md }),',
    '    createElement(LatexReaderSkeleton, { skeletonRef: refs.latex }),',
    '    createElement(PdfReaderSkeleton, { skeletonRef: refs.pdf }));',
    '}',
    'createRoot(document.getElementById("root")).render(createElement(App));',
    'globalThis.__distConsumerRefs = refs;',
    'globalThis.__distConsumerMathCap = MAX_MATH_DIAGRAM_SOURCE_BYTES;',
    '',
  ].join('\n'),
);

// 4. Production build of the dist-only consumer via the Vite CLI (never a
// `vite` import: keeps build tooling out of shipped code and
// scripts — the generated vite.config.mjs below is the exempt shape).
console.log('building dist-only consumer with Vite…');
writeFileSync(
  join(consumerDir, 'vite.config.mjs'),
  [
    'export default {',
    "  build: { outDir: 'bundle', emptyOutDir: true, sourcemap: false },",
    "  logLevel: 'warn',",
    '};',
    '',
  ].join('\n'),
);
try {
  execFileSync('pnpm', ['exec', 'vite', 'build'], {
    cwd: consumerDir,
    stdio: 'pipe',
    encoding: 'utf8',
  });
} catch (error) {
  const detail =
    error instanceof Error && typeof error.stdout === 'string'
      ? `\n${error.stdout}\n${error.stderr ?? ''}`
      : String(error);
  fail(`consumer Vite build failed:${detail}`);
}

// 5. Inspect the production CSS bundle.
const bundleCssDir = join(consumerDir, 'bundle', 'assets');
const bundleFiles = existsSync(bundleCssDir)
  ? readdirSync(bundleCssDir).filter((name) => name.endsWith('.css'))
  : [];
if (bundleFiles.length === 0) fail('consumer build emitted no CSS bundle');
const bundleCss = bundleFiles
  .map((name) => readFileSync(join(bundleCssDir, name), 'utf8'))
  .join('\n');
for (const hook of REQUIRED_HOOKS) {
  if (!bundleCss.includes(hook)) {
    fail(`consumer CSS bundle is missing ${JSON.stringify(hook)}`);
  }
  console.log(`ok consumer css carries: ${hook}`);
}
const layerStatements = bundleCss.match(/@layer[^;{]*[;{]/g) ?? [];
for (const layer of REQUIRED_LAYERS) {
  const declared = layerStatements.some((statement) =>
    statement
      .replace(/^@layer/, '')
      .split(',')
      .map((name) => name.trim().replace(/[{;]\s*$/, ''))
      .includes(layer),
  );
  if (!declared) fail(`consumer CSS bundle declares no @layer ${layer}`);
  console.log(`ok consumer css declares layer: ${layer}`);
}

// 6. KaTeX font assets: the math preview stylesheet
// (`katex.min.css`, pulled in through dist/math-diagram-view.js above)
// references fonts/*.woff2. The production consumer build must emit those
// fonts as bundle assets and every bundled CSS reference must resolve to
// an emitted file — otherwise offline production math renders lose fonts.
const bundleAssets = existsSync(bundleCssDir)
  ? readdirSync(bundleCssDir)
  : [];
const katexFonts = bundleAssets.filter(
  (name) => name.startsWith('KaTeX_') && name.endsWith('.woff2'),
);
if (katexFonts.length === 0) {
  fail('consumer build emitted no KaTeX_*.woff2 font assets');
}
for (const font of katexFonts) {
  if (!bundleCss.includes(font)) {
    fail(`consumer CSS bundle does not reference emitted font assets/${font}`);
  }
  console.log(`ok consumer font asset referenced: assets/${font}`);
}
const referencedFonts = bundleCss.match(/KaTeX_[^"'()\s]*\.woff2/g) ?? [];
if (referencedFonts.length === 0) {
  fail('consumer CSS bundle references no KaTeX_*.woff2 font');
}
for (const reference of new Set(referencedFonts)) {
  const file = reference.slice(reference.lastIndexOf('/') + 1);
  if (!bundleAssets.includes(file)) {
    fail(`consumer CSS references missing font asset ${reference}`);
  }
  console.log(`ok consumer font reference resolves: ${reference}`);
}

if (!keep) rmSync(consumerDir, { recursive: true, force: true });
else console.log(`consumer kept at ${consumerDir}`);
console.log('verify-dist-css-consumer: PASS');
