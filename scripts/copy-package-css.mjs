/**
 * Copy colocated stylesheets into built package output.
 *
 * The TypeScript pipeline (`tsc -p tsconfig.lib.json`) emits JS and
 * declarations but never copies `.css` assets, while every React-owned
 * component is imported explicitly by its component. Without
 * this step a consumer of the built `dist/` output receives unstyled
 * components: `dist/react/Button.js` imports `./Button.module.css`, which
 * must exist next to it.
 *
 * Usage: `node scripts/copy-package-css.mjs [package ...]`
 * With no arguments, all styled packages are processed.
 *
 * Run after every package build (CI runs it before packaging; the
 * dist-consumer gate runs it before asserting). The copy preserves
 * relative paths so intra-package relative CSS imports keep resolving.
 *
 * The same step rewrites sibling .jsx import/export specifiers in the
 * emitted dist JS and dist declarations to .js. Sources import
 * siblings as ./Sibling.jsx (the workspace convention Vite resolves to
 * Sibling.tsx), but tsc emits siblings as Sibling.js, so without
 * the rewrite a dist-only consumer cannot resolve the graph at all.
 * Only relative specifiers are touched; source maps are left alone.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const STYLED_PACKAGES = [
  '@froglight/ui',
  '@froglight/editor-ink',
  '@froglight/editor-notebook',
  '@froglight/editor-blockpage',
  '@froglight/editor-codemirror',
  '@froglight/provider-pdfjs',
];

const PACKAGE_DIRS = {
  '@froglight/ui': 'packages/ui',
  '@froglight/editor-ink': 'packages/editor-ink',
  '@froglight/editor-notebook': 'packages/editor-notebook',
  '@froglight/editor-blockpage': 'packages/editor-blockpage',
  '@froglight/editor-codemirror': 'packages/editor-codemirror',
  '@froglight/provider-pdfjs': 'packages/provider-pdfjs',
};

/**
 * Collect every `.css` file under `srcDir`, returned as paths relative to
 * `srcDir`. Implemented with a manual walk so the script stays dependency
 * free.
 */
export function collectCssFiles(srcDir) {
  const found = [];
  const walk = (relative) => {
    for (const entry of readdirSync(join(srcDir, relative))) {
      const nextRelative = relative === '' ? entry : `${relative}/${entry}`;
      const stat = statSync(join(srcDir, nextRelative));
      if (stat.isDirectory()) walk(nextRelative);
      else if (entry.endsWith('.css')) found.push(nextRelative);
    }
  };
  walk('');
  return found.sort();
}

export function copyPackageCss(packageName) {
  const packageDir = PACKAGE_DIRS[packageName];
  if (packageDir === undefined) {
    throw new Error(`copy-package-css: unknown package ${packageName}`);
  }
  const srcDir = join(root, packageDir, 'src');
  const distDir = join(root, packageDir, 'dist');
  if (!existsSync(srcDir)) {
    throw new Error(`copy-package-css: missing src dir ${srcDir}`);
  }
  mkdirSync(distDir, { recursive: true });
  const files = collectCssFiles(srcDir);
  for (const relative of files) {
    const from = join(srcDir, relative);
    const to = join(distDir, relative);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
  }
  const rewritten = rewriteJsxSpecifiers(distDir);
  return { files, rewritten };
}

/**
 * Rewrite relative `./Sibling.jsx` specifiers to `./Sibling.js` in emitted
 * dist JS and declarations. Matches static and dynamic import/export
 * forms; leaves source maps untouched.
 */
export function rewriteJsxSpecifiers(distDir) {
  let rewritten = 0;
  const pattern = /((?:import|export)[^'"]*?['"])(\.\.?\/[^'"]*?)\.jsx(['"])/g;
  const walk = (relative) => {
    for (const entry of readdirSync(join(distDir, relative))) {
      const nextRelative = relative === '' ? entry : `${relative}/${entry}`;
      const stat = statSync(join(distDir, nextRelative));
      if (stat.isDirectory()) {
        walk(nextRelative);
        continue;
      }
      if (!entry.endsWith('.js') && !entry.endsWith('.d.ts')) continue;
      const path = join(distDir, nextRelative);
      const text = readFileSync(path, 'utf8');
      pattern.lastIndex = 0;
      if (!pattern.test(text)) continue;
      pattern.lastIndex = 0;
      writeFileSync(path, text.replace(pattern, '$1$2.js$3'));
      rewritten += 1;
    }
  };
  if (!existsSync(distDir)) return 0;
  walk('');
  return rewritten;
}

const invokedAsScript =
  process.argv.length > 1 &&
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  const selected =
    process.argv.length > 2 ? process.argv.slice(2) : STYLED_PACKAGES;
  for (const packageName of selected) {
    const { files, rewritten } = copyPackageCss(packageName);
    console.log(
      `copy-package-css: ${packageName}: ${files.length} css files, ${rewritten} js/d.ts files rewritten`,
    );
  }
}
