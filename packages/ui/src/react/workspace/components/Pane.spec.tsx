// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { DocumentKindId } from '@froglight/foundation';
import type { WorkbenchReadingPresentation } from '../../../workbench-ports.js';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Pane,
  buildDockTreePane,
  toPaneViewModel,
  type PaneActions,
} from './Pane.jsx';
import * as menu from '../../../menu.js';
import type { MenuEntry } from '../../../menu.js';
import { createHarness, makeChoice } from '../../test-support.js';
import { WorkspaceContextProvider } from '../WorkspaceContext.js';
import { noWindowChrome } from '../../../window-chrome.js';

/**
 * Reading presentation resolves through one required query: the model
 * mounts the separate reader, the legacy text projection, or the native
 * read-only surface from the presentation discriminant alone — no
 * controller probing, no per-kind branching.
 */

function paneState() {
  return {
    pane: 'main',
    tabs: [{ id: 'doc1', kind: 'document', documentId: 'doc1', viewId: null }],
    activeTab: 'doc1',
    mode: 'reading',
    documentId: 'doc1',
    viewId: null,
    title: 'doc1',
    path: 'doc1.md',
    dirty: false,
    recoveryWarnings: [],
    canGoBack: false,
    canGoForward: false,
  } as const;
}

function baseInput(presentation: WorkbenchReadingPresentation) {
  return {
    paneId: 'main',
    paneState: { ...paneState() },
    focusedPane: 'main',
    mobile: false,
    documentById: new Map([
      ['doc1', { documentId: 'doc1', title: 'doc1', path: 'doc1.md' }],
    ]),
    views: { get: () => undefined } as never,
    drag: null,
    dropTarget: null,
    revision: 0,
    settingsService: null,
    presentation,
  };
}

describe('toPaneViewModel reading presentation', () => {
  it('mounts the separate reader instead of the native read-only surface', () => {
    const model = toPaneViewModel(
      baseInput({
        kind: 'separate-reader',
        provider: { id: 'markdown-reader' } as never,
        kindId: 'froglight.markdown' as DocumentKindId,
      }),
    );
    expect(model.separateReader).toBe(true);
    expect(model.showsNativeReader).toBe(false);
  });

  it('falls back to the native surface when no reader is registered', () => {
    const model = toPaneViewModel(
      baseInput({
        kind: 'editor-readonly',
        kindId: 'froglight.markdown' as DocumentKindId,
      }),
    );
    expect(model.separateReader).toBe(false);
    expect(model.showsNativeReader).toBe(true);
  });
});

describe('Pane missing-editor feedback', () => {
  it.each([
    { mode: 'reading', separate: true, available: false, warns: false },
    { mode: 'edit', separate: true, available: false, warns: true },
    { mode: 'split', separate: true, available: false, warns: true },
    { mode: 'reading', separate: false, available: false, warns: true },
    { mode: 'edit', separate: false, available: true, warns: false },
    {
      mode: 'edit',
      separate: false,
      available: false,
      loading: true,
      warns: false,
    },
  ] as const)(
    '$mode / separate=$separate / available=$available / loading=$loading warns=$warns',
    async ({ mode, separate, available, loading, warns }) => {
      const h = await createHarness();
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      const kindId = 'froglight.markdown' as DocumentKindId;
      const presentation: WorkbenchReadingPresentation = separate
        ? {
            kind: 'separate-reader',
            provider: { id: 'test-reader' } as never,
            kindId,
          }
        : { kind: 'editor-readonly', kindId };
      const model = toPaneViewModel({
        ...baseInput(presentation),
        paneState: {
          ...paneState(),
          mode,
          editorAvailable: available,
          ...(loading !== undefined ? { editorLoading: loading } : {}),
        },
        views: h.ui.views,
      });
      const noop = () => undefined;
      const actions: PaneActions = {
        onPointerDownPane: noop,
        onActivateTab: noop,
        onCloseTab: noop,
        onFocusPane: noop,
        onOpenSwitcher: noop,
        onCreateNote: noop,
        onTabPointerDown: noop,
        onTabContextMenu: noop,
        onGoBack: noop,
        onGoForward: noop,
        onSplitRight: noop,
        onSplitDown: noop,
        onSetMode: noop,
        onOpenNoteMenu: noop,
        onPaneContextMenu: noop,
        onZoneEnter: noop,
        onZoneLeave: noop,
      };
      try {
        await act(async () =>
          root.render(
            <WorkspaceContextProvider
              value={{
                controller: h.controller,
                ui: h.ui,
                choice: makeChoice({ id: 'test', name: 'Test vault' }),
                chrome: noWindowChrome(),
                onClose: noop,
              }}
            >
              <Pane
                model={model}
                actions={actions}
                views={h.ui.views}
                tools={h.controller}
                hosts={{
                  editorHosts: { current: new Map() },
                  readerHosts: { current: new Map() },
                }}
              />
            </WorkspaceContextProvider>,
          ),
        );
        expect(
          host.textContent?.includes('Document content is unavailable'),
        ).toBe(warns);
        if (loading) {
          expect(host.textContent).toContain('Loading document…');
        }
        if (mode === 'reading' && separate) {
          expect(
            host.querySelector('[aria-label="Document preview"]'),
          ).not.toBeNull();
          expect(
            host.querySelector<HTMLElement>('.fl-pane-editor')?.style.display,
          ).toBe('none');
        }
      } finally {
        await act(async () => root.unmount());
        host.remove();
        await h.dispose();
      }
    },
  );
});

describe('Pane splitWithTab duplicate guard', () => {
  function splitEntryFor(
    actions: PaneActions,
    tabId: string,
    label = 'Split right with this tab',
  ): { run: () => void; captured: MenuEntry[][] } {
    const captured: MenuEntry[][] = [];
    const spy = vi
      .spyOn(menu, 'showContextMenu')
      .mockImplementation((entries: readonly MenuEntry[]) => {
        captured.push([...entries]);
        return { close: () => undefined, closed: false };
      });
    try {
      actions.onTabContextMenu(
        { clientX: 10, clientY: 10 } as unknown as React.MouseEvent,
        tabId,
      );
    } finally {
      spy.mockRestore();
    }
    const entries = captured[0] ?? [];
    const split = entries.find(
      (entry): entry is { label?: string; run?: () => void } =>
        typeof entry !== 'string' &&
        (entry as { label?: string }).label === label,
    );
    expect(split?.run).toBeTypeOf('function');
    return { run: split!.run!, captured };
  }

  function buildSplitPane(input: {
    liveOwner: string | null;
    splitCreated?: string;
  }): {
    actions: PaneActions;
    dock: {
      splitPane: ReturnType<typeof vi.fn>;
      discardRedirectedSplit: ReturnType<typeof vi.fn>;
      liveOwnerOf: ReturnType<typeof vi.fn>;
    };
    router: { dispatch: ReturnType<typeof vi.fn> };
  } {
    const splitPane = vi.fn(() => input.splitCreated ?? 'pane-2');
    const discardRedirectedSplit = vi.fn(() => undefined);
    const liveOwnerOf = vi.fn(() => input.liveOwner);
    const dispatch = vi.fn(() => Promise.resolve());
    const dock = {
      leafIds: () => ['main'],
      splitPane,
      liveOwnerOf,
      discardRedirectedSplit,
      moveTab: vi.fn(() => Promise.resolve(null)),
      closeTab: vi.fn(() => Promise.resolve()),
      closePane: vi.fn(() => Promise.resolve()),
      closeOtherPanes: vi.fn(() => Promise.resolve()),
      openView: vi.fn(() => Promise.resolve('view-tab')),
    };
    const paneStateForTest = {
      pane: 'main',
      tabs: [
        { id: 'doc1', kind: 'document', documentId: 'doc1', viewId: null },
      ],
      activeTab: 'doc1',
      mode: 'edit',
      documentId: 'doc1',
      viewId: null,
      title: 'doc1',
      path: 'doc1.md',
      dirty: false,
      recoveryWarnings: [],
      canGoBack: false,
      canGoForward: false,
    } as const;
    const assembled = buildDockTreePane({
      paneId: 'main',
      ports: {
        state: { focusPane: vi.fn() } as never,
        dock: dock as never,
        documents: {
          pruneMissingDocuments: vi.fn(() => Promise.resolve()),
        } as never,
        reading: {
          readingPresentation: () =>
            ({ kind: 'editor-readonly', kindId: null }) as const,
          availableTabModes: () => ['edit', 'reading'] as const,
        } as never,
        router: { dispatch } as never,
      },
      callbacks: {
        onOpenSwitcher: () => undefined,
        onCreateNote: () => undefined,
        notify: () => undefined,
        bump: () => undefined,
        dispatchWorkspaceEvent: () => undefined,
      },
      snapshot: {
        paneState: { ...paneStateForTest } as never,
        paneStateOf: () => ({ ...paneStateForTest }) as never,
        focusedPane: 'main',
        documentById: new Map([
          ['doc1', { documentId: 'doc1', title: 'doc1', path: 'doc1.md' }],
        ]) as never,
        revision: 0,
      },
      mobile: false,
      views: { get: () => undefined } as never,
      settingsService: null,
      drag: {
        drag: null,
        dropTarget: null,
        startTabDrag: () => undefined,
        onPaneZoneEnter: () => undefined,
        clearDropTarget: () => undefined,
      },
    });
    return {
      actions: assembled.actions,
      dock: { splitPane, discardRedirectedSplit, liveOwnerOf },
      router: { dispatch },
    };
  }

  it('splits to an empty pane when the document is live elsewhere', () => {
    const { actions, dock, router } = buildSplitPane({ liveOwner: 'second' });
    const { run } = splitEntryFor(actions, 'doc1', 'Split right');
    run();
    expect(dock.liveOwnerOf).toHaveBeenCalledWith('doc1');
    expect(dock.splitPane).toHaveBeenCalledWith('main', 'right');
    expect(router.dispatch).not.toHaveBeenCalled();
    expect(dock.discardRedirectedSplit).not.toHaveBeenCalled();
  });

  it('splits to an empty pane when the document is live in this pane', () => {
    const { actions, dock, router } = buildSplitPane({
      liveOwner: 'main',
      splitCreated: 'pane-2',
    });
    const { run } = splitEntryFor(actions, 'doc1', 'Split right');
    run();
    expect(dock.liveOwnerOf).toHaveBeenCalledWith('doc1');
    expect(dock.splitPane).toHaveBeenCalledWith('main', 'right');
    expect(router.dispatch).not.toHaveBeenCalled();
    expect(dock.discardRedirectedSplit).not.toHaveBeenCalled();
  });

  it('splits inactive tabs and runs the race-net discard', async () => {
    const { actions, dock, router } = buildSplitPane({
      liveOwner: null,
      splitCreated: 'pane-2',
    });
    const { run } = splitEntryFor(actions, 'doc1');
    run();
    for (let i = 0; i < 10 && router.dispatch.mock.calls.length === 0; i += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    // Let the post-dispatch discard lane flush as well.
    for (
      let i = 0;
      i < 10 && dock.discardRedirectedSplit.mock.calls.length === 0;
      i += 1
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(dock.liveOwnerOf).toHaveBeenCalledWith('doc1');
    expect(dock.splitPane).toHaveBeenCalledWith('main', 'right');
    expect(router.dispatch).toHaveBeenCalledWith({
      type: 'open-document',
      documentId: 'doc1',
      disposition: 'foreground',
      pane: 'pane-2',
    });
    expect(dock.discardRedirectedSplit).toHaveBeenCalledWith('pane-2', 'doc1');
  });
});
