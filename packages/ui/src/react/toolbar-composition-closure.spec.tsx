// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  DocumentToolControl,
  DocumentToolSnapshot,
} from '@froglight/foundation';
import type { WorkbenchEditorToolsPort } from '../workbench-ports.js';
import { createDocumentToolbarRegistry } from '../document-toolbar-registry.js';
import { createToolbarPlacementRegistry } from '../toolbar/placement-registry.js';
import { createToolbarCompositionRegistry } from '../toolbar/composition-registry.js';
import { defaultToolbarComposition } from '../toolbar/default-composition.js';
import {
  computeUnifiedToolbarModel,
  resolveActiveToolCategoryId,
  resolveActiveToolControlId,
  resolveExpandedCategoryId,
} from '../toolbar/unified-toolbar-model.js';
import { WorkspaceContextProvider } from './workspace/WorkspaceContext.js';
import {
  Pane,
  toPaneViewModel,
} from './workspace/components/Pane.jsx';
import type { InstalledUi } from '../workbench.js';
import type { WorkbenchReadingPresentation } from '../workbench-ports.js';
import type { WorkbenchDocumentView } from '../workbench.js';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function makeTools(snapshot: DocumentToolSnapshot | null) {
  const listeners = new Set<() => void>();
  let current = snapshot;
  const calls: Array<[string, string?]> = [];
  return {
    calls,
    setSnapshot(next: DocumentToolSnapshot | null) {
      current = next;
      for (const listener of listeners) listener();
    },
    canExecEditorCommand: () => true,
    execEditorCommand: () => true,
    editorToolSnapshot: () => current,
    executeEditorTool: (_pane: string, id: string, value?: string) => {
      calls.push(value === undefined ? [id] : [id, value]);
      return true;
    },
    onDidChange: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
}

function penSnapshot(activeId: string): DocumentToolSnapshot {
  return {
    context: 'Ink canvas',
    controls: [
      {
        kind: 'button',
        id: 'ink.pen',
        group: 'draw',
        label: 'Ball Pen',
        icon: 'pen',
        role: 'surface-tool',
        toolRole: 'pen',
        semanticRole: 'surface.pen.ball',
        active: activeId === 'ink.pen',
      },
      {
        kind: 'button',
        id: 'ink.eraser',
        group: 'draw',
        label: 'Eraser',
        icon: 'eraser',
        role: 'surface-tool',
        toolRole: 'eraser',
        semanticRole: 'surface.erase',
        active: activeId === 'ink.eraser',
      },
      {
        kind: 'button',
        id: 'ink.rect',
        group: 'draw',
        label: 'Rectangle',
        icon: 'rect',
        role: 'surface-tool',
        toolRole: 'shape',
        semanticRole: 'surface.shape.rectangle',
        active: activeId === 'ink.rect',
      },
    ],
  };
}

/**
 * Exclusive-role Ink snapshot for same-category reconciliation.
 * Pen and Pencil share `surface.write` but have distinct control ids; every
 * draw control carries `activationRole: 'tool'` so Bold-style toggles can be
 * distinguished. Rectangle keeps `surface.shapes` resolvable for browsing.
 */
function exclusiveInkSnapshot(
  activeId: string | null,
  extraControls: readonly DocumentToolControl[] = [],
): DocumentToolSnapshot {
  const tool = (
    id: string,
    label: string,
    semanticRole: string,
    toolRole: 'pen' | 'eraser' | 'shape',
    icon: string,
  ): DocumentToolControl =>
    ({
      kind: 'button',
      id,
      group: 'draw',
      label,
      icon,
      role: 'surface-tool',
      toolRole,
      semanticRole,
      active: activeId === id,
      activationRole: 'tool',
    }) as DocumentToolControl;
  return {
    context: 'Ink canvas',
    controls: [
      tool('ink.pen', 'Ball Pen', 'surface.pen.ball', 'pen', 'pen'),
      tool('ink.pencil', 'Pencil', 'surface.pencil', 'pen', 'pencil'),
      tool('ink.eraser', 'Eraser', 'surface.erase', 'eraser', 'eraser'),
      tool('ink.rect', 'Rectangle', 'surface.shape.rectangle', 'shape', 'rect'),
      ...extraControls,
    ],
  };
}

function toggleBoldControl(active: boolean): DocumentToolControl {
  return {
    kind: 'button',
    id: 'markdown.bold',
    group: 'format',
    label: 'Bold',
    shortLabel: 'B',
    semanticRole: 'writing.bold',
    active,
    activationRole: 'toggle',
  } as DocumentToolControl;
}

describe('composition ownership closure', () => {
  it('keeps semantic items executable without legacy placement claims', () => {
    const tools = makeTools(penSnapshot('ink.pen')) as unknown as WorkbenchEditorToolsPort;
    const contributions = createDocumentToolbarRegistry();
    const placements = createToolbarPlacementRegistry();
    const composition = createToolbarCompositionRegistry();
    const defaults = defaultToolbarComposition();
    for (const entry of defaults.categories)
      composition.registry.registerCategory(entry);
    for (const entry of defaults.items)
      composition.registry.registerItem(entry);
    for (const entry of defaults.extensions)
      composition.registry.registerKindExtension(entry);

    // No legacy placements at all: layout.owned stays empty for these ids.
    const computed = computeUnifiedToolbarModel({
      tools,
      contributions: contributions.registry,
      placements: placements.registry,
      composition: composition.registry,
      pane: 'main',
      documentId: 'doc-1',
      kindId: 'froglight.ink',
    });
    expect(computed.compositionGraph?.categories.length).toBeGreaterThan(0);
    const write = computed.compositionGraph?.categories.find(
      (category) => category.id === 'surface.write',
    );
    expect(write?.items.map((item) => item.control.id)).toContain('ink.pen');
    // Full-pool ownership, not placement-claimed subset.
    expect(computed.ownedById.get('ink.pen')?.owner.kind).toBe('provider');
    expect(computed.layout.owned.map((owned) => owned.control.id)).not.toContain(
      'ink.pen',
    );
    contributions.dispose();
    placements.dispose();
    composition.dispose();
  });

  it('distinguishes expanded category from active-tool category', () => {
    const tools = makeTools(penSnapshot('ink.pen')) as unknown as WorkbenchEditorToolsPort;
    const contributions = createDocumentToolbarRegistry();
    const placements = createToolbarPlacementRegistry();
    const composition = createToolbarCompositionRegistry();
    const defaults = defaultToolbarComposition();
    for (const entry of defaults.categories)
      composition.registry.registerCategory(entry);
    for (const entry of defaults.items)
      composition.registry.registerItem(entry);
    for (const entry of defaults.extensions)
      composition.registry.registerKindExtension(entry);
    const computed = computeUnifiedToolbarModel({
      tools,
      contributions: contributions.registry,
      placements: placements.registry,
      composition: composition.registry,
      pane: 'main',
      documentId: 'doc-1',
      kindId: 'froglight.ink',
    });
    expect(resolveActiveToolControlId(computed.compositionGraph)).toBe('ink.pen');
    expect(resolveActiveToolCategoryId(computed.compositionGraph)).toBe(
      'surface.write',
    );
    // Manual browsing selects Shapes while the active tool stays in Write.
    expect(
      resolveExpandedCategoryId(computed.compositionGraph, 'surface.shapes'),
    ).toBe('surface.shapes');
    // No selection falls back to the active-tool category.
    expect(resolveExpandedCategoryId(computed.compositionGraph, null)).toBe(
      'surface.write',
    );
    contributions.dispose();
    placements.dispose();
    composition.dispose();
  });
});

describe('category/tool reconciliation (mounted)', () => {
  let root: Root | null = null;
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    document.body.replaceChildren();
  });

  it('follows external tool changes instead of presenting a stale category', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const tools = makeTools(penSnapshot('ink.pen'));
    const contributions = createDocumentToolbarRegistry();
    const placements = createToolbarPlacementRegistry();
    const composition = createToolbarCompositionRegistry();
    const defaults = defaultToolbarComposition();
    for (const entry of defaults.categories)
      composition.registry.registerCategory(entry);
    for (const entry of defaults.items)
      composition.registry.registerItem(entry);
    for (const entry of defaults.extensions)
      composition.registry.registerKindExtension(entry);
    const ui = {
      services: { try: () => undefined },
      documentTools: contributions.registry,
      documentToolbarPlacements: placements.registry,
      toolbarComposition: composition.registry,
      views: {
        get: () => undefined,
        list: () => [],
        onDidChange: () => ({ dispose: () => undefined }),
      },
    } as unknown as InstalledUi;
    const presentation: WorkbenchReadingPresentation = {
      kind: 'editor-readonly',
      kindId: 'froglight.ink' as never,
    };
    const renderPane = async (): Promise<void> => {
      const documentById = new Map<string, WorkbenchDocumentView>([
        [
          'doc-1',
          {
            documentId: 'doc-1',
            kindId: 'froglight.ink',
            path: 'ink.ink',
            title: 'ink.ink',
          },
        ],
      ]);
      const model = toPaneViewModel({
        paneId: 'main',
        paneState: {
          pane: 'main',
          tabs: [{ id: 'doc-1', kind: 'document', documentId: 'doc-1', viewId: null }],
          activeTab: 'doc-1',
          mode: 'edit',
          documentId: 'doc-1',
          viewId: null,
          title: 'ink.ink',
          path: 'ink.ink',
          dirty: false,
          recoveryWarnings: [],
          canGoBack: true,
          canGoForward: false,
        } as never,
        focusedPane: 'main',
        mobile: false,
        documentById,
        views: {
          get: () => undefined,
          list: () => [],
          onDidChange: () => ({ dispose: () => undefined }),
        } as unknown as InstalledUi['views'],
        drag: null,
        dropTarget: null,
        revision: 0,
        settingsService: null,
        presentation,
      });
      await act(async () => {
        root?.render(
          <WorkspaceContextProvider
            value={{
              controller: {} as never,
              ui,
              choice: {} as never,
              chrome: {} as never,
              onClose: () => undefined,
            }}
          >
            <Pane
              model={model}
              actions={{
                onPointerDownPane: () => undefined,
                onActivateTab: () => undefined,
                onCloseTab: () => undefined,
                onFocusPane: () => undefined,
                onOpenSwitcher: () => undefined,
                onCreateNote: () => undefined,
                onTabPointerDown: () => undefined,
                onTabContextMenu: () => undefined,
                onGoBack: () => undefined,
                onGoForward: () => undefined,
                onSplitRight: () => undefined,
                onSplitDown: () => undefined,
                onSetMode: () => undefined,
                onOpenNoteMenu: () => undefined,
                onPaneContextMenu: () => undefined,
                onZoneEnter: () => undefined,
                onZoneLeave: () => undefined,
              }}
              hosts={{ editorHosts: { current: new Map() }, readerHosts: { current: new Map() } }}
              views={ui.views}
              tools={tools as unknown as WorkbenchEditorToolsPort}
            />
          </WorkspaceContextProvider>,
        );
      });
    };
    await renderPane();
    // Initially the active tool (Ball Pen) drives the Write shelf.
    expect(
      host.querySelector('[data-tool-shelf="surface.write"]'),
    ).not.toBeNull();
    // User browses Shapes without changing the tool.
    await act(async () => {
      (host.querySelector(
        '[data-toolbar="category-strip"] [data-category="surface.shapes"]',
      ) as HTMLButtonElement).click();
    });
    expect(
      host.querySelector('[data-tool-shelf="surface.shapes"]'),
    ).not.toBeNull();
    // The strip still marks Write as containing the real active tool.
    expect(
      host.querySelector(
        '[data-toolbar="category-strip"] [data-category="surface.write"]',
      )?.getAttribute('data-contains-active-tool'),
    ).toBe('true');
    // External tool change (double-tap / squeeze / shortcut / restore):
    // provider snapshot now reports Eraser active.
    await act(async () => {
      tools.setSnapshot(penSnapshot('ink.eraser'));
    });
    // Shelf reconciles to Erase instead of presenting stale Shapes.
    expect(
      host.querySelector('[data-tool-shelf="surface.erase"]'),
    ).not.toBeNull();
    expect(
      host.querySelector('[data-tool-shelf="surface.shapes"]'),
    ).toBeNull();
    contributions.dispose();
    placements.dispose();
    composition.dispose();
  });

  it('reconciles same-category Pen → Pencil and ignores Bold toggles', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const tools = makeTools(exclusiveInkSnapshot('ink.pen'));
    const contributions = createDocumentToolbarRegistry();
    const placements = createToolbarPlacementRegistry();
    const composition = createToolbarCompositionRegistry();
    const defaults = defaultToolbarComposition();
    for (const entry of defaults.categories)
      composition.registry.registerCategory(entry);
    for (const entry of defaults.items)
      composition.registry.registerItem(entry);
    for (const entry of defaults.extensions)
      composition.registry.registerKindExtension(entry);
    const ui = {
      services: { try: () => undefined },
      documentTools: contributions.registry,
      documentToolbarPlacements: placements.registry,
      toolbarComposition: composition.registry,
      views: {
        get: () => undefined,
        list: () => [],
        onDidChange: () => ({ dispose: () => undefined }),
      },
    } as unknown as InstalledUi;
    const presentation: WorkbenchReadingPresentation = {
      kind: 'editor-readonly',
      kindId: 'froglight.ink' as never,
    };
    const renderPane = async (): Promise<void> => {
      const documentById = new Map<string, WorkbenchDocumentView>([
        [
          'doc-1',
          {
            documentId: 'doc-1',
            kindId: 'froglight.ink',
            path: 'ink.ink',
            title: 'ink.ink',
          },
        ],
      ]);
      const model = toPaneViewModel({
        paneId: 'main',
        paneState: {
          pane: 'main',
          tabs: [{ id: 'doc-1', kind: 'document', documentId: 'doc-1', viewId: null }],
          activeTab: 'doc-1',
          mode: 'edit',
          documentId: 'doc-1',
          viewId: null,
          title: 'ink.ink',
          path: 'ink.ink',
          dirty: false,
          recoveryWarnings: [],
          canGoBack: true,
          canGoForward: false,
        } as never,
        focusedPane: 'main',
        mobile: false,
        documentById,
        views: {
          get: () => undefined,
          list: () => [],
          onDidChange: () => ({ dispose: () => undefined }),
        } as unknown as InstalledUi['views'],
        drag: null,
        dropTarget: null,
        revision: 0,
        settingsService: null,
        presentation,
      });
      await act(async () => {
        root?.render(
          <WorkspaceContextProvider
            value={{
              controller: {} as never,
              ui,
              choice: {} as never,
              chrome: {} as never,
              onClose: () => undefined,
            }}
          >
            <Pane
              model={model}
              actions={{
                onPointerDownPane: () => undefined,
                onActivateTab: () => undefined,
                onCloseTab: () => undefined,
                onFocusPane: () => undefined,
                onOpenSwitcher: () => undefined,
                onCreateNote: () => undefined,
                onTabPointerDown: () => undefined,
                onTabContextMenu: () => undefined,
                onGoBack: () => undefined,
                onGoForward: () => undefined,
                onSplitRight: () => undefined,
                onSplitDown: () => undefined,
                onSetMode: () => undefined,
                onOpenNoteMenu: () => undefined,
                onPaneContextMenu: () => undefined,
                onZoneEnter: () => undefined,
                onZoneLeave: () => undefined,
              }}
              hosts={{ editorHosts: { current: new Map() }, readerHosts: { current: new Map() } }}
              views={ui.views}
              tools={tools as unknown as WorkbenchEditorToolsPort}
            />
          </WorkspaceContextProvider>,
        );
      });
    };
    await renderPane();
    // Pen drives the Write shelf with Ball Pen pressed.
    expect(
      host.querySelector('[data-tool-shelf="surface.write"]'),
    ).not.toBeNull();
    expect(
      host
        .querySelector('[data-tool-shelf="surface.write"] [aria-label="Ball Pen"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    // User browses Shapes without changing the tool.
    await act(async () => {
      (host.querySelector(
        '[data-toolbar="category-strip"] [data-category="surface.shapes"]',
      ) as HTMLButtonElement).click();
    });
    expect(
      host.querySelector('[data-tool-shelf="surface.shapes"]'),
    ).not.toBeNull();
    // Same snapshot (no exclusive change) keeps browsing on Shapes.
    await act(async () => {
      tools.setSnapshot(exclusiveInkSnapshot('ink.pen'));
    });
    expect(
      host.querySelector('[data-tool-shelf="surface.shapes"]'),
    ).not.toBeNull();
    // Bold toggle active never drives an exclusive transition.
    await act(async () => {
      tools.setSnapshot(
        exclusiveInkSnapshot('ink.pen', [toggleBoldControl(true)]),
      );
    });
    expect(
      host.querySelector('[data-tool-shelf="surface.shapes"]'),
    ).not.toBeNull();
    expect(
      host.querySelector(
        '[data-toolbar="category-strip"] [data-category="surface.write"]',
      )?.getAttribute('data-contains-active-tool'),
    ).toBe('true');
    // External same-category switch (squeeze / shortcut / provider command):
    // Pencil becomes the exclusive tool inside surface.write.
    await act(async () => {
      tools.setSnapshot(exclusiveInkSnapshot('ink.pencil'));
    });
    // Shelf reconciles back to Write with Pencil pressed.
    expect(
      host.querySelector('[data-tool-shelf="surface.write"]'),
    ).not.toBeNull();
    expect(
      host.querySelector('[data-tool-shelf="surface.shapes"]'),
    ).toBeNull();
    expect(
      host
        .querySelector('[data-tool-shelf="surface.write"] [aria-label="Pencil"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      host
        .querySelector('[data-tool-shelf="surface.write"] [aria-label="Ball Pen"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('false');
    contributions.dispose();
    placements.dispose();
    composition.dispose();
  });
});
