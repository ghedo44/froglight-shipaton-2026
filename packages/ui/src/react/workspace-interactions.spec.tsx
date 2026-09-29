// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  blockPageKindId,
  documentId,
  inkPageKindId,
  latexKindId,
  notebookKindId,
  resourceId,
} from '@froglight/foundation';
import { mountFroglightApp, type WorkbenchMount } from '../workbench.js';
import { showContextMenu } from '../menu.js';
import {
  createHarness,
  makeChoice,
  settle,
  until,
  click,
  waitMs,
  type Harness,
} from './test-support.js';
import switcherStyles from './SwitcherOverlay.module.css';
import newNoteStyles from './NewNoteModal.module.css';
import launcherStyles from './LauncherView.module.css';
import overlayStyles from './Overlays.module.css';
import workspaceStyles from './WorkspaceView.module.css';

describe('workspace interactions (mount seam)', () => {
  let harness: Harness | null = null;
  let mounted: WorkbenchMount | null = null;

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

  async function start(
    docs: readonly {
      documentId: string;
      kindId?: string;
      path: string;
      text?: string;
    }[] = [
      {
        documentId: 'doc-1',
        path: 'notes/welcome.md',
        text: '# Welcome\n\nHello.',
      },
      { documentId: 'doc-2', path: 'notes/second.md', text: '# Second note' },
    ],
  ) {
    const h = await createHarness(
      [makeChoice({ id: 'v1', name: 'My Vault' })],
      docs,
    );
    const root = document.createElement('div');
    document.body.appendChild(root);
    h.root = root;
    await act(async () => {
      mounted = await mountFroglightApp(root, h.controller, h.adapter, h.ui);
    });
    await activate(h);
    return h;
  }

  async function activate(h: Harness): Promise<void> {
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
  }

  function dispatchOpen(root: ParentNode, documentId: string): void {
    root.dispatchEvent(
      new CustomEvent('froglight:open', {
        detail: { documentId },
        bubbles: true,
      }),
    );
  }

  it('opening a second note adds a tab and switches the active title', async () => {
    const h = await start();
    await act(async () => {
      dispatchOpen(h.root, 'doc-2');
      await settle();
    });
    await until(
      () =>
        h.root.querySelectorAll(`.${workspaceStyles['fl-tab']}`).length === 2,
    );
    await until(
      () =>
        h.root.querySelector(
          `.${workspaceStyles['fl-tab']}.${workspaceStyles.active} .${workspaceStyles['fl-tab-label']}`,
        )?.textContent === 'second.md',
    );
    const activeTab = h.root.querySelector(
      `.${workspaceStyles['fl-tab']}.${workspaceStyles.active} .${workspaceStyles['fl-tab-label']}`,
    );
    expect(activeTab?.textContent).toBe('second.md');
  });

  it('closing the active tab activates its neighbour', async () => {
    const h = await start();
    await act(async () => {
      dispatchOpen(h.root, 'doc-2');
      await settle();
    });
    await until(
      () =>
        h.root.querySelectorAll(`.${workspaceStyles['fl-tab']}`).length === 2,
    );
    // Active is now created-1; close it.
    const activeClose = h.root.querySelector<HTMLElement>(
      `.${workspaceStyles['fl-tab']}.${workspaceStyles.active} .${workspaceStyles['fl-tab-close']}`,
    );
    await act(async () => {
      activeClose!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
    });
    await until(
      () =>
        h.root.querySelectorAll(`.${workspaceStyles['fl-tab']}`).length === 1 &&
        h.root
          .querySelector(`.${workspaceStyles['fl-tab']}`)
          ?.classList.contains(workspaceStyles.active) === true,
    );
    expect(
      h.root.querySelector(
        `.${workspaceStyles['fl-tab']}.${workspaceStyles.active} .${workspaceStyles['fl-tab-label']}`,
      )?.textContent,
    ).toBe('welcome.md');
  });

  it('switcher routes the next open into the empty focused split pane', async () => {
    const h = await start();
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: '\\',
          ctrlKey: true,
          bubbles: true,
        }),
      );
      await settle();
    });
    await until(
      () =>
        h.root.querySelectorAll(`.${workspaceStyles['fl-pane']}`).length === 2,
    );
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'p',
          ctrlKey: true,
          bubbles: true,
        }),
      );
      await settle();
    });
    // (debug line removed)', h.controller.focusedPane, 'leaves:', JSON.stringify(h.controller.leafIds()), 'switcherPane: set');
    // Switcher portals to document.body (containing-block fix).
    type(
      document.body.querySelector<HTMLInputElement>(
        `.${switcherStyles.switcher.split(' ').join('.')} input`,
      )!,
      'sec',
    );
    await until(
      () =>
        document.body.querySelectorAll(`.${switcherStyles['switcher-row']}`)
          .length >= 1,
    );
    await act(async () => {
      document.body
        .querySelector<HTMLElement>(`.${switcherStyles['switcher-row']}`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
    });
    await until(
      () =>
        h.root.querySelectorAll(
          `.${workspaceStyles['fl-topbar-strip']} [data-pane-strip="pane-2"] .${workspaceStyles['fl-tab']}`,
        ).length >= 1,
    );
    expect(
      h.root.querySelector(
        `.${workspaceStyles['fl-topbar-strip']} [data-pane-strip="pane-2"] .${workspaceStyles['fl-tab-label']}`,
      )?.textContent,
    ).toBe('second.md');
  });

  it('dismisses a peer menu before opening the quick switcher', async () => {
    await start();
    const invoker = document.body.querySelector<HTMLElement>(
      `.${workspaceStyles['fl-tab']}`,
    )!;
    showContextMenu([{ label: 'Close' }], invoker);
    expect(
      document.body.querySelector(
        `.${overlayStyles['fl-menu'].split(' ').join('.')}`,
      ),
    ).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'p',
          ctrlKey: true,
          bubbles: true,
        }),
      );
      await settle();
    });

    expect(
      document.body.querySelector(
        `.${overlayStyles['fl-menu'].split(' ').join('.')}`,
      ),
    ).toBeNull();
    expect(
      document.body.querySelector(
        `.${switcherStyles.switcher.split(' ').join('.')}`,
      ),
    ).not.toBeNull();
  });

  it('opens the existing switcher from Search and finds body text', async () => {
    const h = await start([
      {
        documentId: 'doc-1',
        path: 'notes/welcome.md',
        text: '# Welcome\n\nA phrase hidden in the document body.',
      },
    ]);
    h.search.indexDocument(
      documentId('doc-1'),
      { resourceId: resourceId('resource-1') },
      '# Welcome\n\nA phrase hidden in the document body.',
    );

    await click(
      h.root,
      `.${workspaceStyles['fl-activity']} [data-activity="search"]`,
    );

    // Switcher portals to document.body (containing-block fix).
    expect(
      document.body.querySelectorAll(
        `.${switcherStyles.switcher.split(' ').join('.')}`,
      ),
    ).toHaveLength(1);
    expect(document.body.querySelector('.search-modal')).toBeNull();
    expect(
      document.body.querySelectorAll(`.${switcherStyles['switcher-row']}`),
    ).toHaveLength(1);
    const input = document.body.querySelector<HTMLInputElement>(
      `.${switcherStyles.switcher.split(' ').join('.')} input`,
    );
    if (input === null) throw new Error('search switcher input did not mount');
    await act(async () => {
      type(input, 'hidden in the document body');
      await settle();
    });
    await until(
      () =>
        document.body.querySelectorAll(`.${switcherStyles['switcher-row']}`)
          .length === 1,
    );
    expect(
      document.body.querySelector(`.${switcherStyles['switcher-row']}`)
        ?.textContent,
    ).toContain('hidden in the document body');
  });

  it('closing a pane migrates its tabs back into the neighbor', async () => {
    const h = await start();
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: '\\',
          ctrlKey: true,
          bubbles: true,
        }),
      );
      await settle();
    });
    await until(
      () =>
        h.root.querySelectorAll(`.${workspaceStyles['fl-pane']}`).length === 2,
    );
    // Route an open into the empty split pane via the switcher.
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'p',
          ctrlKey: true,
          bubbles: true,
        }),
      );
      await settle();
    });
    type(
      document.body.querySelector<HTMLInputElement>(
        `.${switcherStyles.switcher.split(' ').join('.')} input`,
      )!,
      'sec',
    );
    await until(
      () =>
        document.body.querySelectorAll(`.${switcherStyles['switcher-row']}`)
          .length >= 1,
    );
    await act(async () => {
      document.body
        .querySelector<HTMLElement>(`.${switcherStyles['switcher-row']}`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
    });
    await until(
      () =>
        h.root.querySelectorAll(
          `.${workspaceStyles['fl-topbar-strip']} [data-pane-strip="pane-2"] .${workspaceStyles['fl-tab']}`,
        ).length >= 1,
    );
    const documentArea = h.root.querySelector<HTMLElement>(
      `.${workspaceStyles['fl-pane']}[data-pane="pane-2"] .fl-pane-editor`,
    )!;
    const documentMenuEvent = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 30,
      clientY: 30,
    });
    await act(async () => {
      documentArea.dispatchEvent(documentMenuEvent);
      await settle();
    });
    expect(documentMenuEvent.defaultPrevented).toBe(true);
    await until(
      () =>
        document.body.querySelector(
          `.${overlayStyles['fl-menu'].split(' ').join('.')}`,
        ) !== null,
    );
    expect(
      [
        ...document.body.querySelectorAll(`.${overlayStyles['fl-menu-item']}`),
      ].map((row) => row.textContent),
    ).toContain('Reveal in file explorer');

    const pane = h.root.querySelector<HTMLElement>(
      `.${workspaceStyles['fl-pane']}[data-pane="pane-2"] .${workspaceStyles['fl-pane-header']}`,
    )!;
    await act(async () => {
      pane.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 30,
          clientY: 30,
        }),
      );
      await settle();
    });
    await until(
      () =>
        document.body.querySelector(
          `.${overlayStyles['fl-menu'].split(' ').join('.')}`,
        ) !== null,
    );
    const closeRow = [
      ...document.body.querySelectorAll(`.${overlayStyles['fl-menu-item']}`),
    ].find((row) => row.textContent === 'Close pane');
    await act(async () => {
      (closeRow as HTMLElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await settle();
    });
    await until(
      () =>
        h.root.querySelectorAll(`.${workspaceStyles['fl-pane']}`).length === 1,
    );
    const labels = [
      ...h.root.querySelectorAll(`.${workspaceStyles['fl-tab-label']}`),
    ].map((element) => element.textContent);
    expect(labels).toContain('welcome.md');
    expect(labels).toContain('second.md');
    await until(() => h.controller.calls.closePane.includes('pane-2'));
  });

  it('without a registered reader, reading mode keeps the Markdown editor surface visible', async () => {
    const h = await start();
    await click(h.root, '[aria-label="Document view: Edit"]');
    await click(h.root, '[role="menuitemradio"]:last-child');
    const pane = h.root.querySelector(
      `.${workspaceStyles['fl-pane']}[data-pane="main"]`,
    )!;
    expect(h.controller.tabMode('main')).toBe('reading');
    expect(
      pane
        .querySelector(`.${workspaceStyles['editor-area']}`)
        ?.getAttribute('style') ?? '',
    ).not.toContain('display: none');
    expect(
      pane.querySelector('.fl-pane-preview')?.getAttribute('style') ?? '',
    ).toContain('display: none');
  });

  it.each([
    ['Block Page', blockPageKindId, 'notes/page.blockpage'],
    ['Ink', inkPageKindId, 'drawings/sketch.ink'],
    ['Notebook', notebookKindId, 'notebooks/research.notebook'],
    ['LaTeX', latexKindId, 'papers/thesis.tex'],
  ])(
    'keeps the native %s renderer visible in reading mode',
    async (_family, kindId, path) => {
      const h = await start([{ documentId: 'doc-1', kindId, path }]);
      await click(h.root, '[aria-label="Document view: Edit"]');
      await click(h.root, '[role="menuitemradio"]:last-child');

      const pane = h.root.querySelector(
        `.${workspaceStyles['fl-pane']}[data-pane="main"]`,
      )!;
      expect(h.controller.tabMode('main')).toBe('reading');
      expect(
        pane
          .querySelector(`.${workspaceStyles['editor-area']}`)
          ?.getAttribute('style') ?? '',
      ).not.toContain('display: none');
      expect(
        pane.querySelector('.fl-pane-preview')?.getAttribute('style') ?? '',
      ).toContain('display: none');
    },
  );

  it('Mod P opens the quick switcher; Enter opens the top match', async () => {
    const h = await start();
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'p',
          ctrlKey: true,
          bubbles: true,
        }),
      );
      await settle();
    });
    // Switcher portals to document.body (containing-block fix).
    expect(
      document.body.querySelector(
        `.${switcherStyles.switcher.split(' ').join('.')}`,
      ),
    ).not.toBeNull();

    const input = document.body.querySelector<HTMLInputElement>(
      `.${switcherStyles.switcher.split(' ').join('.')} input`,
    )!;
    type(input, 'wel');
    await until(
      () =>
        document.body.querySelectorAll(`.${switcherStyles['switcher-row']}`)
          .length >= 1,
    );
    expect(
      document.body.querySelectorAll(`.${switcherStyles['switcher-row']}`)
        .length,
    ).toBe(1);

    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      );
      await settle();
    });
    await waitMs(300);
    await until(
      () =>
        h.root.querySelectorAll(`.${workspaceStyles['fl-tab-label']}`).length >=
        1,
    );
  });

  it('keeps a rapidly reopened switcher mounted and actionable', async () => {
    await start();
    const shortcut = (): void => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'p',
          ctrlKey: true,
          bubbles: true,
        }),
      );
    };
    await act(async () => {
      shortcut();
      await settle();
    });
    expect(
      document.body.querySelector(
        `.${switcherStyles.switcher.split(' ').join('.')}`,
      ),
    ).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
      shortcut();
      await settle();
    });
    await act(async () => {
      await waitMs(300);
    });
    const input = document.body.querySelector<HTMLInputElement>(
      `.${switcherStyles.switcher.split(' ').join('.')} input`,
    );
    expect(input).not.toBeNull();
    expect(
      document.body
        .querySelector('[data-fl-component="switcher"]')
        ?.hasAttribute('data-closing'),
    ).toBe(false);

    await act(async () => {
      input!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
      await settle();
    });
    expect(
      document.body
        .querySelector('[data-fl-component="switcher"]')
        ?.hasAttribute('data-closing'),
    ).toBe(true);
  });

  it('finds body text when the switcher is opened outside the sidebar', async () => {
    const h = await start([
      {
        documentId: 'doc-1',
        path: 'notes/welcome.md',
        text: '# Welcome\n\nA phrase only present in the body.',
      },
    ]);
    h.search.indexDocument(
      documentId('doc-1'),
      { resourceId: resourceId('resource-1') },
      '# Welcome\n\nA phrase only present in the body.',
    );

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'p',
          ctrlKey: true,
          bubbles: true,
        }),
      );
      await settle();
    });
    const input = document.body.querySelector<HTMLInputElement>(
      `.${switcherStyles.switcher.split(' ').join('.')} input`,
    );
    if (input === null) throw new Error('switcher input did not mount');
    await act(async () => {
      type(input, 'only present in the body');
      await settle();
    });

    await until(
      () =>
        document.body.querySelectorAll(`.${switcherStyles['switcher-row']}`)
          .length === 1,
    );
    expect(
      document.body.querySelector(`.${switcherStyles['switcher-row']}`)
        ?.textContent,
    ).toContain('only present in the body');
  });

  it('switcher portals outside the contained workspace with a viewport marker', async () => {
    // Containing-block regression: the global palette must not
    // live under `.froglight-layout` (`contain: layout paint`), and the
    // fixed backdrop carries the viewport compensation hook. Stable hooks
    // only — no CSS-module hash dependence beyond the imported class.
    const h = await start();
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'p',
          ctrlKey: true,
          bubbles: true,
        }),
      );
      await settle();
    });
    await until(
      () =>
        document.body.querySelector('[data-fl-component="switcher"]') !== null,
    );
    const backdrop = document.body.querySelector(
      '[data-fl-component="switcher"]',
    ) as HTMLElement | null;
    expect(backdrop).not.toBeNull();
    expect(backdrop!.hasAttribute('data-fl-viewport-overlay')).toBe(true);
    expect(
      backdrop!.closest(`.${workspaceStyles['froglight-layout']}`),
    ).toBeNull();
    expect(h.root.querySelector('[data-fl-component="switcher"]')).toBeNull();
    // Workspace containment stays intact.
    const layout = h.root.querySelector(
      `.${workspaceStyles['froglight-layout']}`,
    ) as HTMLElement | null;
    expect(layout).not.toBeNull();
  });

  it('the new-note picker routes kind and name through createAndOpen', async () => {
    const h = await start();
    await click(
      h.root,
      `.${workspaceStyles['bottomnav-button']}[data-activity="new-note"]`,
    );
    await until(
      () =>
        document.body.querySelector(
          `.${newNoteStyles['new-note'].split(' ').join('.')}`,
        ) !== null,
    );

    const nameInput = document.body.querySelector<HTMLInputElement>(
      `.${newNoteStyles['new-note-input']}`,
    )!;
    nameInput.value = 'Field Notes';
    await act(async () => {
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      await settle();
    });
    await act(async () => {
      (document.activeElement ?? document).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
      await settle();
    });
    await act(async () => {
      (document.activeElement ?? document).dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      );
      await settle();
    });

    await until(() => h.controller.calls.creations.length === 1);
    expect(h.controller.calls.creations[0]).toEqual({
      path: 'Field Notes.blockpage',
      kindId: 'froglight.blockpage',
    });
    await until(
      () =>
        document.body.querySelector(
          `.${newNoteStyles['new-note'].split(' ').join('.')}`,
        ) === null,
    );
    await until(() =>
      [...h.root.querySelectorAll(`.${workspaceStyles['fl-tab-label']}`)].some(
        (tab) => tab.textContent === 'Field Notes.blockpage',
      ),
    );
  });

  it('offers PDF import beside note creation and routes selected bytes to the workbench', async () => {
    const h = await start();
    const button =
      h.root.querySelector<HTMLButtonElement>('[aria-label="New"]');
    expect(button?.getAttribute('aria-label')).toBe('New');

    await act(async () => {
      h.root.querySelector('[data-testid="file-explorer"]')?.dispatchEvent(
        new CustomEvent('froglight:import-pdf', {
          bubbles: true,
          detail: {
            name: 'Lecture.pdf',
            bytes: new Uint8Array([37, 80, 68, 70]),
          },
        }),
      );
      await settle();
    });
    await until(
      () =>
        document.body.querySelector(
          `.${overlayStyles['froglight-modal'].split(' ').join('.')} input`,
        ) !== null,
    );
    await act(async () => {
      (document.activeElement ?? document).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      await settle();
    });

    expect(h.controller.calls.pdfImports).toEqual([
      { name: 'Lecture.pdf', bytes: new Uint8Array([37, 80, 68, 70]) },
    ]);
    expect(
      h.root.querySelector(`.${workspaceStyles['fl-toast']}`)?.textContent,
    ).toContain('Imported 2 PDF pages as a notebook');
  });

  it('workbench shortcuts drive save, sidebar, and split', async () => {
    const h = await start();
    const press = async (
      key: string,
      init: KeyboardEventInit = {},
    ): Promise<void> => {
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
    };
    await press('s');
    await until(() => h.controller.calls.saves.length === 1);

    await press('b');
    await until(
      () =>
        h.root
          .querySelector(`.${workspaceStyles['fl-sidebar']}`)
          ?.classList.contains(workspaceStyles.closed) === true,
    );
    expect(
      h.root
        .querySelector('[data-fl-component="workspace"]')
        ?.classList.contains(workspaceStyles['sidebar-collapsed']),
    ).toBe(true);
    await press('b');
    await until(
      () =>
        h.root
          .querySelector(`.${workspaceStyles['fl-sidebar']}`)
          ?.classList.contains(workspaceStyles.closed) === false,
    );

    await press('\\');
    await until(
      () =>
        h.root.querySelectorAll(`.${workspaceStyles['fl-pane']}`).length === 2,
    );
    // Ctrl+Shift+\ splits down instead of right: three panes now.
    await press('\\', { shiftKey: true });
    await until(
      () =>
        h.root.querySelectorAll(`.${workspaceStyles['fl-pane']}`).length === 3,
    );
  });

  it('right-click outside editable surfaces opens the app menu; Escape closes it', async () => {
    const h = await start();
    const header = h.root.querySelector<HTMLElement>(
      '[data-fl-component="titlebar"]',
    )!;
    await act(async () => {
      header.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 30,
          clientY: 20,
        }),
      );
      await settle();
    });
    // No provider registered on the header itself: suppressed but no menu.
    expect(
      document.body.querySelector(
        `.${overlayStyles['fl-menu'].split(' ').join('.')}`,
      ),
    ).toBeNull();

    // A tab row provides entries via its own context handler.
    await act(async () => {
      dispatchOpen(h.root, 'doc-2');
      await settle();
    });
    await until(
      () =>
        h.root.querySelectorAll(`.${workspaceStyles['fl-tab']}`).length === 2,
    );
    const tab = h.root.querySelector<HTMLElement>(
      `.${workspaceStyles['fl-tab-slot']}:nth-child(2) .${workspaceStyles['fl-tab']}`,
    )!;
    tab.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 40,
      }),
    );
    await until(
      () =>
        document.body.querySelector(
          `.${overlayStyles['fl-menu'].split(' ').join('.')}`,
        ) !== null,
    );
    const items = [
      ...document.body.querySelectorAll(`.${overlayStyles['fl-menu-item']}`),
    ].map((row) => row.textContent);
    expect(items).toContain('Close tab');
    expect(items).toContain('Close other tabs');
    expect(items).toContain('Close all');

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
      await settle();
    });
    await until(
      () =>
        document.body.querySelector(
          `.${overlayStyles['fl-menu'].split(' ').join('.')}`,
        ) === null,
    );
  });

  it('sidebar carries the vault identity', async () => {
    const h = await start();
    expect(
      h.root.querySelector(`.${workspaceStyles['workspace-vault-name']}`)
        ?.textContent,
    ).toContain('My Vault');
  });
});

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
