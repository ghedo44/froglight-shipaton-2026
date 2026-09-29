// @vitest-environment jsdom
/**
 * Mounted keyboard layout behavior.
 *
 * jsdom has no geometry engine, so "main height reduced by N" cannot be read
 * off clientHeight here. This spec pins the highest testable seam instead:
 * the mounted workbench applies the usable inset immediately for exact iOS
 * geometry, the titlebar never moves, and the workspace stylesheet shortens
 * `.fl-main` once (margin, not padding) so the entire dock tree inherits a
 * shorter parent while the titlebar and pane bodies never subtract keyboard
 * height again. Physical-device acceptance (real clientHeight above the
 * keyboard) remains a manual matrix step, covered by the Playwright dock
 * geometry suite.
 */
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { KeyboardInsetStore } from '@froglight/foundation';
import { mountFroglightApp, type WorkbenchMount } from '../workbench.js';
import {
  attachKeyboardShell,
  currentKeyboardInsetTarget,
  detachKeyboardShell,
} from '../platform/keyboard-inset.js';
import {
  createHarness,
  makeChoice,
  settle,
  until,
  type Harness,
} from './test-support.js';
import launcherStyles from './LauncherView.module.css';
import workspaceStyles from './WorkspaceView.module.css';

function workspaceCssSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, 'WorkspaceView.module.css'), 'utf8');
}

function toolbarCssSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, 'UnifiedToolbar.module.css'), 'utf8');
}

function codemirrorCssSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(
    resolve(
      here,
      '../../../editor-codemirror/src/react/CodemirrorHost.module.css',
    ),
    'utf8',
  );
}

describe('mounted keyboard layout (workspace seam)', () => {
  let harness: Harness | null = null;
  let mounted: WorkbenchMount | null = null;

  async function start() {
    const h = await createHarness([makeChoice({ id: 'v1', name: 'My Vault' })]);
    harness = h;
    const root = document.createElement('div');
    document.body.appendChild(root);
    h.root = root;
    await act(async () => {
      mounted = await mountFroglightApp(root, h.controller, h.adapter, h.ui);
    });
    await act(async () => {
      h.root
        .querySelector<HTMLElement>(`.${launcherStyles['recent-vault-card']}`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
    });
    await until(() => h.controller.calls.initialize > 0);
    await until(
      () => h.root.querySelector('[data-fl-component="titlebar"]') !== null,
    );
    return h;
  }

  afterEach(async () => {
    detachKeyboardShell();
    document.documentElement.style.removeProperty('--fl-keyboard-inset-height');
    if (mounted !== null) {
      await act(async () => {
        await mounted!.dispose();
      });
      mounted = null;
    }
    await harness?.dispose();
    harness = null;
  });

  it('exact willShow applies the usable inset immediately; titlebar never moves', async () => {
    const h = await start();
    const store = new KeyboardInsetStore({ settleDebounceMs: 0 });
    const detach = attachKeyboardShell({ store, reduceMotion: true });
    try {
      const titlebar = h.root.querySelector<HTMLElement>(
        '[data-fl-component="titlebar"]',
      )!;
      const main = h.root.querySelector<HTMLElement>(
        `.${workspaceStyles['fl-main']}`,
      )!;
      expect(main).not.toBeNull();
      store.handleNativeEvent('willShow', {
        height: 300,
        durationMs: 250,
        measurement: 'exact',
      });
      // Logical geometry first: the usable inset is live while the keyboard
      // rises so the editor scroll viewport already ends above it.
      expect(
        document.documentElement.style.getPropertyValue(
          '--fl-keyboard-inset-height',
        ),
      ).toBe('300px');
      expect(currentKeyboardInsetTarget()).toBe(300);
      // The application frame origin never moves: no transform, no scroll.
      expect(titlebar.style.transform).toBe('');
      expect(document.documentElement.scrollTop).toBe(0);
      expect(document.body.scrollTop).toBe(0);
      store.handleNativeEvent('willHide', { durationMs: 200 });
      expect(
        document.documentElement.style.getPropertyValue(
          '--fl-keyboard-inset-height',
        ),
      ).toBe('0px');
      expect(titlebar.style.transform).toBe('');
    } finally {
      detach();
      store.dispose();
    }
  });

  it('gives the keyboard inset exactly one dock owner:.fl-main', () => {
    // Ownership boundary, not a property pin: `.fl-main` consumes the inset
    // once so the whole dock tree inherits a shorter parent; pane bodies
    // never subtract it again (no double inset), the titlebar never moves,
    // and the pane-local bottom strip clears only keyboard-aware safe area
    // (safe area while closed, nothing extra above a docked keyboard).
    // Sidebar content keeps its own independent viewport rules. A grid-row
    // or contain-size refactor keeps passing as long as ownership holds.
    const shell = workspaceCssSource().replace(/\/\*[\s\S]*?\*\//g, '');
    const mainBlock = shell.match(/\.fl-main\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(mainBlock).toContain('--fl-keyboard-inset-height');
    const paneBodyBlock =
      shell.match(/\.fl-pane-body\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(paneBodyBlock).not.toContain('--fl-keyboard-inset-height');
    expect(paneBodyBlock).not.toContain('--fl-keyboard-overlay-bottom');
    expect(shell).not.toContain('.fl-pane-body[data-fl-keyboard-viewport]');
    // Sidebar avoidance stays separate from the central dock.
    expect(shell).toContain('.sidebar-content[data-fl-keyboard-viewport]');
    const toolbar = toolbarCssSource().replace(/\/\*[\s\S]*?\*\//g, '');
    const stripBlock =
      toolbar.match(/\.fl-floating-strip\.strip-bottom\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(stripBlock).not.toContain('--fl-keyboard-inset-height');
    expect(stripBlock).not.toContain('--fl-keyboard-safe-bottom');
    expect(stripBlock).toContain('--fl-keyboard-aware-bottom');
  });

  it('keeps the titlebar and top tab strips free of keyboard geometry', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const titlebar = readFileSync(
      resolve(here, 'Titlebar.module.css'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(titlebar).not.toContain('--fl-keyboard-inset-height');
    expect(titlebar).not.toContain('--fl-keyboard-overlay-bottom');
    const shell = workspaceCssSource().replace(/\/\*[\s\S]*?\*\//g, '');
    const topbarBlock =
      shell.match(/\.fl-topbar-row\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(topbarBlock).not.toContain('--fl-keyboard-inset-height');
  });

  it('floating and hardware keyboards leave zero global inset', async () => {
    await start();
    const store = new KeyboardInsetStore({ settleDebounceMs: 0 });
    const detach = attachKeyboardShell({ store, reduceMotion: true });
    try {
      // Docked → floating (undock reports no bottom occlusion as hide).
      store.handleNativeEvent('willShow', {
        height: 300,
        durationMs: 250,
        measurement: 'exact',
      });
      store.handleNativeEvent('willHide', { durationMs: 200 });
      store.handleNativeEvent('didHide', {});
      expect(currentKeyboardInsetTarget()).toBe(0);
      expect(
        document.documentElement.style.getPropertyValue(
          '--fl-keyboard-inset-height',
        ),
      ).toBe('0px');
    } finally {
      detach();
      store.dispose();
    }
  });

  it('rotation wins immediately with exact geometry (no stale portrait height)', async () => {
    await start();
    const store = new KeyboardInsetStore({ settleDebounceMs: 0 });
    const detach = attachKeyboardShell({ store, reduceMotion: true });
    try {
      store.handleNativeEvent('willShow', {
        height: 346,
        durationMs: 250,
        measurement: 'exact',
      });
      store.handleNativeEvent('didShow', { height: 346, measurement: 'exact' });
      store.handleNativeEvent('willHide', { durationMs: 200 });
      store.handleNativeEvent('didHide', {});
      store.handleNativeEvent('willShow', {
        height: 180,
        durationMs: 250,
        measurement: 'exact',
      });
      expect(store.snapshot()).toMatchObject({ height: 180, isOpen: true });
      expect(
        document.documentElement.style.getPropertyValue(
          '--fl-keyboard-inset-height',
        ),
      ).toBe('180px');
    } finally {
      detach();
      store.dispose();
    }
  });

  it('shortens the whole dock through.fl-main; panes carry no marker (split panes)', async () => {
    // Structural contract for the physical split-pane matrix: the keyboard
    // inset is environment geometry consumed once by `.fl-main`; every pane
    // inherits the shorter dock together. jsdom cannot measure real
    // border-box heights, so this pins the highest testable seam — no
    // per-pane marker, a live positive inset, and an unmoved titlebar.
    // Real dimensions ride in the Playwright dock geometry suite.
    const h = await start();
    await act(async () => {
      h.controller.splitPane('main', 'right');
      await settle();
    });
    await until(
      () =>
        h.root.querySelectorAll(`.${workspaceStyles['fl-pane']}`).length === 2,
    );
    const panes = [
      ...h.root.querySelectorAll<HTMLElement>(`.${workspaceStyles['fl-pane']}`),
    ];
    expect(panes).toHaveLength(2);
    const bodies = panes.map(
      (pane) =>
        pane.querySelector<HTMLElement>(
          `.${workspaceStyles['fl-pane-body']}`,
        )!,
    );
    for (const body of bodies) {
      expect(body).not.toBeNull();
      // No per-pane keyboard marker: the dock owns geometry, not focus.
      expect(body.hasAttribute('data-fl-keyboard-viewport')).toBe(false);
    }

    const store = new KeyboardInsetStore({ settleDebounceMs: 0 });
    const detach = attachKeyboardShell({ store, reduceMotion: true });
    try {
      store.handleNativeEvent('target', {
        height: 300,
        durationMs: 250,
        measurement: 'exact',
      });
      expect(store.snapshot().height).toBe(300);
      expect(
        document.documentElement.style.getPropertyValue(
          '--fl-keyboard-inset-height',
        ),
      ).toBe('300px');
      // The application frame origin never moves: no transform, no scroll.
      // `.fl-main` owns the inset through the stylesheet (no inline style,
      // no focus lookup), so both panes inherit it together.
      const titlebar = h.root.querySelector<HTMLElement>(
        '[data-fl-component="titlebar"]',
      )!;
      expect(titlebar.style.transform).toBe('');
      const layout = h.root.querySelector<HTMLElement>(
        `.${workspaceStyles['froglight-layout']}`,
      )!;
      expect(layout.style.transform).toBe('');
      for (const body of bodies) {
        expect(body.style.marginBottom).toBe('');
      }
    } finally {
      detach();
      store.dispose();
    }
  });

  it('keeps the editor shrink chain keyboard-agnostic with one scroll owner', () => {
    // Layout contract, not a geometry measurement: the keyboard-sensitive
    // parent becomes shorter, the CodeMirror host can shrink, and
    // `.cm-scroller` remains the scroll owner. No competing auto scroller
    // may appear between `.fl-main` and the editor host, and the provider
    // package must not consume the keyboard inset itself.
    const shell = workspaceCssSource().replace(/\/\*[\s\S]*?\*\//g, '');
    for (const selector of ['\\.fl-pane\\s*\\{', '\\.fl-pane-body\\s*\\{', '\\.editor-area\\s*\\{']) {
      const block =
        shell.match(new RegExp(`${selector}[^}]*\\}`, 's'))?.[0] ?? '';
      expect(block, selector).toContain('min-height: 0');
    }
    const provider = codemirrorCssSource().replace(/\/\*[\s\S]*?\*\//g, '');
    expect(provider).not.toContain('--fl-keyboard-inset-height');
    const hostBlock =
      provider.match(/\.froglight-cm-host\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(hostBlock).toContain('flex: 1 1 0');
    expect(hostBlock).toContain('min-height: 0');
    expect(hostBlock).toContain('overflow: hidden');
    const editorBlock =
      provider.match(
        /\.froglight-cm-host\s*:global\(\.cm-editor\)\s*\{[^}]*\}/s,
      )?.[0] ?? '';
    expect(editorBlock).toContain('height: 100%');
  });
});
