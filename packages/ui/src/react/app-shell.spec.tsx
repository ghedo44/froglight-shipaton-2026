// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountFroglightApp, type WorkbenchMount } from '../workbench.js';
import {
  chromeDouble,
  createHarness,
  makeChoice,
  settle,
  until,
  type Harness,
} from './test-support.js';
import { act } from 'react';
import type { WindowChrome } from '../window-chrome.js';
import launcherStyles from './LauncherView.module.css';
import titlebarStyles from './Titlebar.module.css';
import overlayStyles from './Overlays.module.css';
import workspaceStyles from './WorkspaceView.module.css';

describe('app shell lifecycle (mount seam)', () => {
  let harness: Harness | null = null;
  let mounted: WorkbenchMount | null = null;

  async function start(
    recents = [makeChoice({ id: 'v1', name: 'My Vault' })],
    options?: { windowChrome?: WindowChrome | null },
  ) {
    const h = await createHarness(recents);
    harness = h;
    const root = document.createElement('div');
    document.body.appendChild(root);
    h.root = root;
    await act(async () => {
      mounted = await mountFroglightApp(
        root,
        h.controller,
        h.adapter,
        h.ui,
        options,
      );
    });
    return h;
  }

  afterEach(async () => {
    if (mounted !== null) {
      await act(async () => {
        await mounted!.dispose();
      });
      mounted = null;
    }
    await harness?.dispose();
    harness = null;
  });

  it('starts at the vault launcher without touching the workspace', async () => {
    const h = await start();
    expect(
      h.root.querySelector(`.${launcherStyles['vault-launcher-brand']} h1`)
        ?.textContent,
    ).toBe('Froglight');
    expect(
      h.root.querySelector(`.${launcherStyles['recent-vault-card']}`),
    ).not.toBeNull();
    expect(h.controller.calls.initialize).toBe(0);
  });

  it('activating a vault swaps to the workspace shell and initializes the controller', async () => {
    const h = await start();
    const card = h.root.querySelector<HTMLElement>(
      `.${launcherStyles['recent-vault-card']}`,
    );
    expect(card).not.toBeNull();
    await act(async () => {
      card!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
    });
    await until(() => h.controller.calls.initialize === 1);
    expect(
      h.root.querySelector('[data-fl-component="titlebar"]'),
    ).not.toBeNull();
    expect(h.root.textContent).toContain('My Vault');
    // The controller received a real element as the main pane's editor host.
    expect(h.controller.editorParentOf('main')).toBeInstanceOf(HTMLElement);
    // Opening the seeded first document is reflected as the active tab.
    await until(
      () =>
        h.root.querySelector(
          `.${workspaceStyles['fl-tab']}.${workspaceStyles.active} .${workspaceStyles['fl-tab-label']}`,
        )?.textContent !== null,
    );
  });

  it('closing the vault tears the workspace down and returns to the launcher', async () => {
    const h = await start();
    await openWorkspace(h);
    await openVaultMenuAndClose(h);
    await until(() => h.controller.calls.closeVault === 1);
    await until(
      () =>
        h.root.querySelector(`.${launcherStyles['vault-launcher']}`) !== null,
    );
    expect(h.root.querySelector('[data-fl-component="titlebar"]')).toBeNull();
  });

  it('dispose clears the DOM exactly once and supports remounting fresh', async () => {
    const h = await start();
    await openWorkspace(h);
    await act(async () => {
      await mounted!.dispose();
    });
    expect(h.root.querySelector('[data-fl-component="titlebar"]')).toBeNull();
    expect(h.controller.calls.dispose).toBe(1);
    // Remount starts over at the launcher with a clean slate.
    let remounted: WorkbenchMount | null = null;
    await act(async () => {
      remounted = await mountFroglightApp(
        h.root,
        h.controller,
        h.adapter,
        h.ui,
      );
    });
    expect(
      h.root.querySelector(`.${launcherStyles['vault-launcher-brand']} h1`)
        ?.textContent,
    ).toBe('Froglight');
    await act(async () => {
      await remounted!.dispose();
    });
    expect(h.controller.calls.dispose).toBe(2);
    mounted = null; // afterEach must not dispose twice
  });

  it('mount → activate → close → activate keeps exactly one workspace shell', async () => {
    const h = await start();
    await openWorkspace(h);
    await openVaultMenuAndClose(h);
    await until(
      () =>
        h.root.querySelector(`.${launcherStyles['vault-launcher']}`) !== null,
    );
    await openWorkspace(h);
    expect(
      h.root.querySelectorAll('[data-fl-component="titlebar"]').length,
    ).toBe(1);
    expect(h.controller.calls.initialize).toBe(2);
  });

  describe('window chrome', () => {
    it('defaults to the plain-browser chrome: workspace header only, no window controls', async () => {
      const h = await start();
      // The browser tab provides its own chrome: the launcher stays a full page.
      expect(h.root.querySelector('[data-fl-component="titlebar"]')).toBeNull();
      await openWorkspace(h);
      // The workspace titlebar is real UI (it hosts the tab strip), not just chrome.
      expect(
        h.root.querySelector('[data-fl-component="titlebar"]'),
      ).not.toBeNull();
      expect(
        h.root.querySelector(`.${titlebarStyles['fl-wincontrols']}`),
      ).toBeNull();
      // Empty regions carry no host drag marker.
      expect(
        h.root
          .querySelector('[data-fl-component="titlebar"]')!
          .hasAttribute('data-tauri-drag-region'),
      ).toBe(false);
    });

    it('hosts with custom chrome get window controls on launcher and workspace', async () => {
      const chrome = chromeDouble();
      const h = await start([makeChoice({ id: 'v1', name: 'My Vault' })], {
        windowChrome: chrome,
      });
      expect(
        h.root
          .querySelector(`.${titlebarStyles['fl-wincontrols']}`)!
          .querySelectorAll('button').length,
      ).toBe(3);
      await openWorkspace(h);
      // The workspace titlebar hosts the main pane's tab strip…
      await until(
        () =>
          h.root.querySelector(
            `[data-fl-component="titlebar"] .${workspaceStyles.tabstrip} .${workspaceStyles['fl-tab']}`,
          ) !== null,
      );
      // …and the same window controls.
      expect(
        h.root.querySelectorAll(`.${titlebarStyles['fl-wincontrols']}`).length,
      ).toBe(1);
      expect(
        h.root
          .querySelector('[data-fl-component="titlebar"]')!
          .hasAttribute('data-tauri-drag-region'),
      ).toBe(true);
    });

    it('the window close button closes the window, not the vault', async () => {
      const chrome = chromeDouble();
      const h = await start([makeChoice({ id: 'v1', name: 'My Vault' })], {
        windowChrome: chrome,
      });
      await openWorkspace(h);
      await act(async () => {
        h.root
          .querySelector<HTMLElement>('[aria-label="Close window"]')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await settle();
      });
      expect(chrome.close).toHaveBeenCalledTimes(1);
      expect(h.controller.calls.closeVault).toBe(0);
      expect(
        h.root.querySelector(`.${launcherStyles['vault-launcher']}`),
      ).toBeNull();
    });

    it('an explicit null chrome is the plain-browser fallback', async () => {
      const h = await start([makeChoice({ id: 'v1', name: 'My Vault' })], {
        windowChrome: null,
      });
      await openWorkspace(h);
      expect(
        h.root.querySelector(`.${titlebarStyles['fl-wincontrols']}`),
      ).toBeNull();
    });

    it('disposing the mount disposes the host chrome exactly once', async () => {
      const chrome = chromeDouble({ dispose: vi.fn() });
      const h = await start([makeChoice({ id: 'v1', name: 'My Vault' })], {
        windowChrome: chrome,
      });
      await openWorkspace(h);
      await act(async () => {
        await mounted!.dispose();
      });
      mounted = null; // afterEach must not dispose twice
      expect(chrome.dispose).toHaveBeenCalledTimes(1);
    });
  });

  async function openWorkspace(h: Harness): Promise<void> {
    await act(async () => {
      h.root
        .querySelector<HTMLElement>(`.${launcherStyles['recent-vault-card']}`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
    });
    await until(() => h.controller.calls.initialize > 0);
    await until(
      () =>
        h.root.querySelector(
          `[data-fl-component="titlebar"] .${workspaceStyles.tabstrip}`,
        ) !== null,
    );
  }

  /** Close-vault lives in the vault identity menu, Obsidian-style. */
  async function openVaultMenuAndClose(h: Harness): Promise<void> {
    await act(async () => {
      h.root
        .querySelector<HTMLElement>(`.${workspaceStyles['vault-row-main']}`)!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
    });
    await until(
      () =>
        document.body.querySelector(
          `.${overlayStyles['fl-menu'].split(' ').join('.')}`,
        ) !== null,
    );
    const item = [
      ...document.body.querySelectorAll<HTMLElement>(
        `.${overlayStyles['fl-menu-item']}`,
      ),
    ].find((candidate) => candidate.textContent?.includes('Close vault'));
    expect(item).toBeDefined();
    await act(async () => {
      item!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
    });
  }
});
