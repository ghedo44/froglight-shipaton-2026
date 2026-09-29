// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountFroglightApp, type WorkbenchMount } from '../workbench.js';
import { workspaceSettingsToken } from '../workspace-settings.js';
import {
  chromeDouble,
  createHarness,
  makeChoice,
  settle,
  until,
  type Harness,
} from './test-support.js';
import launcherStyles from './LauncherView.module.css';
import overlayStyles from './Overlays.module.css';
import titlebarStyles from './Titlebar.module.css';
import workspaceStyles from './WorkspaceView.module.css';
import type { WindowChrome } from '../window-chrome.js';

const mounts: WorkbenchMount[] = [];

// jsdom has neither ResizeObserver nor a canvas implementation; the graph
// pane tab only needs to mount and render its container.
class ResizeObserverStub {
  observe(): void {
    return undefined;
  }
  disconnect(): void {
    return undefined;
  }
  unobserve(): void {
    return undefined;
  }
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;
HTMLCanvasElement.prototype.getContext = (() =>
  new Proxy(
    {},
    {
      get: () => () => undefined,
      set: () => true,
    },
  )) as unknown as HTMLCanvasElement['getContext'];

afterEach(async () => {
  for (const mount of mounts.splice(0)) {
    await mount.dispose();
  }
  document.body.innerHTML = '';
  // the medium-sidebar test stubs matchMedia without restoring it.
  // A leaked stub forces every later test's responsive policy off the wide
  // desktop fixture (1024px reads as medium, not wide), so the sidebar
  // resizers never render and resize tests fail with dispatchEvent-on-null.
  // Unstub after every test; per-test width overrides already restore via
  // try/finally and are unaffected.
  vi.unstubAllGlobals();
});

async function start(
  documents?: Parameters<typeof createHarness>[1],
  chrome?: WindowChrome,
): Promise<{
  h: Harness;
  root: HTMLElement;
}> {
  const choice = makeChoice({ id: 'v', name: 'My Vault' });
  const h = await createHarness(
    [choice],
    documents ?? [
      { documentId: 'doc-1', path: 'notes/welcome.md', text: '# Welcome' },
      { documentId: 'doc-2', path: 'second.md', text: '# Second' },
    ],
  );
  const root = document.body.appendChild(document.createElement('div'));
  h.root = root;
  await act(async () => {
    mounts.push(
      await mountFroglightApp(root, h.controller, h.adapter, h.ui, {
        windowChrome: chrome,
      }),
    );
  });
  // Activate through the launcher UI, then wait for the workspace shell.
  await act(async () => {
    root
      .querySelector<HTMLElement>(`.${launcherStyles['recent-vault-card']}`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
  });

  await until(() => h.controller.calls.initialize > 0);
  await until(
    () => root.querySelector('[data-fl-component="titlebar"]') !== null,
  );
  await settle();
  return { h, root };
}

function pointer(
  element: Element,
  type: string,
  init: { clientX?: number; clientY?: number; button?: number } = {},
): void {
  element.dispatchEvent(
    new MouseEvent(type, {
      bubbles: type !== 'pointerenter' && type !== 'pointerleave',
      cancelable: true,
      button: init.button ?? 0,
      clientX: init.clientX ?? 0,
      clientY: init.clientY ?? 0,
    }),
  );
}

async function pressKey(
  key: string,
  init: KeyboardEventInit = {},
): Promise<void> {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        ctrlKey: true,
        bubbles: true,
        ...init,
      }),
    );
    await settle();
  });
}

describe('workspace dock', () => {
  it('keeps sidebar controls in the activity rail and avoids duplicate vault chrome', async () => {
    const { root } = await start();

    const rail = root.querySelector(`.${workspaceStyles['fl-activity']}`)!;
    expect(rail.querySelector('[aria-label="Toggle sidebar"]')).not.toBeNull();
    expect(
      rail
        .querySelector('[aria-label="Toggle sidebar"]')
        ?.getAttribute('aria-controls'),
    ).toBe('workspace-sidebar');
    expect(
      rail
        .querySelector('[aria-label="Toggle sidebar"]')
        ?.nextElementSibling?.getAttribute('data-activity'),
    ).toBe('search');
    expect(root.querySelector('#workspace-sidebar')).not.toBeNull();
    expect(
      root.querySelector(
        '[data-fl-component="titlebar"] [aria-label="Toggle sidebar"]',
      ),
    ).toBeNull();
    expect(
      root.querySelector(
        '[data-fl-component="titlebar"] .workspace-vault-identity',
      ),
    ).toBeNull();
    const tab = root.querySelector(`.${workspaceStyles['fl-tab']}`)!;
    expect(tab.querySelector('[role="tab"]')).not.toBeNull();
    expect(
      tab.querySelector(`.${workspaceStyles['fl-tab-close']}`)?.tagName,
    ).toBe('BUTTON');
    expect(tab.querySelectorAll('button').length).toBe(2);
  });

  it('keeps the mobile sidebar opener first and the vault identity in the drawer', async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 640,
    });
    try {
      const { root } = await start();
      const titlebar = root.querySelector('[data-fl-component="titlebar"]')!;
      expect(titlebar.querySelector('[aria-label="Open sidebar"]')).toBe(
        titlebar.querySelector(`.${workspaceStyles['titlebar-toggle']}`),
      );
      expect(titlebar.querySelector('.workspace-vault-identity')).toBeNull();
      expect(
        root.querySelector(
          `.${workspaceStyles['fl-sidebar']} .${workspaceStyles['workspace-vault-name']}`,
        ),
      ).not.toBeNull();
      const opener = titlebar.querySelector<HTMLElement>(
        `.${workspaceStyles['titlebar-toggle']}`,
      );
      await act(async () => {
        opener?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await settle();
      });
      expect(
        root
          .querySelector(`.${workspaceStyles['fl-sidebar']}`)
          ?.classList.contains(workspaceStyles.open),
      ).toBe(true);
      expect(
        root
          .querySelector(`.${workspaceStyles['fl-sidebar']}`)
          ?.classList.contains(workspaceStyles.closed),
      ).toBe(false);
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: originalWidth,
      });
    }
  });

  it('uses the activity-rail opener as the only medium sidebar control', async () => {
    const originalWidth = window.innerWidth;
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 900,
    });
    try {
      const { root } = await start();
      const railOpener = root.querySelector<HTMLElement>(
        `.${workspaceStyles['fl-activity']} [aria-label="Toggle sidebar"]`,
      );
      expect(railOpener).not.toBeNull();
      expect(
        root.querySelector(
          '[data-fl-component="titlebar"] [aria-label="Open sidebar"]',
        ),
      ).toBeNull();
      expect(railOpener?.getAttribute('aria-expanded')).toBe('false');

      await act(async () => {
        railOpener?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await settle();
      });

      expect(
        root
          .querySelector(`.${workspaceStyles['fl-sidebar']}`)
          ?.classList.contains(workspaceStyles.open),
      ).toBe(true);
      expect(railOpener?.getAttribute('aria-expanded')).toBe('true');
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: originalWidth,
      });
    }
  });

  it('renders only the focused pane from a persisted split on phones', async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    });
    try {
      const { h, root } = await start();
      const second = h.controller.splitPane('main', 'right');
      const third = h.controller.splitPane(second, 'down');
      await until(
        () =>
          root
            .querySelector(`.${workspaceStyles['fl-pane']}`)
            ?.getAttribute('data-pane') === third,
      );

      expect(
        root.querySelectorAll(`.${workspaceStyles['fl-pane']}`),
      ).toHaveLength(1);
      expect(root.querySelector(`.${workspaceStyles['fl-split']}`)).toBeNull();
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: originalWidth,
      });
    }
  });

  it('does not expose split targets or create a split from a phone shortcut', async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    });
    try {
      const { root } = await start();
      const tab = root.querySelector<HTMLElement>(
        `.${workspaceStyles['fl-tab']}`,
      )!;
      pointer(tab, 'pointerdown', { clientX: 20, clientY: 20 });
      pointer(tab, 'pointermove', { clientX: 45, clientY: 20 });
      await settle();

      expect(
        root.querySelector(`.${workspaceStyles['fl-dropzone']}`),
      ).toBeNull();
      await pressKey('\\');
      expect(
        root.querySelectorAll(`.${workspaceStyles['fl-pane']}`),
      ).toHaveLength(1);
      expect(root.querySelector(`.${workspaceStyles['fl-split']}`)).toBeNull();
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: originalWidth,
      });
    }
  });

  it('routes a tab dropped on a pane edge into a new side-by-side pane', async () => {
    const { h, root } = await start();
    const tab = root.querySelector<HTMLElement>(
      `.${workspaceStyles['fl-topbar-strip']} .${workspaceStyles['fl-tab']}`,
    )!;

    await act(async () => {
      pointer(tab, 'pointerdown', { clientX: 40, clientY: 30 });
      await settle();
    });
    pointer(tab, 'pointermove', { clientX: 60, clientY: 40 });
    await until(
      () =>
        root.querySelector(
          `.${workspaceStyles['fl-dropzone']}[data-zone="right"]`,
        ) !== null,
    );

    const rightZone = root.querySelector<HTMLElement>(
      `.${workspaceStyles['fl-dropzone']}[data-zone="right"]`,
    )!;
    const originalElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => rightZone,
    });
    window.dispatchEvent(
      new MouseEvent('pointermove', {
        bubbles: true,
        clientX: 600,
        clientY: 200,
      }),
    );
    await until(() => rightZone.classList.contains(workspaceStyles.active));
    expect(
      rightZone.querySelector(`.${workspaceStyles['fl-dropzone-label']}`)
        ?.textContent,
    ).toBe('Split right');
    window.dispatchEvent(
      new MouseEvent('pointerup', {
        bubbles: true,
        clientX: 600,
        clientY: 200,
      }),
    );
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: originalElementFromPoint,
    });
    await settle();

    await until(
      () =>
        root.querySelectorAll(`.${workspaceStyles['fl-pane']}`).length === 2,
    );
    expect(h.controller.dockState().root?.kind).toBe('split');
    expect(
      h.controller.paneStates().some((pane) => pane.tabs.length === 1),
    ).toBe(true);
  });

  it('reattaches both documents after a tab split and collapse replace pane hosts', async () => {
    const { h, root } = await start();
    await act(async () => {
      root.dispatchEvent(
        new CustomEvent('froglight:open', {
          detail: { documentId: 'doc-2' },
          bubbles: true,
        }),
      );
      await settle();
    });
    await until(
      () =>
        root.querySelectorAll(
          `[data-pane-strip="main"] .${workspaceStyles['fl-tab']}`,
        ).length === 2,
    );

    const dragTabTo = async (
      tab: HTMLElement,
      zoneSelector: string,
    ): Promise<void> => {
      await act(async () => {
        pointer(tab, 'pointerdown', { clientX: 40, clientY: 30 });
        await settle();
      });
      await act(async () => {
        pointer(tab, 'pointermove', { clientX: 60, clientY: 40 });
        await settle();
      });
      await until(() => root.querySelector(zoneSelector) !== null);
      const zone = root.querySelector<HTMLElement>(zoneSelector);
      if (zone === null) throw new Error(`missing drop zone ${zoneSelector}`);
      const originalElementFromPoint = document.elementFromPoint;
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: () => zone,
      });
      await act(async () => {
        window.dispatchEvent(
          new MouseEvent('pointermove', {
            bubbles: true,
            clientX: 600,
            clientY: 200,
          }),
        );
        await settle();
      });
      await until(() => zone.classList.contains(workspaceStyles.active));
      await act(async () => {
        window.dispatchEvent(
          new MouseEvent('pointerup', {
            bubbles: true,
            clientX: 600,
            clientY: 200,
          }),
        );
        await settle();
      });
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: originalElementFromPoint,
      });
      await settle();
    };

    const mainTab = root.querySelector<HTMLElement>(
      `[data-pane-strip="main"] .${workspaceStyles['fl-tab']}.${workspaceStyles.active}`,
    );
    if (mainTab === null) throw new Error('missing active main tab');
    await dragTabTo(
      mainTab,
      `.${workspaceStyles['fl-pane']}[data-pane="main"] .${workspaceStyles['fl-dropzone']}[data-zone="right"]`,
    );
    await until(
      () =>
        root.querySelectorAll(`.${workspaceStyles['fl-pane']}`).length === 2,
    );
    const splitPane = h.controller.leafIds().find((pane) => pane !== 'main');
    if (splitPane === undefined) throw new Error('missing split pane');
    await until(
      () =>
        h.controller.editorParentOf('main') ===
          root.querySelector(
            `.${workspaceStyles['fl-pane']}[data-pane="main"] .fl-pane-editor`,
          ) &&
        h.controller.editorParentOf(splitPane) ===
          root.querySelector(
            `.${workspaceStyles['fl-pane']}[data-pane="${splitPane}"] .fl-pane-editor`,
          ),
    );

    const splitTab = root.querySelector<HTMLElement>(
      `[data-pane-strip="${splitPane}"] .${workspaceStyles['fl-tab']}.${workspaceStyles.active}`,
    );
    if (splitTab === null) throw new Error('missing active split tab');
    await dragTabTo(
      splitTab,
      `.${workspaceStyles['fl-pane']}[data-pane="main"] .${workspaceStyles['fl-dropzone']}[data-zone="center"]`,
    );
    await until(
      () =>
        root.querySelectorAll(`.${workspaceStyles['fl-pane']}`).length === 1,
    );
    await until(
      () =>
        h.controller.editorParentOf('main') ===
        root.querySelector(
          `.${workspaceStyles['fl-pane']}[data-pane="main"] .fl-pane-editor`,
        ),
    );
    expect(
      root.querySelectorAll(
        `[data-pane-strip="main"] .${workspaceStyles['fl-tab']}`,
      ),
    ).toHaveLength(2);
  });

  it('removes a closed pane so the remaining pane owns the full dock', async () => {
    const { h, root } = await start();
    await pressKey('\\');
    await until(
      () =>
        root.querySelectorAll(`.${workspaceStyles['fl-pane']}`).length === 2,
    );

    const close = root.querySelector<HTMLElement>(
      `.${workspaceStyles['fl-topbar-strip']} [data-pane-strip="main"] .${workspaceStyles['fl-tab-close']}`,
    );
    expect(close).not.toBeNull();
    await act(async () => {
      close!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
    });

    await until(
      () =>
        root.querySelectorAll(`.${workspaceStyles['fl-pane']}`).length === 1,
    );
    expect(root.querySelector(`.${workspaceStyles['fl-split']}`)).toBeNull();
    expect(
      root
        .querySelector(`.${workspaceStyles['fl-pane']}`)
        ?.getAttribute('data-pane'),
    ).toBe('pane-2');
    expect(h.controller.leafIds()).toEqual(['pane-2']);
  });

  it('aligns one topbar strip above each top-row pane with matching weights', async () => {
    const { h, root } = await start();
    await pressKey('\\');
    await until(
      () =>
        root.querySelectorAll(`.${workspaceStyles['fl-pane']}`).length === 2,
    );

    const strips = [
      ...root.querySelectorAll<HTMLElement>(
        `.${workspaceStyles['fl-topbar-strip']}`,
      ),
    ];
    expect(strips.length).toBe(2);
    expect(
      strips.map((strip) =>
        strip
          .querySelector(`.${workspaceStyles.tabstrip}`)
          ?.getAttribute('data-pane-strip'),
      ),
    ).toEqual(['main', 'pane-2']);
    // 50/50 split → equal flex weights around the mirrored divider gutter.
    const parts = [
      ...root.querySelectorAll<HTMLElement>(
        `.${workspaceStyles['fl-topbar-row']} > .${workspaceStyles['fl-strip-split']} > .${workspaceStyles['fl-strip-part']}`,
      ),
    ];
    const weights = parts.map((part) => Number(part.style.flexGrow || 0));
    expect(weights[0]).toBeCloseTo(0.5, 5);
    expect(weights[1]).toBeCloseTo(0.5, 5);
    // The top bar mirrors the dock's fixed divider gutter instead of
    // distributing that width into the pane strips.
    expect(
      root.querySelectorAll(
        `.${workspaceStyles['fl-topbar-row']} .${workspaceStyles['fl-strip-divider']}`,
      ),
    ).toHaveLength(1);
    // The panes themselves carry no duplicate inline strip.
    expect(
      root.querySelectorAll(
        `.${workspaceStyles['fl-pane']} .${workspaceStyles.tabstrip}`,
      ).length,
    ).toBe(0);
    void h;
  });

  it('keeps caption controls at the window edge outside the inspector lane', async () => {
    const chrome = chromeDouble();
    const { root } = await start(undefined, chrome);
    const titlebar = root.querySelector('[data-fl-component="titlebar"]')!;
    const inspectorLane = titlebar.querySelector(
      `.${workspaceStyles['fl-titlebar-inspector']}`,
    )!;

    expect(inspectorLane).not.toBeNull();
    expect(
      inspectorLane.querySelector('[aria-label="Toggle document sidebar"]'),
    ).toBeNull();
    expect(
      titlebar.querySelector('[aria-label="Toggle document sidebar"]'),
    ).not.toBeNull();
    expect(
      inspectorLane.querySelector(`.${workspaceStyles['right-sidebar-tabs']}`),
    ).toBeNull();
    expect(
      titlebar.querySelector(`.${titlebarStyles['fl-wincontrols']}`),
    ).not.toBeNull();
    expect(
      inspectorLane.querySelector(`.${titlebarStyles['fl-wincontrols']}`),
    ).toBeNull();
  });

  it('drags the native window from empty tab-strip space without starting a pane drag', async () => {
    const startDragging = vi.fn(() => Promise.resolve());
    const chrome = chromeDouble({ startDragging });
    const { root } = await start(undefined, chrome);
    const emptyStripSpace = root.querySelector<HTMLElement>(
      `.${workspaceStyles['tabstrip-tabs']}`,
    )!;

    pointer(emptyStripSpace, 'pointerdown', { clientX: 320, clientY: 18 });
    window.dispatchEvent(
      new MouseEvent('pointermove', {
        bubbles: true,
        clientX: 360,
        clientY: 18,
      }),
    );
    await settle();

    expect(startDragging).toHaveBeenCalledTimes(1);
    expect(
      root.querySelector(`.${workspaceStyles['fl-dropzones']}`),
    ).toBeNull();
  });

  it('resizes and clamps both desktop sidebars, including keyboard control', async () => {
    const { h, root } = await start();
    await act(async () => {
      root
        .querySelector<HTMLElement>('[aria-label="Toggle document sidebar"]')
        ?.click();
      await settle();
    });
    const layout = root.querySelector<HTMLElement>(
      '[data-fl-component="workspace"]',
    )!;
    const left = root.querySelector<HTMLElement>(
      '[aria-label="Resize workspace sidebar"]',
    )!;
    const right = root.querySelector<HTMLElement>(
      '[aria-label="Resize document sidebar"]',
    )!;

    await act(async () => {
      pointer(left, 'pointerdown', { clientX: 264 });
      await settle();
      window.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientX: 900 }),
      );
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
      await settle();
    });
    expect(layout.style.getPropertyValue('--fl-layout-sidebar-width')).toBe(
      '420px',
    );
    expect(left.getAttribute('aria-valuenow')).toBe('420');

    await act(async () => {
      right.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
      );
      await settle();
    });
    expect(
      layout.style.getPropertyValue('--fl-layout-right-sidebar-width'),
    ).toBe('240px');
    expect(right.getAttribute('aria-valuenow')).toBe('240');
    expect(
      h.ui.services
        .try(workspaceSettingsToken)!
        .get('workspace.sidebar.width', 0),
    ).toBe(420);
    expect(
      h.ui.services
        .try(workspaceSettingsToken)!
        .get('workspace.rightSidebar.width', 0),
    ).toBe(240);
  });

  it('releases a stale sidebar resize before the next native window drag', async () => {
    const startDragging = vi.fn(() => Promise.resolve());
    const { root } = await start(undefined, chromeDouble({ startDragging }));
    const layout = root.querySelector<HTMLElement>(
      '[data-fl-component="workspace"]',
    )!;
    const resizer = root.querySelector<HTMLElement>(
      '[aria-label="Resize workspace sidebar"]',
    )!;
    const emptyStripSpace = root.querySelector<HTMLElement>(
      `.${workspaceStyles['tabstrip-tabs']}`,
    )!;

    await act(async () => {
      pointer(resizer, 'pointerdown', { clientX: 264 });
      await settle();
    });
    expect(layout.classList.contains(workspaceStyles['sidebar-resizing'])).toBe(
      true,
    );

    await act(async () => {
      pointer(emptyStripSpace, 'pointerdown', { clientX: 320, clientY: 18 });
      await settle();
    });
    expect(layout.classList.contains(workspaceStyles['sidebar-resizing'])).toBe(
      false,
    );
    expect(startDragging).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite rapid background opens while split panes mount', async () => {
    const { h, root } = await start([
      { documentId: 'doc-1', path: 'one.md', text: '# One' },
      { documentId: 'doc-2', path: 'two.md', text: '# Two' },
      { documentId: 'doc-3', path: 'three.md', text: '# Three' },
    ]);

    await act(async () => {
      root.dispatchEvent(
        new CustomEvent('froglight:open-background', {
          detail: { documentId: 'doc-2' },
          bubbles: true,
        }),
      );
      root.dispatchEvent(
        new CustomEvent('froglight:open-background', {
          detail: { documentId: 'doc-3' },
          bubbles: true,
        }),
      );
      await settle();
    });

    await until(() => h.controller.calls.openDocument.length >= 3);
    const openTabs = h.controller
      .paneStates()
      .flatMap((pane) => pane.tabs)
      .filter((tab) => tab.kind === 'document')
      .map((tab) => tab.documentId);
    expect(openTabs).toEqual(
      expect.arrayContaining(['doc-1', 'doc-2', 'doc-3']),
    );
    expect(openTabs.filter((id) => id === 'doc-2')).toHaveLength(1);
    expect(openTabs.filter((id) => id === 'doc-3')).toHaveLength(1);
  });

  it('preserves every tab from rapid opens into the same pane', async () => {
    const { h, root } = await start([
      { documentId: 'doc-1', path: 'one.md', text: '# One' },
      { documentId: 'doc-2', path: 'two.md', text: '# Two' },
      { documentId: 'doc-3', path: 'three.md', text: '# Three' },
    ]);

    await act(async () => {
      for (const documentId of ['doc-2', 'doc-3']) {
        root.dispatchEvent(
          new CustomEvent('froglight:open', {
            detail: { documentId },
            bubbles: true,
          }),
        );
      }
      await settle();
    });

    await until(() => h.controller.calls.openDocument.length >= 3);
    const main = h.controller.paneStates().find((pane) => pane.pane === 'main');
    expect(main?.tabs.map((tab) => tab.documentId)).toEqual([
      'doc-1',
      'doc-2',
      'doc-3',
    ]);
    // Rapid A→B opens end with B active: the shell mailbox fires in order
    // and the controller queue is the only promise serializer (#44).
    expect(main?.activeTab).toBe('doc-3');
  });

  it('supports three side-by-side panes', async () => {
    const { root } = await start();
    await pressKey('\\');
    await until(
      () =>
        root.querySelectorAll(`.${workspaceStyles['fl-pane']}`).length === 2,
    );
    // Focus returns to the fresh pane; splitting again makes three in a row.
    await pressKey('\\');
    await until(
      () =>
        root.querySelectorAll(`.${workspaceStyles['fl-pane']}`).length === 3,
    );
    expect(
      root.querySelectorAll(`.${workspaceStyles['fl-topbar-strip']}`).length,
    ).toBe(3);
    const directions = [
      ...root.querySelectorAll(`.${workspaceStyles['fl-split']}`),
    ].map((split) => split.getAttribute('data-direction'));
    expect(directions).toContain('horizontal');
  });

  it('vertical splits keep deeper strips attached to their pane band', async () => {
    const { h, root } = await start();
    // Split right: main | pane-2. Then split pane-2 down: pane-3 below it.
    await pressKey('\\');
    await until(
      () =>
        root.querySelectorAll(`.${workspaceStyles['fl-pane']}`).length === 2,
    );
    await pressKey('\\', { shiftKey: true });
    await until(
      () =>
        root.querySelectorAll(`.${workspaceStyles['fl-pane']}`).length === 3,
    );

    const rows = root.querySelectorAll(`.${workspaceStyles['fl-topbar-row']}`);
    expect(rows.length).toBe(1);
    // The window top bar owns only the first horizontal band: main | pane-2.
    const row0Parts = [
      ...rows[0]!.querySelectorAll<HTMLElement>(
        `:scope > .${workspaceStyles['fl-strip-split']} > .${workspaceStyles['fl-strip-part']}`,
      ),
    ];
    expect(row0Parts).toHaveLength(2);
    expect(Number(row0Parts[0]!.style.flexGrow)).toBeCloseTo(0.5, 5);
    expect(Number(row0Parts[1]!.style.flexGrow)).toBeCloseTo(0.5, 5);
    // pane-3's strip is inside the lower vertical band, aligned to pane-2.
    expect(
      root
        .querySelector(
          `.${workspaceStyles['fl-band-strips']} .${workspaceStyles.tabstrip}`,
        )
        ?.getAttribute('data-pane-strip'),
    ).toBe(h.controller.leafIds()[2]);
    expect(
      root.querySelector(`.${workspaceStyles['fl-band-strips']}`),
    ).not.toBeNull();
    // Pane bodies render content only; the attached band owns the strip.
    expect(
      root.querySelectorAll(
        `.${workspaceStyles['fl-pane']} .${workspaceStyles.tabstrip}`,
      ).length,
    ).toBe(0);
  });

  it('keeps per-tab reading modes while removing redundant document header chrome', async () => {
    const { h, root } = await start();
    // Open a second tab in main.
    await act(async () => {
      root.dispatchEvent(
        new CustomEvent('froglight:open', {
          detail: { documentId: 'doc-2' },
          bubbles: true,
        }),
      );
      await settle();
    });
    const header = root.querySelector(
      `.${workspaceStyles['fl-pane']}[data-pane="main"] .${workspaceStyles['fl-pane-header']}`,
    )!;
    // Edit mode: the active tab owns document identity, so the
    // header center does not repeat the title; the pane keeps its single
    // bar plus the floating history layer. (The harness fake exposes no
    // provider snapshot, so the center stays empty here; populated centers
    // are pinned at the mounted-Pane seam in unified-toolbar.spec.tsx.)
    expect(header.querySelector('h1')).toBeNull();
    expect(
      root.querySelector(
        `.${workspaceStyles['fl-pane']}[data-pane="main"] [data-anchor="float.top-left"] button[aria-label="Undo"]`,
      ),
    ).not.toBeNull();

    // Reading is per tab: toggle second.md to reading, then switch back.
    await act(async () => {
      root
        .querySelector<HTMLElement>('[aria-label="Document view: Edit"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
    });
    await act(async () => {
      root
        .querySelector<HTMLElement>('[role="menuitemradio"]:last-child')
        ?.click();
      await settle();
    });
    expect(h.controller.tabMode('main', 'doc-2')).toBe('reading');
    // The tab and document own identity; reading has no duplicate pane title.
    expect(header.querySelector('h1')?.textContent).toBeUndefined();
    expect(
      root.querySelector(
        `.${workspaceStyles['fl-pane']}[data-pane="main"] [data-floating-layer]`,
      ),
    ).toBeNull();
    await act(async () => {
      root
        .querySelector<HTMLElement>(
          `.${workspaceStyles['fl-topbar-strip']} [data-pane-strip="main"] .${workspaceStyles['fl-tab-main']}`,
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
    });
    // Back on doc-1 (edit): the floating layer returns, the title leaves.
    await until(
      () =>
        root.querySelector(
          `.${workspaceStyles['fl-pane']}[data-pane="main"] [data-floating-layer]`,
        ) !== null,
    );
    expect(
      root.querySelector(
        `.${workspaceStyles['fl-pane']}[data-pane="main"] .${workspaceStyles['fl-pane-header']} h1`,
      ),
    ).toBeNull();
    expect(h.controller.tabMode('main', 'doc-1')).toBe('edit');
    expect(h.controller.tabMode('main', 'doc-2')).toBe('reading');
  });

  it('the note menu persists "always open in reading view" per document', async () => {
    const { h, root } = await start();
    const menuButton = root.querySelector<HTMLElement>(
      '[data-fl-component="document-toolbar"] button[aria-label="Note actions"]',
    )!;
    await act(async () => {
      menuButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
    });
    const row = [
      ...document.body.querySelectorAll(`.${overlayStyles['fl-menu-item']}`),
    ].find(
      (candidate) => candidate.textContent === 'Always open in reading view',
    );
    expect(row).toBeDefined();
    await act(async () => {
      (row as HTMLElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await settle();
    });
    expect(
      h.ui.services.try(workspaceSettingsToken)!.get('note.doc-1.view', false),
    ).toBe(true);
    expect(h.controller.tabMode('main', 'doc-1')).toBe('reading');
  });

  it('drags a tab onto another pane to move it', async () => {
    const { h, root } = await start();
    await pressKey('\\');
    await until(
      () =>
        root.querySelectorAll(`.${workspaceStyles['fl-pane']}`).length === 2,
    );

    const tab = root.querySelector<HTMLElement>(
      `.${workspaceStyles['fl-topbar-strip']} [data-pane-strip="main"] .${workspaceStyles['fl-tab']}`,
    )!;
    pointer(tab, 'pointerdown', { button: 0 });
    // Promote to a drag, then hover the second pane's center drop zone.
    pointer(tab, 'pointermove', { clientX: 30, clientY: 30 });
    await until(
      () =>
        root.querySelector(
          `.${workspaceStyles['fl-pane']}[data-pane="pane-2"] .${workspaceStyles['fl-dropzone']}[data-zone="center"]`,
        ) !== null,
    );
    const zone = root.querySelector<HTMLElement>(
      `.${workspaceStyles['fl-pane']}[data-pane="pane-2"] .${workspaceStyles['fl-dropzone']}[data-zone="center"]`,
    )!;
    pointer(zone, 'pointerover');
    await until(() => zone.classList.contains(workspaceStyles.active));
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    await settle();

    await until(
      () =>
        h.controller.paneStates().find((pane) => pane.pane === 'pane-2')?.tabs
          .length === 1,
    );
    const main = h.controller.paneStates().find((pane) => pane.pane === 'main');
    expect(main?.tabs.length ?? 0).toBe(0);
  });

  it('uses the pointer half of a tab to choose before or after insertion', async () => {
    const { h, root } = await start();
    await act(async () => {
      root.dispatchEvent(
        new CustomEvent('froglight:open', {
          detail: { documentId: 'doc-2' },
          bubbles: true,
        }),
      );
      await settle();
    });
    await until(
      () => root.querySelectorAll(`.${workspaceStyles['fl-tab']}`).length === 2,
    );

    const tabs = [
      ...root.querySelectorAll<HTMLElement>(`.${workspaceStyles['fl-tab']}`),
    ];
    const first = tabs[0]!;
    const second = tabs[1]!;
    Object.defineProperty(second, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 100,
        right: 200,
        top: 0,
        bottom: 38,
        width: 100,
        height: 38,
        x: 100,
        y: 0,
        toJSON: () => ({}),
      }),
    });
    const originalElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => second,
    });

    pointer(first, 'pointerdown', { clientX: 20, clientY: 20 });
    window.dispatchEvent(
      new MouseEvent('pointermove', {
        bubbles: true,
        clientX: 120,
        clientY: 20,
      }),
    );
    await until(
      () => root.querySelector(`.${workspaceStyles['fl-tab-insert']}`) !== null,
    );
    window.dispatchEvent(
      new MouseEvent('pointerup', {
        bubbles: true,
        clientX: 120,
        clientY: 20,
      }),
    );
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: originalElementFromPoint,
    });
    await settle();

    expect(
      h.controller
        .paneStates()
        .find((pane) => pane.pane === 'main')
        ?.tabs.map((tab) => tab.id),
    ).toEqual(['doc-1', 'doc-2']);
  });

  it('accepts a tab drop on empty tab-strip space', async () => {
    const { h, root } = await start();
    await pressKey('\\');
    await until(
      () =>
        root.querySelectorAll(`.${workspaceStyles['fl-pane']}`).length === 2,
    );

    const source = root.querySelector<HTMLElement>(
      `.${workspaceStyles['fl-topbar-strip']} [data-pane-strip="main"] .${workspaceStyles['fl-tab']}`,
    )!;
    const emptyStrip = root.querySelector<HTMLElement>(
      `.${workspaceStyles['fl-topbar-strip']} [data-pane-strip="pane-2"] .${workspaceStyles['tabstrip-tabs']}`,
    )!;
    const originalElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => emptyStrip,
    });

    pointer(source, 'pointerdown', { clientX: 20, clientY: 20 });
    window.dispatchEvent(
      new MouseEvent('pointermove', {
        bubbles: true,
        clientX: 700,
        clientY: 20,
      }),
    );
    await until(
      () => root.querySelector(`.${workspaceStyles['fl-tab-insert']}`) !== null,
    );
    window.dispatchEvent(
      new MouseEvent('pointerup', {
        bubbles: true,
        clientX: 700,
        clientY: 20,
      }),
    );
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: originalElementFromPoint,
    });
    await settle();

    expect(
      h.controller.paneStates().find((pane) => pane.pane === 'pane-2')?.tabs,
    ).toHaveLength(1);
  });

  it('opens the graph as a pane tab instead of a full-area takeover', async () => {
    const { root } = await start();
    await act(async () => {
      root
        .querySelector<HTMLElement>(
          `.${workspaceStyles['activity-button']}[data-activity="graph"]`,
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
    });
    await until(() =>
      [...root.querySelectorAll(`.${workspaceStyles['fl-tab-label']}`)].some(
        (tab) => tab.textContent === 'Graph',
      ),
    );
    // The graph content renders inside the pane, not a full-area view.
    expect(
      root.querySelector(
        `.${workspaceStyles['fl-pane']} .${workspaceStyles['fl-pane-view']} [data-fl-component="graph-view"]`,
      ) ??
        root.querySelector(
          `.${workspaceStyles['fl-pane']} .${workspaceStyles['fl-pane-view']} canvas`,
        ),
    ).not.toBeNull();
    expect(root.querySelector(`.${workspaceStyles['fl-mainview']}`)).toBeNull();
  });

  it('divider drag and double-click drive the split ratio through the controller', async () => {
    const { h, root } = await start();
    await pressKey('\\');
    await until(
      () =>
        root.querySelectorAll(`.${workspaceStyles['fl-pane']}`).length === 2,
    );
    const divider = root.querySelector<HTMLElement>(
      `.${workspaceStyles['fl-pane-divider']}`,
    )!;
    pointer(divider, 'pointerdown');
    window.dispatchEvent(
      new MouseEvent('pointermove', {
        bubbles: true,
        clientX: 500,
        clientY: 0,
      }),
    );
    await settle();
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    await settle();
    // jsdom rects are zero-sized; the model clamps whatever ratio arrives,
    // but a split with a draggable divider exists and responds to gestures.
    expect(h.controller.dockState().root?.kind).toBe('split');
    // Double-click resets to 50/50.
    divider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await settle();
    const dockRoot = h.controller.dockState().root;
    expect(dockRoot?.kind).toBe('split');
    if (dockRoot?.kind === 'split') expect(dockRoot.ratio).toBe(0.5);
  });

  it('computes divider ratios from the usable span, excluding the divider', async () => {
    const { h, root } = await start();
    await pressKey('\\');
    await until(
      () =>
        root.querySelectorAll(`.${workspaceStyles['fl-pane-divider']}`)
          .length === 1,
    );
    const divider = root.querySelector<HTMLElement>(
      `.${workspaceStyles['fl-pane-divider']}`,
    )!;
    Object.defineProperty(divider.parentElement, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 1000, height: 800 }),
    });
    Object.defineProperty(divider, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 10, height: 800 }),
    });

    await act(async () => {
      pointer(divider, 'pointerdown');
      await settle();
    });
    window.dispatchEvent(
      new MouseEvent('pointermove', {
        bubbles: true,
        clientX: 252.5,
        clientY: 0,
      }),
    );
    await settle();
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));

    const dockRoot = h.controller.dockState().root;
    expect(dockRoot?.kind).toBe('split');
    if (dockRoot?.kind === 'split') expect(dockRoot.ratio).toBeCloseTo(0.25, 5);
  });

  it('applies a nested divider ratio without changing its ancestor split', async () => {
    const { h, root } = await start();
    await pressKey('\\');
    await until(
      () =>
        root.querySelectorAll(`.${workspaceStyles['fl-pane']}`).length === 2,
    );
    await pressKey('\\', { shiftKey: true });
    await until(
      () =>
        root.querySelectorAll(`.${workspaceStyles['fl-pane']}`).length === 3,
    );

    const dividers = [
      ...root.querySelectorAll<HTMLElement>(
        `.${workspaceStyles['fl-pane-divider']}`,
      ),
    ];
    const nestedDivider = dividers[1]!;
    Object.defineProperty(
      nestedDivider.parentElement,
      'getBoundingClientRect',
      {
        configurable: true,
        value: () => ({ left: 0, top: 0, width: 1000, height: 800 }),
      },
    );
    await act(async () => {
      pointer(nestedDivider, 'pointerdown');
      await settle();
    });
    window.dispatchEvent(
      new MouseEvent('pointermove', {
        bubbles: true,
        clientX: 0,
        clientY: 640,
      }),
    );
    await settle();
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));

    const dockRoot = h.controller.dockState().root;
    expect(dockRoot?.kind).toBe('split');
    if (dockRoot?.kind === 'split') {
      expect(dockRoot.ratio).toBe(0.5);
      expect(dockRoot.second.kind).toBe('split');
      if (dockRoot.second.kind === 'split')
        expect(dockRoot.second.ratio).toBeCloseTo(0.8);
    }
  });

  it('supports keyboard divider resizing with an announced ratio', async () => {
    const { h, root } = await start();
    await pressKey('\\');
    await until(
      () =>
        root.querySelectorAll(`.${workspaceStyles['fl-pane-divider']}`)
          .length === 1,
    );

    const divider = root.querySelector<HTMLElement>(
      `.${workspaceStyles['fl-pane-divider']}`,
    )!;
    expect(divider.getAttribute('role')).toBe('separator');
    expect(divider.getAttribute('aria-valuenow')).toBe('50');
    await act(async () => {
      divider.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
      await settle();
    });

    expect(h.controller.dockState().root).toMatchObject({ ratio: 0.55 });
    expect(divider.getAttribute('aria-valuenow')).toBe('55');
  });

  it('offers split commands from the focused note menu', async () => {
    const { root } = await start();
    await act(async () => {
      root
        .querySelector<HTMLElement>(
          '[data-fl-component="document-toolbar"] button[aria-label="Note actions"]',
        )
        ?.click();
      await settle();
    });
    const split = [
      ...document.body.querySelectorAll<HTMLElement>(
        `.${overlayStyles['fl-menu-item']}`,
      ),
    ].find((item) => item.textContent === 'Split right');
    expect(split).toBeDefined();
    expect(
      [
        ...document.body.querySelectorAll<HTMLElement>(
          `.${overlayStyles['fl-menu-item']}`,
        ),
      ].some((item) => item.textContent === 'Split down'),
    ).toBe(true);
    await act(async () => {
      split?.click();
      await settle();
    });
    await until(
      () =>
        root.querySelectorAll(`.${workspaceStyles['fl-pane']}`).length === 2,
    );
  });

  it('the tab context menu splits with the tab in one gesture', async () => {
    const { h, root } = await start();
    const tab = root.querySelector<HTMLElement>(
      `.${workspaceStyles['fl-topbar-strip']} [data-pane-strip="main"] .${workspaceStyles['fl-tab']}`,
    )!;
    await act(async () => {
      tab.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }),
      );
      await settle();
    });
    const row = [
      ...document.body.querySelectorAll(`.${overlayStyles['fl-menu-item']}`),
    ].find((candidate) => candidate.textContent === 'Split down');
    expect(row).toBeDefined();
    await act(async () => {
      (row as HTMLElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await settle();
    });
    await until(
      () =>
        root.querySelectorAll(`.${workspaceStyles['fl-pane']}`).length === 2,
    );
    const created = h.controller.leafIds().find((leaf) => leaf !== 'main');
    const target = h.controller
      .paneStates()
      .find((pane) => pane.pane === created);
    // A live document has one owner; the new pane is ready for another tab.
    expect(target?.tabs).toEqual([]);
    expect(
      h.controller
        .paneStates()
        .find((pane) => pane.pane === 'main')
        ?.tabs.map((tab) => tab.documentId),
    ).toEqual(['doc-1']);
  });

  it('shows the empty-pane card when a pane has no tabs', async () => {
    const { root } = await start();
    await pressKey('\\');
    await until(
      () =>
        root.querySelectorAll(`.${workspaceStyles['fl-pane']}`).length === 2,
    );
    await until(
      () =>
        root.querySelector(
          `.${workspaceStyles['fl-pane']}[data-pane="pane-2"] .${workspaceStyles['pane-empty']}`,
        ) !== null,
    );
    expect(
      root.querySelector(
        `.${workspaceStyles['fl-pane']}[data-pane="pane-2"] .${workspaceStyles['pane-empty-title']}`,
      )?.textContent,
    ).toBe('No document open');
  });
});
