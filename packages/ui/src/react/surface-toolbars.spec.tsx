// @vitest-environment jsdom
/**
 * Surface toolbars acceptance (Spec #48: Ink, Notebook, Whiteboard).
 *
 * Primary presentation seam: mount each family in the real React Pane with
 * the real toolbar registries; assert controls by roles/names/anchors and
 * drive them through the rendered UI.
 *
 * Grammar under test (composition owns primaries + quick properties):
 * - primary creation/selection tools in the composition category strip +
 *   contextual shelf (not a topbar-center placement)
 * - provider-local history in built-in float.top-left (stable)
 * - quick colors/widths/eraser-size in the composition shelf + settings
 *   popover (no legacy float.top-center property island)
 * - compact zoom/navigation in float.bottom-right (out, reset %, in, fit)
 * - Notebook page navigation vs page actions dedicated bottom-center groups
 * - bounded-canvas/page-size at bottom-left, separate from pen properties
 * - no persistent visible context labels (PEN/ERASER/Notebook Page)
 * - no redundant zoom number/slider in the permanent layout
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DocumentToolControl,
  DocumentToolSnapshot,
} from '@froglight/foundation';
import type {
  WorkbenchEditorToolsPort,
  WorkbenchReadingPresentation,
} from '../workbench-ports.js';
import type { WorkbenchDocumentView } from '../workbench.js';
import { createDocumentToolbarRegistry } from '../document-toolbar-registry.js';
import {
  createToolbarPlacementRegistry,
  type ToolbarPlacementContribution,
} from '../toolbar/placement-registry.js';
import { defaultToolbarPlacements } from '../toolbar/default-placements.js';
import { createToolbarCompositionRegistry } from '../toolbar/composition-registry.js';
import { defaultToolbarComposition } from '../toolbar/default-composition.js';
import { WorkspaceContextProvider } from './workspace/WorkspaceContext.js';
import {
  Pane,
  toPaneViewModel,
  type PaneActions,
  type PaneHosts,
} from './workspace/components/Pane.jsx';
import type { InstalledUi } from '../workbench.js';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const button = (
  id: string,
  label: string,
  extra: Partial<Extract<DocumentToolControl, { kind: 'button' }>> = {},
): DocumentToolControl => ({
  kind: 'button',
  id,
  group: 'test',
  label,
  ...extra,
});

function inkSnapshot(activeId: string, zoom = 100): DocumentToolSnapshot {
  const isActive = (id: string): boolean => id === activeId;
  // draw tools carry semanticRoles so the composition graph (the
  // sole primary source) resolves them; geometric placements keep only
  // style/zoom/canvas islands.
  return {
    context: 'Ink canvas',
    controls: [
      button('ink.tool.froglight.ink.select', 'Select', {
        group: 'draw',
        active: isActive('ink.tool.froglight.ink.select'),
        semanticRole: 'surface.select',
      } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
      button('ink.tool.froglight.ink.pen', 'Pen', {
        group: 'draw',
        active: isActive('ink.tool.froglight.ink.pen'),
        semanticRole: 'surface.pen.ball',
      } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
      button('ink.tool.froglight.ink.highlighter', 'Highlighter', {
        group: 'draw',
        active: isActive('ink.tool.froglight.ink.highlighter'),
        semanticRole: 'surface.highlighter',
      } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
      button('ink.tool.froglight.ink.eraser', 'Eraser', {
        group: 'draw',
        active: isActive('ink.tool.froglight.ink.eraser'),
        semanticRole: 'surface.erase',
      } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
      button('ink.tool.froglight.ink.lasso', 'Lasso', {
        group: 'draw',
        active: isActive('ink.tool.froglight.ink.lasso'),
        semanticRole: 'surface.lasso',
      } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
      button('ink.tool.froglight.ink.rect', 'Rectangle', {
        group: 'draw',
        active: isActive('ink.tool.froglight.ink.rect'),
        semanticRole: 'surface.shape.rectangle',
      } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
      button('ink.tool.froglight.ink.ellipse', 'Ellipse', {
        group: 'draw',
        active: isActive('ink.tool.froglight.ink.ellipse'),
        semanticRole: 'surface.shape.ellipse',
      } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
      button('ink.tool.froglight.ink.line', 'Line', {
        group: 'draw',
        active: isActive('ink.tool.froglight.ink.line'),
        semanticRole: 'surface.shape.line',
      } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
      button('ink.tool.froglight.ink.text', 'Text', {
        group: 'draw',
        active: isActive('ink.tool.froglight.ink.text'),
        semanticRole: 'surface.insert.text',
        activationRole: 'tool',
      } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
      button('ink.image', 'Insert image', {
        group: 'insert',
        semanticRole: 'surface.insert.image',
      } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
      {
        kind: 'color',
        id: 'ink.color',
        group: 'style',
        label: 'Stroke color',
        value: '#37352f',
        options: ['#37352f', '#7c6cf0'],
      },
      {
        kind: 'choice',
        id: 'ink.width',
        group: 'style',
        label: 'Stroke width',
        value: '3.5',
        options: [{ value: '3.5', label: '3.5 px' }],
      },
      {
        kind: 'range',
        id: 'ink.eraser-radius',
        group: 'style',
        label: 'Eraser size',
        value: 10,
        min: 2,
        max: 40,
        step: 1,
      },
      button('ink.zoom-out', 'Zoom out', { group: 'view' }),
      button('ink.zoom-reset', `Zoom ${zoom}%, activate to reset to 100%`, {
        group: 'view',
      }),
      // Exact controls stay provider-exposed but must remain unplaced.
      {
        kind: 'number',
        id: 'ink.zoom',
        group: 'view',
        label: 'Zoom',
        value: zoom,
        min: 25,
        max: 800,
        step: 1,
        suffix: '%',
      },
      {
        kind: 'range',
        id: 'ink.zoom-slider',
        group: 'view',
        label: 'Zoom slider',
        value: zoom,
        min: 25,
        max: 800,
        step: 5,
      },
      button('ink.zoom-in', 'Zoom in', { group: 'view' }),
      button('ink.fit', 'Fit canvas', { group: 'view' }),
      {
        kind: 'number',
        id: 'ink.frame-width',
        group: 'canvas',
        label: 'Canvas width',
        value: 800,
        min: 1,
        max: 10000,
        step: 1,
        suffix: 'px',
      },
      {
        kind: 'number',
        id: 'ink.frame-height',
        group: 'canvas',
        label: 'Canvas height',
        value: 600,
        min: 1,
        max: 10000,
        step: 1,
        suffix: 'px',
      },
    ],
  };
}

function notebookSnapshot(activeId: string, zoom = 100): DocumentToolSnapshot {
  return {
    context: 'Notebook page',
    controls: [
      button('notebook.tool.froglight.ink.select', 'Select', {
        group: 'draw',
        active: activeId === 'notebook.tool.froglight.ink.select',
        semanticRole: 'surface.select',
      } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
      button('notebook.tool.froglight.ink.pen', 'Pen', {
        group: 'draw',
        active: activeId === 'notebook.tool.froglight.ink.pen',
        semanticRole: 'surface.pen.ball',
      } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
      button('notebook.tool.froglight.ink.highlighter', 'Highlighter', {
        group: 'draw',
        active: activeId === 'notebook.tool.froglight.ink.highlighter',
        semanticRole: 'surface.highlighter',
      } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
      button('notebook.tool.froglight.ink.eraser', 'Eraser', {
        group: 'draw',
        active: activeId === 'notebook.tool.froglight.ink.eraser',
        semanticRole: 'surface.erase',
      } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
      button('notebook.tool.froglight.ink.lasso', 'Lasso', {
        group: 'draw',
        active: activeId === 'notebook.tool.froglight.ink.lasso',
        semanticRole: 'surface.lasso',
      } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
      button('notebook.tool.froglight.ink.rect', 'Rectangle', {
        group: 'draw',
        active: activeId === 'notebook.tool.froglight.ink.rect',
        semanticRole: 'surface.shape.rectangle',
      } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
      button('notebook.tool.froglight.notebook.text', 'Text', {
        group: 'draw',
        active: activeId === 'notebook.tool.froglight.notebook.text',
        semanticRole: 'surface.insert.text',
        activationRole: 'tool',
      } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
      button('notebook.image', 'Insert image', {
        group: 'insert',
        semanticRole: 'surface.insert.image',
      } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
      {
        kind: 'color',
        id: 'notebook.color',
        group: 'style',
        label: 'Stroke color',
        value: '#37352f',
        options: ['#37352f'],
      },
      {
        kind: 'choice',
        id: 'notebook.width',
        group: 'style',
        label: 'Stroke width',
        value: '3.5',
        options: [{ value: '3.5', label: '3.5 px' }],
      },
      {
        kind: 'range',
        id: 'notebook.eraser-radius',
        group: 'style',
        label: 'Eraser size',
        value: 10,
        min: 2,
        max: 40,
        step: 1,
      },
      button('notebook.previous', 'Previous page', { group: 'pages' }),
      {
        kind: 'status',
        id: 'notebook.page',
        group: 'pages',
        label: '2 / 5',
      },
      button('notebook.next', 'Next page', { group: 'pages' }),
      button('notebook.add', 'Add page', {
        group: 'pages',
        semanticRole: 'notebook.page.add',
      }),
      button('notebook.duplicate', 'Duplicate page', {
        group: 'pages',
        semanticRole: 'notebook.page.duplicate',
      }),
      button('notebook.delete', 'Delete page', {
        group: 'pages',
        semanticRole: 'notebook.page.delete',
      }),
      {
        kind: 'choice',
        id: 'notebook.template',
        group: 'pages',
        label: 'Page paper',
        value: 'blank',
        options: [{ value: 'blank', label: 'Blank' }],
        semanticRole: 'notebook.page.template',
      },
      button('notebook.overview', 'Page overview', {
        group: 'view',
        semanticRole: 'notebook.page.overview',
      }),
      button('notebook.insert-pdf-before', 'Insert PDF before current page', {
        group: 'insert',
        semanticRole: 'notebook.insert.pdf.before',
      }),
      button('notebook.insert-pdf-after', 'Insert PDF after current page', {
        group: 'insert',
        semanticRole: 'notebook.insert.pdf.after',
      }),
      button('notebook.zoom-out', 'Zoom out', { group: 'view' }),
      button(
        'notebook.zoom-reset',
        `Notebook zoom ${zoom}%, activate to reset to 100%`,
        { group: 'view' },
      ),
      {
        kind: 'number',
        id: 'notebook.zoom',
        group: 'view',
        label: 'Notebook zoom',
        value: zoom,
        min: 25,
        max: 800,
        step: 1,
        suffix: '%',
      },
      {
        kind: 'range',
        id: 'notebook.zoom-slider',
        group: 'view',
        label: 'Notebook zoom slider',
        value: zoom,
        min: 25,
        max: 800,
        step: 5,
      },
      button('notebook.zoom-in', 'Zoom in', { group: 'view' }),
      button('notebook.fit', 'Fit notebook pages', { group: 'view' }),
      {
        kind: 'number',
        id: 'notebook.page-width',
        group: 'page-size',
        label: 'Page width',
        value: 800,
        min: 64,
        max: 20000,
        step: 1,
        suffix: 'px',
      },
      {
        kind: 'number',
        id: 'notebook.page-height',
        group: 'page-size',
        label: 'Page height',
        value: 600,
        min: 64,
        max: 20000,
        step: 1,
        suffix: 'px',
      },
    ],
  };
}

function whiteboardSnapshot(activeId: string): DocumentToolSnapshot {
  const isActive = (id: string): boolean => id === activeId;
  return {
    context: 'Whiteboard',
    controls: [
      button('whiteboard.tool.select', 'Select', {
        group: 'select',
        active: isActive('whiteboard.tool.select'),
        semanticRole: 'surface.select',
      } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
      button('whiteboard.tool.pen', 'Pen', {
        group: 'draw',
        active: isActive('whiteboard.tool.pen'),
        semanticRole: 'surface.pen.ball',
      } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
      button('whiteboard.tool.highlighter', 'Highlighter', {
        group: 'draw',
        active: isActive('whiteboard.tool.highlighter'),
        semanticRole: 'surface.highlighter',
      } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
      button('whiteboard.tool.eraser', 'Eraser', {
        group: 'erase',
        active: isActive('whiteboard.tool.eraser'),
        semanticRole: 'surface.erase',
      } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
      button('whiteboard.tool.lasso', 'Lasso', {
        group: 'select',
        active: isActive('whiteboard.tool.lasso'),
        semanticRole: 'surface.lasso',
      } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
      button('whiteboard.tool.text', 'Text', {
        group: 'insert',
        active: isActive('whiteboard.tool.text'),
        semanticRole: 'surface.insert.text',
        activationRole: 'tool',
      } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
      button('whiteboard.tool.card', 'Card', {
        group: 'insert',
        active: isActive('whiteboard.tool.card'),
        semanticRole: 'surface.insert.card',
      } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
      button('whiteboard.tool.rect', 'Rectangle', {
        group: 'shapes',
        active: isActive('whiteboard.tool.rect'),
        semanticRole: 'surface.shape.rectangle',
      } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
      button('whiteboard.tool.ellipse', 'Ellipse', {
        group: 'shapes',
        active: isActive('whiteboard.tool.ellipse'),
        semanticRole: 'surface.shape.ellipse',
      } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
      button('whiteboard.tool.line', 'Line', {
        group: 'connect',
        active: isActive('whiteboard.tool.line'),
        semanticRole: 'surface.shape.line',
      } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
      button('whiteboard.image', 'Insert image', {
        group: 'insert',
        semanticRole: 'surface.insert.image',
      } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
      {
        kind: 'color',
        id: 'whiteboard.color',
        group: 'style',
        label: 'Color',
        value: '#37352f',
        options: ['#37352f'],
      },
      {
        kind: 'choice',
        id: 'whiteboard.width',
        group: 'style',
        label: 'Width',
        value: '2',
        options: [{ value: '2', label: '2 px' }],
      },
      {
        kind: 'range',
        id: 'whiteboard.eraser-radius',
        group: 'style',
        label: 'Eraser size',
        value: 10,
        min: 2,
        max: 40,
        step: 1,
      },
      button('whiteboard.zoom-out', 'Zoom out', { group: 'view' }),
      button(
        'whiteboard.zoom-reset',
        'Whiteboard zoom 100%, activate to reset to 100%',
        {
          group: 'view',
        },
      ),
      button('whiteboard.zoom-in', 'Zoom in', { group: 'view' }),
      button('whiteboard.fit', 'Fit board', { group: 'view' }),
    ],
  };
}

interface ToolsDouble extends WorkbenchEditorToolsPort {
  setSnapshot(snapshot: DocumentToolSnapshot | null): void;
  calls: {
    execute: Array<[string, string?]>;
    commands: Array<'undo' | 'redo'>;
  };
}

function makeTools(snapshot: DocumentToolSnapshot | null): ToolsDouble {
  const listeners = new Set<() => void>();
  let current = snapshot;
  const calls: ToolsDouble['calls'] = { execute: [], commands: [] };
  return {
    calls,
    setSnapshot(next) {
      current = next;
      for (const listener of listeners) listener();
    },
    canExecEditorCommand: () => true,
    execEditorCommand: (command) => {
      calls.commands.push(command);
      return true;
    },
    editorToolSnapshot: () => current,
    executeEditorTool: (_pane, id, value) => {
      calls.execute.push(value === undefined ? [id] : [id, value]);
      for (const listener of listeners) listener();
      return true;
    },
    onDidChange: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
}

function paneState(mode: 'edit' | 'reading', documentId: string) {
  return {
    pane: 'main',
    tabs: [{ id: documentId, kind: 'document', documentId, viewId: null }],
    activeTab: documentId,
    mode,
    documentId,
    viewId: null,
    title: 'surface',
    path: 'notes/surface',
    dirty: false,
    recoveryWarnings: [],
    canGoBack: true,
    canGoForward: false,
  } as const;
}

function stubActions(): PaneActions {
  const noop = (): void => undefined;
  return {
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
}

function stubViews(): InstalledUi['views'] {
  return {
    get: () => undefined,
    list: () => [],
    onDidChange: () => ({ dispose: () => undefined }),
  } as unknown as InstalledUi['views'];
}

describe('surface toolbars (mounted Pane)', () => {
  let root: Root | null = null;

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  async function mountPane(input: {
    mode?: 'edit' | 'reading';
    documentId?: string;
    kindId?: string;
    snapshot?: DocumentToolSnapshot | null;
    seedPlacements?: readonly ToolbarPlacementContribution[];
  }): Promise<{
    host: HTMLElement;
    tools: ToolsDouble;
    contributions: ReturnType<typeof createDocumentToolbarRegistry>;
    placements: ReturnType<typeof createToolbarPlacementRegistry>;
    composition: ReturnType<typeof createToolbarCompositionRegistry>;
  }> {
    const {
      mode = 'edit',
      documentId = 'doc-1',
      kindId = 'froglight.ink',
      snapshot = inkSnapshot('ink.tool.froglight.ink.pen'),
      seedPlacements = defaultToolbarPlacements(),
    } = input;
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const tools = makeTools(snapshot);
    const contributions = createDocumentToolbarRegistry();
    const placements = createToolbarPlacementRegistry();
    for (const placement of seedPlacements)
      placements.registry.register(placement);
    // production installs the default composition alongside
    // geometric placements; primary tools resolve through it.
    const composition = createToolbarCompositionRegistry();
    const defaults = defaultToolbarComposition();
    for (const entry of defaults.categories)
      composition.registry.registerCategory(entry);
    for (const entry of defaults.items)
      composition.registry.registerItem(entry);
    for (const entry of defaults.extensions)
      composition.registry.registerKindExtension(entry);
    const presentation: WorkbenchReadingPresentation = {
      kind: 'editor-readonly',
      kindId: kindId as never,
    };
    const hosts: PaneHosts = {
      editorHosts: { current: new Map() },
      readerHosts: { current: new Map() },
    };
    const ui = {
      services: { try: () => undefined },
      documentTools: contributions.registry,
      documentToolbarPlacements: placements.registry,
      toolbarComposition: composition.registry,
    } as unknown as InstalledUi;
    const mountedRoot = root;
    if (mountedRoot === null) throw new Error('missing React root');
    const documentById = new Map<string, WorkbenchDocumentView>([
      [documentId, { documentId, kindId, path: 'notes/s', title: 's' }],
    ]);
    const model = toPaneViewModel({
      paneId: 'main',
      paneState: { ...paneState(mode, documentId) },
      focusedPane: 'main',
      mobile: false,
      documentById,
      views: stubViews(),
      drag: null,
      dropTarget: null,
      revision: 0,
      settingsService: null,
      presentation,
    });
    await act(async () => {
      mountedRoot.render(
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
            actions={stubActions()}
            hosts={hosts}
            views={stubViews()}
            tools={tools}
          />
        </WorkspaceContextProvider>,
      );
    });
    return { host, tools, contributions, placements, composition };
  }

  it('places Ink primary tools in the category strip and shelf with stable history and compact zoom', async () => {
    const { host } = await mountPane({
      kindId: 'froglight.ink',
      snapshot: inkSnapshot('ink.tool.froglight.ink.pen'),
    });
    // primaries live in the composition category strip + shelf,
    // not a topbar-center placement.
    const strip = host.querySelector('[data-toolbar="category-strip"]');
    expect(strip).not.toBeNull();
    for (const name of [
      'Pen',
      'Highlighter',
      'Eraser',
      'Selection',
      'Shapes',
      'Insert',
      // direct Text strip button with an empty canvas (creation
      // alias, not the dormant style group).
      'Text',
    ]) {
      expect(strip?.querySelector(`[aria-label="${name}"]`)).not.toBeNull();
    }
    expect(host.querySelector('[data-toolbar="topbar-center"]')).toBeNull();
    // The Pen shelf shows the pen family; Highlighter has its own direct
    // category target and never waits behind the fourth pen slot.
    const shelf = host.querySelector('[data-tool-shelf="surface.write"]');
    expect(shelf).not.toBeNull();
    expect(shelf?.querySelector('[aria-label="Highlighter"]')).toBeNull();
    expect(strip?.querySelector('[aria-label="Highlighter"]')).not.toBeNull();
    expect(strip?.querySelectorAll('[aria-label="Pen"]')).toHaveLength(1);
    // Stable provider-local history at top-left.
    const history = host.querySelector('[data-anchor="float.top-left"]');
    expect(history?.querySelector('[aria-label="Undo"]')).not.toBeNull();
    expect(history?.querySelector('[aria-label="Redo"]')).not.toBeNull();
    // Compact zoom bottom-right: out, reset %, in, fit — no slider/number.
    const zoom = host.querySelector('[data-anchor="float.bottom-right"]');
    expect(zoom?.querySelector('[aria-label="Zoom out"]')).not.toBeNull();
    expect(zoom?.querySelector('[aria-label="Zoom in"]')).not.toBeNull();
    expect(zoom?.querySelector('[aria-label="Fit canvas"]')).not.toBeNull();
    const reset = zoom?.querySelector('[aria-label*="reset to 100%"]');
    expect(reset).not.toBeNull();
    expect(reset?.textContent).toContain('100%');
    expect(zoom?.querySelector('[aria-label="Zoom slider"]')).toBeNull();
    expect(zoom?.querySelector('[aria-label="Zoom"]')).toBeNull();
    // Bounded-canvas settings separate at bottom-left.
    const canvas = host.querySelector('[data-anchor="float.bottom-left"]');
    expect(canvas?.querySelector('[aria-label="Canvas width"]')).not.toBeNull();
    // No persistent visible context labels.
    expect(host.textContent).not.toMatch(/\\bPEN\\b/);
    expect(host.textContent).not.toMatch(/\\bERASER\\b/);
    expect(host.textContent).not.toContain('Notebook Page');
  });

  it('keeps top-center shelf-only without a legacy property island', async () => {
    const { host, tools } = await mountPane({
      kindId: 'froglight.ink',
      snapshot: inkSnapshot('ink.tool.froglight.ink.pen'),
    });
    // the top-center slot holds only the composition shelf. The
    // legacy style-properties island is deleted, so no non-shelf
    // `float.top-center` element stacks beneath it.
    const legacyIsland = () =>
      [...host.querySelectorAll('[data-anchor="float.top-center"]')].find(
        (element) => !element.hasAttribute('data-tool-shelf'),
      ) ?? null;
    const shelf = () => host.querySelector('[data-tool-shelf="surface.write"]');
    expect(shelf()).not.toBeNull();
    expect(legacyIsland()).toBeNull();
    await act(async () => {
      tools.setSnapshot(inkSnapshot('ink.tool.froglight.ink.eraser'));
    });
    // Eraser shelf replaces the Write shelf; still no stacked island.
    expect(
      host.querySelector('[data-tool-shelf="surface.erase"]'),
    ).not.toBeNull();
    expect(legacyIsland()).toBeNull();
    // One top-center element (the shelf), no second full-width toolbar row.
    expect(
      host.querySelectorAll('[data-anchor="float.top-center"]').length,
    ).toBe(1);
    expect(
      host.querySelectorAll('[data-toolbar="topbar-center"]').length,
    ).toBeLessThanOrEqual(1);
    // Legacy style controls stay mounted in the snapshot but unplaced: they
    // never render a duplicate Stroke color / Eraser size alongside the
    // shelf-owned quick properties.
    await act(async () => {
      tools.setSnapshot(inkSnapshot('ink.tool.froglight.ink.text'));
    });
    expect(legacyIsland()).toBeNull();
    await act(async () => {
      tools.setSnapshot(inkSnapshot('ink.tool.froglight.ink.highlighter'));
    });
    expect(legacyIsland()).toBeNull();
    await act(async () => {
      tools.setSnapshot(inkSnapshot('ink.tool.froglight.ink.line'));
    });
    expect(legacyIsland()).toBeNull();
  });

  it('keeps Notebook navigation independent with management + PDF insert shelf-owned', async () => {
    const { host, tools } = await mountPane({
      kindId: 'froglight.notebook',
      snapshot: notebookSnapshot('notebook.tool.froglight.ink.pen'),
    });
    // direct Text strip button with an empty canvas.
    const strip = host.querySelector('[data-toolbar="category-strip"]');
    expect(strip?.querySelector('[aria-label="Text"]')).not.toBeNull();
    const nav = host.querySelector('[data-anchor="float.bottom-left"]');
    expect(nav?.querySelector('[aria-label="Previous page"]')).not.toBeNull();
    expect(nav?.querySelector('[aria-label="Next page"]')).not.toBeNull();
    // Compact current/total without a persistent visible Notebook Page label.
    // the category strip owns primaries, so snapshot context is not
    // rendered as a placement leaf; assert only that no visible label leaks.
    expect(nav?.textContent).toContain('2 / 5');
    expect(host.textContent).not.toContain('Notebook Page');
    // page management is shelf-only — never in the
    // bottom-left island.
    expect(nav?.querySelector('[aria-label="Add page"]')).toBeNull();
    expect(nav?.querySelector('[aria-label="Page paper"]')).toBeNull();
    // PDF insertion lives in the Insert shelf, not in
    // navigation and not as primary creation.: no topbar-center
    // placement remains; composition owns tools.
    expect(host.querySelector('[data-toolbar="topbar-center"]')).toBeNull();
    expect(
      nav?.querySelector('[aria-label="Insert PDF before current page"]'),
    ).toBeNull();
    expect(host.querySelector('[data-category="notebook.pages"]')).toBeNull();
    // browsing Insert shows image + PDF before/after in secondary.
    await act(async () => {
      (
        host.querySelector(
          '[data-toolbar="category-strip"] [data-category="surface.insert"]',
        ) as HTMLButtonElement
      ).click();
    });
    const insertShelf = host.querySelector(
      '[data-tool-shelf="surface.insert"]',
    );
    expect(
      insertShelf?.querySelector('[aria-label="Insert image"]'),
    ).not.toBeNull();
    expect(
      insertShelf?.querySelector(
        '[aria-label="Insert PDF before current page"]',
      ),
    ).not.toBeNull();
    expect(
      insertShelf?.querySelector(
        '[aria-label="Insert PDF after current page"]',
      ),
    ).not.toBeNull();
    // no Text voice in Insert.
    expect(insertShelf?.querySelector('[aria-label="Text"]')).toBeNull();
    // Drawing quick properties live in the composition shelf + popover
    // not a geometric top-center island.
    const legacyIsland = [
      ...host.querySelectorAll('[data-anchor="float.top-center"]'),
    ].find((element) => !element.hasAttribute('data-tool-shelf'));
    expect(legacyIsland).toBeUndefined();
    // Compact stack zoom.
    const zoom = host.querySelector('[data-anchor="float.bottom-right"]');
    expect(zoom?.querySelector('[aria-label*="reset to 100%"]')).not.toBeNull();
    expect(
      zoom?.querySelector('[aria-label="Notebook zoom slider"]'),
    ).toBeNull();
    await act(async () => {
      tools.setSnapshot(notebookSnapshot('notebook.tool.froglight.ink.eraser'));
    });
    // Navigation survives drawing-context changes.
    expect(
      host
        .querySelector('[data-anchor="float.bottom-left"]')
        ?.querySelector('[aria-label="Previous page"]'),
    ).not.toBeNull();
  });

  it('exposes Whiteboard creation without page controls and one connector', async () => {
    const { host } = await mountPane({
      kindId: 'froglight.whiteboard',
      snapshot: whiteboardSnapshot('whiteboard.tool.pen'),
    });
    // creation vocabulary lives in the category strip + shelf.
    const strip = host.querySelector('[data-toolbar="category-strip"]');
    for (const name of [
      'Pen',
      'Highlighter',
      'Eraser',
      'Selection',
      'Shapes',
      'Insert',
      // direct Text strip button with an empty canvas.
      'Text',
    ]) {
      expect(strip?.querySelector(`[aria-label="${name}"]`)).not.toBeNull();
    }
    const shelf = host.querySelector('[data-tool-shelf="surface.write"]');
    expect(shelf?.querySelector('[aria-label="Pen"]')).not.toBeNull();
    // No duplicate Arrow button for the same line tool: exactly one
    // connector-named control across strip + shelf.
    expect(host.querySelector('[aria-label="Arrow"]')).toBeNull();
    // No page navigation or page-size controls.
    expect(host.querySelector('[aria-label="Previous page"]')).toBeNull();
    expect(host.querySelector('[aria-label="Page width"]')).toBeNull();
    expect(host.querySelector('[aria-label="Canvas width"]')).toBeNull();
    const zoom = host.querySelector('[data-anchor="float.bottom-right"]');
    expect(zoom?.querySelector('[aria-label="Fit board"]')).not.toBeNull();
    expect(zoom?.querySelector('[aria-label="Zoom slider"]')).toBeNull();
  });

  it('routes Surface toolbar activation through the provider command seam', async () => {
    const { host, tools } = await mountPane({
      kindId: 'froglight.ink',
      snapshot: inkSnapshot('ink.tool.froglight.ink.pen'),
    });
    await act(async () => {
      (
        host.querySelector(
          '[data-anchor="float.bottom-right"] [aria-label="Zoom in"]',
        ) as HTMLButtonElement
      ).click();
      await Promise.resolve();
    });
    expect(tools.calls.execute).toContainEqual(['ink.zoom-in']);
    await act(async () => {
      (
        host.querySelector(
          '[data-anchor="float.bottom-right"] [aria-label*="reset to 100%"]',
        ) as HTMLButtonElement
      ).click();
      await Promise.resolve();
    });
    expect(tools.calls.execute).toContainEqual(['ink.zoom-reset']);
  });

  it('exposes selected tool state and disabled image insertion accessibly', async () => {
    const snapshot: DocumentToolSnapshot = {
      context: 'Ink canvas',
      controls: [
        button('ink.tool.froglight.ink.pen', 'Pen', {
          group: 'draw',
          active: true,
          semanticRole: 'surface.pen.ball',
        } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
        button('ink.tool.froglight.ink.eraser', 'Eraser', {
          group: 'draw',
          active: false,
          semanticRole: 'surface.erase',
        } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
        button('ink.image', 'Insert image', {
          group: 'insert',
          disabled: true,
          semanticRole: 'surface.insert.image',
        } as Partial<Extract<DocumentToolControl, { kind: 'button' }>>),
      ],
    };
    const { host } = await mountPane({
      kindId: 'froglight.ink',
      snapshot,
    });
    // selected/disabled tool state lives in the composition shelf.
    const pen = host.querySelector(
      '[data-tool-shelf="surface.write"] [aria-label="Pen"]',
    );
    expect(pen?.getAttribute('aria-pressed')).toBe('true');
    // Insert image lives in the Insert category; browse there to assert
    // disabled state accessibly.
    await act(async () => {
      (
        host.querySelector(
          '[data-toolbar="category-strip"] [data-category="surface.insert"]',
        ) as HTMLButtonElement
      ).click();
    });
    const image = host.querySelector(
      '[data-tool-shelf="surface.insert"] [aria-label="Insert image"]',
    ) as HTMLButtonElement;
    expect(image?.disabled).toBe(true);
  });

  describe('Text creation click-through from the single Text presenter', () => {
    it('keeps Text creation direct while formatting moves into settings', async () => {
      const snapshot = inkSnapshot('ink.tool.froglight.ink.text');
      const { host } = await mountPane({
        kindId: 'froglight.ink',
        snapshot: {
          ...snapshot,
          controls: [
            ...snapshot.controls,
            {
              kind: 'choice',
              id: 'ink.text.style',
              group: 'text',
              label: 'Text style',
              value: 'body',
              options: [
                { value: 'body', label: 'Body' },
                { value: 'h1', label: 'Heading 1' },
              ],
              semanticRole: 'surface.text.style',
            },
            {
              kind: 'number',
              id: 'ink.text.size',
              group: 'text',
              label: 'Font size',
              value: 16,
              min: 8,
              max: 96,
              step: 1,
              semanticRole: 'surface.text.size',
            },
            button('ink.text.bold', 'Bold', {
              group: 'text',
              semanticRole: 'surface.text.bold',
              activationRole: 'toggle',
            }),
            button('ink.text.italic', 'Italic', {
              group: 'text',
              semanticRole: 'surface.text.italic',
              activationRole: 'toggle',
            }),
            {
              kind: 'choice',
              id: 'ink.text.align',
              group: 'text',
              label: 'Text alignment',
              value: 'start',
              options: [{ value: 'start', label: 'Align start' }],
              semanticRole: 'surface.text.align',
            },
            {
              kind: 'color',
              id: 'ink.text.color',
              group: 'text',
              label: 'Text color',
              value: '#37352f',
              options: ['#37352f'],
              semanticRole: 'surface.text.color',
            },
            button('ink.text.wrap', 'Wrap text', {
              group: 'text',
              semanticRole: 'surface.text.wrap',
              activationRole: 'toggle',
            }),
          ],
        },
      });

      await act(async () => {
        (
          host.querySelector(
            '[data-toolbar="category-strip"] [data-category="surface.text"]',
          ) as HTMLButtonElement
        ).click();
      });

      const shelf = host.querySelector('[data-tool-shelf="surface.text"]');
      expect(shelf).not.toBeNull();
      expect(shelf?.querySelector('[aria-label="Text"]')).toBeNull();
      expect(shelf?.querySelector('[aria-label="Bold"]')).not.toBeNull();
    });

    async function clickShelfText(input: {
      readonly kindId: string;
      readonly snapshot: DocumentToolSnapshot;
      readonly providerTextId: string;
    }): Promise<void> {
      const { host, tools } = await mountPane({
        kindId: input.kindId,
        snapshot: input.snapshot,
      });
      // Direct Text strip button with an empty canvas.
      expect(
        host.querySelector(
          '[data-toolbar="category-strip"] [aria-label="Text"]',
        ),
      ).not.toBeNull();
      const browse = async (category: string): Promise<void> => {
        await act(async () => {
          (
            host.querySelector(
              `[data-toolbar="category-strip"] [data-category="${category}"]`,
            ) as HTMLButtonElement
          ).click();
        });
      };
      // Insert carries no Text voice — the shelf shows image (and
      // family extras), never Text.
      await browse('surface.insert');
      expect(
        host.querySelector(
          '[data-tool-shelf="surface.insert"] [aria-label="Text"]',
        ),
      ).toBeNull();
      const before = tools.calls.execute.length;
      // The primary Text button activates the tool; the secondary has only
      // formatting controls and never repeats Text.
      await browse('surface.text');
      expect(
        host.querySelector(
          '[data-tool-shelf="surface.text"] [aria-label="Text"]',
        ),
      ).toBeNull();
      // Single execution through the provider channel with the
      // family-dialect Text control id — never a duplicate, never a
      // no-op, never the wrong owner.
      expect(tools.calls.execute.length).toBe(before + 1);
      expect(tools.calls.execute[before]).toEqual([input.providerTextId]);
    }

    it('routes Ink Text from the primary button to ink.tool.froglight.ink.text', async () => {
      await clickShelfText({
        kindId: 'froglight.ink',
        snapshot: inkSnapshot('ink.tool.froglight.ink.pen'),
        providerTextId: 'ink.tool.froglight.ink.text',
      });
    });

    it('routes Notebook Text from the primary button to notebook.tool.froglight.notebook.text', async () => {
      await clickShelfText({
        kindId: 'froglight.notebook',
        snapshot: notebookSnapshot('notebook.tool.froglight.ink.pen'),
        providerTextId: 'notebook.tool.froglight.notebook.text',
      });
    });

    it('routes Whiteboard Text from the primary button to whiteboard.tool.text', async () => {
      await clickShelfText({
        kindId: 'froglight.whiteboard',
        snapshot: whiteboardSnapshot('whiteboard.tool.pen'),
        providerTextId: 'whiteboard.tool.text',
      });
    });
  });
});
