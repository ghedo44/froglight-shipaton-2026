// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CommunityPluginInfo,
  CommunityPluginManager,
} from '@froglight/plugin-platform';
import type { ViewDef } from '../view-registry.js';
import { CommunityPluginsView } from './CommunityPluginsView.jsx';
import styles from './CommunityPluginsView.module.css';
import overlayStyles from './Overlays.module.css';
import settingsStyles from './SettingsView.module.css';
import { ViewSlot } from './ViewSlot.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

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

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function communityView(
  manager: CommunityPluginManager,
  onChanged?: () => void,
): ViewDef {
  return {
    id: 'community-plugins',
    area: 'sidebar',
    title: 'Community plugins',
    component: () =>
      createElement(CommunityPluginsView, { manager, onChanged }),
  };
}

async function mountCommunity(
  manager: CommunityPluginManager,
  onChanged?: () => void,
): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      createElement(ViewSlot, { view: communityView(manager, onChanged) }),
    );
  });
  return host;
}

function unmount(): void {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
}

afterEach(unmount);

describe('community plugins React view (ViewSlot seam)', () => {
  it('maps every asserted class through the CSS module', () => {
    for (const name of [
      'community-banner',
      'warning',
      'community-banner-icon',
      'community-toolbar',
      'community-feedback',
      'community-list',
      'community-empty',
      'community-plugin-row',
      'community-plugin-main',
      'community-plugin-title',
      'community-plugin-controls',
      'community-perm-chips',
      'community-perm-chip',
      'community-plugin-error',
      'community-state-badge',
      'toggle',
      'toggle-knob',
      'on',
    ]) {
      expect(styles[name], `module class ${name}`).toMatch(/\S/);
    }
  });

  it('renders installed plugins with version, permission chips and state badge', async () => {
    const mounted = await mountCommunity(fakeManager([info()]));
    expect(mounted.querySelector('h2')?.textContent).toBe('Community plugins');
    expect(mounted.textContent).toContain('froglight.example 1.2.3');
    expect(
      mounted.querySelector(`.${styles['community-perm-chip']}`)?.textContent,
    ).toBe('workspace.commands.register');
    expect(
      mounted.querySelector(`.${styles['community-state-badge']}`)?.textContent,
    ).toBe('Disabled');
    // Trust tier labeling is honest and visible.
    expect(mounted.textContent).toContain('not sandboxed');
  });

  it('renders the banner, toolbar, feedback, and list skeleton', async () => {
    const mounted = await mountCommunity(fakeManager([info()]));
    expect(
      mounted.querySelector(`.${styles['community-banner']}.${styles.warning}`),
    ).not.toBeNull();
    expect(
      mounted.querySelector(`.${styles['community-banner-icon']}`),
    ).not.toBeNull();
    expect(
      mounted.querySelector(`.${styles['community-toolbar']}`),
    ).not.toBeNull();
    expect(
      mounted.querySelector(
        `.${styles['community-toolbar']} [data-fl-component="button"][data-variant="secondary"]`,
      ),
    ).not.toBeNull();
    const feedback = mounted.querySelector<HTMLElement>(
      `.${styles['community-feedback']}`,
    );
    expect(feedback).not.toBeNull();
    expect(feedback?.dataset.empty).toBe('true');
    expect(
      mounted.querySelector(`.${styles['community-list']}`),
    ).not.toBeNull();
    expect(
      mounted.querySelector(`.${styles['community-plugin-row']}`),
    ).not.toBeNull();
    expect(
      mounted.querySelector(`.${styles['community-plugin-controls']}`),
    ).not.toBeNull();
  });

  it('shows an empty state when no plugins are installed', async () => {
    const mounted = await mountCommunity(fakeManager([]));
    expect(
      mounted.querySelector(`.${styles['community-empty']}`)?.textContent,
    ).toMatch(/No community plugins/i);
  });

  it('toggling a disabled plugin enables it through the manager', async () => {
    const manager = fakeManager([info({ state: 'disabled' })]);
    const mounted = await mountCommunity(manager);
    const toggle = mounted.querySelector<HTMLButtonElement>(
      `.${styles['community-plugin-row']} .${styles.toggle}`,
    );
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    await act(async () => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
    });
    const badgeAfter = mounted.querySelector(
      `.${styles['community-state-badge']}`,
    )?.textContent;
    expect(badgeAfter).toBe('Enabled');
  });

  it('safe mode row reflects and drives the manager', async () => {
    const manager = fakeManager([info({ state: 'blocked-safe-mode' })], true);
    const mounted = await mountCommunity(manager);
    const rows = [
      ...mounted.querySelectorAll<HTMLElement>(
        `.${settingsStyles['settings-row']}`,
      ),
    ];
    const safeRow = rows.find((row) => row.textContent?.includes('Safe mode'));
    const toggle = safeRow?.querySelector<HTMLButtonElement>(
      `.${styles.toggle}`,
    );
    expect(toggle?.classList.contains(styles.on)).toBe(true);
    await act(async () => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
    });
    expect(manager.safeMode).toBe(false);
  });

  it('remove asks for confirmation and deletes via the manager', async () => {
    const manager = fakeManager([info()]);
    const mounted = await mountCommunity(manager);
    const removeButton =
      mounted.querySelector<HTMLButtonElement>('.community-remove');
    await act(async () => {
      removeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
    });
    // Confirm dialog is up; accept it.
    const confirmButton = document.querySelector<HTMLButtonElement>(
      `.${overlayStyles['froglight-modal'].split(' ').join('.')} [data-fl-component="button"][data-variant="danger"]`,
    );
    expect(confirmButton).toBeTruthy();
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
    });
    expect(manager.list()).toHaveLength(0);
    expect(
      document.querySelector(
        `.${overlayStyles['froglight-modal'].split(' ').join('.')}`,
      ),
    ).toBeNull();
  });
});
