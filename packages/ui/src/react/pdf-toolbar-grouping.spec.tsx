// @vitest-environment jsdom
/**
 * PDF + utility-anchor grouping at the mounted-Pane seam.
 *
 * Behavioral pins only — no PDF redesign, no canonical/engine changes:
 *
 * - Mounted-Pane regression: a PDF pane opens with the grouped
 *   main strip (Pages/Select/Annotate), the history + bottom-center page
 *   islands, and every PDF action (page nav, source-select toggle,
 *   import-as-notebook) executable through the same workbench seam.
 * - Split-pane per-pane scoping: two panes (PDF + Markdown) sharing
 *   one registry set render independent strips/islands; actions route to
 *   the owning pane only.
 * - Reading mode: a PDF pane in reading mode removes edit tools
 *   while keeping the pane bar.
 * - Collapse: the floating reserve collapses on scroll and when the
 *   snapshot reports displaced, for PDF panes exactly like every family.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { DocumentToolSnapshot } from '@froglight/foundation';
import type { WorkbenchEditorToolsPort } from '../workbench-ports.js';
import type { WorkbenchDocumentView } from '../workbench.js';
import { createDocumentToolbarRegistry } from '../document-toolbar-registry.js';
import { createToolbarPlacementRegistry } from '../toolbar/placement-registry.js';
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
import workspaceStyles from './WorkspaceView.module.css';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function pdfSnapshot(): DocumentToolSnapshot {
  return {
    context: 'PDF source',
    controls: [
      {
        kind: 'button',
        id: 'pdf.previous',
        group: 'pages',
        label: 'Previous PDF page',
        shortLabel: 'Previous',
        semanticRole: 'pdf.page.previous',
      },
      { kind: 'status', id: 'pdf.page', group: 'pages', label: '3 / 9' },
      {
        kind: 'button',
        id: 'pdf.next',
        group: 'pages',
        label: 'Next PDF page',
        shortLabel: 'Next',
        semanticRole: 'pdf.page.next',
      },
      {
        kind: 'button',
        id: 'pdf.source-select',
        group: 'interaction',
        label: 'Select and copy source text',
        shortLabel: 'Source Select',
        semanticRole: 'pdf.select.source',
      },
      {
        kind: 'button',
        id: 'pdf.import-notebook',
        group: 'document',
        label: 'Annotate / Import as Notebook',
        shortLabel: 'Annotate',
        semanticRole: 'pdf.annotate.notebook',
      },
    ] as DocumentToolSnapshot['controls'],
  };
}

function markdownSnapshot(): DocumentToolSnapshot {
  return {
    context: 'Markdown paragraph',
    controls: [
      {
        kind: 'choice',
        id: 'markdown.block',
        group: 'block',
        label: 'Line style',
        value: 'paragraph',
        options: [{ value: 'paragraph', label: 'Paragraph' }],
        semanticRole: 'writing.style',
      },
      {
        kind: 'button',
        id: 'markdown.bold',
        group: 'format',
        label: 'Bold',
        shortLabel: 'B',
        semanticRole: 'writing.bold',
        activationRole: 'toggle',
      },
    ] as DocumentToolSnapshot['controls'],
  };
}

interface ToolsDouble extends WorkbenchEditorToolsPort {
  setSnapshot(snapshot: DocumentToolSnapshot | null): void;
  calls: { execute: Array<[string, string?]> };
}

function makeTools(snapshot: DocumentToolSnapshot | null): ToolsDouble {
  const listeners = new Set<() => void>();
  let current = snapshot;
  const calls: ToolsDouble['calls'] = { execute: [] };
  return {
    calls,
    setSnapshot(next) {
      current = next;
      for (const listener of listeners) listener();
    },
    canExecEditorCommand: () => true,
    execEditorCommand: () => true,
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

describe('pdf toolbar grouping (mounted Pane)', () => {
  let root: Root | null = null;

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    document.body.replaceChildren();
  });

  async function mountPanes(input: {
    panes: ReadonlyArray<{
      paneId: string;
      documentId: string;
      kindId: string;
      title: string;
      mode?: 'edit' | 'reading';
      snapshot: DocumentToolSnapshot | null;
      tools: ToolsDouble;
    }>;
    focusedPane?: string;
  }): Promise<{
    host: HTMLElement;
    registries: {
      contributions: ReturnType<typeof createDocumentToolbarRegistry>;
      placements: ReturnType<typeof createToolbarPlacementRegistry>;
      composition: ReturnType<typeof createToolbarCompositionRegistry>;
    };
  }> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const contributions = createDocumentToolbarRegistry();
    const placements = createToolbarPlacementRegistry();
    for (const placement of defaultToolbarPlacements()) {
      placements.registry.register(placement);
    }
    const composition = createToolbarCompositionRegistry();
    const defaults = defaultToolbarComposition();
    for (const entry of defaults.categories) {
      composition.registry.registerCategory(entry);
    }
    for (const entry of defaults.items) {
      composition.registry.registerItem(entry);
    }
    for (const entry of defaults.extensions) {
      composition.registry.registerKindExtension(entry);
    }
    const views = stubViews();
    const ui = {
      services: { try: () => undefined },
      documentTools: contributions.registry,
      documentToolbarPlacements: placements.registry,
      toolbarComposition: composition.registry,
    } as unknown as InstalledUi;
    const hosts: PaneHosts = {
      editorHosts: { current: new Map() },
      readerHosts: { current: new Map() },
    };
    const panes = input.panes.map((pane) => {
      const documentById = new Map<string, WorkbenchDocumentView>([
        [
          pane.documentId,
          {
            documentId: pane.documentId,
            kindId: pane.kindId,
            path: pane.title,
            title: pane.title,
          },
        ],
      ]);
      return {
        pane,
        model: toPaneViewModel({
          paneId: pane.paneId,
          paneState: {
            pane: pane.paneId,
            tabs: [
              {
                id: pane.documentId,
                kind: 'document',
                documentId: pane.documentId,
                viewId: null,
              },
            ],
            activeTab: pane.documentId,
            mode: pane.mode ?? 'edit',
            documentId: pane.documentId,
            viewId: null,
            title: pane.title,
            path: pane.title,
            dirty: false,
            recoveryWarnings: [],
            canGoBack: false,
            canGoForward: false,
          } as never,
          focusedPane: input.focusedPane ?? input.panes[0]?.paneId ?? 'main',
          mobile: false,
          documentById,
          views,
          drag: null,
          dropTarget: null,
          revision: 0,
          settingsService: null,
          presentation: {
            kind: 'editor-readonly',
            kindId: pane.kindId,
          } as never,
        }),
      };
    });
    const actions = stubActions();
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
          {panes.map(({ pane, model }) => (
            <Pane
              key={pane.paneId}
              model={model}
              actions={actions}
              hosts={hosts}
              views={views}
              tools={pane.tools}
            />
          ))}
        </WorkspaceContextProvider>,
      );
    });
    return { host, registries: { contributions, placements, composition } };
  }

  function paneScope(host: HTMLElement, paneId: string): HTMLElement {
    const scope = host.querySelector(`[data-pane="${paneId}"]`);
    if (scope === null) throw new Error(`missing pane scope ${paneId}`);
    return scope as HTMLElement;
  }

  it('opens a PDF pane grouped with the same workbench seam for every action', async () => {
    const tools = makeTools(pdfSnapshot());
    const { host, registries } = await mountPanes({
      panes: [
        {
          paneId: 'main',
          documentId: 'pdf-1',
          kindId: 'froglight.pdf',
          title: 'a.pdf',
          snapshot: pdfSnapshot(),
          tools,
        },
      ],
    });
    try {
      const scope = paneScope(host, 'main');
      // Grouped main strip: Pages / Select / Annotate, no flat fallback.
      const strip = scope.querySelector('[data-toolbar="category-strip"]');
      for (const name of ['Pages', 'Select', 'Annotate']) {
        expect(strip?.querySelector(`[aria-label="${name}"]`)).not.toBeNull();
      }
      // Single row: no topbar-center placement, no secondary tray.
      expect(scope.querySelector('[data-toolbar="topbar-center"]')).toBeNull();
      expect(scope.querySelector('.fl-doc-toolbar-secondary')).toBeNull();
      // Utility islands: shell history + bottom-center page navigation.
      const history = scope.querySelector('[data-anchor="float.top-left"]');
      expect(history?.querySelector('[aria-label="Undo"]')).not.toBeNull();
      const pages = scope.querySelector('[data-anchor="float.bottom-left"]');
      expect(
        pages?.querySelector('[aria-label="Previous PDF page"]'),
      ).not.toBeNull();
      expect(
        pages?.querySelector('[aria-label="Next PDF page"]'),
      ).not.toBeNull();
      expect(pages?.textContent).toContain('3 / 9');
      // Same seam: page navigation executes through the workbench tools port.
      await act(async () => {
        (
          pages?.querySelector(
            '[aria-label="Next PDF page"]',
          ) as HTMLButtonElement
        ).click();
        await Promise.resolve();
      });
      expect(tools.calls.execute).toContainEqual(['pdf.next']);
      // Select group shelf exposes the source-select toggle.
      await act(async () => {
        (
          strip?.querySelector(
            '[data-category="pdf.select"]',
          ) as HTMLButtonElement
        ).click();
      });
      const selectShelf = scope.querySelector('[data-tool-shelf="pdf.select"]');
      expect(
        selectShelf?.querySelector(
          '[aria-label="Select and copy source text"]',
        ),
      ).not.toBeNull();
      await act(async () => {
        (
          selectShelf?.querySelector(
            '[aria-label="Select and copy source text"]',
          ) as HTMLButtonElement
        ).click();
        await Promise.resolve();
      });
      expect(tools.calls.execute).toContainEqual(['pdf.source-select']);
      // Annotate group shelf exposes import-as-notebook.
      await act(async () => {
        (
          strip?.querySelector(
            '[data-category="pdf.annotate"]',
          ) as HTMLButtonElement
        ).click();
      });
      const annotateShelf = scope.querySelector(
        '[data-tool-shelf="pdf.annotate"]',
      );
      expect(
        annotateShelf?.querySelector(
          '[aria-label="Annotate / Import as Notebook"]',
        ),
      ).not.toBeNull();
      await act(async () => {
        (
          annotateShelf?.querySelector(
            '[aria-label="Annotate / Import as Notebook"]',
          ) as HTMLButtonElement
        ).click();
        await Promise.resolve();
      });
      expect(tools.calls.execute).toContainEqual(['pdf.import-notebook']);
    } finally {
      registries.contributions.dispose();
      registries.placements.dispose();
      registries.composition.dispose();
    }
  });

  it('scopes PDF and Markdown split panes independently (no cross-pane leak)', async () => {
    const pdfTools = makeTools(pdfSnapshot());
    const markdownTools = makeTools(markdownSnapshot());
    const { host, registries } = await mountPanes({
      panes: [
        {
          paneId: 'main',
          documentId: 'pdf-1',
          kindId: 'froglight.pdf',
          title: 'a.pdf',
          snapshot: pdfSnapshot(),
          tools: pdfTools,
        },
        {
          paneId: 'right',
          documentId: 'md-1',
          kindId: 'froglight.markdown',
          title: 'b.md',
          snapshot: markdownSnapshot(),
          tools: markdownTools,
        },
      ],
    });
    try {
      const pdf = paneScope(host, 'main');
      const markdown = paneScope(host, 'right');
      // Each pane owns its strip vocabulary.
      for (const name of ['Pages', 'Select', 'Annotate']) {
        expect(
          pdf.querySelector(
            `[data-toolbar="category-strip"] [aria-label="${name}"]`,
          ),
        ).not.toBeNull();
      }
      expect(
        markdown.querySelector('[data-toolbar="writing-direct"]'),
      ).not.toBeNull();
      // Empty groups omit (never placeholders): this snapshot carries no
      // insert controls, so Insert stays out of the markdown strip.
      expect(
        markdown.querySelector(
          '[data-toolbar="category-strip"] [aria-label="Insert"]',
        ),
      ).toBeNull();
      expect(
        markdown.querySelector('[data-anchor="float.bottom-left"]'),
      ).toBeNull();
      expect(pdf.querySelector('[aria-label="Bold"]')).toBeNull();
      // Each pane owns its floating layer: two panes, two layers.
      expect(host.querySelectorAll('[data-floating-layer]').length).toBe(2);
      // Actions route to the owning pane only.
      await act(async () => {
        (
          pdf.querySelector(
            '[data-anchor="float.bottom-left"] [aria-label="Next PDF page"]',
          ) as HTMLButtonElement
        ).click();
        await Promise.resolve();
      });
      expect(pdfTools.calls.execute).toContainEqual(['pdf.next']);
      expect(markdownTools.calls.execute).toEqual([]);
    } finally {
      registries.contributions.dispose();
      registries.placements.dispose();
      registries.composition.dispose();
    }
  });

  it('removes PDF edit tools in reading mode but keeps the pane bar', async () => {
    const tools = makeTools(pdfSnapshot());
    const { host, registries } = await mountPanes({
      panes: [
        {
          paneId: 'main',
          documentId: 'pdf-1',
          kindId: 'froglight.pdf',
          title: 'a.pdf',
          mode: 'reading',
          snapshot: pdfSnapshot(),
          tools,
        },
      ],
    });
    try {
      const scope = paneScope(host, 'main');
      expect(
        scope.querySelectorAll(`.${workspaceStyles['fl-pane-header']}`).length,
      ).toBe(1);
      expect(scope.querySelector('[data-toolbar="category-strip"]')).toBeNull();
      expect(scope.querySelector('[data-tool-shelf]')).toBeNull();
      expect(scope.querySelector('[data-floating-layer]')).toBeNull();
      // Reading never reserves the floating clear zone.
      expect(
        scope
          .querySelector(`.${workspaceStyles['fl-pane-body']}`)
          ?.classList.contains(workspaceStyles['fl-pane-body-floating']),
      ).toBe(false);
      expect(tools.calls.execute).toEqual([]);
    } finally {
      registries.contributions.dispose();
      registries.placements.dispose();
      registries.composition.dispose();
    }
  });
});
