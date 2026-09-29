/**
 * Surface family composition convergence.
 *
 * Ink, Notebook, and Whiteboard share one composition grammar for
 * Pen/Highlighter/Eraser/Select/Shapes/Insert/Text: identical categories, items,
 * ordering, and semantic roles. The Text category is always live through
 * the direct creation button (`surface.text.create` → `surface.insert.text`)
 * on an empty canvas; the seven style roles join it only when text is
 * selected.
 * Document-specific extensions are additions-only:
 * Notebook contributes Pages + PDF insertion, Whiteboard contributes Card;
 * neither redefines or replaces shared vocabulary. Differences arrive
 * through family membership and contributions — there are no kindId
 * branches in normal toolbar presentation, so equivalent provider controls
 * resolve to the same graph in every Surface family.
 */
import { describe, expect, it } from 'vitest';
import {
  buildSurfaceDrawControls,
  buildSurfaceImageControl,
  buildSurfaceTextControls,
  createSharedSurfaceDrawTools,
  surfaceTextControlIds,
  SURFACE_SHARED_SWATCHES,
  SURFACE_SHARED_WIDTHS,
  SURFACE_TOOL_IDS,
  type DocumentToolControl,
  type SurfaceToolbarHost,
} from '@froglight/foundation';
import { resolveToolbarComposition } from './composition-registry.js';
import {
  groupCategoriesByStripGroup,
  slotIdForItem,
  stripGroupIdForCategory,
} from './composition-registry.js';
import { applySlotOrder } from './toolbar-customization.js';
import {
  splitGroupedSqueezeItems,
  type GroupedSqueezeEntry,
} from './placement-resolver.js';
import {
  writingCodeBlockControl,
  writingFormatToggleControl,
  writingLinkControl,
} from '@froglight/foundation';
import {
  DEFAULT_TOOLBAR_ITEMS,
  DEFAULT_TOOLBAR_CATEGORIES,
  DEFAULT_TOOLBAR_KIND_EXTENSIONS,
  defaultToolbarComposition,
} from './default-composition.js';

function stubHost(overrides: Partial<SurfaceToolbarHost> = {}) {
  const host: SurfaceToolbarHost = {
    activeToolId: () => SURFACE_TOOL_IDS.pen,
    setTool: () => undefined,
    penColor: () => '#37352f',
    setPenColor: () => undefined,
    penWidth: () => 3.5,
    setPenWidth: () => undefined,
    eraserRadius: () => 10,
    setEraserRadius: () => undefined,
    zoomFactor: () => 1,
    setZoomFactor: () => undefined,
    canInsertImage: () => true,
    chooseImage: () => undefined,
    fitToView: () => undefined,
    ...overrides,
  };
  return host;
}

const button = (
  id: string,
  label: string,
  semanticRole: string,
): DocumentToolControl => ({
  kind: 'button',
  id,
  group: 'test',
  label,
  semanticRole,
});

/** Equivalent provider controls per family (mirrors each provider's snapshot). */
function familyControls(kind: 'ink' | 'notebook' | 'whiteboard') {
  const host = stubHost();
  if (kind === 'ink') {
    return [
      ...buildSurfaceDrawControls(host, {
        prefix: 'ink',
        tools: createSharedSurfaceDrawTools({
          pen: SURFACE_TOOL_IDS.pen,
          fountain: SURFACE_TOOL_IDS.fountain,
          brush: SURFACE_TOOL_IDS.brush,
          pencil: SURFACE_TOOL_IDS.pencil,
          highlighter: SURFACE_TOOL_IDS.highlighter,
          eraser: SURFACE_TOOL_IDS.eraser,
          select: SURFACE_TOOL_IDS.select,
          lasso: SURFACE_TOOL_IDS.lasso,
          line: 'froglight.ink.line',
          rectangle: 'froglight.ink.rect',
          ellipse: 'froglight.ink.ellipse',
          text: 'froglight.ink.text',
        }),
      }),
      buildSurfaceImageControl(host, { prefix: 'ink', icon: 'image' }),
      button('ink.frame-width', 'Canvas width', 'ink.canvas.width'),
      button('ink.frame-height', 'Canvas height', 'ink.canvas.height'),
      button('ink.export', 'Export PNG', 'ink.canvas.export'),
    ];
  }
  if (kind === 'notebook') {
    return [
      ...buildSurfaceDrawControls(host, {
        prefix: 'notebook',
        tools: createSharedSurfaceDrawTools({
          pen: SURFACE_TOOL_IDS.pen,
          fountain: SURFACE_TOOL_IDS.fountain,
          brush: SURFACE_TOOL_IDS.brush,
          pencil: SURFACE_TOOL_IDS.pencil,
          highlighter: SURFACE_TOOL_IDS.highlighter,
          eraser: SURFACE_TOOL_IDS.eraser,
          select: SURFACE_TOOL_IDS.select,
          lasso: SURFACE_TOOL_IDS.lasso,
          line: 'froglight.ink.line',
          rectangle: 'froglight.ink.rect',
          ellipse: 'froglight.ink.ellipse',
          text: 'froglight.notebook.text',
        }),
      }),
      buildSurfaceImageControl(host, { prefix: 'notebook', icon: 'image' }),
      button('notebook.overview', 'Page overview', 'notebook.page.overview'),
      button('notebook.template', 'Page paper', 'notebook.page.template'),
      button('notebook.add', 'Add page', 'notebook.page.add'),
      button('notebook.duplicate', 'Duplicate page', 'notebook.page.duplicate'),
      button('notebook.delete', 'Delete page', 'notebook.page.delete'),
      button('notebook.go-to-page', 'jump', 'notebook.page.jump'),
      button('notebook.page-size-preset', 'size', 'notebook.page.size'),
      button(
        'notebook.orientation',
        'orientation',
        'notebook.page.orientation',
      ),
      button('notebook.page-width', 'width', 'notebook.page.width'),
      button('notebook.page-height', 'height', 'notebook.page.height'),
      button('notebook.paper-spacing', 'spacing', 'notebook.paper.spacing'),
      button('notebook.paper-color', 'color', 'notebook.paper.color'),
      button('notebook.paper-reset', 'reset', 'notebook.paper.reset'),
    ];
  }
  return [
    ...buildSurfaceDrawControls(host, {
      prefix: 'whiteboard',
      tools: [
        ...createSharedSurfaceDrawTools(
          {
            pen: SURFACE_TOOL_IDS.pen,
            fountain: SURFACE_TOOL_IDS.fountain,
            brush: SURFACE_TOOL_IDS.brush,
            pencil: SURFACE_TOOL_IDS.pencil,
            highlighter: SURFACE_TOOL_IDS.highlighter,
            eraser: SURFACE_TOOL_IDS.eraser,
            select: SURFACE_TOOL_IDS.select,
            lasso: SURFACE_TOOL_IDS.lasso,
            line: 'froglight.ink.line',
            rectangle: 'froglight.ink.rect',
            ellipse: 'froglight.ink.ellipse',
            text: 'froglight.ink.text',
          },
          {
            pen: 'pen',
            fountain: 'fountain',
            brush: 'brush',
            pencil: 'pencil',
            highlighter: 'highlighter',
            eraser: 'eraser',
            select: 'select',
            lasso: 'lasso',
            line: 'line',
            rectangle: 'rect',
            ellipse: 'ellipse',
            text: 'text',
          },
        ),
        {
          key: 'card',
          toolId: 'froglight.whiteboard.card',
          label: 'Card',
          icon: 'blocks',
          group: 'insert',
          toolRole: 'shape',
          semanticRole: 'surface.insert.card',
        },
      ],
    }),
    buildSurfaceImageControl(host, { prefix: 'whiteboard', icon: 'image' }),
  ];
}

function resolveFor(kindId: string, controls: readonly DocumentToolControl[]) {
  return resolveToolbarComposition({
    snapshot: defaultToolbarComposition(),
    kindId,
    controls,
  });
}

describe('surface family composition convergence', () => {
  it('keeps Surface kind extensions additions-only', () => {
    const baseCategoryIds = new Set(
      DEFAULT_TOOLBAR_CATEGORIES.map((entry) => entry.id),
    );
    const baseItemIds = new Set(DEFAULT_TOOLBAR_ITEMS.map((entry) => entry.id));
    for (const extension of DEFAULT_TOOLBAR_KIND_EXTENSIONS.filter((entry) =>
      entry.id.startsWith('surface.'),
    )) {
      for (const category of extension.categories ?? []) {
        // Extensions add categories; they never redefine shared ones.
        expect(
          baseCategoryIds.has(category.id),
          `${extension.id} redefines category ${category.id}`,
        ).toBe(false);
        expect(category.familyId).toBe('surface');
      }
      for (const item of extension.items ?? []) {
        // Extensions add items; they never override shared items.
        expect(
          baseItemIds.has(item.id),
          `${extension.id} overrides item ${item.id}`,
        ).toBe(false);
        // Every extension item lands in a shared Surface category or an
        // extension-owned one — never in another family's category.
        const ownCategories = new Set(
          (extension.categories ?? []).map((entry) => entry.id),
        );
        const ok =
          baseCategoryIds.has(item.categoryId) ||
          ownCategories.has(item.categoryId);
        expect(ok, `${item.id} targets ${item.categoryId}`).toBe(true);
      }
    }
    // Page properties project into the sidebar; Whiteboard adds Card.
    const notebook = DEFAULT_TOOLBAR_KIND_EXTENSIONS.find(
      (entry) => entry.id === 'surface.notebook',
    );
    expect(notebook?.categories ?? []).toEqual([]);
    const whiteboard = DEFAULT_TOOLBAR_KIND_EXTENSIONS.find(
      (entry) => entry.id === 'surface.whiteboard',
    );
    expect(whiteboard?.items?.map((entry) => entry.semanticRole)).toEqual([
      'surface.insert.card',
    ]);
    // Ink canvas properties project into the sidebar.
    expect(
      DEFAULT_TOOLBAR_KIND_EXTENSIONS.find(
        (entry) => entry.id === 'surface.ink',
      )?.items?.map((entry) => entry.semanticRole) ?? [],
    ).toEqual([]);
  });

  it('resolves identical shared categories for Ink, Notebook, and Whiteboard', () => {
    const ink = resolveFor('froglight.ink', familyControls('ink'));
    const notebook = resolveFor(
      'froglight.notebook',
      familyControls('notebook'),
    );
    const whiteboard = resolveFor(
      'froglight.whiteboard',
      familyControls('whiteboard'),
    );
    for (const graph of [ink, notebook, whiteboard]) {
      expect(graph.diagnostics).toEqual([]);
    }
    const sharedIds = (categoryId: string) =>
      [ink, notebook, whiteboard].map(
        (graph) =>
          graph.categories
            .find((entry) => entry.id === categoryId)
            ?.items.map((item) => item.semanticRole) ?? null,
      );
    // Same five categories with the same labels/icons/order …
    const strip = (
      graph: ReturnType<typeof resolveFor>,
      id: string,
    ): unknown => {
      const category = graph.categories.find((entry) => entry.id === id);
      return (
        category && {
          label: category.label,
          icon: category.icon,
          order: category.order,
        }
      );
    };
    for (const id of [
      'surface.write',
      'surface.highlighter',
      'surface.erase',
      'surface.select',
      'surface.shapes',
      'surface.insert',
      'surface.text',
    ]) {
      expect(strip(notebook, id), id).toEqual(strip(ink, id));
      expect(strip(whiteboard, id), id).toEqual(strip(ink, id));
      expect(strip(ink, id), id).not.toBeNull();
    }
    // … and the same shared items in the same order …
    expect(sharedIds('surface.write')).toEqual([
      [
        'surface.pen.ball',
        'surface.pen.fountain',
        'surface.pen.brush',
        'surface.pencil',
      ],
      [
        'surface.pen.ball',
        'surface.pen.fountain',
        'surface.pen.brush',
        'surface.pencil',
      ],
      [
        'surface.pen.ball',
        'surface.pen.fountain',
        'surface.pen.brush',
        'surface.pencil',
      ],
    ]);
    expect(sharedIds('surface.highlighter')).toEqual([
      ['surface.highlighter'],
      ['surface.highlighter'],
      ['surface.highlighter'],
    ]);
    expect(sharedIds('surface.erase')).toEqual([
      ['surface.erase'],
      ['surface.erase'],
      ['surface.erase'],
    ]);
    expect(sharedIds('surface.select')).toEqual([
      ['surface.select', 'surface.lasso'],
      ['surface.select', 'surface.lasso'],
      ['surface.select', 'surface.lasso'],
    ]);
    expect(sharedIds('surface.shapes')).toEqual([
      [
        'surface.shape.line',
        'surface.shape.rectangle',
        'surface.shape.ellipse',
      ],
      [
        'surface.shape.line',
        'surface.shape.rectangle',
        'surface.shape.ellipse',
      ],
      [
        'surface.shape.line',
        'surface.shape.rectangle',
        'surface.shape.ellipse',
      ],
    ]);
    // … with Insert extended (never replaced) per family:
    // no text item — creation lives in `surface.text` only;
    // notebook adds PDF before/after) …
    expect(sharedIds('surface.insert')).toEqual([
      ['surface.insert.image'],
      ['surface.insert.image'],
      ['surface.insert.image', 'surface.insert.card'],
    ]);
    // … and the direct Text strip button use the same presenter per family,
    // with zero selection-creation role and the same control.
    expect(sharedIds('surface.text')).toEqual([
      ['surface.insert.text'],
      ['surface.insert.text'],
      ['surface.insert.text'],
    ]);
  });

  it('resolves notebook PDF insertion in Insert, dormant without a PDF import path', () => {
    // `notebook.insert.pdf.before/after` ride the shared
    // `surface.insert` category (notebook extension, add-only) so clicking
    // Insert shows them in the secondary shelf next to image. Dormant via
    // omission until the provider emits the roles (gated by canInsertPdf).
    const pdfControls: DocumentToolControl[] = [
      {
        kind: 'button',
        id: 'notebook.insert-pdf-before',
        group: 'insert',
        label: 'Insert PDF before current page',
        semanticRole: 'notebook.insert.pdf.before',
      },
      {
        kind: 'button',
        id: 'notebook.insert-pdf-after',
        group: 'insert',
        label: 'Insert PDF after current page',
        semanticRole: 'notebook.insert.pdf.after',
      },
    ];
    const notebook = resolveFor('froglight.notebook', [
      ...familyControls('notebook'),
      ...pdfControls,
    ]);
    expect(notebook.diagnostics).toEqual([]);
    expect(
      notebook.categories
        .find((entry) => entry.id === 'surface.insert')
        ?.items.map((item) => item.semanticRole),
    ).toEqual([
      'surface.insert.image',
      'notebook.insert.pdf.before',
      'notebook.insert.pdf.after',
    ]);
    // Page properties and management are no longer composed into the toolbar.
    expect(
      notebook.categories
        .find((entry) => entry.id === 'notebook.pages')
        ?.items.map((item) => item.semanticRole),
    ).toBeUndefined();
    // Dormant without the provider roles: unresolved, never synthesized.
    const dormant = resolveFor(
      'froglight.notebook',
      familyControls('notebook'),
    );
    expect(dormant.diagnostics).toEqual([]);
    expect(dormant.unresolved).toEqual(
      expect.arrayContaining([
        'notebook.insert.pdf.before',
        'notebook.insert.pdf.after',
      ]),
    );
    expect(
      dormant.categories
        .find((entry) => entry.id === 'surface.insert')
        ?.items.map((item) => item.semanticRole),
    ).toEqual(['surface.insert.image']);
    // Ink/Whiteboard never see notebook PDF vocabulary.
    for (const [kindId, kind] of [
      ['froglight.ink', 'ink'],
      ['froglight.whiteboard', 'whiteboard'],
    ] as const) {
      const graph = resolveFor(kindId, familyControls(kind));
      expect(graph.diagnostics).toEqual([]);
      expect(graph.unresolved).not.toContain('notebook.insert.pdf.before');
      expect(graph.unresolved).not.toContain('notebook.insert.pdf.after');
    }
  });

  it('resolves two distinct eraser tools with no duplicate presenter', () => {
    // One provider control per fixed-mode eraser role (same shapes the
    // builder emits via `createSharedSurfaceEraserTools`): legacy
    // `surface.erase` plus the two modes. Distinct roles resolve side by side
    // with zero diagnostics — never a duplicate presenter — in every
    // projection, with the legacy tool leading in verbatim order.
    const eraserTools = (prefix: string): DocumentToolControl[] =>
      (
        [
          ['Stroke Eraser', 'surface.erase.stroke'],
          ['Precision Eraser', 'surface.erase.precision'],
        ] as const
      ).map(([label, semanticRole], index) => ({
        kind: 'button',
        id: `${prefix}.tool.eraser.${['stroke', 'precision'][index]}`,
        group: 'draw',
        label,
        semanticRole,
      }));
    for (const [kindId, kind] of [
      ['froglight.ink', 'ink'],
      ['froglight.notebook', 'notebook'],
      ['froglight.whiteboard', 'whiteboard'],
    ] as const) {
      const controls = [...familyControls(kind), ...eraserTools(kind)];
      for (const projection of ['normal', 'compact', 'squeeze'] as const) {
        const graph = resolveToolbarComposition({
          snapshot: defaultToolbarComposition(),
          kindId,
          controls,
          projection,
        });
        expect(graph.diagnostics).toEqual([]);
        const erase = graph.categories.find(
          (entry) => entry.id === 'surface.erase',
        );
        expect(erase?.items.map((item) => item.semanticRole)).toEqual([
          'surface.erase',
          'surface.erase.stroke',
          'surface.erase.precision',
        ]);
        expect(erase?.items.map((item) => item.id)).toEqual([
          'surface.erase.tool',
          'surface.erase.stroke',
          'surface.erase.precision',
        ]);
      }
      // Dormancy stays per-tool: without the mode controls only the legacy
      // tool resolves and the mode ids report unresolved.
      const legacy = resolveFor(kindId, familyControls(kind));
      expect(legacy.diagnostics).toEqual([]);
      expect(
        legacy.categories
          .find((entry) => entry.id === 'surface.erase')
          ?.items.map((item) => item.semanticRole),
      ).toEqual(['surface.erase']);
      expect(legacy.unresolved).toEqual(
        expect.arrayContaining([
          'surface.erase.stroke',
          'surface.erase.precision',
        ]),
      );
    }
  });

  it('resolves grouped surface text identically for Ink/Notebook/Whiteboard', () => {
    const state = {
      hasText: true as const,
      style: 'h1' as const,
      size: 24 as const,
      bold: { active: true, mixed: false },
      italic: { active: false, mixed: false },
      align: 'center' as const,
      color: '#37352f' as const,
      wrap: { active: false, mixed: false },
    };
    // Text creation is a direct tool; formatting projects contextually.
    const expectedRoles = ['surface.insert.text'];
    // Same labels/icons/roles/order across dialects `ink.tool.*` /
    // `notebook.tool.*` / `whiteboard.tool.*` (family parity); the
    // squeeze/selection projections consume the same graph.
    for (const [kindId, kind] of [
      ['froglight.ink', 'ink'],
      ['froglight.notebook', 'notebook'],
      ['froglight.whiteboard', 'whiteboard'],
    ] as const) {
      const textControls = buildSurfaceTextControls(
        surfaceTextControlIds(kind),
        state,
      );
      const graph = resolveFor(kindId, [
        ...familyControls(kind),
        ...textControls,
      ]);
      expect(graph.diagnostics).toEqual([]);
      const text = graph.categories.find(
        (entry) => entry.id === 'surface.text',
      );
      expect(text?.label).toBe('Text');
      expect(text?.items.map((item) => item.semanticRole)).toEqual(
        expectedRoles,
      );
      // Creation vs style stay distinct by exact semanticRole (never label
      // / toolRole / group / id-substring / icon): creation is group
      // `draw` + toolRole `text`, style is group `text`.
      const creation = text?.items.find(
        (item) => item.id === 'surface.text.create',
      );
      expect(creation?.semanticRole).toBe('surface.insert.text');
      expect(creation?.control.group).toBe('draw');
      expect(
        (creation?.control as unknown as { toolRole?: string }).toolRole,
      ).toBe('text');
      // Squeeze secondary tier: the same roles resolve in the squeeze
      // projection for every family once emitted.
      const squeeze = resolveToolbarComposition({
        snapshot: defaultToolbarComposition(),
        kindId,
        controls: [...familyControls(kind), ...textControls],
        projection: 'squeeze',
      });
      expect(
        squeeze.categories
          .find((entry) => entry.id === 'surface.text')
          ?.items.map((item) => item.semanticRole),
      ).toEqual(expectedRoles);
    }
    // Dormant style without text: no family emits the style
    // roles, so the seven style items stay unresolved (never synthesized)
    // while the Text category stays LIVE with creation only — the direct
    // strip button with zero selection. Dormancy must NEVER hide creation.
    for (const [kindId, kind] of [
      ['froglight.ink', 'ink'],
      ['froglight.notebook', 'notebook'],
      ['froglight.whiteboard', 'whiteboard'],
    ] as const) {
      const graph = resolveFor(kindId, familyControls(kind));
      expect(graph.diagnostics).toEqual([]);
      const text = graph.categories.find(
        (entry) => entry.id === 'surface.text',
      );
      expect(text?.label).toBe('Text');
      expect(text?.items.map((item) => item.semanticRole)).toEqual([
        'surface.insert.text',
      ]);
      expect(text?.items.map((item) => item.id)).toEqual([
        'surface.text.create',
      ]);
      expect(
        graph.unresolved.some((id) => id.startsWith('surface.text.')),
      ).toBe(false);
      // The creation alias itself always resolves — never dormant.
      expect(graph.unresolved).not.toContain('surface.text.create');
    }
  });

  it('keeps Insert creation-free with zero text controls', () => {
    // Creation (provider group `draw`, toolRole `text`,
    // `surface.insert.text`) resolves ONLY as the direct `surface.text`
    // strip button (item `surface.text.create`) — never from
    // `surface.insert`. The
    // Insert shelf carries image (+ card/PDF per family) while the style
    // group (provider group `text`, roles `surface.text.*`) stays dormant
    // via omission. Dormancy must NEVER hide the creation tool: never
    // conflate on label `Text`, toolRole `text`, group `text`, id
    // substring `.text`, or icon `type`.
    for (const [kindId, kind] of [
      ['froglight.ink', 'ink'],
      ['froglight.notebook', 'notebook'],
      ['froglight.whiteboard', 'whiteboard'],
    ] as const) {
      const graph = resolveFor(kindId, familyControls(kind));
      expect(graph.diagnostics).toEqual([]);
      const insert = graph.categories.find(
        (entry) => entry.id === 'surface.insert',
      );
      expect(insert?.label).toBe('Insert');
      // Insert never presents creation — no item carries the
      // creation role here.
      expect(
        insert?.items.some(
          (item) => item.semanticRole === 'surface.insert.text',
        ),
      ).toBe(false);
      // direct strip button (single presenter): the
      // `surface.text` category is LIVE with zero selection, presenting
      // the creation control (draw group + text coarse role) as its
      // leading item.
      const text = graph.categories.find(
        (entry) => entry.id === 'surface.text',
      );
      expect(text?.label).toBe('Text');
      expect(text?.items.map((item) => item.semanticRole)).toEqual([
        'surface.insert.text',
      ]);
      expect(text?.items.map((item) => item.id)).toEqual([
        'surface.text.create',
      ]);
      const direct = text?.items[0];
      expect(direct?.control.group).toBe('draw');
      expect(
        (direct?.control as unknown as { toolRole?: string }).toolRole,
      ).toBe('text');
      expect(
        graph.unresolved.some((id) => id.startsWith('surface.text.')),
      ).toBe(false);
      // Squeeze secondary tier presents creation ONLY in `surface.text`:
      // Insert must never present `surface.insert.text` again.
      const squeeze = resolveToolbarComposition({
        snapshot: defaultToolbarComposition(),
        kindId,
        controls: familyControls(kind),
        projection: 'squeeze',
      });
      expect(
        squeeze.categories
          .find((entry) => entry.id === 'surface.insert')
          ?.items.map((item) => item.semanticRole),
      ).not.toContain('surface.insert.text');
      expect(
        squeeze.categories
          .find((entry) => entry.id === 'surface.text')
          ?.items.map((item) => item.semanticRole),
      ).toEqual(['surface.insert.text']);
    }
    // Whiteboard canary: `whiteboard.tool.text` creation (group `draw`)
    // stays distinct from `whiteboard.text.*` style (group `text`), and
    // `froglight.card` text stays distinct from `froglight.text`.
    const whiteboard = resolveFor(
      'froglight.whiteboard',
      familyControls('whiteboard'),
    );
    expect(
      whiteboard.categories
        .find((entry) => entry.id === 'surface.insert')
        ?.items.map((item) => item.semanticRole),
    ).toEqual(['surface.insert.image', 'surface.insert.card']);
  });

  it('keeps Notebook Pages out of every toolbar graph', () => {
    const notebook = resolveFor(
      'froglight.notebook',
      familyControls('notebook'),
    );
    const pages = notebook.categories.find(
      (entry) => entry.id === 'notebook.pages',
    );
    expect(pages).toBeUndefined();
    expect(
      resolveFor('froglight.ink', familyControls('ink')).categories.some(
        (entry) => entry.id === 'notebook.pages',
      ),
    ).toBe(false);
    expect(
      resolveFor(
        'froglight.whiteboard',
        familyControls('whiteboard'),
      ).categories.some((entry) => entry.id === 'notebook.pages'),
    ).toBe(false);
  });

  it('shares the family palette and widths with provider style controls', () => {
    // The composition shelf and the provider style islands read the same
    // shared constants — no per-family palette drift is representable.
    expect([...SURFACE_SHARED_SWATCHES]).toEqual([
      '#37352f',
      '#7c6cf0',
      '#c4554d',
      '#448361',
      '#a08430',
    ]);
    expect([...SURFACE_SHARED_WIDTHS]).toEqual([2, 3.5, 6]);
  });
});

/**
 * Tests for additive grouping and slot metadata.
 *
 * `groupId`/`slotId` add structure only: no id
 * is renamed, repurposed, or removed, and graphs without the metadata
 * resolve identically. These tests pin the grouping/slot contract —
 * strip-group buckets per family, fixed slot families with null-pad/
 * overflow behavior, verbatim order, unresolved-clean matrices per
 * document kind, the blockpage one-path, the markdown strike omit, PDF
 * label-only stability, overlay re-sort order, and hidden semantics.
 */
describe('default-composition grouping additions', () => {
  it('declares a non-blank groupId on every category (never blank)', () => {
    const all = [
      ...DEFAULT_TOOLBAR_CATEGORIES,
      ...DEFAULT_TOOLBAR_KIND_EXTENSIONS.flatMap(
        (entry) => entry.categories ?? [],
      ),
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const category of all) {
      expect(
        category.groupId !== undefined && category.groupId.trim() !== '',
        `${category.id} must declare a non-blank groupId`,
      ).toBe(true);
    }
    // Pinned strip-group map: surface merges shapes+insert into one Insert
    // group (Pen/Highlighter/Eraser/Select/Insert/Present); every other
    // category is a singleton group keyed by its category id.
    expect(
      Object.fromEntries(all.map((entry) => [entry.id, entry.groupId])),
    ).toEqual({
      'surface.write': 'surface.write',
      'surface.highlighter': 'surface.highlighter',
      'surface.erase': 'surface.erase',
      'surface.select': 'surface.select',
      'surface.shapes': 'surface.shapes',
      'surface.insert': 'surface.insert',
      'surface.text': 'surface.text',
      'writing.style': 'writing.style',
      'writing.insert': 'writing.insert',
      'writing.structure': 'writing.structure',
      'pdf.pages': 'pdf.pages',
      'pdf.select': 'pdf.select',
      'pdf.annotate': 'pdf.annotate',
      'latex.math': 'latex.math',
      'latex.references': 'latex.references',
    });
  });

  it('keeps Canvas out of the content toolbar', () => {
    const graph = resolveFor('froglight.ink', familyControls('ink'));
    expect(graph.diagnostics).toEqual([]);
    const buckets = groupCategoriesByStripGroup(graph.categories);
    expect([...buckets.keys()]).toEqual([
      'surface.select',
      'surface.write',
      'surface.highlighter',
      'surface.erase',
      'surface.shapes',
      'surface.insert',
      'surface.text',
    ]);
    // Shapes and Insert have independent primary entries.
    expect(buckets.get('surface.insert')?.map((entry) => entry.id)).toEqual([
      'surface.insert',
    ]);
    expect(buckets.get('surface.shapes')?.map((entry) => entry.id)).toEqual([
      'surface.shapes',
    ]);
    // Effective strip-group ids agree with the shared fallback rule —
    // consumers must use the helper, never guess.
    for (const category of graph.categories) {
      expect(stripGroupIdForCategory(category)).toBe(category.groupId);
    }
  });

  it('assigns slotIds to exactly the pen/size/color conduits', () => {
    const slotted = new Map(
      [...DEFAULT_TOOLBAR_ITEMS].flatMap((entry) =>
        entry.slotId !== undefined ? [[entry.id, entry.slotId] as const] : [],
      ),
    );
    // Four pen slots (exactly the `toolRole: 'pen'` conduits) + one color
    // conduit + two size conduits. Highlighter stays unslotted (fifth in
    // verbatim Write order → More overflow); squeeze settings fallbacks
    // stay unslotted verbatim so slot orders key on primaries only.
    expect(Object.fromEntries(slotted)).toEqual({
      'surface.write.ball': 'surface.slot.pen.ball',
      'surface.write.fountain': 'surface.slot.pen.fountain',
      'surface.write.brush': 'surface.slot.pen.brush',
      'surface.write.pencil': 'surface.slot.pen.pencil',
      'surface.write.color': 'surface.slot.color.pen',
      'surface.write.width': 'surface.slot.size.width',
      'surface.erase.size': 'surface.slot.size.eraser',
    });
    for (const slotId of slotted.values()) {
      expect(slotId.trim() !== '', `blank slotId`).toBe(true);
    }
  });

  it('keeps effective shelf slot ids unique and disjoint from item ids', () => {
    // residual: effective slot ids double as React keys per shelf,
    // so they must be distinct per item and never collide with the item-id
    // key domain (unslotted items key by item id).
    const allItems = [
      ...DEFAULT_TOOLBAR_ITEMS,
      ...DEFAULT_TOOLBAR_KIND_EXTENSIONS.flatMap((entry) => entry.items ?? []),
    ];
    const effective = allItems.map((entry) => slotIdForItem(entry));
    expect(new Set(effective).size).toBe(allItems.length);
    const itemIds = new Set(allItems.map((entry) => entry.id));
    for (const entry of allItems) {
      if (entry.slotId !== undefined) {
        expect(
          itemIds.has(entry.slotId),
          `slotId ${entry.slotId} collides with an item id`,
        ).toBe(false);
      }
    }
    // Per-shelf (per-category) distinctness: no shelf repeats a key.
    const byCategory = new Map<string, string[]>();
    for (const entry of allItems) {
      const list = byCategory.get(entry.categoryId) ?? [];
      list.push(slotIdForItem(entry));
      byCategory.set(entry.categoryId, list);
    }
    for (const [categoryId, keys] of byCategory) {
      expect(new Set(keys).size, `duplicate shelf key in ${categoryId}`).toBe(
        keys.length,
      );
    }
  });

  it('passes groupId/slotId through resolution in verbatim order', () => {
    const graph = resolveFor('froglight.ink', familyControls('ink'));
    expect(graph.diagnostics).toEqual([]);
    const write = graph.categories.find(
      (entry) => entry.id === 'surface.write',
    );
    expect(write?.groupId).toBe('surface.write');
    // Slotted pens resolve with slot identity intact, in verbatim
    // composition order; Highlighter has its own primary category.
    expect(write?.items.map((item) => item.id)).toEqual([
      'surface.write.ball',
      'surface.write.fountain',
      'surface.write.brush',
      'surface.write.pencil',
    ]);
    expect(write?.items.map((item) => item.slotId ?? null)).toEqual([
      'surface.slot.pen.ball',
      'surface.slot.pen.fountain',
      'surface.slot.pen.brush',
      'surface.slot.pen.pencil',
    ]);
    // Squeeze-only conduits stay out of the normal projection (dormancy
    // authority is the graph, not the metadata): no slot implies no
    // synthesis, and their absence changes nothing about the strip.
    expect(
      graph.categories
        .flatMap((category) => category.items)
        .some((item) => item.slotId?.startsWith('surface.slot.size.') === true),
    ).toBe(false);
    const squeeze = resolveToolbarComposition({
      snapshot: defaultToolbarComposition(),
      kindId: 'froglight.ink',
      controls: familyControls('ink'),
      projection: 'squeeze',
    });
    // No style controls emitted → squeeze conduits stay dormant, never
    // synthesized; metadata never revives a missing control.
    expect(squeeze.unresolved).toEqual(
      expect.arrayContaining([
        'surface.write.color',
        'surface.write.width',
        'surface.erase.size',
      ]),
    );
  });

  it('keeps unresolved-clean matrices per family (grouping changes nothing)', () => {
    // Exact sorted pins: grouping/slot metadata must not resolve, hide, or
    // synthesize a single item. Any added/removed/renamed id fails loudly
    // here (add-only). Cross-family items stay dormant via omission —
    // the resolver omits empty categories so no empty shelf ever renders.
    const sortedUnresolved = (
      kindId: string,
      controls: readonly DocumentToolControl[],
    ) =>
      [
        ...resolveToolbarComposition({
          snapshot: defaultToolbarComposition(),
          kindId,
          controls,
        }).unresolved,
      ].sort();
    const surfaceDormant = [
      'pdf.annotate.notebook',
      'pdf.pages.next',
      'pdf.pages.previous',
      'pdf.select.source',
      'surface.erase.precision',
      'surface.erase.stroke',
      'writing.format.bold',
      'writing.format.code',
      'writing.format.italic',
      'writing.format.strike',
      // selection contracts: dormant here via missing
      // category (surface kinds resolve no writing.* category), never
      // synthesized; writing kinds skip them silently by projection.
      'writing.insert.audio',
      'writing.insert.code-block',
      'writing.insert.diagram',
      'writing.insert.diagram.retry',
      'writing.insert.diagram.source',
      'writing.insert.file',
      'writing.insert.image',
      'writing.insert.link',
      'writing.insert.math',
      'writing.insert.math.retry',
      'writing.insert.math.source',
      'writing.insert.media.alt',
      'writing.insert.media.caption',
      'writing.insert.media.clear-remote',
      'writing.insert.media.name',
      'writing.insert.media.remote-url',
      'writing.insert.media.replace',
      'writing.insert.media.retry',
      'writing.insert.table',
      'writing.insert.video',
      'writing.structure.table.add-column',
      'writing.structure.table.add-row',
      'writing.structure.table.move-column-left',
      'writing.structure.table.move-column-right',
      'writing.structure.table.move-row-down',
      'writing.structure.table.move-row-up',
      'writing.structure.table.remove-column',
      'writing.structure.table.remove-row',
      'writing.structure.table.toggle-header',
      'writing.style.block',
    ];
    expect(sortedUnresolved('froglight.ink', familyControls('ink'))).toEqual(
      surfaceDormant,
    );
    expect(
      sortedUnresolved('froglight.notebook', familyControls('notebook')),
    ).toEqual([
      'notebook.insert.pdf.after',
      'notebook.insert.pdf.before',
      ...surfaceDormant,
    ]);
    expect(
      sortedUnresolved('froglight.whiteboard', familyControls('whiteboard')),
    ).toEqual(surfaceDormant);
    const surfacePdfHead = [
      'pdf.annotate.notebook',
      'pdf.pages.next',
      'pdf.pages.previous',
      'pdf.select.source',
      'surface.erase.precision',
      'surface.erase.settings-size',
      'surface.erase.size',
      'surface.erase.stroke',
      'surface.erase.tool',
      'surface.insert.image',
      'surface.select.lasso',
      'surface.select.object',
      'surface.shapes.ellipse',
      'surface.shapes.line',
      'surface.shapes.rectangle',
      'surface.text.create',
      'surface.write.ball',
      'surface.write.brush',
      'surface.write.color',
      'surface.write.fountain',
      'surface.write.highlighter',
      'surface.write.pencil',
      'surface.write.saved-style',
      'surface.write.settings-color',
      'surface.write.settings-size',
      'surface.write.width',
    ];
    expect(
      sortedUnresolved('froglight.markdown', writingControls('markdown')),
    ).toEqual([
      'markdown.insert.divider',
      'markdown.style.bullet',
      'markdown.style.numbered',
      'markdown.style.quote',
      'markdown.style.task',
      ...surfacePdfHead,
      'writing.format.strike',
      // repair (amendment): creation is shelf-only
      // (`normal`/`compact`), so with no insert controls emitted these 8
      // stay dormant here via omission, never synthesized.
      'writing.insert.audio',
      'writing.insert.diagram',
      'writing.insert.embed',
      'writing.insert.file',
      'writing.insert.image',
      'writing.insert.import-image',
      'writing.insert.markdown-table',
      'writing.insert.math',
      'writing.insert.note-link',
      'writing.insert.table',
      'writing.insert.video',
    ]);
    // Blockpage one-path (repair): the dormant writing
    // items are the shared code-block (no control emitted) plus the 8
    // shelf-only creation ids (no insert controls emitted here) — no
    // blockpage-only contextual items exist in composition, so creation
    // rides the shared shelf and selection edits stay provider-local.
    expect(
      sortedUnresolved('froglight.blockpage', writingControls('blockpage')),
    ).toEqual([
      ...surfacePdfHead,
      'writing.insert.audio',
      'writing.insert.code-block',
      'writing.insert.diagram',
      'writing.insert.file',
      'writing.insert.image',
      'writing.insert.math',
      'writing.insert.table',
      'writing.insert.video',
    ]);
    expect(
      sortedUnresolved('froglight.latex', writingControls('latex')),
    ).toEqual([
      'latex.insert.enumerate',
      'latex.insert.itemize',
      'latex.insert.quote',
      ...surfacePdfHead,
      'writing.format.code',
      'writing.format.strike',
      'writing.insert.audio',
      'writing.insert.code-block',
      'writing.insert.diagram',
      'writing.insert.file',
      'writing.insert.image',
      'writing.insert.link',
      'writing.insert.math',
      'writing.insert.table',
      'writing.insert.video',
    ]);
    expect(sortedUnresolved('froglight.pdf', pdfControls())).toEqual([
      'surface.erase.precision',
      'surface.erase.settings-size',
      'surface.erase.size',
      'surface.erase.stroke',
      'surface.erase.tool',
      'surface.insert.image',
      'surface.select.lasso',
      'surface.select.object',
      'surface.shapes.ellipse',
      'surface.shapes.line',
      'surface.shapes.rectangle',
      'surface.text.create',
      'surface.write.ball',
      'surface.write.brush',
      'surface.write.color',
      'surface.write.fountain',
      'surface.write.highlighter',
      'surface.write.pencil',
      'surface.write.saved-style',
      'surface.write.settings-color',
      'surface.write.settings-size',
      'surface.write.width',
      'writing.format.bold',
      'writing.format.code',
      'writing.format.italic',
      'writing.format.strike',
      // selection contracts: dormant here via missing
      // category (PDF resolves no writing.* category), never synthesized.
      'writing.insert.audio',
      'writing.insert.code-block',
      'writing.insert.diagram',
      'writing.insert.diagram.retry',
      'writing.insert.diagram.source',
      'writing.insert.file',
      'writing.insert.image',
      'writing.insert.link',
      'writing.insert.math',
      'writing.insert.math.retry',
      'writing.insert.math.source',
      'writing.insert.media.alt',
      'writing.insert.media.caption',
      'writing.insert.media.clear-remote',
      'writing.insert.media.name',
      'writing.insert.media.remote-url',
      'writing.insert.media.replace',
      'writing.insert.media.retry',
      'writing.insert.table',
      'writing.insert.video',
      'writing.structure.table.add-column',
      'writing.structure.table.add-row',
      'writing.structure.table.move-column-left',
      'writing.structure.table.move-column-right',
      'writing.structure.table.move-row-down',
      'writing.structure.table.move-row-up',
      'writing.structure.table.remove-column',
      'writing.structure.table.remove-row',
      'writing.structure.table.toggle-header',
      'writing.style.block',
    ]);
  });

  it('keeps the single Text presenter in its own Present group', () => {
    // The retired dual presenter decayed to a single
    // presenter: one provider control behind `surface.text.create` in the
    // Text strip group only, with zero diagnostics — grouping never
    // triggers the duplicate-presenter rule.
    const graph = resolveFor('froglight.ink', familyControls('ink'));
    expect(graph.diagnostics).toEqual([]);
    const insert = graph.categories.find(
      (entry) => entry.id === 'surface.insert',
    );
    const text = graph.categories.find((entry) => entry.id === 'surface.text');
    expect(insert?.groupId).toBe('surface.insert');
    expect(text?.groupId).toBe('surface.text');
    // No Insert item carries the creation role anymore.
    expect(
      insert?.items.some((item) => item.semanticRole === 'surface.insert.text'),
    ).toBe(false);
    const viaText = text?.items.find(
      (item) => item.id === 'surface.text.create',
    );
    expect(viaText?.control.semanticRole).toBe('surface.insert.text');
    expect(viaText?.slotId).toBeUndefined();
  });

  it('omits markdown strike without a markdown strike item', () => {
    // The ledger decision: markdown cannot compute strike honestly, so no
    // markdown strike item is emitted and the shared strike stays dormant.
    const markdown = DEFAULT_TOOLBAR_KIND_EXTENSIONS.find(
      (entry) => entry.id === 'writing.markdown',
    );
    expect(markdown?.items?.map((item) => item.id) ?? []).toEqual([
      'markdown.style.quote',
      'markdown.style.bullet',
      'markdown.style.numbered',
      'markdown.style.task',
      'writing.insert.note-link',
      'writing.insert.embed',
      'writing.insert.import-image',
      'writing.insert.markdown-table',
      'markdown.insert.divider',
    ]);
    const graph = resolveToolbarComposition({
      snapshot: defaultToolbarComposition(),
      kindId: 'froglight.markdown',
      controls: writingControls('markdown'),
    });
    expect(graph.diagnostics).toEqual([]);
    expect(graph.unresolved).toContain('writing.format.strike');
    expect(
      graph.categories.some((category) =>
        category.items.some((item) => item.semanticRole === 'writing.strike'),
      ),
    ).toBe(false);
  });

  it('keeps blockpage creation on the shared shelf with no selection duplicates', () => {
    // No blockpage-only semantic roles exist anywhere in composition, and
    // no selection-float category exists: creation rides `writing.insert`/
    // `writing.structure`, selection edits stay provider-local.
    const roles = new Set([
      ...DEFAULT_TOOLBAR_ITEMS.map((entry) => entry.semanticRole),
      ...DEFAULT_TOOLBAR_KIND_EXTENSIONS.flatMap((entry) => [
        ...(entry.items ?? []).map((item) => item.semanticRole),
      ]),
    ]);
    for (const role of roles) {
      expect(role.startsWith('blockpage.'), `blockpage role ${role}`).toBe(
        false,
      );
    }
    const categoryIds = [
      ...DEFAULT_TOOLBAR_CATEGORIES.map((entry) => entry.id),
      ...DEFAULT_TOOLBAR_KIND_EXTENSIONS.flatMap((entry) => [
        ...(entry.categories ?? []).map((category) => category.id),
      ]),
    ];
    expect(categoryIds.filter((id) => id.includes('selection'))).toEqual([]);
    const graph = resolveToolbarComposition({
      snapshot: defaultToolbarComposition(),
      kindId: 'froglight.blockpage',
      controls: writingControls('blockpage'),
    });
    expect(graph.diagnostics).toEqual([]);
    expect(graph.categories.map((entry) => entry.id)).toEqual([
      'writing.style',
      'writing.insert',
    ]);
  });

  it('keeps PDF identifiers stable with labels pinned', () => {
    // Label-only unification: ids never rename (customization stability);
    // any vocabulary convergence is display-label mapping elsewhere.
    expect(
      DEFAULT_TOOLBAR_CATEGORIES.filter((entry) => entry.familyId === 'pdf'),
    ).toEqual([
      {
        id: 'pdf.pages',
        familyId: 'pdf',
        groupId: 'pdf.pages',
        label: 'Pages',
        icon: 'pages',
        order: 10,
        priority: 100,
      },
      {
        id: 'pdf.select',
        familyId: 'pdf',
        groupId: 'pdf.select',
        label: 'Select',
        icon: 'cursor',
        order: 20,
        priority: 80,
      },
      {
        id: 'pdf.annotate',
        familyId: 'pdf',
        groupId: 'pdf.annotate',
        label: 'Annotate',
        icon: 'ink',
        order: 30,
        priority: 70,
      },
    ]);
    expect(
      DEFAULT_TOOLBAR_ITEMS.filter((entry) => entry.id.startsWith('pdf.')).map(
        (entry) => entry.id,
      ),
    ).toEqual([
      'pdf.pages.previous',
      'pdf.pages.next',
      'pdf.select.source',
      'pdf.annotate.notebook',
    ]);
  });

  it('re-sorts overrides after constraints over grouped/slotted defaults', () => {
    // Ordering authority is unchanged: registry `order`/`priority`/
    // `before`/`after` resolve first; user-order and slot-order overlays
    // only re-sort after, with grouping/slot metadata riding along.
    const controls = familyControls('ink');
    const reordered = resolveToolbarComposition({
      snapshot: defaultToolbarComposition(),
      kindId: 'froglight.ink',
      controls,
      overrides: {
        categoryOrder: ['surface.text', 'surface.write'],
        itemOrder: {
          'surface.write': ['surface.write.pencil', 'surface.write.ball'],
        },
      },
    });
    expect(reordered.diagnostics).toEqual([]);
    expect(reordered.categories.map((entry) => entry.id)).toEqual([
      'surface.text',
      'surface.write',
      'surface.select',
      'surface.highlighter',
      'surface.erase',
      'surface.shapes',
      'surface.insert',
    ]);
    // Group buckets follow the overridden category order verbatim.
    expect([
      ...groupCategoriesByStripGroup(reordered.categories).keys(),
    ]).toEqual([
      'surface.text',
      'surface.write',
      'surface.select',
      'surface.highlighter',
      'surface.erase',
      'surface.shapes',
      'surface.insert',
    ]);
    // Item override re-sorts; unlisted pens keep registry order after, and
    // slot identities ride with their items.
    expect(
      reordered.categories
        .find((entry) => entry.id === 'surface.write')
        ?.items.map((item) => `${item.id}=${item.slotId ?? ''}`),
    ).toEqual([
      'surface.write.pencil=surface.slot.pen.pencil',
      'surface.write.ball=surface.slot.pen.ball',
      'surface.write.fountain=surface.slot.pen.fountain',
      'surface.write.brush=surface.slot.pen.brush',
    ]);
    // slot-order overlay re-sorts effective slot ids (slotIds
    // double as customization keys); unknown ids never match.
    const writeItems =
      resolveFor('froglight.ink', controls).categories.find(
        (entry) => entry.id === 'surface.write',
      )?.items ?? [];
    expect(
      applySlotOrder(writeItems, [
        'surface.slot.pen.brush',
        'surface.slot.pen.ball',
        'unknown-slot-id',
      ]).map((item) => item.id),
    ).toEqual([
      'surface.write.brush',
      'surface.write.ball',
      'surface.write.fountain',
      'surface.write.pencil',
    ]);
  });

  it('hides the single Text presenter by item id (dual-hide contract)', () => {
    // Hidden semantics hold per projection: the retired Insert presenter
    // id stays unknown-ignored, hiding the live `surface.text.create`
    // removes creation everywhere (single presenter), and hidden items
    // stay out of `unresolved` (deliberate, not missing).
    const controls = familyControls('ink');
    const hideRetired = resolveToolbarComposition({
      snapshot: defaultToolbarComposition(),
      kindId: 'froglight.ink',
      controls,
      overrides: { hiddenItems: ['surface.insert.text'] },
    });
    // Retired id is unknown: ignored, creation still live via Text.
    expect(hideRetired.diagnostics).toEqual([]);
    expect(
      hideRetired.categories
        .find((entry) => entry.id === 'surface.text')
        ?.items.map((item) => item.id),
    ).toEqual(['surface.text.create']);
    const hideCreate = resolveToolbarComposition({
      snapshot: defaultToolbarComposition(),
      kindId: 'froglight.ink',
      controls,
      overrides: { hiddenItems: ['surface.text.create'] },
    });
    expect(hideCreate.diagnostics).toEqual([]);
    // Insert never presents the creation control.
    expect(
      hideCreate.categories
        .find((entry) => entry.id === 'surface.insert')
        ?.items.map((item) => item.semanticRole),
    ).not.toContain('surface.insert.text');
    expect(
      hideCreate.categories.some((entry) => entry.id === 'surface.text'),
    ).toBe(false);
    expect(hideCreate.unresolved).not.toContain('surface.text.create');
    const hideCategory = resolveToolbarComposition({
      snapshot: defaultToolbarComposition(),
      kindId: 'froglight.ink',
      controls,
      overrides: { hiddenCategories: ['surface.text'] },
    });
    expect(
      hideCategory.categories
        .find((entry) => entry.id === 'surface.insert')
        ?.items.map((item) => item.semanticRole),
    ).not.toContain('surface.insert.text');
    expect(hideCategory.unresolved).not.toContain('surface.text.create');
  });
});

/** Portable writing doubles mirroring each provider's snapshot (see writing-family-consistency.spec.ts). */
function writingControls(
  family: 'markdown' | 'blockpage' | 'latex',
): DocumentToolControl[] {
  const styleChoice = (id: string, value: string): DocumentToolControl => ({
    kind: 'choice',
    id,
    group: 'block',
    label: 'Style',
    semanticRole: 'writing.style',
    value,
    options: [{ value: 'paragraph', label: 'Paragraph' }],
  });
  if (family === 'markdown') {
    return [
      styleChoice('markdown.block', 'paragraph'),
      writingFormatToggleControl('markdown.bold', 'bold', { active: true }),
      writingFormatToggleControl('markdown.italic', 'italic', { mixed: true }),
      writingFormatToggleControl('markdown.code', 'code', { disabled: true }),
      writingLinkControl('markdown.link', {
        value: 'https://froglight.test',
        active: true,
      }),
      writingCodeBlockControl('markdown.code-block', {}),
    ];
  }
  if (family === 'blockpage') {
    return [
      styleChoice('block.type', 'paragraph'),
      writingFormatToggleControl('block.bold', 'bold', { active: true }),
      writingFormatToggleControl('block.italic', 'italic', { mixed: true }),
      writingFormatToggleControl('block.strike', 'strike', {}),
      writingFormatToggleControl('block.code', 'code', { disabled: true }),
      writingLinkControl('block.link', {
        value: 'https://froglight.test',
        active: true,
      }),
    ];
  }
  return [
    {
      kind: 'choice',
      id: 'latex.structure',
      group: 'structure',
      label: 'Structure',
      semanticRole: 'writing.style',
      value: '',
      options: [{ value: '', label: 'Structure…' }],
    } as DocumentToolControl,
    writingFormatToggleControl('latex.bold', 'bold', {}),
    writingFormatToggleControl(
      'latex.emphasis',
      'italic',
      {},
      { label: 'Emphasis' },
    ),
    {
      kind: 'button',
      id: 'latex.inline-math',
      group: 'math',
      label: 'Inline math',
      shortLabel: '$x$',
      semanticRole: 'latex.math.inline',
    },
    {
      kind: 'button',
      id: 'latex.display-math',
      group: 'math',
      label: 'Display math',
      shortLabel: '\\[x\\]',
      semanticRole: 'latex.math.display',
    },
    {
      kind: 'choice',
      id: 'latex.environment',
      group: 'insert',
      label: 'Environment',
      value: '',
      options: [{ value: '', label: 'Environment…' }],
      semanticRole: 'latex.environment',
    },
    {
      kind: 'input',
      id: 'latex.label',
      group: 'references',
      label: 'Label name',
      placeholder: 'label-key',
      actionLabel: 'Label',
      semanticRole: 'latex.reference.label',
    },
    {
      kind: 'input',
      id: 'latex.ref',
      group: 'references',
      label: 'Reference label',
      placeholder: 'label-key',
      actionLabel: 'Ref',
      semanticRole: 'latex.reference.ref',
    },
    {
      kind: 'input',
      id: 'latex.cite',
      group: 'references',
      label: 'Citation key',
      placeholder: 'citation-key',
      actionLabel: 'Cite',
      semanticRole: 'latex.reference.cite',
    },
  ];
}

/** Standalone PDF doubles mirroring the provider snapshot (see writing-family-consistency.spec.ts). */
function pdfControls(): DocumentToolControl[] {
  return [
    {
      kind: 'button',
      id: 'pdf.previous',
      group: 'pages',
      label: 'Previous PDF page',
      shortLabel: 'Previous',
      icon: 'arrow-back',
      semanticRole: 'pdf.page.previous',
    },
    {
      kind: 'button',
      id: 'pdf.next',
      group: 'pages',
      label: 'Next PDF page',
      shortLabel: 'Next',
      icon: 'arrow-forward',
      semanticRole: 'pdf.page.next',
    },
    {
      kind: 'button',
      id: 'pdf.source-select',
      group: 'interaction',
      label: 'Select and copy source text',
      shortLabel: 'Source Select',
      icon: 'cursor',
      semanticRole: 'pdf.select.source',
      activationRole: 'toggle',
      active: true,
    },
    {
      kind: 'button',
      id: 'pdf.import-notebook',
      group: 'document',
      label: 'Annotate / Import as Notebook',
      shortLabel: 'Annotate',
      icon: 'notebook',
      semanticRole: 'pdf.annotate.notebook',
    },
  ];
}

/**
 *  stable order pin (verbatim order).
 *
 * Selecting ANY tool must never change primary nor secondary order: the
 * resolved composition sequence is the sole ordering authority and the
 * active tool is marked in place, never moved first. Every assertion below
 * fails loudly under a reorder-to-first (active-to-head) implementation.
 */
describe('stable primary/secondary order (no reorder-to-first)', () => {
  type SqueezeButton = Extract<DocumentToolControl, { kind: 'button' }>;
  const squeezeEntry = (
    id: string,
    controlId: string,
    extra: Partial<SqueezeButton> = {},
  ): GroupedSqueezeEntry => ({
    id,
    control: {
      kind: 'button',
      id: controlId,
      group: 'draw',
      label: id,
      ...extra,
    },
  });

  /** Realistic Surface squeeze order: the ordering authority.*/
  function surfaceEntries(): GroupedSqueezeEntry[] {
    const defs: Array<[string, string, Partial<SqueezeButton>]> = [
      [
        'pen.ball',
        'ink.tool.pen.ball',
        { toolRole: 'pen', semanticRole: 'surface.pen.ball' },
      ],
      [
        'pen.fountain',
        'ink.tool.pen.fountain',
        { toolRole: 'pen', semanticRole: 'surface.pen.fountain' },
      ],
      [
        'pen.brush',
        'ink.tool.pen.brush',
        { toolRole: 'pen', semanticRole: 'surface.pen.brush' },
      ],
      [
        'pen.pencil',
        'ink.tool.pen.pencil',
        { toolRole: 'pen', semanticRole: 'surface.pencil' },
      ],
      [
        'highlighter',
        'ink.tool.highlighter',
        { toolRole: 'highlighter', semanticRole: 'surface.highlighter' },
      ],
      [
        'eraser',
        'ink.tool.eraser',
        { toolRole: 'eraser', semanticRole: 'surface.erase' },
      ],
      [
        'select',
        'ink.tool.select',
        { toolRole: 'select', semanticRole: 'surface.select' },
      ],
      [
        'lasso',
        'ink.tool.lasso',
        { toolRole: 'lasso', semanticRole: 'surface.lasso' },
      ],
      [
        'shape.line',
        'ink.tool.shape.line',
        { toolRole: 'shape', semanticRole: 'surface.shape.line' },
      ],
      [
        'shape.rect',
        'ink.tool.shape.rectangle',
        { toolRole: 'shape', semanticRole: 'surface.shape.rectangle' },
      ],
      [
        'shape.ellipse',
        'ink.tool.shape.ellipse',
        { toolRole: 'shape', semanticRole: 'surface.shape.ellipse' },
      ],
      [
        'insert.text',
        'ink.tool.insert.text',
        { toolRole: 'text', semanticRole: 'surface.insert.text' },
      ],
      [
        'insert.image',
        'ink.tool.insert.image',
        { semanticRole: 'surface.insert.image' },
      ],
      [
        'community',
        'community.example.diagram.diamond.command',
        { semanticRole: 'community.example.diagram.diamond' },
      ],
    ];
    return defs.map(([id, controlId, meta]) =>
      squeezeEntry(id, controlId, meta),
    );
  }

  const entryIds = (entries: readonly GroupedSqueezeEntry[]): string[] =>
    entries.map((entry) => entry.id);

  it('keeps both tiers in composition order for every active selection', () => {
    const entries = surfaceEntries();
    const rank = new Map(entries.map((entry, index) => [entry.id, index]));
    const isVerbatim = (list: readonly GroupedSqueezeEntry[]): boolean =>
      list.every(
        (entry, i, arr) =>
          i === 0 ||
          (rank.get(arr[i - 1]?.id ?? '') ?? 0) < (rank.get(entry.id) ?? 0),
      );
    for (const activeControlId of [
      null,
      ...entries.map((entry) => entry.control.id),
    ]) {
      const { primary, secondary } = splitGroupedSqueezeItems(entries, {
        activeControlId,
      });
      expect(
        isVerbatim(primary),
        `primary verbatim with ${activeControlId}`,
      ).toBe(true);
      expect(
        isVerbatim(secondary),
        `secondary verbatim with ${activeControlId}`,
      ).toBe(true);
      // Partition covers every entry exactly once: overflow goes to the
      // secondary tier, never into a reordered head.
      expect([...primary, ...secondary]).toHaveLength(entries.length);
    }
  });

  it('never moves the active tool to the head of its tier', () => {
    const entries = surfaceEntries();
    // Contextual active stays at the contextual slot (last), never head: a
    // reorder-to-first implementation would put shape.rect at index 0.
    const rect = splitGroupedSqueezeItems(entries, {
      activeControlId: 'ink.tool.shape.rectangle',
    });
    expect(entryIds(rect.primary)).toEqual([
      'pen.ball',
      'highlighter',
      'eraser',
      'select',
      'shape.rect',
    ]);
    // Lasso active swaps the select-family rep in place, never to head.
    const lasso = splitGroupedSqueezeItems(entries, {
      activeControlId: 'ink.tool.lasso',
    });
    expect(entryIds(lasso.primary)).toEqual([
      'pen.ball',
      'highlighter',
      'eraser',
      'lasso',
      'shape.line',
    ]);
    expect(entryIds(lasso.secondary)).toContain('select');
    // Pen-sibling active holds the pen-family slot while the secondary head
    // stays put: the displaced sibling overflows verbatim, never promoted.
    const brush = splitGroupedSqueezeItems(entries, {
      activeControlId: 'ink.tool.pen.brush',
    });
    expect(entryIds(brush.primary)).toEqual([
      'pen.brush',
      'highlighter',
      'eraser',
      'select',
      'shape.line',
    ]);
    expect(entryIds(brush.secondary)[0]).toBe('pen.ball');
    // Text active (contextual family) likewise stays last, never head.
    const text = splitGroupedSqueezeItems(entries, {
      activeControlId: 'ink.tool.insert.text',
    });
    expect(entryIds(text.primary)).toEqual([
      'pen.ball',
      'highlighter',
      'eraser',
      'select',
      'insert.text',
    ]);
  });

  it('leaves both tiers byte-identical when the selection changes no family rep', () => {
    const entries = surfaceEntries();
    const baseline = splitGroupedSqueezeItems(entries, {
      activeControlId: 'ink.tool.pen.ball',
    });
    expect(entryIds(baseline.primary)).toEqual([
      'pen.ball',
      'highlighter',
      'eraser',
      'select',
      'shape.line',
    ]);
    expect(entryIds(baseline.secondary)).toEqual([
      'pen.fountain',
      'pen.brush',
      'pen.pencil',
      'lasso',
      'shape.rect',
      'shape.ellipse',
      'insert.text',
      'insert.image',
      'community',
    ]);
    // Eraser/Select keep their own family slot; role-less image/community
    // commands never promote (actions, not drawing tools); null keeps the
    // first-of-each-family default. None of these selections may move a
    // single entry in either tier.
    for (const activeControlId of [
      null,
      'ink.tool.eraser',
      'ink.tool.select',
      'ink.tool.insert.image',
      'community.example.diagram.diamond.command',
    ]) {
      const split = splitGroupedSqueezeItems(entries, { activeControlId });
      expect(
        entryIds(split.primary),
        `primary stable with ${activeControlId}`,
      ).toEqual(entryIds(baseline.primary));
      expect(
        entryIds(split.secondary),
        `secondary stable with ${activeControlId}`,
      ).toEqual(entryIds(baseline.secondary));
    }
  });
});

/**
 * Blockpage contracts: one-path composition constrains creation to
 * the shelf; contextual edits for table/media/mathDiagram/columns may
 * surface secondarily at float.selection via placement islands; creation
 * stays shelf-only (never shelf + float, never selection).
 *
 * The blockpage-only provider groups (table/columns/media/mathDiagram/
 * insert) are wired through add-only `writing.*` item ids in the shared
 * `writing.insert` / `writing.structure` categories with no `blockpage.*`
 * category, item, or semantic role anywhere in composition. Creation
 * (`block.insert.*`) carries the `normal`/`compact` shelf projection;
 * contextual edits (media/math/diagram/table/column) carry `selection`
 * only. The selection graph carries every contextual provider role with
 * zero diagnostics for the island tasks to consume, while the
 * shelf graph carries creation. Contracts before consumers: no
 * consumer changes here.
 *
 * Doubles below mirror the provider snapshot shapes 1:1 (plain
 * DocumentEditorTools, no PM types): table grid ops (`#tableControls`),
 * column region ops (`#columnControls`), media payloads (`#mediaControls`),
 * math/diagram sources (`#mathDiagramControls`), creation catalog
 * (`#insertControls`). Control id equals semantic role per the provider
 * convention; resolution keys on semanticRole alone.
 */
describe('blockpage selection contracts', () => {
  const tableButton = (id: string, label: string): DocumentToolControl => ({
    kind: 'button',
    id,
    group: 'table',
    label,
    semanticRole: id,
  });
  const mediaInput = (
    id: string,
    label: string,
    actionLabel: string,
  ): DocumentToolControl => ({
    kind: 'input',
    id,
    group: 'media',
    label,
    placeholder: '',
    actionLabel,
    semanticRole: id,
  });
  const mediaButton = (id: string, label: string): DocumentToolControl => ({
    kind: 'button',
    id,
    group: 'media',
    label,
    semanticRole: id,
  });
  const mathDiagramInput = (
    id: string,
    label: string,
  ): DocumentToolControl => ({
    kind: 'input',
    id,
    group: 'mathDiagram',
    label,
    placeholder: '',
    actionLabel: 'Set source',
    semanticRole: id,
    value: '',
  });
  const mathDiagramButton = (
    id: string,
    label: string,
  ): DocumentToolControl => ({
    kind: 'button',
    id,
    group: 'mathDiagram',
    label,
    semanticRole: id,
  });
  const insertButton = (
    insertType: string,
    label: string,
  ): DocumentToolControl => ({
    kind: 'button',
    id: `block.insert.${insertType}`,
    group: 'insert',
    label,
    semanticRole: `block.insert.${insertType}`,
  });

  /** Every item id (add-only; pinned by toolbar-customization.spec).*/
  const T001_NEW_IDS = [
    'writing.insert.table',
    'writing.insert.image',
    'writing.insert.video',
    'writing.insert.audio',
    'writing.insert.file',
    'writing.insert.math',
    'writing.insert.diagram',
    'writing.insert.media.name',
    'writing.insert.media.caption',
    'writing.insert.media.alt',
    'writing.insert.media.remote-url',
    'writing.insert.media.clear-remote',
    'writing.insert.media.replace',
    'writing.insert.media.retry',
    'writing.insert.math.source',
    'writing.insert.math.retry',
    'writing.insert.diagram.source',
    'writing.insert.diagram.retry',
    'writing.structure.table.add-row',
    'writing.structure.table.add-column',
    'writing.structure.table.remove-row',
    'writing.structure.table.remove-column',
    'writing.structure.table.move-row-up',
    'writing.structure.table.move-row-down',
    'writing.structure.table.move-column-left',
    'writing.structure.table.move-column-right',
    'writing.structure.table.toggle-header',
  ];

  /** (amendment): creation is shelf-only (`normal`/`compact`).*/
  const CREATION_SHELF_IDS = [
    'writing.insert.table',
    'writing.insert.image',
    'writing.insert.video',
    'writing.insert.audio',
    'writing.insert.file',
    'writing.insert.math',
    'writing.insert.diagram',
  ];

  /** Provider group controls (selection-reachable contract pool). */
  function providerGroupControls(variant: 'math' | 'diagram'): {
    readonly table: readonly DocumentToolControl[];
    readonly media: readonly DocumentToolControl[];
    readonly mathDiagram: readonly DocumentToolControl[];
    readonly insert: readonly DocumentToolControl[];
  } {
    const table = [
      tableButton('table.addRow', 'Add row'),
      tableButton('table.addColumn', 'Add column'),
      tableButton('table.removeRow', 'Remove row'),
      tableButton('table.removeColumn', 'Remove column'),
      tableButton('table.moveRowUp', 'Move row up'),
      tableButton('table.moveRowDown', 'Move row down'),
      tableButton('table.moveColumnLeft', 'Move column left'),
      tableButton('table.moveColumnRight', 'Move column right'),
      tableButton('table.toggleHeader', 'Header row'),
    ];
    // Non-image media root: name/remote/clear-remote present (image roots
    // omit them provider-side; covered by the image-root test below).
    const media = [
      mediaInput('media.name', 'Media name', 'Set name'),
      mediaInput('media.caption', 'Media caption', 'Set caption'),
      mediaInput('media.alt', 'Alt text', 'Set alt text'),
      mediaButton('media.replace', 'Replace video'),
      mediaInput('media.remoteUrl', 'Remote URL', 'Use remote'),
      mediaButton('media.clearRemote', 'Use vault instead'),
      mediaButton('media.retry', 'Retry media load'),
    ];
    // The provider roots at exactly one source atom: math XOR diagram.
    const mathDiagram =
      variant === 'math'
        ? [
            mathDiagramInput('math.source', 'Math source (LaTeX)'),
            mathDiagramButton('math.retry', 'Retry preview'),
          ]
        : [
            mathDiagramInput('diagram.source', 'Diagram source (Mermaid)'),
            mathDiagramButton('diagram.retry', 'Retry preview'),
          ];
    const insert = [
      insertButton('table', 'Insert table'),
      insertButton('image', 'Insert image'),
      insertButton('video', 'Insert video'),
      insertButton('audio', 'Insert audio'),
      insertButton('file', 'Insert file'),
      insertButton('math', 'Insert math'),
      insertButton('diagram', 'Insert diagram'),
    ];
    return { table, media, mathDiagram, insert };
  }

  /** Full blockpage snapshot: portable grammar plus every provider group. */
  function blockpageSelectionControls(
    variant: 'math' | 'diagram' = 'math',
  ): DocumentToolControl[] {
    const groups = providerGroupControls(variant);
    return [
      {
        kind: 'choice',
        id: 'block.type',
        group: 'block',
        label: 'Block type',
        semanticRole: 'writing.style',
        value: 'paragraph',
        options: [{ value: 'paragraph', label: 'Paragraph' }],
      } as DocumentToolControl,
      writingFormatToggleControl('block.bold', 'bold', { active: true }),
      writingFormatToggleControl('block.italic', 'italic', { mixed: true }),
      writingFormatToggleControl('block.strike', 'strike', {}),
      writingFormatToggleControl('block.code', 'code', { disabled: true }),
      writingLinkControl('block.link', {
        value: 'https://froglight.test',
        active: true,
      }),
      ...groups.table,
      ...groups.media,
      ...groups.mathDiagram,
      ...groups.insert,
    ];
  }

  const selectionGraph = (controls: readonly DocumentToolControl[]) =>
    resolveToolbarComposition({
      snapshot: defaultToolbarComposition(),
      kindId: 'froglight.blockpage',
      controls,
      projection: 'selection',
    });

  it('declares no blockpage.* category, item, or semantic role (one-path)', () => {
    const ids = [
      ...DEFAULT_TOOLBAR_CATEGORIES.map((entry) => entry.id),
      ...DEFAULT_TOOLBAR_ITEMS.map((entry) => entry.id),
      ...DEFAULT_TOOLBAR_KIND_EXTENSIONS.flatMap((entry) => [
        ...(entry.categories ?? []).map((category) => category.id),
        ...(entry.items ?? []).map((item) => item.id),
      ]),
    ];
    for (const id of ids) {
      expect(id.startsWith('blockpage.'), `blockpage id ${id}`).toBe(false);
    }
    const roles = new Set([
      ...DEFAULT_TOOLBAR_ITEMS.map((entry) => entry.semanticRole),
      ...DEFAULT_TOOLBAR_KIND_EXTENSIONS.flatMap((entry) => [
        ...(entry.items ?? []).map((item) => item.semanticRole),
      ]),
    ]);
    for (const role of roles) {
      expect(role.startsWith('blockpage.'), `blockpage role ${role}`).toBe(
        false,
      );
    }
    // Every id is declared exactly once, in a shared writing.*
    // category (never a blockpage extension: the writing.blockpage
    // extension stays empty, pinned by writing-family-consistency).
    const declared = DEFAULT_TOOLBAR_ITEMS.filter((entry) =>
      T001_NEW_IDS.includes(entry.id),
    );
    expect(declared.map((entry) => entry.id).sort()).toEqual(
      [...T001_NEW_IDS].sort(),
    );
    for (const entry of declared) {
      expect(
        entry.categoryId === 'writing.insert' ||
          entry.categoryId === 'writing.structure',
        `${entry.id} housed in ${entry.categoryId}`,
      ).toBe(true);
      // (amendment one-path): creation is shelf-only,
      // contextual edits stay selection-only.
      if (CREATION_SHELF_IDS.includes(entry.id)) {
        expect(entry.projections).toEqual(['normal', 'compact']);
      } else {
        expect(entry.projections).toEqual(['selection']);
      }
    }
    // Creation never appears at selection: shelf one-path, never both.
    const selectionIds = new Set(
      DEFAULT_TOOLBAR_ITEMS.filter((entry) =>
        (entry.projections ?? []).includes('selection'),
      ).map((entry) => entry.id),
    );
    for (const id of CREATION_SHELF_IDS) {
      expect(selectionIds.has(id), `${id} leaks into selection`).toBe(false);
    }
  });

  it('wires every table/media/mathDiagram/columns role with zero diagnostics', () => {
    const groups = providerGroupControls('math');
    const graph = selectionGraph(blockpageSelectionControls('math'));
    expect(graph.diagnostics).toEqual([]);
    // No duplicate presenters: one live item per provider role.
    const liveRoles = graph.categories.flatMap((category) =>
      category.items.map((item) => item.semanticRole),
    );
    expect(new Set(liveRoles).size).toBe(liveRoles.length);
    // Zero orphans for the contextual pool: every emitted table/columns/
    // media/mathDiagram control resolves to a live selection item.
    // Creation (`block.insert.*`) is shelf-only per the amendment
    // and resolves in the shelf graph, never here — covered by
    // the shelf one-path test below.
    const live = new Set(liveRoles);
    for (const control of [
      ...groups.table,
      ...groups.media,
      ...groups.mathDiagram,
    ]) {
      const role = control.semanticRole;
      expect(
        typeof role === 'string' && live.has(role),
        `orphaned provider role ${String(role)}`,
      ).toBe(true);
    }
    // Creation roles stay out of the selection graph by projection gating
    // (skipped before dormancy accounting — never diagnostics, never
    // unresolved noise).
    for (const control of groups.insert) {
      expect(live.has(control.semanticRole as string)).toBe(false);
    }
  });

  it('wires every creation role on the shelf with zero diagnostics (shelf one-path)', () => {
    const groups = providerGroupControls('math');
    const graph = resolveToolbarComposition({
      snapshot: defaultToolbarComposition(),
      kindId: 'froglight.blockpage',
      controls: blockpageSelectionControls('math'),
    });
    expect(graph.diagnostics).toEqual([]);
    const live = new Set(
      graph.categories.flatMap((category) =>
        category.items.map((item) => item.semanticRole),
      ),
    );
    for (const control of groups.insert) {
      const role = control.semanticRole;
      expect(
        typeof role === 'string' && live.has(role),
        `orphaned creation role ${String(role)}`,
      ).toBe(true);
    }
    // No duplicate presenters on the shelf either.
    const liveRoles = graph.categories.flatMap((category) =>
      category.items.map((item) => item.semanticRole),
    );
    expect(new Set(liveRoles).size).toBe(liveRoles.length);
    // Compact shelf carries the same creation one-path.
    const compact = resolveToolbarComposition({
      snapshot: defaultToolbarComposition(),
      kindId: 'froglight.blockpage',
      controls: blockpageSelectionControls('math'),
      projection: 'compact',
    });
    expect(compact.diagnostics).toEqual([]);
    const compactLive = new Set(
      compact.categories.flatMap((category) =>
        category.items.map((item) => item.semanticRole),
      ),
    );
    for (const control of groups.insert) {
      expect(compactLive.has(control.semanticRole as string)).toBe(true);
    }
  });

  it('keeps selection order verbatim after the portable members', () => {
    const graph = selectionGraph(blockpageSelectionControls('math'));
    expect(graph.diagnostics).toEqual([]);
    // Portable grammar carries no selection projection, so the selection
    // graph holds exactly the two shared categories with the contextual
    // contract items in verbatim contribution order (active marked in place
    // by consumers — never moved first). Creation (`block.insert.*`) is
    // shelf-only per the amendment and never appears here.
    expect(graph.categories.map((entry) => entry.id)).toEqual([
      'writing.insert',
      'writing.structure',
    ]);
    expect(
      graph.categories
        .find((entry) => entry.id === 'writing.insert')
        ?.items.map((item) => item.semanticRole),
    ).toEqual([
      'media.name',
      'media.caption',
      'media.alt',
      'media.replace',
      'media.remoteUrl',
      'media.clearRemote',
      'media.retry',
      'math.source',
      'math.retry',
    ]);
    expect(
      graph.categories
        .find((entry) => entry.id === 'writing.insert')
        ?.items.map((item) => item.id),
    ).toEqual([
      'writing.insert.media.name',
      'writing.insert.media.caption',
      'writing.insert.media.alt',
      'writing.insert.media.replace',
      'writing.insert.media.remote-url',
      'writing.insert.media.clear-remote',
      'writing.insert.media.retry',
      'writing.insert.math.source',
      'writing.insert.math.retry',
    ]);
    // Selection-only contextual ids never leak into the primary graph —
    // not even as dormant noise.
    for (const id of T001_NEW_IDS.filter(
      (entry) => !CREATION_SHELF_IDS.includes(entry) &&
        !entry.startsWith('writing.insert.diagram.'),
    )) {
      expect(graph.unresolved, `${id} leaks`).not.toContain(id);
    }
    // Shelf creation is live here (controls emitted), so none of the 8 is
    // dormant.
    for (const id of CREATION_SHELF_IDS) {
      expect(graph.unresolved, `${id} dormant`).not.toContain(id);
    }
  });
});
