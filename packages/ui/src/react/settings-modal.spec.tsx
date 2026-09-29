// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import type { ServiceToken } from '@froglight/runtime';
import { definePlugin } from '@froglight/runtime';
import { commandsToken } from '@froglight/foundation';
import { mountFroglightApp, type WorkbenchMount } from '../workbench.js';
import { workspaceSettingsToken } from '../workspace-settings.js';
import { settingsRegistryToken } from '../settings-registry.js';
import {
  createHarness,
  makeChoice,
  settle,
  until,
  waitMs,
  type Harness,
} from './test-support.js';
import launcherStyles from './LauncherView.module.css';
import styles from './SettingsModal.module.css';
import workspaceStyles from './WorkspaceView.module.css';

describe('settings modal (mount seam)', () => {
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
    await openWorkspace(h);
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

  it('maps every asserted class through the CSS module', () => {
    for (const name of [
      'settings-backdrop',
      'settings-modal',
      'settings-nav',
      'settings-search-wrap',
      'settings-search',
      'settings-nav-list',
      'settings-nav-group',
      'settings-nav-group-label',
      'settings-nav-item',
      'settings-nav-icon',
      'settings-nav-name',
      'settings-empty',
      'settings-main',
      'settings-close',
      'settings-content',
      'active',
    ]) {
      expect(styles[name], `module class ${name}`).toMatch(/\S/);
    }
  });

  it('the activity-bar settings button opens an almost-full-screen modal listing core sections', async () => {
    const h = await start();
    await clickActivitySettings(h);
    const dialog = modalDialog(h);
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute('aria-modal')).toBe('true');
    const names = navNames(h);
    expect(names).toEqual([
      'Appearance',
      'Editor',
      'Community plugins',
      'Account',
      'Froglight Pro',
      'Vault Sync',
      'Backups',
      'About',
    ]);
    // Focus lands in the search field.
    expect(
      document.activeElement?.classList.contains(styles['settings-search']),
    ).toBe(true);
  });

  it('contains late editor focus while allowing a nested dialog', async () => {
    const h = await start();
    await clickActivitySettings(h);
    const search = document.activeElement;
    const editor = document.createElement('textarea');
    document.body.append(editor);
    editor.focus();
    expect(document.activeElement).toBe(search);
    const nested = document.createElement('div');
    nested.setAttribute('role', 'alertdialog');
    const input = document.createElement('input');
    nested.append(input);
    document.body.append(nested);
    input.focus();
    expect(document.activeElement).toBe(input);
    nested.remove();
    editor.remove();
  });

  it('releases focus ownership as soon as its closing animation starts', async () => {
    const h = await start();
    await clickActivitySettings(h);
    const editor = document.createElement('textarea');
    document.body.append(editor);

    await pressKey('Escape');
    editor.focus();
    expect(document.activeElement).toBe(editor);

    await waitMs(200);
    expect(modalDialog(h)).toBeNull();
    expect(document.activeElement).toBe(editor);
    editor.remove();
  });

  it('restores dialog focus when reopened during its closing animation', async () => {
    const h = await start();
    await clickActivitySettings(h);

    await pressKey('Escape');
    expect(
      document.body
        .querySelector('[data-fl-component="settings-modal"]')
        ?.hasAttribute('data-closing'),
    ).toBe(true);
    await clickActivitySettings(h);

    expect(
      document.body
        .querySelector('[data-fl-component="settings-modal"]')
        ?.hasAttribute('data-closing'),
    ).toBe(false);
    expect(
      document.activeElement?.classList.contains(styles['settings-search']),
    ).toBe(true);
  });

  it('cancels a stale close when the bottom navigation reopens settings', async () => {
    const h = await start();
    const bottomSettings = h.root.querySelector<HTMLElement>(
      `.${workspaceStyles['fl-bottomnav']} [data-activity="settings"]`,
    )!;
    await act(async () => {
      bottomSettings.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
    });

    await pressKey('Escape');
    await act(async () => {
      bottomSettings.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
    });
    await waitMs(200);

    expect(modalDialog(h)).not.toBeNull();
    expect(
      document.activeElement?.classList.contains(styles['settings-search']),
    ).toBe(true);
  });

  it('Escape, the close button, and a backdrop click each close the modal', async () => {
    const h = await start();
    await clickActivitySettings(h);
    expect(modalDialog(h)).not.toBeNull();

    await pressKey('Escape');
    await waitMs(200);

    await clickActivitySettings(h);
    await click(h, '[aria-label="Close settings"]');
    await waitMs(200);

    await clickActivitySettings(h);
    await act(async () => {
      document.body
        .querySelector<HTMLElement>(`.${styles['settings-backdrop']}`)!
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await waitMs(200);
  });

  it('the first core section is active by default and renders its rows into the content pane', async () => {
    const h = await start();
    await clickActivitySettings(h);
    expect(
      document.body.querySelector<HTMLElement>(
        `.${styles['settings-nav-item']}.${styles.active}`,
      )?.dataset.name,
    ).toBe('Appearance');
    expect(
      document.body.querySelector<HTMLSelectElement>(
        '[data-setting-key="appearance.theme"]',
      )!.value,
    ).toBe('system');
    expect(
      document.body.querySelector<HTMLInputElement>(
        '[data-setting-key="editor.fontSize"]',
      ),
    ).not.toBeNull();
    // Appearance also hosts the app accent picker.
    expect(
      document.body.querySelector('[data-fl-component="accent-picker"]'),
    ).not.toBeNull();
  });

  it('changing a control persists through the workspace settings service and applies its effect', async () => {
    const h = await start();
    await clickActivitySettings(h);
    const select = document.body.querySelector<HTMLSelectElement>(
      '[data-setting-key="appearance.theme"]',
    )!;
    await act(async () => {
      setSelectValue(select, 'dark');
      await settle();
    });
    expect(
      h.ui.services
        .try(workspaceSettingsToken)!
        .get('appearance.theme', 'system'),
    ).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');

    // Reopening keeps the persisted value.
    await pressKey('Escape');
    await waitMs(200);
    await clickActivitySettings(h);
    expect(
      document.body.querySelector<HTMLSelectElement>(
        '[data-setting-key="appearance.theme"]',
      )!.value,
    ).toBe('dark');
  });

  it('the search field filters sections by name and keywords and shows an empty state', async () => {
    const h = await start();
    await clickActivitySettings(h);

    await typeQuery(h, 'theme');
    expect(navNames(h)).toEqual(['Appearance']);

    // accent keywords match Appearance only; the Pro tab is
    // sync-led status + subscription.
    await typeQuery(h, 'accent');
    expect(navNames(h)).toEqual(['Appearance']);

    await typeQuery(h, 'safe mode');
    expect(navNames(h)).toEqual(['Community plugins']);

    await typeQuery(h, 'zzzqqq');
    expect(navNames(h)).toEqual([]);
    expect(
      document.body.querySelector(`.${styles['settings-empty']}`)?.textContent,
    ).toContain('No settings match');
  });

  it('plugin sections appear and disappear with their slot; selection falls back to a core section', async () => {
    const h = await start();
    await h.runtime.registerSlot({
      id: 'plugin-section',
      plugin: pluginSectionOwner(),
    });

    await clickActivitySettings(h);
    expect(navNames(h)).toContain('My Plugin');
    await clickOnBody(
      `.${styles['settings-nav-item']}[data-section-id="test.plugin-section.main"]`,
    );
    expect(
      document.body.querySelector(`.${styles['settings-content']}`)!
        .textContent,
    ).toContain('plugin section body');

    await h.runtime.removeSlot('plugin-section');
    await until(() => navNames(h).every((name) => name !== 'My Plugin'));
    // The vanished section's content is replaced by a surviving section.
    expect(
      document.body.querySelector(`.${styles['settings-content']}`)!
        .textContent,
    ).not.toContain('plugin section body');
    expect(navNames(h).length).toBeGreaterThan(0);
  });

  it('the Open settings command opens the modal', async () => {
    const h = await start();
    const commands = await captureService(h, commandsToken);
    await act(async () => {
      commands.execute('froglight.settings.open');
      await settle();
    });
    expect(modalDialog(h)).not.toBeNull();
  });

  it('a dirty open editor is untouched behind the modal', async () => {
    const h = await start();
    h.controller.setPaneDirty('main', true);
    await clickActivitySettings(h);
    expect(modalDialog(h)).not.toBeNull();
    await pressKey('Escape');
    expect(
      h.root.querySelector(`.${workspaceStyles['fl-tab-dirty']}`),
    ).not.toBeNull();
    expect(h.controller.editorParentOf('main')).toBeInstanceOf(HTMLElement);
    expect(
      h.root.querySelector(
        `.${workspaceStyles['fl-tab']}.${workspaceStyles.active} .${workspaceStyles['fl-tab-label']}`,
      )?.textContent,
    ).toBe('welcome.md');
  });

  it('arrow keys move the section selection from the search field, and Tab is trapped inside', async () => {
    const h = await start();
    await clickActivitySettings(h);
    expect(activeSection(h)).toBe('Appearance');

    await pressKeyInSearch(h, 'ArrowDown');
    expect(activeSection(h)).toBe('Editor');
    await pressKeyInSearch(h, 'ArrowDown');
    expect(activeSection(h)).toBe('Community plugins');
    await pressKeyInSearch(h, 'ArrowUp');
    expect(activeSection(h)).toBe('Editor');

    // Tab cycles within the dialog: the last focusable wraps to the first.
    const dialog = modalDialog(h)!;
    const focusables = [
      ...dialog.querySelectorAll<HTMLElement>(
        'button, input, select, [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((element) => !element.hasAttribute('disabled'));
    const last = focusables[focusables.length - 1]!;
    last.focus();
    await act(async () => {
      // The keydown targets the focused element, as in a real browser.
      last.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
      await settle();
    });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(focusables[0]);
  });

  it('closing the modal restores focus to the invoking settings button', async () => {
    const h = await start();
    const settingsButton = h.root.querySelector<HTMLElement>(
      `.${workspaceStyles['fl-activity']} [data-activity="settings"]`,
    )!;
    await clickActivitySettings(h);
    expect(modalDialog(h)).not.toBeNull();
    await pressKey('Escape');
    await waitMs(200);
    expect(document.activeElement).toBe(settingsButton);
  });

  it('unloading the active section falls back to the first surviving section', async () => {
    const h = await start();
    await h.runtime.registerSlot({
      id: 'plugin-section',
      plugin: pluginSectionOwner(),
    });
    await clickActivitySettings(h);
    await clickOnBody(
      `.${styles['settings-nav-item']}[data-section-id="test.plugin-section.main"]`,
    );
    expect(activeSection(h)).toBe('My Plugin');

    await h.runtime.removeSlot('plugin-section');
    await until(() => navNames(h).every((name) => name !== 'My Plugin'));
    expect(activeSection(h)).toBe('Appearance');
    expect(
      document.body.querySelector(`.${styles['settings-content']}`)!
        .textContent,
    ).toContain('Base theme');
  });

  it('settings portals outside the contained workspace with a viewport marker', async () => {
    const h = await start();
    await clickActivitySettings(h);
    const backdrop = document.body.querySelector(
      '[data-fl-component="settings-modal"]',
    ) as HTMLElement | null;
    expect(backdrop).not.toBeNull();
    expect(backdrop!.hasAttribute('data-fl-viewport-overlay')).toBe(true);
    expect(
      backdrop!.closest(`.${workspaceStyles['froglight-layout']}`),
    ).toBeNull();
    expect(
      h.root.querySelector('[data-fl-component="settings-modal"]'),
    ).toBeNull();
  });

  // ------------------------------------------------------------ helpers

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

  async function clickActivitySettings(h: Harness): Promise<void> {
    const button = h.root.querySelector<HTMLElement>(
      `.${workspaceStyles['fl-activity']} [data-activity="settings"]`,
    )!;
    await act(async () => {
      // Real browsers focus a button on click; jsdom does not.
      button.focus();
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
    });
  }

  function modalDialog(_h: Harness): HTMLElement | null {
    // Settings portals to document.body (containing-block fix).
    return document.body.querySelector<HTMLElement>(
      `.${styles['settings-modal'].split(' ').join('.')}[role="dialog"]`,
    );
  }

  function navNames(_h: Harness): string[] {
    return [
      ...document.body.querySelectorAll<HTMLElement>(
        `.${styles['settings-nav-item']}`,
      ),
    ].map((item) => item.dataset.name!);
  }

  function activeSection(_h: Harness): string | undefined {
    return document.body.querySelector<HTMLElement>(
      `.${styles['settings-nav-item']}.${styles.active}`,
    )?.dataset.name;
  }

  async function pressKeyInSearch(_h: Harness, key: string): Promise<void> {
    await act(async () => {
      document.body
        .querySelector<HTMLElement>(`.${styles['settings-search']}`)!
        .dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      await settle();
    });
  }

  async function pressKey(key: string): Promise<void> {
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true }),
      );
      await settle();
    });
  }

  async function click(h: Harness, selector: string): Promise<void> {
    // Portal-aware: settings content lives in document.body, workspace
    // chrome lives in h.root. Prefer the workspace root, fall back to body.
    const element =
      h.root.querySelector<HTMLElement>(selector) ??
      document.body.querySelector<HTMLElement>(selector);
    expect(element).not.toBeNull();
    await act(async () => {
      element!.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      await settle();
    });
  }

  async function clickOnBody(selector: string): Promise<void> {
    const element = document.body.querySelector<HTMLElement>(selector);
    expect(element).not.toBeNull();
    await act(async () => {
      element!.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      await settle();
    });
  }

  async function typeQuery(_h: Harness, query: string): Promise<void> {
    const input = document.body.querySelector<HTMLInputElement>(
      `.${styles['settings-search']}`,
    )!;
    await act(async () => {
      setNativeValue(input, query);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await settle();
    });
  }
});

/**
 * A trusted plugin contributing one settings section through the registry —
 * the same seam a third-party plugin author would use.
 */
function pluginSectionOwner() {
  return definePlugin({
    id: 'test.plugin-section',
    requirements: { requires: [settingsRegistryToken] },
    activate: (ctx) => {
      const registry = ctx.require(settingsRegistryToken);
      ctx.effect(
        () =>
          registry.register({
            id: 'test.plugin-section.main',
            name: 'My Plugin',
            group: 'My Plugin',
            keywords: ['widget'],
            component: function PluginSectionBody() {
              return createElement('p', null, 'plugin section body');
            },
          }).dispose,
      );
    },
  });
}

async function captureService<T>(
  h: Harness,
  token: ServiceToken<T>,
  slotId = `test.capture-${Math.random().toString(36).slice(2)}`,
): Promise<T> {
  let captured: T | null = null;
  await h.runtime.registerSlot({
    id: slotId,
    plugin: definePlugin({
      id: slotId,
      requirements: { requires: [token] },
      activate: (ctx) => {
        captured = ctx.require(token);
      },
    }),
  });
  if (captured === null)
    throw new Error(`service for ${slotId} failed to activate`);
  return captured;
}

function setNativeValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!;
  setter.call(input, value);
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    'value',
  )!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}
