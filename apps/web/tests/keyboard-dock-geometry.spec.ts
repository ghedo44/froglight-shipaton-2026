/**
 * Central dock keyboard geometry (`.fl-main` ownership).
 *
 * Real-browser layout regression for the physical iPad failure: editors did
 * not resize with the keyboard because only the focused `.fl-pane-body`
 * subtracted keyboard height, leaving the split hierarchy, tab bands, and
 * dividers at full height. The dock now shortens once at `.fl-main` and
 * every pane inherits it; CodeMirror stays keyboard-agnostic and shrinks
 * purely through parent geometry with `.cm-scroller` as the sole scroll
 * owner.
 *
 * jsdom cannot measure this (no layout engine), so these specs run under
 * Chromium with the real production stylesheets. The CodeMirror case mounts
 * the actual `@codemirror/view` engine (served from the workspace's own
 * node_modules through an import map — no CDN, no new dependency); only
 * the document provider is stubbed. CodeMirror-owned DOM is exempt from
 * the React rule, and its `.cm-*` classes are the stable
 * integration surface the provider CSS already targets.
 */
import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const CM_ORIGIN = 'https://cm.local';

function repoRoot(): string {
  const cwd = process.cwd();
  return cwd.endsWith('web') ? join(cwd, '..', '..') : cwd;
}

function workspaceStyles(): string {
  const root = repoRoot();
  const files = [
    'packages/ui/src/styles/globals.css',
    'packages/ui/src/react/WorkspaceView.module.css',
    'packages/ui/src/react/Titlebar.module.css',
    'packages/editor-codemirror/src/react/CodemirrorHost.module.css',
    'packages/ui/src/platform/platform.css',
  ];
  const css = files
    .map((name) => readFileSync(join(root, name), 'utf8'))
    // Emulate CSS-module compilation for the inlined sources: production
    // hashes local classes and unwraps `:global(x)` to `x` (verified in the
    // built web bundle, e.g. `.<hash> .cm-editor{height:100%}`). The harness
    // matches literal class names, so unwrap `:global()` the same way;
    // without this the CodeMirror height rules never match and the scroller
    // measures content height instead of the shortened pane.
    .map((text) => text.replaceAll(/:global\(([^()]*)\)/g, '$1'))
    .join('\n');
  const tokens = `:root{--fl-keyboard-inset-height:0px;--fl-visual-viewport-pan-y:0px;--fl-safe-area-top:0px;--fl-safe-area-bottom:0px;--fl-safe-area-left:0px;--fl-safe-area-right:0px;--fl-keyboard-aware-bottom:0px;--fl-layout-tab-height:40px;--fl-layout-sidebar-width:240px;--fl-layout-right-sidebar-width:240px;--fl-layout-ribbon-width:48px;--fl-titlebar-inset-left:0px;--fl-titlebar-inset-right:0px;--fl-window-controls-width:0px;--fl-surface-raised:#fff;--fl-surface-editor:#fff;--fl-surface-sidebar:#f5f5f5;--fl-surface-hover:#eee;--fl-surface-sunken:#eee;--fl-surface-active:#e5e5e5;--fl-surface-input:#fff;--fl-text-primary:#111;--fl-text-secondary:#333;--fl-text-muted:#666;--fl-border-default:#ddd;--fl-border-strong:#bbb;--fl-radius-md:8px;--fl-radius-sm:4px;--fl-radius-lg:8px;--fl-radius-xl:12px;--fl-shadow-medium:0 2px 8px rgba(0,0,0,.15);--fl-shadow-overlay:0 4px 16px rgba(0,0,0,.2);--fl-accent:#0066cc;--fl-accent-strong:#0055aa;--fl-accent-soft:#e6f0ff;--fl-danger:#cc0000;--fl-success:#00aa00;--fl-motion-fast:100ms;--fl-motion-normal:200ms;--fl-motion-slow:300ms;--fl-ease-standard:ease;--fl-ease-spring:ease;--fl-font-sans:sans-serif;--fl-font-mono:monospace;--fl-editor-font-size:14px;}`;
  const frozen = `*,*::before,*::after{animation:none !important;transition:none !important;}html,body{height:100%;margin:0;}`;
  return `${tokens}\n${css}\n${frozen}`;
}

function paneHtml(pane: string, header: string, bodyExtra = ''): string {
  return (
    `<div class="fl-pane focused" data-pane="${pane}">` +
    `<div class="fl-pane-header"><span>${header}</span></div>` +
    `<div class="fl-pane-body"><div class="editor-area fl-pane-editor">` +
    `<div class="froglight-cm-host" data-cm="${pane}"></div>${bodyExtra}` +
    `</div></div></div>`
  );
}

/** Horizontal split dock mirroring `DockPanes` output for two panes. */
function horizontalDockHtml(): string {
  return (
    `<div class="froglight-layout">` +
    `<div class="fl-titlebar" data-fl-component="titlebar"><div class="fl-titlebar-main">titlebar</div></div>` +
    `<div class="fl-body">` +
    `<div class="fl-activity">rail</div>` +
    `<div class="fl-sidebar"><div class="sidebar-inner">sidebar</div></div>` +
    `<main class="fl-main" data-fl-component="main">` +
    `<div class="fl-split" data-direction="horizontal">` +
    `<div class="fl-split-first" style="flex-grow:0.5;flex-basis:0;">${paneHtml('pane-a', 'A')}</div>` +
    `<div class="fl-pane-divider" role="separator" aria-label="Resize pane divider"></div>` +
    `<div class="fl-split-second" style="flex-grow:0.5;flex-basis:0;">${paneHtml('pane-b', 'B')}</div>` +
    `</div></main>` +
    `<div class="fl-right-sidebar">inspector</div>` +
    `</div></div>`
  );
}

/** Vertical split dock with the inline second-band tab strip. */
function verticalDockHtml(): string {
  return (
    `<div class="froglight-layout">` +
    `<div class="fl-titlebar" data-fl-component="titlebar"><div class="fl-titlebar-main">titlebar</div></div>` +
    `<div class="fl-body">` +
    `<div class="fl-activity">rail</div>` +
    `<div class="fl-sidebar"><div class="sidebar-inner">sidebar</div></div>` +
    `<main class="fl-main" data-fl-component="main">` +
    `<div class="fl-split" data-direction="vertical">` +
    `<div class="fl-split-first" style="flex-grow:0.5;flex-basis:0;">${paneHtml('pane-a', 'A')}</div>` +
    `<div class="fl-pane-divider" role="separator" aria-label="Resize pane divider"></div>` +
    `<div class="fl-split-second" style="flex-grow:0.5;flex-basis:0;">` +
    `<div class="fl-band-strips" data-band-strip="pane-b"><div class="fl-topbar-strip"><span>band tabs</span></div></div>` +
    `${paneHtml('pane-b', 'B')}` +
    `</div></div></main>` +
    `<div class="fl-right-sidebar">inspector</div>` +
    `</div></div>`
  );
}

/** Resolve workspace CodeMirror ESM entry points (import condition). */
function resolveCmFiles(): Map<string, string> {
  const cmRequire = createRequire(
    join(repoRoot(), 'packages/editor-codemirror/package.json'),
  );
  const specs = [
    '@codemirror/state',
    '@codemirror/view',
    '@marijn/find-cluster-break',
    'style-mod',
    'w3c-keyname',
    'crelt',
  ];
  const files = new Map<string, string>();
  for (const spec of specs) {
    // Resolve the package directory by walking up from the entry point:
    // several CodeMirror packages restrict `exports` (no `./package.json`
    // subpath), so subpath resolution cannot be used here.
    let dir = dirname(cmRequire.resolve(spec));
    while (!existsSync(join(dir, 'package.json'))) {
      const parent = dirname(dir);
      if (parent === dir) throw new Error(`package root missing for ${spec}`);
      dir = parent;
    }
    const pkgPath = join(dir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      exports?: unknown;
      module?: string;
      main?: string;
    };
    const exportsMap = pkg.exports as
      | string
      | Record<string, string | Record<string, string>>
      | undefined;
    let rel: string | undefined;
    if (typeof exportsMap === 'string') {
      rel = exportsMap;
    } else if (exportsMap !== undefined) {
      const dot = (exportsMap as Record<string, unknown>)['.'];
      if (typeof dot === 'string') rel = dot;
      else if (dot !== null && typeof dot === 'object') {
        rel = (dot as Record<string, string>)['import'];
      } else {
        rel = (exportsMap as Record<string, string>)['import'];
      }
    }
    rel ??= pkg.module ?? pkg.main;
    if (rel === undefined) throw new Error(`no ESM entry for ${spec}`);
    files.set(spec, join(dirname(pkgPath), rel));
  }
  // Fail fast on an incomplete closure: every bare import in the served
  // files must resolve through the import map below.
  const bare = new Set<string>();
  for (const path of files.values()) {
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(
      /(?:import|export)[^'"]*from\s*['"]([^'".][^'"]*)['"]/g,
    )) {
      bare.add(match[1]);
    }
  }
  const missing = [...bare].filter(
    (spec) =>
      !files.has(spec) && !spec.startsWith('.') && !spec.startsWith('/'),
  );
  if (missing.length > 0) {
    throw new Error(`unmapped CodeMirror imports: ${missing.join(', ')}`);
  }
  return files;
}

function importMapHtml(files: Map<string, string>): string {
  const imports: Record<string, string> = {};
  for (const spec of files.keys()) {
    imports[spec] = `${CM_ORIGIN}/${encodeURIComponent(spec)}.js`;
  }
  return `<script type="importmap">${JSON.stringify({ imports })}</script>`;
}

async function serveCmFiles(
  page: import('@playwright/test').Page,
  files: Map<string, string>,
): Promise<void> {
  const byUrl = new Map<string, string>();
  for (const [spec, path] of files) {
    byUrl.set(`${CM_ORIGIN}/${encodeURIComponent(spec)}.js`, path);
  }
  await page.route(`${CM_ORIGIN}/*`, async (route) => {
    const path = byUrl.get(route.request().url());
    if (path === undefined) {
      await route.abort();
      return;
    }
    await route.fulfill({
      body: readFileSync(path, 'utf8'),
      contentType: 'application/javascript',
    });
  });
}

const CM_BOOT = `
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
const lines = Array.from({ length: 200 }, (_, i) => 'Line ' + (i + 1) + ' of the document body.');
for (const host of document.querySelectorAll('[data-cm]')) {
  new EditorView({ state: EditorState.create({ doc: lines.join('\\n') }), parent: host });
}
window.__cmReady = true;
`;

async function setDockHarness(
  page: import('@playwright/test').Page,
  html: string,
  mountCm: boolean,
): Promise<void> {
  const css = workspaceStyles();
  const files = mountCm ? resolveCmFiles() : new Map<string, string>();
  if (mountCm) await serveCmFiles(page, files);
  const head =
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>${css}</style>` +
    (mountCm ? importMapHtml(files) : '');
  const boot = mountCm ? `<script type="module">${CM_BOOT}</script>` : '';
  await page.setContent(
    `<!doctype html><html><head>${head}</head><body>${html}${boot}</body></html>`,
    { waitUntil: 'load' },
  );
  if (mountCm) {
    await page.waitForFunction(() => (window as any).__cmReady === true, null, {
      timeout: 15000,
    });
  }
}

async function applyKeyboardInset(
  page: import('@playwright/test').Page,
  height: number,
): Promise<void> {
  await page.evaluate((value) => {
    document.documentElement.style.setProperty(
      '--fl-keyboard-inset-height',
      `${value}px`,
    );
  }, height);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(resolve)),
  );
}

test.describe('dock keyboard geometry (tablet 1024x768)', () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test('horizontal split panes and divider shorten together; titlebar fixed', async ({
    page,
  }) => {
    await setDockHarness(page, horizontalDockHtml(), false);

    const main = page.locator('.fl-main');
    const paneA = page.locator('[data-pane="pane-a"]');
    const paneB = page.locator('[data-pane="pane-b"]');
    const divider = page.locator('.fl-split .fl-pane-divider');
    const titlebar = page.locator('[data-fl-component="titlebar"]');
    for (const locator of [main, paneA, paneB, divider, titlebar]) {
      await expect(locator).toBeVisible();
    }

    const beforeMain = await main.boundingBox();
    const beforeTitle = await titlebar.boundingBox();
    expect(beforeMain).not.toBeNull();
    expect(beforeTitle).not.toBeNull();

    await applyKeyboardInset(page, 300);

    const afterMain = await main.boundingBox();
    expect(afterMain).not.toBeNull();
    // `.fl-main` owns the inset exactly once: border-box shrinks by it.
    expect(beforeMain!.height - afterMain!.height).toBeCloseTo(300, 0);
    const margin = await page.evaluate(
      () => getComputedStyle(document.querySelector('.fl-main')!).marginBottom,
    );
    expect(margin).toBe('300px');

    const viewportHeight = page.viewportSize()?.height ?? 768;
    const keyboardTop = viewportHeight - 300;
    for (const [name, locator] of [
      ['pane A', paneA],
      ['pane B', paneB],
      ['divider', divider],
    ] as const) {
      const box = await locator.boundingBox();
      expect(box, name).not.toBeNull();
      expect(box!.y + box!.height, `${name} bottom`).toBeLessThanOrEqual(
        keyboardTop + 1,
      );
    }

    // Top titlebar chrome never moves with the keyboard.
    const afterTitle = await titlebar.boundingBox();
    expect(afterTitle).not.toBeNull();
    expect(afterTitle!.y).toBeCloseTo(beforeTitle!.y, 0);
    expect(afterTitle!.height).toBeCloseTo(beforeTitle!.height, 0);
  });

  test('vertical split inline band strip stays inside the shortened main', async ({
    page,
  }) => {
    await setDockHarness(page, verticalDockHtml(), false);
    const band = page.locator('.fl-band-strips');
    await expect(band).toBeVisible();

    await applyKeyboardInset(page, 300);

    const viewportHeight = page.viewportSize()?.height ?? 768;
    const keyboardTop = viewportHeight - 300;
    const bandBox = await band.boundingBox();
    expect(bandBox).not.toBeNull();
    expect(bandBox!.y + bandBox!.height).toBeLessThanOrEqual(keyboardTop + 1);

    const paneB = await page.locator('[data-pane="pane-b"]').boundingBox();
    expect(paneB).not.toBeNull();
    expect(paneB!.y + paneB!.height).toBeLessThanOrEqual(keyboardTop + 1);
  });

  test('real CodeMirror scroller shortens and final lines stay reachable', async ({
    page,
  }) => {
    await setDockHarness(page, horizontalDockHtml(), true);

    const scrollerBox = async (): Promise<{
      x: number;
      y: number;
      width: number;
      height: number;
    } | null> => page.locator('.cm-scroller').first().boundingBox();
    await expect(page.locator('.cm-scroller').first()).toBeVisible();

    const before = await scrollerBox();
    expect(before).not.toBeNull();

    await applyKeyboardInset(page, 300);

    const after = await scrollerBox();
    expect(after).not.toBeNull();
    // Parent geometry only — no CodeMirror keyboard awareness: the editor
    // viewport shortens with the dock.
    expect(before!.height - after!.height).toBeCloseTo(300, 0);

    const scrolled = await page.evaluate(() => {
      const scroller = document.querySelector(
        '.cm-scroller',
      ) as HTMLElement | null;
      if (!scroller) throw new Error('missing .cm-scroller');
      const overflowed = scroller.scrollHeight >= scroller.clientHeight;
      scroller.scrollTop = scroller.scrollHeight;
      return {
        overflowed,
        clientHeight: scroller.clientHeight,
        scrollHeight: scroller.scrollHeight,
        top: scroller.scrollTop,
      };
    });
    expect(scrolled.overflowed).toBe(true);
    expect(scrolled.top).toBeGreaterThan(0);
  });
});
