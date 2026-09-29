// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { SDK_VERSION } from '@froglight/sdk';
import type {
  CommunityPluginInfo,
  CommunityPluginManager,
} from '@froglight/plugin-platform';
import type { ViewDef } from '../view-registry.js';
import {
  bindAppearanceToDocument,
  DEFAULT_VIEW_KEY,
  FONT_SIZE_KEY,
  THEME_KEY,
} from '../settings-view.js';
import type {
  WorkspaceSettingsService,
  WorkspaceSettingsValue,
} from '../workspace-settings.js';
import { mountIsolatedReactRoot } from './isolated-react-root.js';
import { ViewSlot } from './ViewSlot.jsx';
import communityStyles from './CommunityPluginsView.module.css';
import styles from './SettingsView.module.css';
import {
  AboutSettingsView,
  AppearanceSettingsView,
  CommunityPluginsSettingsView,
  EditorSettingsView,
} from './SettingsView.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function stubSettings(
  initial: Record<string, WorkspaceSettingsValue> = {},
): WorkspaceSettingsService & {
  readonly values: Record<string, WorkspaceSettingsValue>;
} {
  const values: Record<string, WorkspaceSettingsValue> = { ...initial };
  const listeners = new Set<
    (key: string, value: WorkspaceSettingsValue) => void
  >();
  const settings: WorkspaceSettingsService = {
    get<T extends WorkspaceSettingsValue>(key: string, defaultValue: T): T {
      const value = values[key];
      return (value === undefined ? defaultValue : value) as T;
    },
    set(key: string, value: WorkspaceSettingsValue): void {
      values[key] = value;
      for (const listener of [...listeners]) listener(key, value);
    },
    onChange(listener: (key: string, value: WorkspaceSettingsValue) => void): {
      dispose(): void;
    } {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  return { ...settings, values };
}

function info(
  overrides: Partial<CommunityPluginInfo> = {},
): CommunityPluginInfo {
  return {
    id: 'froglight.example',
    state: 'disabled',
    manifest: {
      manifestVersion: 1,
      id: 'froglight.example',
      version: '1.2.3',
      froglightSdk: '^0.1.0',
      permissions: ['workspace.commands.register'],
    },
    error: null,
    ...overrides,
  };
}

/** Deterministic in-memory manager double covering the surface the view uses. */
function fakeManager(initial: CommunityPluginInfo[] = [], safeMode = false) {
  let infos = initial;
  let safe = safeMode;
  const manager: CommunityPluginManager = {
    list: () => infos,
    get safeMode() {
      return safe;
    },
    setSafeMode: (on: boolean) => {
      safe = on;
      return Promise.resolve();
    },
    enable: (id: string) => {
      infos = infos.map((entry) =>
        entry.id === id ? { ...entry, state: 'active' } : entry,
      );
      return Promise.resolve();
    },
    disable: (id: string) => {
      infos = infos.map((entry) =>
        entry.id === id ? { ...entry, state: 'disabled' } : entry,
      );
      return Promise.resolve();
    },
    remove: (id: string) => {
      infos = infos.filter((entry) => entry.id !== id);
      return Promise.resolve();
    },
    sync: () => Promise.resolve(),
  } as unknown as CommunityPluginManager;
  return manager;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function mountView(view: ViewDef): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(createElement(ViewSlot, { view }));
  });
  return host;
}

function mountNode(node: ReactElement): HTMLElement {
  return mountView({
    id: 'test.settings-section',
    area: 'pane',
    title: 'Settings',
    component: () => node,
  });
}

function unmount(): void {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

afterEach(unmount);

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    'value',
  )!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function setSliderValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  });
}

function accentOption(mounted: ParentNode, id: string): HTMLButtonElement {
  const option = mounted.querySelector(
    `[data-fl-component="accent-option"][data-accent-id="${id}"]`,
  );
  if (option === null) throw new Error(`no accent option ${id}`);
  return option as HTMLButtonElement;
}

async function clickButton(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    await flush();
  });
}

describe('settings React views (ViewSlot seam)', () => {
  it('maps every asserted class through the CSS module', () => {
    for (const name of [
      'settings-section-title',
      'settings-row',
      'settings-row-text',
      'settings-row-label',
      'settings-row-description',
      'settings-control',
      'settings-select',
      'settings-select-chevron',
      'settings-slider',
      'settings-about',
      'settings-section',
    ]) {
      expect(styles[name], `module class ${name}`).toMatch(/\S/);
    }
  });

  it('appearance renders the frozen structure', () => {
    const mounted = mountNode(
      createElement(AppearanceSettingsView, { settings: stubSettings() }),
    );
    expect(
      mounted.querySelector(`h2.${styles['settings-section-title']}`)
        ?.textContent,
    ).toBe('Appearance');
    expect(
      [...mounted.querySelectorAll(`.${styles['settings-row-label']}`)].map(
        (row) => row.textContent,
      ),
    ).toEqual(['Base theme', 'Animations', 'Editor font size', 'App accent']);
    expect(
      [
        ...mounted.querySelectorAll(`.${styles['settings-row-description']}`),
      ].map((row) => row.textContent),
    ).toEqual([
      'Match your system, or force light/dark.',
      'Follow your system, or turn app animations on or off.',
      'Pick the accent color used across the app.',
    ]);
    const select = mounted.querySelector<HTMLSelectElement>(
      `select.${styles['settings-control']}[data-setting-key="appearance.theme"]`,
    )!;
    expect([...select.options].map((option) => option.value)).toEqual([
      'system',
      'light',
      'dark',
    ]);
    expect([...select.options].map((option) => option.text)).toEqual([
      'System',
      'Light',
      'Dark',
    ]);
    expect(select.value).toBe('system');
    expect(
      mounted.querySelector(
        `.${styles['settings-select-chevron']}[aria-hidden="true"] svg`,
      ),
    ).not.toBeNull();
    const slider = mounted.querySelector<HTMLInputElement>(
      `.${styles['settings-slider']} input[data-setting-key="editor.fontSize"]`,
    )!;
    expect(slider.type).toBe('range');
    expect([slider.min, slider.max, slider.step]).toEqual(['11', '24', '1']);
    expect(slider.value).toBe('14');
    expect(slider.getAttribute('aria-label')).toBe('Editor font size');
    // The font-size text holds only a label.
    const rows = mounted.querySelectorAll(`.${styles['settings-row']}`);
    expect(rows).toHaveLength(4);
    expect(rows[0]!.textContent).toContain('Base theme');
    expect(rows[1]!.textContent).toContain('Animations');
    expect(rows[2]!.textContent).toContain('Editor font size');
    expect(rows[3]!.textContent).toContain('App accent');
    expect(
      rows[2]!.querySelector(`.${styles['settings-row-description']}`),
    ).toBeNull();
    // The accent row hosts the shared picker (composition move).
    const picker = rows[3]!.querySelector(
      '[data-fl-component="accent-picker"]',
    );
    expect(picker).not.toBeNull();
    expect(
      picker!.querySelector(
        '[data-fl-component="accent-option"][data-accent-id="violet"]',
      ),
    ).not.toBeNull();
    expect(
      picker!.querySelector(
        '[data-fl-component="accent-option"][data-accent-id="ocean"]',
      ),
    ).not.toBeNull();
  });

  it('changing the theme persists through the settings service and applies its effect', async () => {
    const settings = stubSettings();
    const binding = bindAppearanceToDocument(settings);
    try {
      const mounted = mountNode(
        createElement(AppearanceSettingsView, { settings }),
      );
      const select = mounted.querySelector<HTMLSelectElement>(
        '[data-setting-key="appearance.theme"]',
      )!;
      await act(async () => {
        setSelectValue(select, 'dark');
      });
      expect(settings.get(THEME_KEY, 'system')).toBe('dark');
      expect(document.documentElement.dataset.theme).toBe('dark');
    } finally {
      binding.dispose();
      delete document.documentElement.dataset.theme;
      document.documentElement.style.removeProperty('--fl-editor-font-size');
      document.documentElement.style.removeProperty('--editor-font-size');
    }
  });

  it('reopening keeps persisted values', () => {
    const settings = stubSettings({ [THEME_KEY]: 'dark', [FONT_SIZE_KEY]: 18 });
    const mounted = mountNode(
      createElement(AppearanceSettingsView, { settings }),
    );
    expect(
      mounted.querySelector<HTMLSelectElement>(
        '[data-setting-key="appearance.theme"]',
      )!.value,
    ).toBe('dark');
    expect(
      mounted.querySelector<HTMLInputElement>(
        '[data-setting-key="editor.fontSize"]',
      )!.value,
    ).toBe('18');
  });

  it('dragging the font-size slider persists a number', async () => {
    const settings = stubSettings();
    const mounted = mountNode(
      createElement(AppearanceSettingsView, { settings }),
    );
    const slider = mounted.querySelector<HTMLInputElement>(
      '[data-setting-key="editor.fontSize"]',
    )!;
    await act(async () => {
      setSliderValue(slider, '18');
    });
    expect(settings.get(FONT_SIZE_KEY, 14)).toBe(18);
  });

  it('appearance offers every accent free with no lock, hint, or upsell', async () => {
    const settings = stubSettings();
    const mounted = mountNode(
      createElement(AppearanceSettingsView, { settings }),
    );
    await settle();
    const picker = mounted.querySelector(
      '[data-fl-component="accent-picker"]',
    )!;
    const options = [
      ...picker.querySelectorAll('[data-fl-component="accent-option"]'),
    ];
    expect(
      options.map((option) => option.getAttribute('data-accent-id')),
    ).toEqual(['forest', 'violet', 'ocean', 'ember', 'rose']);
    expect(accentOption(mounted, 'forest').dataset.selected).toBe('true');
    for (const option of options) {
      expect(option.hasAttribute('data-locked')).toBe(false);
      expect(option.getAttribute('aria-disabled')).toBeNull();
    }
    expect(picker.querySelector('[data-locked]')).toBeNull();
    expect(picker.textContent).not.toMatch(/unlock/i);
    expect(picker.textContent).not.toMatch(/Froglight Pro/);
    expect(picker.textContent).not.toMatch(/below/i);
    await clickButton(accentOption(mounted, 'ocean'));
    expect(settings.values['appearance.accent']).toBe('ocean');
  });

  it('appearance records every accent selection without a purchase provider', async () => {
    const settings = stubSettings();
    const mounted = mountNode(
      createElement(AppearanceSettingsView, { settings }),
    );
    await settle();
    for (const id of ['forest', 'violet', 'ocean', 'ember', 'rose']) {
      await clickButton(accentOption(mounted, id));
      expect(settings.values['appearance.accent']).toBe(id);
    }
  });

  it('appearance follows external accent changes without a remount', async () => {
    const settings = stubSettings();
    const mounted = mountNode(
      createElement(AppearanceSettingsView, { settings }),
    );
    await settle();
    expect(accentOption(mounted, 'ocean').dataset.selected).toBe('false');
    await act(async () => {
      settings.set('appearance.accent', 'ocean');
    });
    expect(accentOption(mounted, 'ocean').dataset.selected).toBe('true');
    expect(accentOption(mounted, 'forest').dataset.selected).toBe('false');
  });

  it('editor renders the frozen structure and persists its select', async () => {
    const settings = stubSettings();
    const mounted = mountNode(createElement(EditorSettingsView, { settings }));
    expect(
      mounted.querySelector(`h2.${styles['settings-section-title']}`)
        ?.textContent,
    ).toBe('Editor');
    expect(
      mounted.querySelector(`.${styles['settings-row-label']}`)?.textContent,
    ).toBe('Default view mode');
    expect(
      mounted.querySelector(`.${styles['settings-row-description']}`)
        ?.textContent,
    ).toBe('How notes open: editing, reading, or split where supported.');
    const select = mounted.querySelector<HTMLSelectElement>(
      `select.${styles['settings-control']}[data-setting-key="workspace.defaultView"]`,
    )!;
    expect([...select.options].map((option) => option.value)).toEqual([
      'edit',
      'reading',
      'split',
    ]);
    expect([...select.options].map((option) => option.text)).toEqual([
      'Editing',
      'Reading',
      'Split',
    ]);
    expect(select.value).toBe('edit');
    await act(async () => {
      setSelectValue(select, 'split');
    });
    expect(settings.get(DEFAULT_VIEW_KEY, 'edit')).toBe('split');
  });

  it('about renders the frozen copy', () => {
    const mounted = mountNode(createElement(AboutSettingsView));
    expect(
      mounted.querySelector(`h2.${styles['settings-section-title']}`)
        ?.textContent,
    ).toBe('About');
    const paragraphs = [
      ...mounted.querySelectorAll(`p.${styles['settings-about']}`),
    ];
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]!.textContent).toBe(`Froglight · SDK ${SDK_VERSION}`);
    expect(paragraphs[1]!.textContent).toContain('plain Markdown files');
  });

  it('community without a vault renders the placeholder', () => {
    const mounted = mountNode(createElement(CommunityPluginsSettingsView, {}));
    expect(
      mounted.querySelector(`h2.${styles['settings-section-title']}`)
        ?.textContent,
    ).toBe('Community plugins');
    expect(
      mounted.querySelector(`p.${styles['settings-about']}`)?.textContent,
    ).toBe('Open a vault to manage community plugins.');
    expect(
      mounted.querySelector(`.${communityStyles['community-banner']}`),
    ).toBeNull();
  });

  it('community with a manager hosts the full plugins surface', () => {
    const mounted = mountNode(
      createElement(CommunityPluginsSettingsView, {
        resolveCommunity: () => fakeManager([info()]),
      }),
    );
    expect(
      mounted.querySelector(`.${styles['settings-section']} h2`)?.textContent,
    ).toBe('Community plugins');
    expect(mounted.textContent).toContain('froglight.example 1.2.3');
    expect(
      mounted.querySelector(`.${communityStyles['community-perm-chip']}`)
        ?.textContent,
    ).toBe('workspace.commands.register');
    expect(
      mounted.querySelector(`.${communityStyles['community-state-badge']}`)
        ?.textContent,
    ).toBe('Disabled');
    expect(mounted.textContent).toContain('not sandboxed');
    expect(mounted.textContent).toContain('Safe mode');
  });

  it('community with no plugins shows its empty state', () => {
    const mounted = mountNode(
      createElement(CommunityPluginsSettingsView, {
        resolveCommunity: () => fakeManager([]),
      }),
    );
    expect(
      mounted.querySelector(`.${communityStyles['community-empty']}`)
        ?.textContent,
    ).toMatch(/No community plugins/i);
  });

  it('toggling a hosted plugin enables it through the manager', async () => {
    const mounted = mountNode(
      createElement(CommunityPluginsSettingsView, {
        resolveCommunity: () => fakeManager([info({ state: 'disabled' })]),
      }),
    );
    const toggle = mounted.querySelector<HTMLButtonElement>(
      `.${communityStyles['community-plugin-row']} .${communityStyles.toggle}`,
    )!;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await act(async () => {
      toggle.click();
      await flush();
    });
    expect(
      mounted.querySelector(`.${communityStyles['community-state-badge']}`)
        ?.textContent,
    ).toBe('Enabled');
  });

  it('the isolated root mounts and clears a section on dispose', () => {
    const container = document.createElement('div');
    container.textContent = 'stale';
    document.body.appendChild(container);
    try {
      let mounted = null as unknown as { dispose(): void };
      act(() => {
        mounted = mountIsolatedReactRoot(
          container,
          createElement(AboutSettingsView),
        );
      });
      expect(
        container.querySelector(`h2.${styles['settings-section-title']}`)
          ?.textContent,
      ).toBe('About');
      act(() => {
        mounted.dispose();
      });
      expect(container.querySelector('h2')).toBeNull();
    } finally {
      container.remove();
    }
  });
});
