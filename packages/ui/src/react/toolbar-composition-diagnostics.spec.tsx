// @vitest-environment jsdom
/**
 *  surface composition diagnostics instead of silent drops.
 *
 * `computeUnifiedToolbarModel` merges `compositionGraph.diagnostics` +
 * `unresolved` into the reported `layout.diagnostics` channel (duplicate
 * semantic roles, ordering cycles, dormant cross-plugin items). The squeeze
 * palette routes the same assembled/composition diagnostics to
 * `deps.diagnostics`.
 *
 * Seams: `computeUnifiedToolbarModel.layout.diagnostics`,
 * `StylusAccessoryBinder` squeeze `deps.diagnostics`, `reportDiagnostics`.
 *
 * the transitional floating duplicate guard is removed. Default
 * placements and the default composition are disjoint by construction (see
 * the disjointness pin in `default-placements.spec.ts`), so no suppression
 * diagnostic exists anymore; custom hosts must not register top-center
 * placements duplicating composition-owned tools.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocumentToolSnapshot } from '@froglight/foundation';
import { InMemoryStylusService } from '@froglight/foundation';
import type { WorkbenchEditorToolsPort } from '../workbench-ports.js';
import { createDocumentToolbarRegistry } from '../document-toolbar-registry.js';
import { createToolbarPlacementRegistry } from '../toolbar/placement-registry.js';
import { createToolbarCompositionRegistry } from '../toolbar/composition-registry.js';
import {
  computeUnifiedToolbarModel,
  FloatingToolbarLayer,
} from './UnifiedToolbar.jsx';
import {
  StylusAccessoryBinder,
  type StylusPaletteHandle,
} from '../stylus-accessory.js';
import type { StylusPaletteModel } from '../stylus-palette-model.js';
import { createStylusMenuRegistry } from '../stylus-menu-registry.js';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function makeTools(snapshot: DocumentToolSnapshot | null) {
  const listeners = new Set<() => void>();
  let current = snapshot;
  return {
    setSnapshot(next: DocumentToolSnapshot | null) {
      current = next;
      for (const listener of listeners) listener();
    },
    canExecEditorCommand: () => true,
    execEditorCommand: () => true,
    editorToolSnapshot: () => current,
    executeEditorTool: () => true,
    onDidChange: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
}

function penControl(
  id: string,
  semanticRole: string,
): DocumentToolSnapshot['controls'][number] {
  return {
    kind: 'button',
    id,
    group: 'draw',
    label: id,
    icon: 'pen',
    role: 'surface-tool',
    toolRole: 'pen',
    semanticRole,
  } as DocumentToolSnapshot['controls'][number];
}

function installSurfaceComposition(
  registry: ReturnType<typeof createToolbarCompositionRegistry>['registry'],
  extra?: {
    readonly items?: Parameters<typeof registry.registerItem>[0][];
  },
): void {
  registry.registerCategory({
    id: 'surface.write',
    familyId: 'surface',
    label: 'Write',
    icon: 'pen',
  });
  registry.registerItem({
    id: 'test.write.pen',
    categoryId: 'surface.write',
    semanticRole: 'surface.pen.ball',
    projections: ['normal', 'compact', 'squeeze'],
  });
  for (const item of extra?.items ?? []) registry.registerItem(item);
  registry.registerKindExtension({
    id: 'test-ink-family',
    kindIds: ['froglight.ink'],
    familyIds: ['surface'],
  });
}

describe('composition diagnostics surfacing (A4)', () => {
  it('surfaces a duplicate semantic role in layout.diagnostics', () => {
    const tools = makeTools({
      context: 'Ink canvas',
      controls: [
        penControl('ink.pen', 'surface.pen.ball'),
        penControl('ink.pen.clone', 'surface.pen.ball'),
      ],
    }) as unknown as WorkbenchEditorToolsPort;
    const contributions = createDocumentToolbarRegistry();
    const placements = createToolbarPlacementRegistry();
    const composition = createToolbarCompositionRegistry();
    try {
      installSurfaceComposition(composition.registry);
      const computed = computeUnifiedToolbarModel({
        tools,
        contributions: contributions.registry,
        placements: placements.registry,
        composition: composition.registry,
        pane: 'main',
        documentId: 'doc-1',
        kindId: 'froglight.ink',
      });
      expect(computed.compositionGraph?.diagnostics.join('\n')).toContain(
        "duplicate semantic toolbar role 'surface.pen.ball'",
      );
      // Merged into the reported channel, not dropped.
      expect(computed.layout.diagnostics.join('\n')).toContain(
        "duplicate semantic toolbar role 'surface.pen.ball'",
      );
    } finally {
      contributions.dispose();
      placements.dispose();
      composition.dispose();
    }
  });

  it('surfaces a dormant cross-plugin item (missing category) as unresolved, not silent', () => {
    const tools = makeTools({
      context: 'Ink canvas',
      controls: [penControl('ink.pen', 'surface.pen.ball')],
    }) as unknown as WorkbenchEditorToolsPort;
    const contributions = createDocumentToolbarRegistry();
    const placements = createToolbarPlacementRegistry();
    const composition = createToolbarCompositionRegistry();
    try {
      installSurfaceComposition(composition.registry, {
        items: [
          {
            id: 'dormant.cross-plugin.item',
            categoryId: 'missing.category',
            semanticRole: 'surface.pen.ball',
          },
        ],
      });
      const computed = computeUnifiedToolbarModel({
        tools,
        contributions: contributions.registry,
        placements: placements.registry,
        composition: composition.registry,
        pane: 'main',
        documentId: 'doc-1',
        kindId: 'froglight.ink',
      });
      expect(computed.compositionGraph?.unresolved).toContain(
        'dormant.cross-plugin.item',
      );
      expect(computed.layout.diagnostics.join('\n')).toContain(
        "unresolved toolbar item 'dormant.cross-plugin.item'",
      );
    } finally {
      contributions.dispose();
      placements.dispose();
      composition.dispose();
    }
  });

  it('surfaces an ordering cycle in layout.diagnostics', () => {
    const tools = makeTools({
      context: 'Ink canvas',
      controls: [penControl('ink.pen', 'surface.pen.ball')],
    }) as unknown as WorkbenchEditorToolsPort;
    const contributions = createDocumentToolbarRegistry();
    const placements = createToolbarPlacementRegistry();
    const composition = createToolbarCompositionRegistry();
    try {
      installSurfaceComposition(composition.registry, {
        items: [
          {
            id: 'cycle.a',
            categoryId: 'surface.write',
            semanticRole: 'surface.pen.ball',
            before: ['cycle.b'],
          },
          {
            id: 'cycle.b',
            categoryId: 'surface.write',
            semanticRole: 'surface.pen.ball',
            before: ['cycle.a'],
          },
        ],
      });
      const computed = computeUnifiedToolbarModel({
        tools,
        contributions: contributions.registry,
        placements: placements.registry,
        composition: composition.registry,
        pane: 'main',
        documentId: 'doc-1',
        kindId: 'froglight.ink',
      });
      expect(computed.compositionGraph?.diagnostics.join('\n')).toContain(
        'ordering cycle',
      );
      expect(computed.layout.diagnostics.join('\n')).toContain(
        'ordering cycle',
      );
    } finally {
      contributions.dispose();
      placements.dispose();
      composition.dispose();
    }
  });

  it('reports merged composition diagnostics through the dev console channel', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let root: Root | null = null;
    try {
      const host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
      const tools = makeTools({
        context: 'Ink canvas',
        controls: [
          penControl('ink.pen', 'surface.pen.ball'),
          penControl('ink.pen.clone', 'surface.pen.ball'),
        ],
      }) as unknown as WorkbenchEditorToolsPort;
      const contributions = createDocumentToolbarRegistry();
      const placements = createToolbarPlacementRegistry();
      const composition = createToolbarCompositionRegistry();
      try {
        installSurfaceComposition(composition.registry, {
          items: [
            {
              id: 'dormant.cross-plugin.item',
              categoryId: 'missing.category',
              semanticRole: 'surface.pen.ball',
            },
          ],
        });
        placements.registry.register({
          id: 'legacy.pen',
          kindIds: ['froglight.ink'],
          anchor: 'float.top-center',
          controlIds: ['ink.pen'],
        });
        await act(async () => {
          root?.render(
            <FloatingToolbarLayer
              tools={tools}
              contributions={contributions.registry}
              placements={placements.registry}
              composition={composition.registry}
              pane="main"
              documentId="doc-1"
              kindId="froglight.ink"
            />,
          );
        });
        const messages = error.mock.calls
          .map((call) => String(call[0] ?? ''))
          .join('\n');
        expect(messages).toContain('duplicate semantic toolbar role');
        expect(messages).toContain('dormant.cross-plugin.item');
      } finally {
        contributions.dispose();
        placements.dispose();
        composition.dispose();
      }
      await act(async () => root?.unmount());
      root = null;
      document.body.replaceChildren();
    } finally {
      error.mockRestore();
    }
  });
});

describe('floating duplicate guard removed (mounted)', () => {
  let root: Root | null = null;
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('renders the shelf from the unclaimed tool while the claimed duplicate is reported (single-owner)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const tools = makeTools({
      context: 'Ink canvas',
      controls: [
        penControl('ink.pen', 'surface.pen.ball'),
        penControl('ink.highlighter', 'surface.highlighter'),
      ],
    }) as unknown as WorkbenchEditorToolsPort;
    const contributions = createDocumentToolbarRegistry();
    const placements = createToolbarPlacementRegistry();
    const composition = createToolbarCompositionRegistry();
    try {
      installSurfaceComposition(composition.registry, {
        items: [
          {
            id: 'test.write.highlighter',
            categoryId: 'surface.write',
            semanticRole: 'surface.highlighter',
            projections: ['normal', 'compact', 'squeeze'],
          },
        ],
      });
      placements.registry.register({
        id: 'legacy.pen',
        kindIds: ['froglight.ink'],
        anchor: 'float.top-center',
        controlIds: ['ink.pen'],
      });
      await act(async () => {
        root?.render(
          <FloatingToolbarLayer
            tools={tools}
            contributions={contributions.registry}
            placements={placements.registry}
            composition={composition.registry}
            pane="main"
            documentId="doc-1"
            kindId="froglight.ink"
          />,
        );
      });
      // cross-layer single-owner: the geometrically claimed pen is
      // skipped in the shelf (the island keeps it) with a combined
      // diagnostic. The shelf still renders from the unclaimed highlighter,
      // so every asserted shelf has an unclaimed tool and does not depend
      // on the claimed-only configuration. Defaults never overlap; see the
      // disjointness pin in default-placements.spec.ts. Custom hosts must
      // not duplicate.
      expect(
        host.querySelector('[data-tool-shelf="surface.write"]'),
      ).not.toBeNull();
      const messages = error.mock.calls
        .map((call) => String(call[0] ?? ''))
        .join('\n');
      expect(messages).not.toContain('suppressed at float.top-center');
      expect(messages).toContain(
        "duplicate toolbar control 'ink.pen' in composition shelf 'test.write.pen' (already owned by geometric placement 'legacy.pen')",
      );
    } finally {
      contributions.dispose();
      placements.dispose();
      composition.dispose();
    }
  });
});

describe('squeeze assembled diagnostics (A4)', () => {
  it('routes assembled + composition diagnostics to deps.diagnostics', () => {
    const service = new InMemoryStylusService();
    const menus = createStylusMenuRegistry();
    const composition = createToolbarCompositionRegistry();
    const toolbarControls = createDocumentToolbarRegistry();
    try {
      installSurfaceComposition(composition.registry, {
        items: [
          {
            id: 'dormant.squeeze.item',
            categoryId: 'missing.category',
            semanticRole: 'surface.pen.ball',
            projections: ['squeeze'],
          },
        ],
      });
      const snapshot: DocumentToolSnapshot = {
        context: 'Ink canvas',
        controls: [
          penControl('ink.pen', 'surface.pen.ball'),
          penControl('ink.pen.clone', 'surface.pen.ball'),
        ],
      };
      // Assembled-pool duplicate: a contribution claiming a provider-owned
      // id must reach `deps.diagnostics`, not drop silently.
      const duplicateClaim = toolbarControls.registry.register({
        id: 'acme.pen-override',
        controls: () => [
          {
            kind: 'button',
            id: 'ink.pen',
            group: 'draw',
            label: 'Override pen',
          } as DocumentToolSnapshot['controls'][number],
        ],
        execute: () => true,
      });
      const diagnostics: string[] = [];
      const palettes: StylusPaletteModel[] = [];
      const binder = new StylusAccessoryBinder({
        service,
        menuRegistry: menus.registry,
        toolbarComposition: composition.registry,
        toolbarRegistry: toolbarControls.registry,
        tools: {
          editorToolSnapshot: () => snapshot,
          executeEditorTool: () => true,
        },
        focusedPane: () => 'main',
        menuContext: () => ({
          pane: 'main',
          documentId: 'doc-1',
          kindId: 'froglight.ink',
        }),
        showMenu: () => undefined,
        menuAnchor: () => ({ x: 10, y: 20 }),
        showPalette: (model, _anchor) => {
          palettes.push(model);
          let closed = false;
          const handle: StylusPaletteHandle = {
            updateAnchor: () => undefined,
            close: () => {
              closed = true;
            },
            get closed() {
              return closed;
            },
          };
          return handle;
        },
        commands: {
          canExecEditorCommand: () => true,
          execEditorCommand: () => true,
        },
        diagnostics: (message: string) => {
          diagnostics.push(message);
        },
      });
      service.handleNativeEvent('action', {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 100, y: 100 },
      });
      expect(palettes).toHaveLength(1);
      const joined = diagnostics.join('\n');
      // Duplicate semantic role from the squeeze composition.
      expect(joined).toContain(
        "duplicate semantic toolbar role 'surface.pen.ball'",
      );
      // Dormant squeeze item surfaces as unresolved, not silent.
      expect(joined).toContain("unresolved toolbar item 'dormant.squeeze.item'");
      // Assembled owned-pool duplicate reaches the same channel.
      expect(joined).toContain("duplicate toolbar control 'ink.pen'");
      binder.dispose();
      duplicateClaim.dispose();
    } finally {
      composition.dispose();
      toolbarControls.dispose();
      menus.dispose();
    }
  });
});
