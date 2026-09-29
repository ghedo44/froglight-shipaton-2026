// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, it, expect } from 'vitest';
import type {
  CommunityPluginInfo,
  CommunityPluginManager,
} from '@froglight/plugin-platform';
import { CommunityPluginsView } from './react/CommunityPluginsView.jsx';
import communityStyles from './react/CommunityPluginsView.module.css';
import overlayStyles from './react/Overlays.module.css';
import settingsStyles from './react/SettingsView.module.css';
import { ViewSlot } from './react/ViewSlot.jsx';

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

let root: Root | null = null;
let host: HTMLElement | null = null;

function mountSection(manager: CommunityPluginManager): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      createElement(ViewSlot, {
        view: {
          id: 'community-plugins',
          area: 'main',
          title: 'Community plugins',
          component: () => createElement(CommunityPluginsView, { manager }),
        },
      }),
    );
  });
  return host;
}

function unmount(): void {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

afterEach(() => {
  unmount();
});

describe('community plugins settings section', () => {
  it('renders installed plugins with version, permission chips and state badge', () => {
    const container = mountSection(fakeManager([info()]));
    expect(container.querySelector('h2')?.textContent).toBe(
      'Community plugins',
    );
    expect(container.textContent).toContain('froglight.example 1.2.3');
    expect(
      container.querySelector(`.${communityStyles['community-perm-chip']}`)
        ?.textContent,
    ).toBe('workspace.commands.register');
    expect(
      container.querySelector(`.${communityStyles['community-state-badge']}`)
        ?.textContent,
    ).toBe('Disabled');
    // Trust tier labeling is honest and visible.
    expect(container.textContent).toContain('not sandboxed');
  });

  it('shows an empty state when no plugins are installed', () => {
    const container = mountSection(fakeManager([]));
    expect(
      container.querySelector(`.${communityStyles['community-empty']}`)
        ?.textContent,
    ).toMatch(/No community plugins/i);
  });

  it('toggling a disabled plugin enables it through the manager', async () => {
    const container = mountSection(fakeManager([info({ state: 'disabled' })]));
    const toggle = container.querySelector<HTMLButtonElement>(
      `.${communityStyles['community-plugin-row']} .${communityStyles.toggle}`,
    );
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    await act(async () => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const badgeAfter = container.querySelector(
      `.${communityStyles['community-state-badge']}`,
    )?.textContent;
    expect(badgeAfter).toBe('Enabled');
  });

  it('safe mode row reflects and drives the manager', async () => {
    const manager = fakeManager([info({ state: 'blocked-safe-mode' })], true);
    const container = mountSection(manager);
    const rows = [
      ...container.querySelectorAll<HTMLElement>(
        `.${settingsStyles['settings-row']}`,
      ),
    ];
    const safeRow = rows.find((row) => row.textContent?.includes('Safe mode'));
    const toggle = safeRow?.querySelector<HTMLButtonElement>(
      `.${communityStyles.toggle}`,
    );
    expect(toggle?.classList.contains(communityStyles.on)).toBe(true);
    await act(async () => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(manager.safeMode).toBe(false);
  });

  it('remove asks for confirmation and deletes via the manager', async () => {
    const manager = fakeManager([info()]);
    const container = mountSection(manager);
    const removeButton =
      container.querySelector<HTMLButtonElement>('.community-remove');
    await act(async () => {
      removeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // Confirm dialog is up; accept it.
    const confirmButton = document.querySelector<HTMLButtonElement>(
      `.${overlayStyles['froglight-modal'].split(' ').join('.')} [data-fl-component="button"][data-variant="danger"]`,
    );
    expect(confirmButton).toBeTruthy();
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(manager.list()).toHaveLength(0);
    expect(
      document.querySelector(
        `.${overlayStyles['froglight-modal'].split(' ').join('.')}`,
      ),
    ).toBeNull();
  });
});
