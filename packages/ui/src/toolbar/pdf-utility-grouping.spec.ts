/**
 * PDF + utility-anchor grouping.
 *
 * Behavioral migration only: the composition graph already owns the
 * grouped PDF main strip (Pages / Select / Annotate singleton groups) and
 * the geometric placements already own history (global) + page navigation
 * (PDF bottom-center). No production change here — these pins prove the
 * behavior through the same seams providers and the shell already use:
 *
 * - every PDF open resolves a grouped main + secondary shelf, empty
 *   groups omit (never empty/disabled placeholders), no flat fallback.
 * - PDF vocabulary is label-only — ids never rename; display labels
 *   map Pages/Select/Annotate while annotate/select stay reachable.
 * - (placement level): single-row shell, floating secondary islands,
 *   per-pane kind scoping, deterministic resolution, no placeholders.
 * - PDF toolbar traffic is plain DTO data (no engine references).
 * - community PDF contributions flow through the validated DTO +
 *   command broker only, kind-scoped, lifecycle-owned.
 *
 * Mounted-Pane / split-pane / reading-mode / collapse behavior for PDF is
 * pinned in `packages/ui/src/react/pdf-toolbar-grouping.spec.tsx`; the
 * provider seam (page nav, source-select toggle, import-as-notebook) is
 * pinned in `packages/provider-pdfjs/src/toolbar-grouping.spec.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  isExclusiveActiveToolControl,
  type DocumentToolControl,
} from '@froglight/foundation';
import {
  createToolbarCompositionRegistry,
  groupCategoriesByStripGroup,
  resolveToolbarComposition,
  stripGroupIdForCategory,
} from './composition-registry.js';
import { defaultToolbarComposition } from './default-composition.js';
import { defaultToolbarPlacements } from './default-placements.js';
import { createToolbarPlacementRegistry } from './placement-registry.js';
import {
  assembleOwnedPool,
  resolveToolbarGroups,
} from './placement-resolver.js';
import {
  createDocumentToolbarRegistry,
  type DocumentToolbarContext,
} from '../document-toolbar-registry.js';
import {
  registerCommunityToolbarContribution,
  validateCommunityToolbarContribution,
  type CommunityToolbarCommandBroker,
} from './community-contribution.js';

/** Faithful doubles mirroring `PdfDocumentEditorProvider` snapshot literals 1:1. */
function pdfControls(): DocumentToolControl[] {
  return [
    {
      kind: 'button',
      id: 'pdf.previous',
      semanticRole: 'pdf.page.previous',
      group: 'pages',
      label: 'Previous PDF page',
      shortLabel: 'Previous',
      icon: 'arrow-back',
    },
    {
      kind: 'status',
      id: 'pdf.page',
      group: 'pages',
      label: '3 / 9',
    },
    {
      kind: 'button',
      id: 'pdf.next',
      semanticRole: 'pdf.page.next',
      group: 'pages',
      label: 'Next PDF page',
      shortLabel: 'Next',
      icon: 'arrow-forward',
    },
    {
      kind: 'button',
      id: 'pdf.source-select',
      semanticRole: 'pdf.select.source',
      group: 'interaction',
      label: 'Select and copy source text',
      shortLabel: 'Source Select',
      icon: 'cursor',
      active: true,
      activationRole: 'toggle',
    },
    {
      kind: 'button',
      id: 'pdf.import-notebook',
      semanticRole: 'pdf.annotate.notebook',
      group: 'document',
      label: 'Annotate / Import as Notebook',
      shortLabel: 'Annotate',
      icon: 'notebook',
    },
  ] as DocumentToolControl[];
}

function context(
  kindId: string,
  pool: readonly DocumentToolControl[],
  pane = 'main',
  documentId = 'doc-1',
): DocumentToolbarContext {
  return {
    pane,
    documentId,
    kindId,
    editor: { context: 'test', controls: [...pool] },
  };
}

function resolveProviderLayout(input: {
  readonly placements: ReturnType<typeof defaultToolbarPlacements>;
  readonly pool: readonly DocumentToolControl[];
  readonly context: DocumentToolbarContext;
}) {
  const resolved = resolveToolbarGroups({
    placements: input.placements,
    ownedPool: assembleOwnedPool({ providerControls: input.pool }).ownedPool,
    context: input.context,
  });
  const controlsAt = (anchor: string) =>
    resolved.groups
      .filter((group) => group.anchor === anchor)
      .flatMap((group) => group.controls.map((owned) => owned.control));
  return {
    ...resolved,
    topbarCenter: controlsAt('topbar-center'),
    floating: {
      'float.top-left': controlsAt('float.top-left'),
      'float.top-center': controlsAt('float.top-center'),
      'float.top-right': controlsAt('float.top-right'),
      'float.left-center': controlsAt('float.left-center'),
      'float.right-center': controlsAt('float.right-center'),
      'float.bottom-left': controlsAt('float.bottom-left'),
      'float.bottom-center': controlsAt('float.bottom-center'),
      'float.bottom-right': controlsAt('float.bottom-right'),
      'float.selection': controlsAt('float.selection'),
    },
  };
}

function resolvePdf(
  pool: readonly DocumentToolControl[],
  kindId = 'froglight.pdf',
) {
  return resolveToolbarComposition({
    snapshot: defaultToolbarComposition(),
    kindId,
    controls: pool,
  });
}

describe('pdf grouping: grouped main + shelf for every PDF open', () => {
  it('resolves Pages/Select/Annotate singleton groups with no flat fallback', () => {
    const graph = resolvePdf(pdfControls());
    expect(graph.diagnostics).toEqual([]);
    expect(graph.categories.map((entry) => entry.id)).toEqual([
      'pdf.pages',
      'pdf.select',
      'pdf.annotate',
    ]);
    // Singleton groups keyed by category id: every family
    // opens grouped, PDF included.
    for (const category of graph.categories) {
      expect(category.groupId).toBe(category.id);
      expect(stripGroupIdForCategory(category)).toBe(category.id);
    }
    expect([...groupCategoriesByStripGroup(graph.categories).keys()]).toEqual([
      'pdf.pages',
      'pdf.select',
      'pdf.annotate',
    ]);
    // No flat fallback: every resolved item belongs to a grouped category,
    // and each provider control is presented exactly once.
    const controlIds = graph.categories.flatMap((category) =>
      category.items.map((item) => item.control.id),
    );
    expect([...controlIds].sort()).toEqual([
      'pdf.import-notebook',
      'pdf.next',
      'pdf.previous',
      'pdf.source-select',
    ]);
  });

  it('omits empty groups instead of rendering placeholders', () => {
    // Without an importer the Annotate group resolves away entirely.
    const withoutAnnotate = pdfControls().filter(
      (control) => control.id !== 'pdf.import-notebook',
    );
    const graph = resolvePdf(withoutAnnotate);
    expect(graph.diagnostics).toEqual([]);
    expect(graph.categories.map((entry) => entry.id)).toEqual([
      'pdf.pages',
      'pdf.select',
    ]);
    expect(graph.unresolved).toContain('pdf.annotate.notebook');
    // Navigation alone still opens grouped — never an empty shelf.
    const navOnly = pdfControls().filter(
      (control) =>
        control.id === 'pdf.previous' ||
        control.id === 'pdf.next' ||
        control.id === 'pdf.page',
    );
    const navGraph = resolvePdf(navOnly);
    expect(navGraph.categories.map((entry) => entry.id)).toEqual(['pdf.pages']);
    for (const category of navGraph.categories) {
      expect(category.items.length).toBeGreaterThan(0);
    }
  });

  it('keeps source-select a non-exclusive toggle outside tool reconciliation', () => {
    const graph = resolvePdf(pdfControls());
    const select = graph.categories
      .find((entry) => entry.id === 'pdf.select')
      ?.items.find((item) => item.semanticRole === 'pdf.select.source');
    if (select === undefined) throw new Error('missing pdf.select.source');
    if (select.control.kind !== 'button') {
      throw new Error('pdf.select.source must stay a toggle button');
    }
    expect(select.control.active).toBe(true);
    expect(isExclusiveActiveToolControl(select.control)).toBe(false);
  });
});

describe('pdf grouping: label-only vocabulary, no id renames', () => {
  it('pins stable ids with display-label mapping Pages/Select/Annotate', () => {
    const graph = resolvePdf(pdfControls());
    expect(
      graph.categories.map((entry) => `${entry.id}=${entry.label}`),
    ).toEqual([
      'pdf.pages=Pages',
      'pdf.select=Select',
      'pdf.annotate=Annotate',
    ]);
    // Display labels converge (Pages/Select/Annotate) while every id stays
    // family-idiomatic: unification is label mapping, never id changes.
    const shortLabels = new Map<string, string>();
    for (const category of graph.categories) {
      for (const item of category.items) {
        if (item.control.kind === 'button') {
          shortLabels.set(
            item.control.id,
            item.control.shortLabel ?? item.control.label,
          );
        }
      }
    }
    expect(shortLabels.get('pdf.previous')).toBe('Previous');
    expect(shortLabels.get('pdf.next')).toBe('Next');
    expect(shortLabels.get('pdf.source-select')).toBe('Source Select');
    expect(shortLabels.get('pdf.import-notebook')).toBe('Annotate');
  });

  it('keeps existing annotate/select actions reachable after migration', () => {
    const graph = resolvePdf(pdfControls());
    const roles = new Map(
      graph.categories.flatMap((category) =>
        category.items.map(
          (item) => [item.semanticRole, item.control.id] as const,
        ),
      ),
    );
    expect(roles.get('pdf.select.source')).toBe('pdf.source-select');
    expect(roles.get('pdf.annotate.notebook')).toBe('pdf.import-notebook');
    expect(roles.get('pdf.page.previous')).toBe('pdf.previous');
    expect(roles.get('pdf.page.next')).toBe('pdf.next');
  });
});

describe('pdf grouping: utility anchors stay single-row and floating', () => {
  it('scopes history globally and page navigation to the pdf kind', () => {
    const pool = pdfControls();
    const pdf = context('froglight.pdf', pool);
    const placed = defaultToolbarPlacements().filter(
      (placement) =>
        placement.kindIds === undefined ||
        placement.kindIds.includes(pdf.kindId),
    );
    const history = placed.find(
      (placement) => placement.id === 'froglight.toolbar-placement.history',
    );
    expect(history?.anchor).toBe('float.top-left');
    expect(history?.controlIds).toEqual([
      'shell.history.undo',
      'shell.history.redo',
    ]);
    expect(history?.compact).toBe('never');
    const pages = placed.find(
      (placement) => placement.id === 'froglight.toolbar-placement.pdf.pages',
    );
    expect(pages?.anchor).toBe('float.bottom-left');
    expect(pages?.order).toBe(20);
    expect(pages?.controlIds).toEqual([
      'pdf.previous',
      'pdf.page',
      'pdf.next',
      'pdf.outline',
    ]);
    // Single row: no topbar-center and no top-center property island for PDF.
    expect(
      placed.some((placement) => placement.anchor === 'topbar-center'),
    ).toBe(false);
    expect(
      placed.some((placement) => placement.anchor === 'float.top-center'),
    ).toBe(false);
    // Markdown shares history but never claims the PDF island.
    const markdownPlaced = defaultToolbarPlacements().filter(
      (placement) =>
        placement.kindIds === undefined ||
        placement.kindIds.includes('froglight.markdown'),
    );
    expect(
      markdownPlaced.some(
        (placement) => placement.id === 'froglight.toolbar-placement.pdf.pages',
      ),
    ).toBe(false);
  });

  it('resolves one nav island while source actions stay composition-owned', () => {
    const pool = pdfControls();
    const layout = resolveProviderLayout({
      placements: defaultToolbarPlacements(),
      pool,
      context: context('froglight.pdf', pool),
    });
    expect(layout.diagnostics).toEqual([]);
    expect(layout.topbarCenter).toEqual([]);
    expect(layout.floating['float.top-center']).toEqual([]);
    // Page navigation keeps previous/page/next together bottom-left.
    expect(layout.floating['float.bottom-left'].map((c) => c.id)).toEqual([
      'pdf.previous',
      'pdf.page',
      'pdf.next',
    ]);
    // The PDF provider emits no zoom/selection/diagnostics controls, so
    // those utility anchors stay empty — never placeholders.
    expect(layout.floating['float.bottom-right']).toEqual([]);
    expect(layout.floating['float.selection']).toEqual([]);
    expect(layout.floating['float.top-right']).toEqual([]);
    // Source actions resolve through composition, hence geometrically
    // unplaced — the same seam the shelf renders.
    expect(layout.unplaced).toEqual(
      expect.arrayContaining(['pdf.source-select', 'pdf.import-notebook']),
    );
  });

  it('resolves deterministically per kind so per-pane scoping holds', () => {
    const created = createToolbarPlacementRegistry();
    try {
      for (const placement of defaultToolbarPlacements()) {
        created.registry.register(placement);
      }
      const idsFor = (pane: string, kindId: string): readonly string[] =>
        created.registry
          .placementsFor(context(kindId, pdfControls(), pane))
          .map((placement) => placement.id);
      const left = idsFor('main', 'froglight.pdf');
      const right = idsFor('right', 'froglight.pdf');
      // Pane identity never perturbs placement matching: two split panes
      // hosting PDFs resolve identically, scoped by kind.
      expect(right).toEqual(left);
      expect(left).toContain('froglight.toolbar-placement.pdf.pages');
      const markdown = idsFor('main', 'froglight.markdown');
      expect(markdown).not.toContain('froglight.toolbar-placement.pdf.pages');
    } finally {
      created.dispose();
    }
  });
});

describe('pdf grouping: no canonical/engine changes', () => {
  it('keeps pdf toolbar controls as plain DTO data', () => {
    const pool = pdfControls();
    // JSON round-trip preserves every control: no functions, handles, or
    // engine references cross the toolbar seams.
    expect(JSON.parse(JSON.stringify(pool))).toEqual(
      pool.map((control) => ({ ...control })),
    );
    const visit = (value: unknown): void => {
      expect(typeof value === 'function').toBe(false);
      expect(typeof value === 'symbol').toBe(false);
      if (Array.isArray(value)) {
        for (const entry of value) visit(entry);
      } else if (typeof value === 'object' && value !== null) {
        for (const entry of Object.values(value)) visit(entry);
      }
    };
    visit(pool);
    for (const control of pool) {
      expect(control.id).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
      for (const text of [control.id, control.label]) {
        expect(text).not.toMatch(/pdfjs|worker|\.mjs|canvas/i);
      }
    }
  });
});

describe('pdf grouping: community DTO/broker only', () => {
  const KIND_PDF = 'froglight.pdf';

  function harness() {
    const composition = createToolbarCompositionRegistry();
    const defaults = defaultToolbarComposition();
    for (const entry of defaults.categories)
      composition.registry.registerCategory(entry);
    for (const entry of defaults.items)
      composition.registry.registerItem(entry);
    for (const entry of defaults.extensions)
      composition.registry.registerKindExtension(entry);
    const controls = createDocumentToolbarRegistry();
    const brokerCalls: Array<{
      pluginId: string;
      commandId: string;
      context: { pane: string; documentId: string; kindId: string };
    }> = [];
    const broker: CommunityToolbarCommandBroker = {
      execute: (pluginId, commandId, ctx) => {
        brokerCalls.push({
          pluginId,
          commandId,
          context: {
            pane: ctx.pane,
            documentId: ctx.documentId,
            kindId: ctx.kindId,
          },
        });
        return true;
      },
    };
    return { composition, controls, broker, brokerCalls };
  }

  const manifest = {
    id: 'pdf-note',
    targetCategoryId: 'pdf.select',
    label: 'PDF Note',
    commandId: 'note',
    order: 5,
  } as const;

  it('validates the community DTO fail-closed', () => {
    expect(validateCommunityToolbarContribution({ ...manifest })).toEqual([]);
    expect(
      validateCommunityToolbarContribution({
        ...manifest,
        icon: 'nope-not-an-icon' as never,
      }).length,
    ).toBeGreaterThan(0);
    const { composition, controls, broker } = harness();
    expect(() =>
      registerCommunityToolbarContribution({
        pluginId: 'acme',
        manifest: { ...manifest, icon: 'nope-not-an-icon' as never },
        composition: composition.registry,
        controls: controls.registry,
        broker,
        kindIds: [KIND_PDF],
      }),
    ).toThrow(TypeError);
  });

  it('routes community pdf contributions through structure + broker, kind-scoped', () => {
    const { composition, controls, broker, brokerCalls } = harness();
    const handle = registerCommunityToolbarContribution({
      pluginId: 'acme',
      manifest: { ...manifest },
      composition: composition.registry,
      controls: controls.registry,
      broker,
      kindIds: [KIND_PDF],
    });
    const pdfCtx = context(KIND_PDF, pdfControls());
    // Lifecycle invariant: activate -> one registration.
    const provided = controls.registry.controls(pdfCtx);
    expect(
      provided.filter(
        (control) => control.id === 'community.acme.pdf-note.command',
      ),
    ).toHaveLength(1);
    // Structure path: the DTO item resolves under pdf.select alongside the
    // first-party toggle — dormant without its control, never synthesized.
    const pool = [
      ...pdfControls(),
      ...provided.filter(
        (control) => control.id === 'community.acme.pdf-note.command',
      ),
    ];
    const graph = resolveToolbarComposition({
      snapshot: composition.registry.snapshot(),
      kindId: KIND_PDF,
      controls: pool,
    });
    expect(graph.diagnostics).toEqual([]);
    expect(
      graph.categories
        .find((entry) => entry.id === 'pdf.select')
        ?.items.map((item) => item.semanticRole),
    ).toEqual(expect.arrayContaining(['community.acme.pdf-note']));
    const dormant = resolveToolbarComposition({
      snapshot: composition.registry.snapshot(),
      kindId: KIND_PDF,
      controls: pdfControls(),
    });
    expect(dormant.unresolved).toContain('community.acme.pdf-note.item');
    // Execution path: the broker receives routing only — never DOM/handles.
    expect(
      controls.registry.execute(pdfCtx, 'community.acme.pdf-note.command'),
    ).toBe(true);
    expect(brokerCalls).toEqual([
      {
        pluginId: 'acme',
        commandId: 'note',
        context: { pane: 'main', documentId: 'doc-1', kindId: KIND_PDF },
      },
    ]);
    // Kind scoping: markdown never sees or executes the PDF contribution.
    const markdownCtx = context('froglight.markdown', []);
    expect(
      controls.registry
        .controls(markdownCtx)
        .some((control) => control.id === 'community.acme.pdf-note.command'),
    ).toBe(false);
    expect(
      controls.registry.execute(markdownCtx, 'community.acme.pdf-note.command'),
    ).toBe(false);
    // Lifecycle invariant: dispose -> zero registrations.
    handle.dispose();
    expect(
      controls.registry
        .controls(pdfCtx)
        .some((control) => control.id === 'community.acme.pdf-note.command'),
    ).toBe(false);
    expect(
      controls.registry.execute(pdfCtx, 'community.acme.pdf-note.command'),
    ).toBe(false);
  });
});
