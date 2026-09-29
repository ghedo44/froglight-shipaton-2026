// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Presentation-ownership final gate.
 *
 * Fails when a retired imperative presentation path returns without an
 * explicit allow-list entry below. `document.createElement()` itself is
 * NOT banned — engines legitimately need it for rendering primitives,
 * offscreen canvases, export/print infrastructure, third-party integration
 * (PDF.js page mounts), temporary input elements, and provider failure
 * placeholders. Each remaining occurrence carries an
 * comment at its site; this gate pins the narrow migration surface:
 *
 * - no visible-skeleton builders (`create*Skeleton` for stable chrome);
 * - no runtime-injected structural stylesheets (`*_CSS` strings,
 *   `ensureStyles`/`injectStyles`, retired `<style>` ids);
 * - no `style.cssText` layout in production sources;
 * - no side-effect-only `.module.css` imports (production builds drop
 *   unreferenced CSS modules, so component styles would silently vanish —
 *   see scripts/verify-dist-css-consumer.mjs);
 * - no block-form `:global {}` in `.module.css` (dropped in production;
 *   plain provider stylesheets carry global hooks instead).
 *
 * Tests (`*.spec.*`) and the spec helper (`test-support.ts`) are exempt:
 * specs build throwaway hosts and assert rendered output by design.
 */

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

const SCANNED_PACKAGE_DIRS = [
  'packages/ui/src',
  'packages/editor-ink/src',
  'packages/editor-notebook/src',
  'packages/editor-whiteboard/src',
  'packages/editor-codemirror/src',
  'packages/editor-blockpage/src',
  'packages/provider-pdfjs/src',
  'packages/provider-pdf-lib/src',
];

const EXEMPT_FILES = new Set(['packages/ui/src/react/test-support.ts']);

function collectProductionSources(): Array<{ file: string; text: string }> {
  const collected: Array<{ file: string; text: string }> = [];
  const walk = (relativeDir: string): void => {
    const absoluteDir = join(repoRoot, relativeDir);
    for (const entry of readdirSync(absoluteDir)) {
      const relative = `${relativeDir}/${entry}`;
      const stat = statSync(join(repoRoot, relative));
      if (stat.isDirectory()) {
        walk(relative);
        continue;
      }
      if (!relative.endsWith('.ts') && !relative.endsWith('.tsx')) continue;
      if (relative.endsWith('.spec.ts') || relative.endsWith('.spec.tsx'))
        continue;
      if (EXEMPT_FILES.has(relative)) continue;
      collected.push({
        file: relative,
        text: readFileSync(join(repoRoot, relative), 'utf8'),
      });
    }
  };
  for (const dir of SCANNED_PACKAGE_DIRS) walk(dir);
  return collected.sort((a, b) => (a.file < b.file ? -1 : 1));
}

/** [forbidden substring, why it must stay gone] */
const FORBIDDEN_SUBSTRINGS: ReadonlyArray<readonly [string, string]> = [
  [
    'createInkSkeleton',
    'retired Ink skeleton builder (React owns the skeleton)',
  ],
  [
    'createNotebookSkeleton',
    'retired Notebook skeleton builder (React owns the chrome)',
  ],
  [
    'createLatexReaderSkeleton',
    'retired LaTeX reader skeleton builder (React owns the wrapper)',
  ],
  [
    'createLatexEditorSkeleton',
    'retired LaTeX editor skeleton builder (React owns the wrapper)',
  ],
  [
    'createMarkdownSkeleton',
    'retired Markdown skeleton builder (React owns the host)',
  ],
  ['EDITOR_CSS', 'retired Ink CSS-in-JS (colocated InkSurfaceSkeleton.css)'],
  ['NB_CSS', 'retired Notebook CSS-in-JS (colocated NotebookChrome.css)'],
  ['CHROME_CSS', 'retired BlockPage CSS-in-JS (colocated stylesheets)'],
  ['ensureStyles', 'retired runtime style injector'],
  ['injectStyles', 'retired runtime style injector'],
  ['fl-ink-editor-styles', 'retired injected Ink <style> id'],
  ['fl-notebook-styles', 'retired injected Notebook <style> id'],
  ['flbp-chrome-styles', 'retired injected BlockPage <style> id'],
  ['mountComponentBridge', 'renamed to mountIsolatedReactRoot'],
  ['component-bridge', 'renamed to isolated-react-root'],
  [
    'cssText',
    'no Froglight layout through style.cssText in production sources',
  ],
];

describe('presentation ownership (retired paths stay retired)', () => {
  const sources = collectProductionSources();

  it('scans a non-trivial production surface', () => {
    expect(sources.length).toBeGreaterThan(50);
  });

  for (const [forbidden, reason] of FORBIDDEN_SUBSTRINGS) {
    it(`no ${forbidden} in production sources — ${reason}`, () => {
      const offenders = sources
        .filter(({ text }) => text.includes(forbidden))
        .map(({ file }) => file);
      expect(offenders, `retired pattern ${forbidden} found`).toEqual([]);
    });
  }

  it('no side-effect-only.module.css imports (production drops them)', () => {
    const pattern = /^\s*import\s+['"][^'"]*\.module\.css['"]\s*;?\s*$/m;
    const offenders = sources
      .filter(({ text }) => pattern.test(text))
      .map(({ file }) => file);
    // Every CSS module must be value-imported (import styles from …) and
    // used, otherwise the production build tree-shakes its rules away.
    expect(offenders).toEqual([]);
  });

  it('dialog infrastructure has one React owner', () => {
    const offenders = sources
      .filter(({ file, text }) =>
        (/<dialog\b|\.showModal\s*\(/.test(text)) ||
        (file !== 'packages/ui/src/react/primitives/Dialog.tsx' &&
          /from\s+['"][^'"]*(?:DialogBackdrop|useDialogKeyboard|useDialogFocusReturn)\.(?:js|jsx)['"]/.test(text)),
      )
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('no block-form:global {} in CSS modules (production drops it)', () => {
    const offenders: string[] = [];
    const walk = (relativeDir: string): void => {
      const absoluteDir = join(repoRoot, relativeDir);
      for (const entry of readdirSync(absoluteDir)) {
        const relative = `${relativeDir}/${entry}`;
        const stat = statSync(join(repoRoot, relative));
        if (stat.isDirectory()) {
          walk(relative);
          continue;
        }
        if (!relative.endsWith('.module.css')) continue;
        const text = readFileSync(join(repoRoot, relative), 'utf8');
        if (/:global\s*\{/.test(text)) offenders.push(relative);
      }
    };
    for (const dir of SCANNED_PACKAGE_DIRS) walk(dir);
    // Functional :global(selector) scoped under a local class ships fine;
    // the bare block form does not. Global hooks belong in plain provider
    // stylesheets (e.g. styles/prose-mirror.css).
    expect(offenders).toEqual([]);
  });

  it('retired colocated-module twins stay deleted', () => {
    const retired = [
      'packages/editor-ink/src/react/InkSurfaceSkeleton.module.css',
      'packages/editor-notebook/src/react/NotebookChrome.module.css',
      'packages/editor-codemirror/src/react/LatexReaderSkeleton.module.css',
      'packages/editor-codemirror/src/react/LatexEditorSkeleton.module.css',
      'packages/provider-pdfjs/src/react/PdfReaderSkeleton.module.css',
      'packages/ui/src/react/component-bridge.ts',
    ];
    expect(retired.filter((file) => existsSync(join(repoRoot, file)))).toEqual(
      [],
    );
  });

  it('every provider stylesheet layers itself under components', () => {
    const sheets = [
      'packages/editor-ink/src/react/InkSurfaceSkeleton.css',
      'packages/editor-notebook/src/react/NotebookChrome.css',
      'packages/editor-blockpage/src/react/BlockpageHost.module.css',
      'packages/editor-blockpage/src/styles/prose-mirror.css',
      'packages/editor-codemirror/src/react/CodemirrorHost.module.css',
      'packages/editor-codemirror/src/react/LatexEditorSkeleton.css',
      'packages/editor-codemirror/src/react/LatexReaderSkeleton.css',
      'packages/provider-pdfjs/src/react/PdfReaderSkeleton.css',
    ];
    for (const sheet of sheets) {
      const text = readFileSync(join(repoRoot, sheet), 'utf8');
      expect(text, `${sheet} must layer under components`).toContain(
        '@layer components',
      );
      const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
      expect(
        withoutComments,
        `${sheet} must not define :root tokens`,
      ).not.toMatch(/:root\s*\{/);
    }
  });
});
