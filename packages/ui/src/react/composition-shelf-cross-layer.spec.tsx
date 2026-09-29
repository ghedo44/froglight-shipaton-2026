// @vitest-environment jsdom
/**
 *  cross-layer shelf/island dedupe.
 *
 * Generic, kind-blind, all families (NOT PDF-special-cased): the
 * composition shelf skips controls already claimed geometrically
 * (`control.id` only, sole Text-alias exemption), the geometric island
 * keeps them, and a combined cross-layer diagnostic reports each skip in
 * the single pane computation (never silent, never per-surface render).
 *
 * - PDF Previous/Next render exactly once (shelf XOR island; island keeps
 *   nav since bottom-center is the primary nav surface; Pages strip group
 *   stays intact via the untouched normal projection; Select/Annotate
 *   shelves stay reachable).
 * - Notebook management (add/duplicate/delete/template/overview) renders
 *  exactly once in the `notebook.pages` shelf: shelf-only,
 *   no bottom-center management island, hence no cross-layer skip).
 * - Combined duplicate diagnostic present for the remaining geometric
 *   overlap (PDF nav); single-computation pin holds.
 * - Text creation role never hides and never reports (no regression).
 * - Verbatim order, browsed/active gate, owner `control.id` vs scope
 *   `slotKey`, portaled More, estimator budgets, and kind-blind shell are
 *   preserved (neighbors pin the rest; this spec pins the cross-layer
 *   seam only).
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocumentToolSnapshot } from '@froglight/foundation';
import type { WorkbenchEditorToolsPort } from '../workbench-ports.js';
import { createDocumentToolbarRegistry } from '../document-toolbar-registry.js';
import { createToolbarPlacementRegistry } from '../toolbar/placement-registry.js';
import { defaultToolbarPlacements } from '../toolbar/default-placements.js';
import { createToolbarCompositionRegistry } from '../toolbar/composition-registry.js';
import { defaultToolbarComposition } from '../toolbar/default-composition.js';
import {
  computeUnifiedToolbarModel,
  FloatingToolbarLayer,
  TOOLBAR_COMPACT_QUERY,
  TopbarCenterTools,
  UnifiedToolbarProvider,
} from './UnifiedToolbar.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function stubMedia(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  void TOOLBAR_COMPACT_QUERY;
}

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
        activationRole: 'toggle',
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

function notebookPagesSnapshot(): DocumentToolSnapshot {
  return {
    context: 'Notebook',
    controls: [
      {
        kind: 'button',
        id: 'notebook.previous',
        group: 'pages',
        label: 'Previous page',
        shortLabel: 'Previous',
      },
      { kind: 'status', id: 'notebook.page', group: 'pages', label: '2 / 5' },
      {
        kind: 'button',
        id: 'notebook.next',
        group: 'pages',
        label: 'Next page',
        shortLabel: 'Next',
      },
      {
        kind: 'choice',
        id: 'notebook.template',
        semanticRole: 'notebook.page.template',
        group: 'pages',
        label: 'Page paper',
        value: 'ruled',
        options: [{ value: 'ruled', label: 'Ruled' }],
      },
      {
        kind: 'button',
        id: 'notebook.add',
        semanticRole: 'notebook.page.add',
        group: 'pages',
        label: 'Add page',
        shortLabel: 'Add page',
      },
      {
        kind: 'button',
        id: 'notebook.duplicate',
        semanticRole: 'notebook.page.duplicate',
        group: 'pages',
        label: 'Duplicate page',
        shortLabel: 'Duplicate',
      },
      {
        kind: 'button',
        id: 'notebook.delete',
        semanticRole: 'notebook.page.delete',
        group: 'pages',
        label: 'Delete page',
        shortLabel: 'Delete',
      },
      {
        kind: 'button',
        id: 'notebook.overview',
        semanticRole: 'notebook.page.overview',
        group: 'view',
        label: 'Page overview',
        shortLabel: 'Pages',
      },
    ] as DocumentToolSnapshot['controls'],
  };
}

function textSnapshot(): DocumentToolSnapshot {
  return {
    context: 'Surface',
    controls: [
      {
        kind: 'button',
        id: 'ink.tool.text',
        group: 'draw',
        label: 'Text',
        shortLabel: 'Text',
        semanticRole: 'surface.insert.text',
        active: true,
        activationRole: 'tool',
      },
    ] as unknown as DocumentToolSnapshot['controls'],
  };
}

interface Harness {
  host: HTMLElement;
  dispose: () => void;
  strip: () => HTMLElement;
}

describe('cross-layer shelf/island dedupe', () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  function mount(input: {
    snapshot: DocumentToolSnapshot;
    kindId: string;
    onSnapshot?: (calls: { count: number }) => void;
  }): Harness {
    stubMedia();
    host?.remove();
    if (root !== null) {
      act(() => root!.unmount());
      root = null;
    }
    const counter = { count: 0 };
    const listeners = new Set<() => void>();
    const current: DocumentToolSnapshot | null = input.snapshot;
    const port = {
      onDidChange: (listener: () => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      execEditorCommand: () => false,
      canExecEditorCommand: () => true,
      editorToolSnapshot: () => {
        counter.count += 1;
        input.onSnapshot?.(counter);
        return current;
      },
      executeEditorTool: () => true,
    } as unknown as WorkbenchEditorToolsPort;
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
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const toolbarProps = {
      tools: port,
      contributions: contributions.registry,
      placements: placements.registry,
      composition: composition.registry,
      pane: 'pane-1',
      documentId: 'doc-1',
      kindId: input.kindId,
    };
    act(() => {
      root!.render(
        <UnifiedToolbarProvider {...toolbarProps}>
          <TopbarCenterTools {...toolbarProps} />
          <FloatingToolbarLayer {...toolbarProps} />
        </UnifiedToolbarProvider>,
      );
    });
    const element = host;
    return {
      host: element,
      dispose: () => {
        contributions.dispose();
        placements.dispose();
        composition.dispose();
      },
      strip: () => {
        const found = element.querySelector('[data-toolbar="category-strip"]');
        if (!(found instanceof HTMLElement)) throw new Error('missing strip');
        return found;
      },
    };
  }

  it('PDF Previous/Next render exactly once (island keeps nav; Pages strip intact)', () => {
    const harness = mount({ snapshot: pdfSnapshot(), kindId: 'froglight.pdf' });
    try {
      // Pages strip group intact — normal projection untouched (no
      // item drop). Select/Annotate stay reachable.
      for (const name of ['Pages', 'Select', 'Annotate']) {
        expect(
          harness.strip().querySelector(`[aria-label="${name}"]`),
        ).not.toBeNull();
      }
      // single visible owner: exactly one rendered control per id.
      expect(
        harness.host.querySelectorAll('[aria-label="Previous PDF page"]')
          .length,
      ).toBe(1);
      expect(
        harness.host.querySelectorAll('[aria-label="Next PDF page"]').length,
      ).toBe(1);
      // Island keeps nav at the bottom-left.
      const island = harness.host.querySelector(
        '[data-anchor="float.bottom-left"]',
      );
      expect(
        island?.querySelector('[aria-label="Previous PDF page"]'),
      ).not.toBeNull();
      expect(
        island?.querySelector('[aria-label="Next PDF page"]'),
      ).not.toBeNull();
      // Shelf skips geometrically claimed nav: no Pages-shelf duplicate.
      // A fully skipped Pages shelf hides (no empty island); either way no
      // second Previous/Next exists (pinned by the counts above).
      const pagesShelf = harness.host.querySelector(
        '[data-tool-shelf="pdf.pages"]',
      );
      if (pagesShelf !== null) {
        expect(
          pagesShelf.querySelector('[aria-label="Previous PDF page"]'),
        ).toBeNull();
        expect(
          pagesShelf.querySelector('[aria-label="Next PDF page"]'),
        ).toBeNull();
      }
      // Select/Annotate shelves stay reachable via the strip.
      act(() => {
        (
          harness
            .strip()
            .querySelector('[data-category="pdf.select"]') as HTMLButtonElement
        ).click();
      });
      expect(
        harness.host.querySelector(
          '[data-tool-shelf="pdf.select"] [aria-label="Select and copy source text"]',
        ),
      ).not.toBeNull();
      act(() => {
        (
          harness
            .strip()
            .querySelector(
              '[data-category="pdf.annotate"]',
            ) as HTMLButtonElement
        ).click();
      });
      expect(
        harness.host.querySelector(
          '[data-tool-shelf="pdf.annotate"] [aria-label="Annotate / Import as Notebook"]',
        ),
      ).not.toBeNull();
    } finally {
      harness.dispose();
    }
  });

  it('Notebook management stays out of toolbar while navigation floats', () => {
    const harness = mount({
      snapshot: notebookPagesSnapshot(),
      kindId: 'froglight.notebook',
    });
    try {
      expect(
        harness.host.querySelector('[data-category="notebook.pages"]'),
      ).toBeNull();
      for (const label of [
        'Add page',
        'Duplicate page',
        'Delete page',
        'Page paper',
        'Page overview',
      ]) {
        expect(
          harness.host.querySelectorAll(`[aria-label="${label}"]`).length,
        ).toBe(0);
      }
      // No bottom-left management island: the nav island keeps only
      // navigation (+ outline), never management.
      const island = harness.host.querySelector(
        '[data-anchor="float.bottom-left"]',
      );
      for (const label of [
        'Add page',
        'Duplicate page',
        'Delete page',
        'Page paper',
        'Page overview',
      ]) {
        expect(island?.querySelector(`[aria-label="${label}"]`)).toBeNull();
      }
      expect(
        island?.querySelector('[aria-label="Previous page"]'),
      ).not.toBeNull();
      expect(island?.querySelector('[aria-label="Next page"]')).not.toBeNull();
    } finally {
      harness.dispose();
    }
  });

  it('reports a combined cross-layer duplicate diagnostic (never silent)', () => {
    stubMedia();
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
    try {
      const listeners = new Set<() => void>();
      const port = {
        onDidChange: (listener: () => void) => {
          listeners.add(listener);
          return { dispose: () => listeners.delete(listener) };
        },
        execEditorCommand: () => false,
        canExecEditorCommand: () => true,
        editorToolSnapshot: () => pdfSnapshot(),
        executeEditorTool: () => true,
      } as unknown as WorkbenchEditorToolsPort;
      const computed = computeUnifiedToolbarModel({
        tools: port,
        contributions: contributions.registry,
        placements: placements.registry,
        composition: composition.registry,
        pane: 'pane-1',
        documentId: 'doc-1',
        kindId: 'froglight.pdf',
      });
      const crossLayer = computed.layout.diagnostics.filter((entry) =>
        entry.includes('in composition shelf'),
      );
      // PDF Previous + Next each report once (generic `control.id` keys).
      expect(
        crossLayer.filter((entry) => entry.includes("'pdf.previous'")).length,
      ).toBe(1);
      expect(
        crossLayer.filter((entry) => entry.includes("'pdf.next'")).length,
      ).toBe(1);
      // Notebook management is shelf-only: no geometric
      // claim, hence no cross-layer diagnostic for management controls.
      const notebookPort = {
        ...port,
        editorToolSnapshot: () => notebookPagesSnapshot(),
      } as unknown as WorkbenchEditorToolsPort;
      const notebookComputed = computeUnifiedToolbarModel({
        tools: notebookPort,
        contributions: contributions.registry,
        placements: placements.registry,
        composition: composition.registry,
        pane: 'pane-1',
        documentId: 'doc-1',
        kindId: 'froglight.notebook',
      });
      const notebookCross = notebookComputed.layout.diagnostics.filter(
        (entry) => entry.includes('in composition shelf'),
      );
      expect(
        notebookCross.some((entry) => entry.includes("'notebook.add'")),
      ).toBe(false);
      expect(
        notebookCross.some((entry) => entry.includes("'notebook.overview'")),
      ).toBe(false);
      // Page management no longer participates in the toolbar graph.
      expect(
        notebookComputed.compositionGraph?.categories
          .find((category) => category.id === 'notebook.pages')
          ?.items.map((item) => item.control.id)
          .sort(),
      ).toBeUndefined();
    } finally {
      contributions.dispose();
      placements.dispose();
      composition.dispose();
    }
  });

  it('pins single computation with the duplicate present', () => {
    let snapshotCalls = 0;
    const listeners = new Set<() => void>();
    const tools = {
      editorToolSnapshot: () => {
        snapshotCalls += 1;
        return pdfSnapshot();
      },
      executeEditorTool: () => true,
      canExecEditorCommand: () => true,
      execEditorCommand: () => true,
      onDidChange: (listener: () => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    } as unknown as WorkbenchEditorToolsPort;
    stubMedia();
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
    const element = document.createElement('div');
    document.body.appendChild(element);
    const localRoot = createRoot(element);
    const props = {
      tools,
      contributions: contributions.registry,
      placements: placements.registry,
      composition: composition.registry,
      pane: 'main',
      documentId: 'doc-1',
      kindId: 'froglight.pdf',
    };
    try {
      act(() => {
        localRoot.render(
          <UnifiedToolbarProvider {...props}>
            <TopbarCenterTools {...props} />
            <FloatingToolbarLayer {...props} />
          </UnifiedToolbarProvider>,
        );
      });
      // One pane-level computation shared by both surfaces via context.
      expect(snapshotCalls).toBe(1);
      // The duplicate still renders exactly once (counts prove the skip ran
      // inside that single computation + render, not a second pass).
      expect(
        element.querySelectorAll('[aria-label="Next PDF page"]').length,
      ).toBe(1);
    } finally {
      act(() => localRoot.unmount());
      element.remove();
      contributions.dispose();
      placements.dispose();
      composition.dispose();
    }
  });

  it('Text creation alias never hides and never reports (no regression)', () => {
    stubMedia();
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
    try {
      const port = {
        onDidChange: () => ({ dispose: () => undefined }),
        execEditorCommand: () => false,
        canExecEditorCommand: () => true,
        editorToolSnapshot: () => textSnapshot(),
        executeEditorTool: () => true,
      } as unknown as WorkbenchEditorToolsPort;
      const computed = computeUnifiedToolbarModel({
        tools: port,
        contributions: contributions.registry,
        placements: placements.registry,
        composition: composition.registry,
        pane: 'pane-1',
        documentId: 'doc-1',
        kindId: 'froglight.ink',
      });
      // No cross-layer diagnostic names the Text control.
      expect(
        computed.layout.diagnostics.filter((entry) =>
          entry.includes('ink.tool.text'),
        ),
      ).toEqual([]);
      // Canonical Text home still resolves (Insert-first never steals Text).
      expect(
        computed.compositionGraph?.categories.some(
          (category) => category.id === 'surface.text',
        ),
      ).toBe(true);
    } finally {
      contributions.dispose();
      placements.dispose();
      composition.dispose();
    }
  });
});
