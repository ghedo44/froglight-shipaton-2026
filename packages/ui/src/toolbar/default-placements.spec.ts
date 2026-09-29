/**
 *  + pins for the first-party default placements.
 *
 * The semantic composition graph (`defaultToolbarComposition()`) is the sole
 * source of truth for normal primary document tools, and the composition
 * shelf (+ settings popover) is the sole presenter for active-tool quick
 * properties. Default placements keep only geometric utilities: history,
 * zoom, selection, page/navigation, canvas/page-size, and diagnostics.
 * No `float.top-center` first-party placement remains.
 *
 * Export commands stay unplaced because the document sidebar presents export.
 * PDF navigation/page status, source-select, and import actions survive via
 * composition (source actions) + geometric page placement (navigation).
 */

import { describe, expect, it } from 'vitest';
import type { DocumentToolControl } from '@froglight/foundation';
import { defaultToolbarPlacements } from './default-placements.js';
import { defaultToolbarComposition } from './default-composition.js';
import { createToolbarPlacementRegistry } from './placement-registry.js';
import { createDocumentToolbarRegistry } from '../document-toolbar-registry.js';
import { computeUnifiedToolbarModel } from './unified-toolbar-model.js';
import type { WorkbenchEditorToolsPort } from '../workbench-ports.js';
import { createToolbarCompositionRegistry } from './composition-registry.js';
import { resolveToolbarComposition } from './composition-registry.js';
import {
  assembleOwnedPool,
  resolveToolbarGroups,
} from './placement-resolver.js';
import type { DocumentToolbarContext } from '../document-toolbar-registry.js';

const button = (id: string, active = false): DocumentToolControl => ({
  kind: 'button',
  id,
  group: 'test',
  label: id,
  ...(active ? { active: true as const } : {}),
});

function context(
  kindId: string,
  pool: readonly DocumentToolControl[] = [],
): DocumentToolbarContext {
  return {
    pane: 'main',
    documentId: 'doc-1',
    kindId,
    editor: { context: 'test', controls: pool },
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

function semanticButton(
  id: string,
  semanticRole: string,
  extra: Partial<Extract<DocumentToolControl, { kind: 'button' }>> = {},
): DocumentToolControl {
  return {
    kind: 'button',
    id,
    group: 'test',
    label: id,
    semanticRole,
    ...extra,
  } as DocumentToolControl;
}

function compositionControlIdsFor(
  kindId: string,
  controls: readonly DocumentToolControl[],
): string[] {
  const created = createToolbarCompositionRegistry();
  const defaults = defaultToolbarComposition();
  for (const entry of defaults.categories)
    created.registry.registerCategory(entry);
  for (const entry of defaults.items) created.registry.registerItem(entry);
  for (const entry of defaults.extensions)
    created.registry.registerKindExtension(entry);
  try {
    const graph = resolveToolbarComposition({
      snapshot: created.registry.snapshot(),
      kindId,
      controls,
    });
    return graph.categories.flatMap((category) =>
      category.items.map((item) => item.control.id),
    );
  } finally {
    created.dispose();
  }
}

describe('defaultToolbarPlacements: composition owns primaries', () => {
  const DELETED_PRIMARY_IDS = [
    'froglight.toolbar-placement.markdown.primary',
    'froglight.toolbar-placement.markdown.format',
    'froglight.toolbar-placement.markdown.insert',
    'froglight.toolbar-placement.blockpage.primary',
    'froglight.toolbar-placement.blockpage.format',
    'froglight.toolbar-placement.blockpage.context',
    'froglight.toolbar-placement.ink.primary',
    'froglight.toolbar-placement.notebook.primary',
    'froglight.toolbar-placement.whiteboard.primary',
    'froglight.toolbar-placement.pdf.primary',
    'froglight.toolbar-placement.latex.primary',
    'froglight.toolbar-placement.latex.insert',
  ];

  it('keeps no topbar-center primary placement for composition-covered tools', () => {
    const placements = defaultToolbarPlacements();
    expect(placements.filter((p) => p.anchor === 'topbar-center')).toEqual([]);
    for (const id of DELETED_PRIMARY_IDS) {
      expect(placements.map((p) => p.id)).not.toContain(id);
    }
  });

  it('keeps only geometric anchors', () => {
    const anchors = new Set(defaultToolbarPlacements().map((p) => p.anchor));
    expect(anchors.has('topbar-center' as never)).toBe(false);
    for (const anchor of anchors) {
      expect(anchor.startsWith('float.')).toBe(true);
    }
  });

  it('resolves writing primaries through composition, not placement', () => {
    const markdownControls: DocumentToolControl[] = [
      {
        kind: 'choice',
        id: 'markdown.block',
        group: 'block',
        label: 'Line style',
        value: 'paragraph',
        options: [{ value: 'paragraph', label: 'Paragraph' }],
        semanticRole: 'writing.style',
      } as DocumentToolControl,
      semanticButton('markdown.bold', 'writing.bold'),
      semanticButton('markdown.italic', 'writing.italic'),
      semanticButton('markdown.code', 'writing.code'),
      {
        kind: 'input',
        id: 'markdown.link',
        group: 'insert',
        label: 'Link',
        actionLabel: 'Link',
        semanticRole: 'writing.link',
      } as unknown as DocumentToolControl,
      semanticButton('markdown.code-block', 'writing.code-block'),
    ];
    const ids = compositionControlIdsFor(
      'froglight.markdown',
      markdownControls,
    );
    for (const id of [
      'markdown.block',
      'markdown.bold',
      'markdown.italic',
      'markdown.code',
      'markdown.link',
      'markdown.code-block',
    ]) {
      expect(ids).toContain(id);
    }
    // Geometrically, writing tools are now unplaced (composition-owned).
    const layout = resolveProviderLayout({
      placements: defaultToolbarPlacements(),
      pool: markdownControls,
      context: context('froglight.markdown', markdownControls),
    });
    expect(layout.diagnostics).toEqual([]);
    expect(layout.topbarCenter).toEqual([]);
    expect(layout.floating['float.top-center']).toEqual([]);
    expect(layout.unplaced).toEqual(
      expect.arrayContaining(['markdown.block', 'markdown.bold']),
    );
  });

  it('resolves Surface primaries through composition, not placement', () => {
    const inkControls: DocumentToolControl[] = [
      semanticButton('ink.pen', 'surface.pen.ball'),
      semanticButton('ink.eraser', 'surface.erase'),
      semanticButton('ink.rect', 'surface.shape.rectangle'),
      semanticButton('ink.text', 'surface.insert.text'),
      semanticButton('ink.image', 'surface.insert.image'),
    ];
    const ids = compositionControlIdsFor('froglight.ink', inkControls);
    for (const id of ['ink.pen', 'ink.eraser', 'ink.rect']) {
      expect(ids).toContain(id);
    }
    const layout = resolveProviderLayout({
      placements: defaultToolbarPlacements(),
      pool: inkControls,
      context: context('froglight.ink', inkControls),
    });
    expect(layout.unplaced).toEqual(
      expect.arrayContaining(['ink.pen', 'ink.eraser', 'ink.rect']),
    );
  });

  it('resolves PDF source actions through composition while pages stay geometric', () => {
    const pdfControls: DocumentToolControl[] = [
      semanticButton('pdf.previous', 'pdf.page.previous'),
      {
        kind: 'status',
        id: 'pdf.page',
        group: 'pages',
        label: '3 / 9',
      } as DocumentToolControl,
      semanticButton('pdf.next', 'pdf.page.next'),
      semanticButton('pdf.source-select', 'pdf.select.source'),
      semanticButton('pdf.import-notebook', 'pdf.annotate.notebook'),
    ];
    const ids = compositionControlIdsFor('froglight.pdf', pdfControls);
    expect(ids).toEqual(
      expect.arrayContaining([
        'pdf.previous',
        'pdf.next',
        'pdf.source-select',
        'pdf.import-notebook',
      ]),
    );
    const layout = resolveProviderLayout({
      placements: defaultToolbarPlacements(),
      pool: pdfControls,
      context: context('froglight.pdf', pdfControls),
    });
    expect(layout.diagnostics).toEqual([]);
    // Geometric page navigation keeps previous/page/next together.
    expect(layout.floating['float.bottom-left'].map((c) => c.id)).toEqual([
      'pdf.previous',
      'pdf.page',
      'pdf.next',
    ]);
    // Source actions are composition-owned, hence geometrically unplaced.
    expect(layout.unplaced).toEqual(
      expect.arrayContaining(['pdf.source-select', 'pdf.import-notebook']),
    );
    expect(layout.topbarCenter).toEqual([]);
  });

  it('resolves LaTeX source tools through composition while diagnostics stay geometric', () => {
    const latexControls: DocumentToolControl[] = [
      {
        kind: 'choice',
        id: 'latex.structure',
        group: 'structure',
        label: 'Structure',
        value: '',
        options: [{ value: '', label: 'Structure…' }],
        semanticRole: 'writing.style',
      } as DocumentToolControl,
      semanticButton('latex.bold', 'writing.bold'),
      semanticButton('latex.emphasis', 'writing.italic'),
      semanticButton('latex.inline-math', 'latex.math.inline'),
      semanticButton('latex.display-math', 'latex.math.display'),
      semanticButton('latex.environment.itemize', 'latex.environment.itemize'),
      {
        kind: 'input',
        id: 'latex.label',
        group: 'references',
        label: 'Label name',
        actionLabel: 'Label',
        semanticRole: 'latex.reference.label',
      } as unknown as DocumentToolControl,
      {
        kind: 'input',
        id: 'latex.ref',
        group: 'references',
        label: 'Reference label',
        actionLabel: 'Ref',
        semanticRole: 'latex.reference.ref',
      } as unknown as DocumentToolControl,
      {
        kind: 'input',
        id: 'latex.cite',
        group: 'references',
        label: 'Citation key',
        actionLabel: 'Cite',
        semanticRole: 'latex.reference.cite',
      } as unknown as DocumentToolControl,
      {
        kind: 'diagnostics',
        id: 'latex.diagnostics',
        group: 'diagnostics',
        label: 'LaTeX no issues',
        state: 'clean',
        errorCount: 0,
        noteCount: 0,
        entries: [],
      },
    ];
    const ids = compositionControlIdsFor('froglight.latex', latexControls);
    for (const id of [
      'latex.structure',
      'latex.bold',
      'latex.inline-math',
      'latex.environment.itemize',
      'latex.cite',
    ]) {
      expect(ids).toContain(id);
    }
    const layout = resolveProviderLayout({
      placements: defaultToolbarPlacements(),
      pool: latexControls,
      context: context('froglight.latex', latexControls),
    });
    expect(layout.diagnostics).toEqual([]);
    expect(layout.floating['float.top-right'].map((c) => c.id)).toEqual([
      'latex.diagnostics',
    ]);
    expect(layout.unplaced).toEqual(
      expect.arrayContaining(['latex.structure', 'latex.bold', 'latex.cite']),
    );
    expect(layout.topbarCenter).toEqual([]);
  });

  it('keeps composition shelf and float.top-center islands disjoint (no double render)', () => {
    // no first-party `float.top-center` placement remains, so the
    // shelf cannot collide with a geometric property island by id. This
    // preserves the ID-level pin (now trivially empty) alongside the
    // semantic presenter pin below, which is the real duplicate guard:
    // different control ids presenting the same user-facing property still
    // count as a duplicate.
    const cases: Array<{
      kindId: string;
      controls: readonly DocumentToolControl[];
    }> = [
      {
        kindId: 'froglight.ink',
        controls: [
          semanticButton('ink.tool.froglight.ink.pen', 'surface.pen.ball'),
          semanticButton('ink.tool.froglight.ink.eraser', 'surface.erase'),
          {
            kind: 'color',
            id: 'ink.color',
            group: 'style',
            label: 'Stroke color',
            value: '#111',
            options: ['#111'],
          } as DocumentToolControl,
          {
            kind: 'choice',
            id: 'ink.width',
            group: 'style',
            label: 'Width',
            value: '2',
            options: [{ value: '2', label: '2' }],
          } as DocumentToolControl,
        ],
      },
      {
        kindId: 'froglight.markdown',
        controls: [
          {
            kind: 'choice',
            id: 'markdown.block',
            group: 'block',
            label: 'Line style',
            value: 'paragraph',
            options: [{ value: 'paragraph', label: 'Paragraph' }],
            semanticRole: 'writing.style',
          } as DocumentToolControl,
          semanticButton('markdown.bold', 'writing.bold'),
        ],
      },
      {
        kindId: 'froglight.latex',
        controls: [
          semanticButton('latex.bold', 'writing.bold'),
          {
            kind: 'diagnostics',
            id: 'latex.diagnostics',
            group: 'diagnostics',
            label: 'LaTeX no issues',
            state: 'clean',
            errorCount: 0,
            noteCount: 0,
            entries: [],
          },
        ],
      },
    ];
    const topCenterIds = new Set(
      defaultToolbarPlacements()
        .filter((p) => p.anchor === 'float.top-center')
        .flatMap((p) => [...p.controlIds]),
    );
    expect(topCenterIds.size).toBe(0);
    for (const { kindId, controls } of cases) {
      const compositionIds = new Set(
        compositionControlIdsFor(kindId, controls),
      );
      for (const id of compositionIds) {
        expect(topCenterIds.has(id)).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// semantic / user-facing disjointness.
//
// Different control ids presenting the same user-facing Surface property
// still count as a duplicate (legacy `ink.color` with
// `surface.style.color` vs shelf `ink.settings.pen.color` with
// `surface.settings.color`). These pins count *presenters per property*,
// not ids: the geometric island must present zero while the shelf path
// presents exactly one.
// ---------------------------------------------------------------------------

const COLOR_ROLES = new Set(['surface.style.color', 'surface.settings.color']);
const WIDTH_ROLES = new Set(['surface.style.width', 'surface.settings.size']);
const ERASER_ROLES = new Set([
  'surface.erase.size',
  'surface.settings.eraser-size',
]);

function legacyStyleControls(prefix: string): DocumentToolControl[] {
  return [
    {
      kind: 'color',
      id: `${prefix}.color`,
      group: 'style',
      label: 'Stroke color',
      value: '#37352f',
      options: ['#37352f'],
      semanticRole: 'surface.style.color',
    } as DocumentToolControl,
    {
      kind: 'choice',
      id: `${prefix}.width`,
      group: 'style',
      label: 'Stroke width',
      value: '3.5',
      options: [{ value: '3.5', label: '3.5 px' }],
      semanticRole: 'surface.style.width',
    } as DocumentToolControl,
    {
      kind: 'range',
      id: `${prefix}.eraser-radius`,
      group: 'style',
      label: 'Eraser size',
      value: 12,
      min: 2,
      max: 40,
      step: 1,
      semanticRole: 'surface.erase.size',
    } as DocumentToolControl,
  ];
}

function penSettingsControls(
  prefix: string,
  toolKey = 'pen',
): DocumentToolControl[] {
  return [
    {
      kind: 'color',
      id: `${prefix}.settings.${toolKey}.color`,
      group: 'settings',
      label: 'Color',
      value: '#37352f',
      options: ['#37352f'],
      semanticRole: 'surface.settings.color',
    } as DocumentToolControl,
    {
      kind: 'choice',
      id: `${prefix}.settings.${toolKey}.size`,
      group: 'settings',
      label: 'Size',
      value: '3.5',
      options: [{ value: '3.5', label: '3.5 px' }],
      semanticRole: 'surface.settings.size',
    } as DocumentToolControl,
  ];
}

function eraserSettingsControls(prefix: string): DocumentToolControl[] {
  return [
    {
      kind: 'range',
      id: `${prefix}.settings.eraser.radius`,
      group: 'settings',
      label: 'Eraser size',
      value: 12,
      min: 2,
      max: 40,
      step: 1,
      semanticRole: 'surface.settings.eraser-size',
    } as DocumentToolControl,
  ];
}

function countPresenters(
  pool: readonly DocumentToolControl[],
  placedTopCenter: readonly DocumentToolControl[],
  roles: ReadonlySet<string>,
): { island: number; shelf: number; total: number } {
  // The geometric island is the only placement path for these roles after
  // (no top-center placement remains, so this is zero). The shelf
  // path presents the provider-emitted `surface.settings.*` controls for the
  // active tool; legacy `surface.style.*` / `surface.erase.size` controls are
  // unplaced by construction and never counted as shelf presenters.
  const island = placedTopCenter.filter((control) =>
    roles.has(control.semanticRole ?? ''),
  ).length;
  const shelf = pool.filter(
    (control) =>
      control.group === 'settings' &&
      roles.has(control.semanticRole ?? '') &&
      // Shelf settings are active-tool scoped by the provider (only the
      // active tool's settings are emitted) and by scoping; count
      // what the pool carries for this snapshot.
      placedTopCenter.every((placed) => placed.id !== control.id),
  ).length;
  return { island, shelf, total: island + shelf };
}

describe('defaultToolbarPlacements Repair 1: shelf owns quick properties', () => {
  const FAMILIES = [
    { kindId: 'froglight.ink', prefix: 'ink' },
    { kindId: 'froglight.notebook', prefix: 'notebook' },
    { kindId: 'froglight.whiteboard', prefix: 'whiteboard' },
  ] as const;

  const PEN_TOOLS = [
    { label: 'Ball Pen', role: 'surface.pen.ball' },
    { label: 'Fountain Pen', role: 'surface.pen.fountain' },
    { label: 'Brush Pen', role: 'surface.pen.brush' },
    { label: 'Pencil', role: 'surface.pencil' },
  ] as const;

  it('keeps no float.top-center first-party placement', () => {
    const topCenter = defaultToolbarPlacements().filter(
      (p) => p.anchor === 'float.top-center',
    );
    expect(topCenter).toEqual([]);
  });

  it('leaves legacy Surface style controls geometrically unplaced', () => {
    for (const { kindId, prefix } of FAMILIES) {
      const pool: DocumentToolControl[] = [
        ...legacyStyleControls(prefix),
        button(`${prefix}.zoom-out`),
        button(`${prefix}.zoom-reset`),
        button(`${prefix}.zoom-in`),
      ];
      const layout = resolveProviderLayout({
        placements: defaultToolbarPlacements(),
        pool,
        context: context(kindId, pool),
      });
      expect(layout.diagnostics).toEqual([]);
      expect(layout.floating['float.top-center']).toEqual([]);
      // Legacy quick properties are provider-emitted but placement-orphaned:
      // the shelf/popover path (surface.settings.*) presents instead.
      expect(layout.unplaced).toEqual(
        expect.arrayContaining([
          `${prefix}.color`,
          `${prefix}.width`,
          `${prefix}.eraser-radius`,
        ]),
      );
    }
  });

  it.each(
    FAMILIES.flatMap((family) =>
      PEN_TOOLS.map((tool) => ({
        kindId: family.kindId,
        prefix: family.prefix,
        toolLabel: tool.label,
        toolRole: tool.role,
      })),
    ),
  )(
    'presents exactly one color + one width for $toolLabel ($kindId)',
    ({ kindId, prefix, toolRole }) => {
      // Realistic provider-shaped pool: legacy quick controls (both ids) +
      // the active tool's shelf settings. Different ids, same user-facing
      // properties — counting by id alone would miss the duplicate.
      const pool: DocumentToolControl[] = [
        semanticButton(`${prefix}.tool.active`, toolRole, { active: true }),
        ...legacyStyleControls(prefix),
        ...penSettingsControls(prefix),
      ];
      const layout = resolveProviderLayout({
        placements: defaultToolbarPlacements(),
        pool,
        context: context(kindId, pool),
      });
      expect(layout.diagnostics).toEqual([]);
      const placedTopCenter = layout.floating['float.top-center'];
      expect(placedTopCenter).toEqual([]);

      const color = countPresenters(pool, placedTopCenter, COLOR_ROLES);
      const width = countPresenters(pool, placedTopCenter, WIDTH_ROLES);
      const eraser = countPresenters(pool, placedTopCenter, ERASER_ROLES);
      // Island presents zero; the shelf path presents exactly one each.
      // A legacy island regression (island === 1) would push totals to 2
      // and fail here even though every control id is distinct.
      expect(color.island).toBe(0);
      expect(color.shelf).toBe(1);
      expect(color.total).toBe(1);
      expect(width.island).toBe(0);
      expect(width.shelf).toBe(1);
      expect(width.total).toBe(1);
      // Pen snapshots carry no eraser settings: no visible eraser presenter.
      // The legacy radius sits unplaced and island-invisible.
      expect(eraser.island).toBe(0);
      expect(eraser.total).toBe(0);
    },
  );

  it.each(FAMILIES.map((family) => ({ ...family })))(
    'presents exactly one eraser size for Eraser ($kindId)',
    ({ kindId, prefix }) => {
      const pool: DocumentToolControl[] = [
        semanticButton(`${prefix}.tool.eraser`, 'surface.erase', {
          active: true,
        }),
        ...legacyStyleControls(prefix),
        ...eraserSettingsControls(prefix),
      ];
      const layout = resolveProviderLayout({
        placements: defaultToolbarPlacements(),
        pool,
        context: context(kindId, pool),
      });
      expect(layout.diagnostics).toEqual([]);
      const placedTopCenter = layout.floating['float.top-center'];
      expect(placedTopCenter).toEqual([]);

      const color = countPresenters(pool, placedTopCenter, COLOR_ROLES);
      const width = countPresenters(pool, placedTopCenter, WIDTH_ROLES);
      const eraser = countPresenters(pool, placedTopCenter, ERASER_ROLES);
      expect(color.shelf).toBe(0);
      expect(color.total).toBe(0);
      expect(width.shelf).toBe(0);
      expect(width.total).toBe(0);
      // Two eraser-size controls exist in the pool (legacy + settings) but
      // only the shelf settings presenter counts as visible: the legacy
      // radius is unplaced, the island presents zero. Count the shelf path
      // explicitly so a legacy-island regression (island === 1) fails.
      const shelfEraser = pool.filter(
        (control) =>
          control.group === 'settings' &&
          ERASER_ROLES.has(control.semanticRole ?? ''),
      ).length;
      expect(shelfEraser).toBe(1);
      expect(eraser.island).toBe(0);
      expect(eraser.total).toBe(1);
    },
  );
});

describe('defaultToolbarPlacements geometric utilities', () => {
  it('keeps Notebook page navigation stable with the outline jump, management shelf-only', () => {
    const poolIds = [
      'notebook.tool.froglight.ink.pen',
      'notebook.color',
      'notebook.previous',
      'notebook.page',
      'notebook.next',
      'notebook.source-outline',
      'notebook.add',
      'notebook.duplicate',
      'notebook.delete',
      'notebook.template',
      'notebook.overview',
      'notebook.insert-pdf-before',
      'notebook.insert-pdf-after',
      'notebook.zoom-out',
      'notebook.zoom-reset',
      'notebook.zoom-in',
      'notebook.fit',
      'notebook.page-width',
      'notebook.page-height',
    ];
    const pool = poolIds.map((id) => button(id));
    const layout = resolveProviderLayout({
      placements: defaultToolbarPlacements(),
      pool,
      context: context('froglight.notebook', pool),
    });
    expect(layout.diagnostics).toEqual([]);
    const placements = defaultToolbarPlacements().filter((p) =>
      p.kindIds?.includes('froglight.notebook'),
    );
    const nav = placements.find(
      (p) => p.id === 'froglight.toolbar-placement.notebook.pages-nav',
    );
    // no bottom-center management island remains — management is
    // shelf-only via the `notebook.pages` composition category.
    expect(
      placements.some(
        (p) => p.id === 'froglight.toolbar-placement.notebook.pages-actions',
      ),
    ).toBe(false);
    expect(nav?.controlIds).toEqual([
      'notebook.previous',
      'notebook.page',
      'notebook.next',
      'notebook.source-outline',
    ]);
    expect(nav?.anchor).toBe('float.bottom-left');
    expect(nav?.priority).toBe(80);
    // Navigation + outline float together; management/PDF-insert stay
    // geometrically unplaced (shelf-owned via composition).
    expect(layout.floating['float.bottom-left'].map((c) => c.id)).toEqual([
      'notebook.previous',
      'notebook.page',
      'notebook.next',
      'notebook.source-outline',
    ]);
    for (const id of [
      'notebook.add',
      'notebook.duplicate',
      'notebook.delete',
      'notebook.template',
      'notebook.overview',
      'notebook.insert-pdf-before',
      'notebook.insert-pdf-after',
    ]) {
      expect(layout.unplaced).toContain(id);
    }
    // Draw tools are composition-owned, hence geometrically unplaced.
    expect(layout.unplaced).toContain('notebook.tool.froglight.ink.pen');
  });

  it('docks grouped notebook text at the selection anchor, dormant without text', () => {
    const placements = defaultToolbarPlacements().filter((p) =>
      p.kindIds?.includes('froglight.notebook'),
    );
    const text = placements.find(
      (p) => p.id === 'froglight.toolbar-placement.notebook.text',
    );
    expect(text?.anchor).toBe('float.selection');
    expect(text?.controlIds).toEqual([
      'notebook.text.style',
      'notebook.text.size',
      'notebook.text.bold',
      'notebook.text.italic',
      'notebook.text.align',
      'notebook.text.color',
      'notebook.text.wrap',
    ]);
    // After arrange (31), below arrange priority so arrange survives first.
    expect(text?.order).toBe(32);
    expect(text?.priority).toBeLessThan(
      placements.find(
        (p) => p.id === 'froglight.toolbar-placement.notebook.arrange',
      )?.priority ?? 100,
    );
    // Dormant without text: disabled/absent text controls hide the island.
    const dormant = [
      button('notebook.text.style'),
      button('notebook.text.bold'),
    ].map((control) => ({ ...control, disabled: true as const }));
    const hidden = resolveProviderLayout({
      placements: defaultToolbarPlacements(),
      pool: dormant,
      context: context('froglight.notebook', dormant),
    });
    expect(hidden.floating['float.selection']).toEqual([]);
    // Live with text: enabled text controls dock at float.selection.
    const live: DocumentToolControl[] = [
      {
        kind: 'choice',
        id: 'notebook.text.style',
        group: 'text',
        label: 'Text style',
        value: 'h1',
        options: [{ value: 'body', label: 'Body' }],
        semanticRole: 'surface.text.style',
      },
      semanticButton('notebook.text.bold', 'surface.text.bold', {
        active: true,
      }),
    ];
    const shown = resolveProviderLayout({
      placements: defaultToolbarPlacements(),
      pool: live,
      context: context('froglight.notebook', live),
    });
    expect(shown.floating['float.selection'].map((c) => c.id)).toEqual([
      'notebook.text.style',
      'notebook.text.bold',
    ]);
    // Still no second-row geometry: no topbar-center, no float.top-center.
    expect(shown.topbarCenter).toEqual([]);
    expect(shown.floating['float.top-center']).toEqual([]);
  });

  it('docks grouped ink/whiteboard text at the selection anchor, dormant without text', () => {
    // Same geometric contract as Notebook: additive ids only,
    // `float.selection` only, order 32 after arrange, priority below
    // arrange — never topbar-center, never a second row.
    for (const [kindId, prefix] of [
      ['froglight.ink', 'ink'],
      ['froglight.whiteboard', 'whiteboard'],
    ] as const) {
      const placements = defaultToolbarPlacements().filter((p) =>
        p.kindIds?.includes(kindId),
      );
      const text = placements.find((p) => p.id.endsWith('.text'));
      expect(text?.anchor).toBe('float.selection');
      expect(text?.controlIds).toEqual([
        `${prefix}.text.style`,
        `${prefix}.text.size`,
        `${prefix}.text.bold`,
        `${prefix}.text.italic`,
        `${prefix}.text.align`,
        `${prefix}.text.color`,
        `${prefix}.text.wrap`,
      ]);
      expect(text?.order).toBe(32);
      const arrange = placements.find((p) => p.id.endsWith('.arrange'));
      expect(text?.priority).toBeLessThan(arrange?.priority ?? 100);
      // Dormant without text: disabled/absent text controls hide the island.
      const dormant = [
        button(`${prefix}.text.style`),
        button(`${prefix}.text.bold`),
      ].map((control) => ({ ...control, disabled: true as const }));
      const hidden = resolveProviderLayout({
        placements: defaultToolbarPlacements(),
        pool: dormant,
        context: context(kindId, dormant),
      });
      expect(hidden.floating['float.selection']).toEqual([]);
      // Live with text: enabled text controls dock at float.selection.
      const live: DocumentToolControl[] = [
        {
          kind: 'choice',
          id: `${prefix}.text.style`,
          group: 'text',
          label: 'Text style',
          value: 'h1',
          options: [{ value: 'body', label: 'Body' }],
          semanticRole: 'surface.text.style',
        },
        semanticButton(`${prefix}.text.bold`, 'surface.text.bold', {
          active: true,
        }),
      ];
      const shown = resolveProviderLayout({
        placements: defaultToolbarPlacements(),
        pool: live,
        context: context(kindId, live),
      });
      expect(shown.floating['float.selection'].map((c) => c.id)).toEqual([
        `${prefix}.text.style`,
        `${prefix}.text.bold`,
      ]);
      // Still no second-row geometry: no topbar-center, no float.top-center.
      expect(shown.topbarCenter).toEqual([]);
      expect(shown.floating['float.top-center']).toEqual([]);
    }
  });

  it('keeps Whiteboard free of page controls without property islands', () => {
    const placements = defaultToolbarPlacements().filter((p) =>
      p.kindIds?.includes('froglight.whiteboard'),
    );
    expect(placements.map((p) => p.id)).not.toContain(
      'froglight.toolbar-placement.whiteboard.primary',
    );
    for (const p of placements) {
      for (const id of p.controlIds) {
        expect(id).not.toMatch(/page|notebook\.previous|frame/i);
      }
    }
    // every whiteboard property island is deleted; quick
    // properties live in the composition shelf + popover instead.
    for (const id of placements.map((p) => p.id)) {
      expect(id).not.toMatch(
        /properties-(pen|highlighter|eraser|text|card|shapes|connectors)/,
      );
    }
    expect(placements.some((p) => p.anchor === 'float.top-center')).toBe(false);
  });

  it('keeps Surface zoom compact with current/reset instead of sliders', () => {
    const prefixFor = (kindId: string): string => {
      if (kindId === 'froglight.ink') return 'ink';
      if (kindId === 'froglight.notebook') return 'notebook';
      return 'whiteboard';
    };
    for (const kindId of [
      'froglight.ink',
      'froglight.notebook',
      'froglight.whiteboard',
    ]) {
      const prefix = prefixFor(kindId);
      const placements = defaultToolbarPlacements().filter((p) =>
        p.kindIds?.includes(kindId),
      );
      const zoom = placements.find((p) => p.id.endsWith('.zoom'));
      expect(zoom?.anchor).toBe('float.bottom-right');
      expect(zoom?.controlIds).not.toContain(`${prefix}.zoom-slider`);
      expect(zoom?.controlIds).not.toContain(`${prefix}.zoom`);
      expect(zoom?.controlIds).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/zoom-out$/),
          expect.stringMatching(/zoom-reset$/),
          expect.stringMatching(/zoom-in$/),
          expect.stringMatching(/fit$/),
        ]),
      );
    }
  });

  it('keeps spatial navigation and zoom independent from tool selection', () => {
    const pool = [
      button('ink.tool.froglight.ink.pen', true),
      button('ink.color'),
      button('ink.zoom-in'),
    ];
    const ink = resolveProviderLayout({
      placements: defaultToolbarPlacements(),
      pool,
      context: context('froglight.ink', pool),
    });
    // Draw tools are composition-owned: no topbar-center placement remains.
    expect(ink.topbarCenter.map((c) => c.id)).toEqual([]);
    // legacy style properties are shelf-owned, so the geometric
    // top-center island stays empty while zoom still floats bottom-right.
    expect(ink.floating['float.top-center'].map((c) => c.id)).toEqual([]);
    expect(ink.floating['float.bottom-right'].map((c) => c.id)).toEqual([
      'ink.zoom-in',
    ]);
    expect(ink.unplaced).toContain('ink.tool.froglight.ink.pen');
    expect(ink.unplaced).toContain('ink.color');
  });

  it('keeps Ink and Notebook sizing out of floating navigation', () => {
    const inkPool = [
      button('ink.tool.froglight.ink.pen', true),
      button('ink.frame-width'),
      button('ink.frame-height'),
    ];
    const ink = resolveProviderLayout({
      placements: defaultToolbarPlacements(),
      pool: inkPool,
      context: context('froglight.ink', inkPool),
    });
    expect(ink.floating['float.bottom-left']).toEqual([]);
    const notebookPool = [
      button('notebook.tool.froglight.ink.pen', true),
      button('notebook.page-width'),
      button('notebook.page-height'),
    ];
    const notebook = resolveProviderLayout({
      placements: defaultToolbarPlacements(),
      pool: notebookPool,
      context: context('froglight.notebook', notebookPool),
    });
    expect(notebook.floating['float.bottom-left']).toEqual([]);
  });

  it('keeps LaTeX diagnostics floating top-right without a compile action', () => {
    const pool: DocumentToolControl[] = [
      button('latex.structure'),
      button('latex.bold'),
      {
        kind: 'diagnostics',
        id: 'latex.diagnostics',
        group: 'diagnostics',
        label: 'LaTeX no issues',
        state: 'clean',
        errorCount: 0,
        noteCount: 0,
        entries: [],
      },
    ];
    const layout = resolveProviderLayout({
      placements: defaultToolbarPlacements(),
      pool,
      context: context('froglight.latex', pool),
    });
    expect(layout.diagnostics).toEqual([]);
    expect(layout.floating['float.top-right'].map((c) => c.id)).toEqual([
      'latex.diagnostics',
    ]);
    // Structure/bold are composition-owned, hence geometrically unplaced.
    expect(layout.unplaced).toEqual(
      expect.arrayContaining(['latex.structure', 'latex.bold']),
    );
    const placed = defaultToolbarPlacements()
      .filter((placement) => placement.kindIds?.includes('froglight.latex'))
      .flatMap((placement) => [...placement.controlIds]);
    for (const id of placed) {
      expect(id).not.toMatch(/compile|export|pdf|bibliography|bibtex/i);
    }
    expect(placed).not.toContain('latex.compile-pdf');
  });

  it('leaves writing controls geometrically unplaced (composition-owned)', () => {
    const markdownPool = [
      'markdown.block',
      'markdown.bold',
      'markdown.link',
    ].map((id) => button(id));
    const markdown = resolveProviderLayout({
      placements: defaultToolbarPlacements(),
      pool: markdownPool,
      context: context('froglight.markdown', markdownPool),
    });
    expect(markdown.topbarCenter).toEqual([]);
    expect(markdown.floating['float.top-center']).toEqual([]);
    expect(markdown.unplaced).toEqual(
      expect.arrayContaining(['markdown.block', 'markdown.bold']),
    );
  });
});

// ---------------------------------------------------------------------------
// blockpage selection islands.
//
// Contextual edits for table/media/mathDiagram/columns surface secondarily
// at `float.selection` via add-only placement islands; creation
// (`block.insert.*`) stays shelf-only and is never islanded. Islands claim
// provider-exact control ids by `control.id` only, kind-blind (no
// `kindIds`), visible while an island control is enabled
// (`anyControlEnabled`-style `when`). The shelf keeps its generic
// single-owner skip (geometrically claimed ids render once, in the island)
// and the selection graph's `unresolved` + `diagnostics` merge into
// `layout.diagnostics`.
// ---------------------------------------------------------------------------

const TABLE_ISLAND_IDS = [
  'table.addRowBefore',
  'table.addRow',
  'table.addColumnBefore',
  'table.addColumn',
  'table.removeRow',
  'table.removeColumn',
  'table.moveRowUp',
  'table.moveRowDown',
  'table.moveColumnLeft',
  'table.moveColumnRight',
  'table.toggleHeader',
];

const MEDIA_ISLAND_IDS = [
  'media.name',
  'media.caption',
  'media.alt',
  'media.details',
  'media.replace',
  'media.remoteUrl',
  'media.clearRemote',
  'media.retry',
];

const MATH_DIAGRAM_ISLAND_IDS = [
  'math.edit',
  'math.source',
  'math.retry',
  'diagram.edit',
  'diagram.source',
  'diagram.retry',
];

const CREATION_INSERT_IDS = [
  'block.insert.table',
  'block.insert.image',
  'block.insert.video',
  'block.insert.audio',
  'block.insert.file',
  'block.insert.math',
  'block.insert.diagram',
];

function islandInput(id: string): DocumentToolControl {
  return {
    kind: 'input',
    id,
    group: 'test',
    label: id,
    placeholder: '',
    actionLabel: `Set ${id}`,
    semanticRole: id,
  } as unknown as DocumentToolControl;
}

function selectionPool(ids: readonly string[]): DocumentToolControl[] {
  return ids.map((id) =>
    id === 'math.source' ||
    id === 'diagram.source' ||
    id.startsWith('media.')
      ? islandInput(id)
      : semanticButton(id, id),
  );
}

function modelHarness(controls: readonly DocumentToolControl[]) {
  const contributions = createDocumentToolbarRegistry();
  const placements = createToolbarPlacementRegistry();
  for (const placement of defaultToolbarPlacements()) {
    placements.registry.register(placement);
  }
  const composition = createToolbarCompositionRegistry();
  const defaults = defaultToolbarComposition();
  for (const entry of defaults.categories)
    composition.registry.registerCategory(entry);
  for (const entry of defaults.items) composition.registry.registerItem(entry);
  for (const entry of defaults.extensions)
    composition.registry.registerKindExtension(entry);
  return { contributions, placements, composition };
}

function modelFor(
  controls: readonly DocumentToolControl[],
  kindId: string,
): ReturnType<typeof computeUnifiedToolbarModel> {
  const harness = modelHarness(controls);
  try {
    return computeUnifiedToolbarModel({
      tools: {
        onDidChange: () => ({ dispose: () => undefined }),
        execEditorCommand: () => false,
        canExecEditorCommand: () => false,
        editorToolSnapshot: () => ({
          context: 'test',
          controls: [...controls],
          contextualAnchor: { x: 40, y: 40, width: 120, height: 24 },
        }),
        executeEditorTool: () => true,
      } as unknown as WorkbenchEditorToolsPort,
      contributions: harness.contributions.registry,
      placements: harness.placements.registry,
      composition: harness.composition.registry,
      pane: 'main',
      documentId: 'doc-1',
      kindId,
    });
  } finally {
    harness.contributions.dispose();
    harness.placements.dispose();
    harness.composition.dispose();
  }
}

describe('defaultToolbarPlacements: blockpage selection islands', () => {
  it('declares four kind-blind float.selection islands with verbatim provider-exact ids', () => {
    const placements = defaultToolbarPlacements();
    const expected: Array<{
      id: string;
      order: number;
      controlIds: readonly string[];
    }> = [
      {
        id: 'froglight.toolbar-placement.selection.table',
        order: 33,
        controlIds: TABLE_ISLAND_IDS,
      },
      {
        id: 'froglight.toolbar-placement.selection.media',
        order: 35,
        controlIds: MEDIA_ISLAND_IDS,
      },
      {
        id: 'froglight.toolbar-placement.selection.math-diagram',
        order: 36,
        controlIds: MATH_DIAGRAM_ISLAND_IDS,
      },
    ];
    for (const { id, order, controlIds } of expected) {
      const found = placements.find((p) => p.id === id);
      expect(found, `missing island ${id}`).toBeDefined();
      expect(found?.anchor).toBe('float.selection');
      expect(found?.order).toBe(order);
      expect(found?.controlIds).toEqual(controlIds);
      expect(found?.priority).toBe(45);
      expect(found?.compact).toBe('auto');
      // Kind-blind: no kindIds, so any provider emitting these ids gets
      // the island; claiming keys on control.id only.
      expect(found?.kindIds).toBeUndefined();
      expect(typeof found?.when).toBe('function');
    }
  });

  it('never islands creation: no block.insert.* in any placement', () => {
    const placed = defaultToolbarPlacements().flatMap((p) => [...p.controlIds]);
    for (const id of placed) {
      expect(id.startsWith('block.insert.'), `${id} islanded`).toBe(false);
    }
    // Creation controls stay geometrically unplaced (shelf-owned): a
    // creation-only pool leaves every float.selection island dormant.
    const pool = CREATION_INSERT_IDS.map((id) => button(id));
    const layout = resolveProviderLayout({
      placements: defaultToolbarPlacements(),
      pool,
      context: context('froglight.blockpage', pool),
    });
    expect(layout.diagnostics).toEqual([]);
    expect(layout.floating['float.selection']).toEqual([]);
    expect(layout.unplaced).toEqual(
      expect.arrayContaining(CREATION_INSERT_IDS),
    );
  });

  it('claims table grid ops at float.selection, dormant with creation only', () => {
    const pool = selectionPool(TABLE_ISLAND_IDS);
    const layout = resolveProviderLayout({
      placements: defaultToolbarPlacements(),
      pool,
      context: context('froglight.blockpage', pool),
    });
    expect(layout.diagnostics).toEqual([]);
    expect(layout.floating['float.selection'].map((c) => c.id)).toEqual(
      TABLE_ISLAND_IDS,
    );
    expect(layout.topbarCenter).toEqual([]);
    expect(layout.floating['float.top-center']).toEqual([]);
  });

  it('claims media payload edits with image-root dormancy and no gaps', () => {
    const pool = selectionPool(MEDIA_ISLAND_IDS);
    const shown = resolveProviderLayout({
      placements: defaultToolbarPlacements(),
      pool,
      context: context('froglight.blockpage', pool),
    });
    expect(shown.diagnostics).toEqual([]);
    expect(shown.floating['float.selection'].map((c) => c.id)).toEqual(
      MEDIA_ISLAND_IDS,
    );
    // Image roots omit name/remote/clear-remote provider-side: the island
    // keeps caption/alt/retry in placement order, never placeholders.
    const imagePool = selectionPool([
      'media.caption',
      'media.alt',
      'media.replace',
      'media.retry',
    ]);
    const image = resolveProviderLayout({
      placements: defaultToolbarPlacements(),
      pool: imagePool,
      context: context('froglight.blockpage', imagePool),
    });
    expect(image.diagnostics).toEqual([]);
    expect(image.floating['float.selection'].map((c) => c.id)).toEqual([
      'media.caption',
      'media.alt',
      'media.replace',
      'media.retry',
    ]);
  });

  it('claims one math/diagram pair at a time, never synthesized', () => {
    const mathPool = selectionPool(['math.source', 'math.retry']);
    const math = resolveProviderLayout({
      placements: defaultToolbarPlacements(),
      pool: mathPool,
      context: context('froglight.blockpage', mathPool),
    });
    expect(math.diagnostics).toEqual([]);
    expect(math.floating['float.selection'].map((c) => c.id)).toEqual([
      'math.source',
      'math.retry',
    ]);
    const diagramPool = selectionPool(['diagram.source', 'diagram.retry']);
    const diagram = resolveProviderLayout({
      placements: defaultToolbarPlacements(),
      pool: diagramPool,
      context: context('froglight.blockpage', diagramPool),
    });
    expect(diagram.diagnostics).toEqual([]);
    expect(diagram.floating['float.selection'].map((c) => c.id)).toEqual([
      'diagram.source',
      'diagram.retry',
    ]);
  });



  it('stays kind-blind: identical claims under a foreign kind', () => {
    const pool = TABLE_ISLAND_IDS.map((id) => button(id));
    const layout = resolveProviderLayout({
      placements: defaultToolbarPlacements(),
      pool,
      context: context('froglight.markdown', pool),
    });
    expect(layout.diagnostics).toEqual([]);
    expect(layout.floating['float.selection'].map((c) => c.id)).toEqual(
      TABLE_ISLAND_IDS,
    );
  });

  it('keeps the island alive on edge-disabled geometry, dormant when all disabled', () => {
    // Provider edge-disabled moves (first row/column) must not eject the
    // island while enabled peers remain.
    const partial = TABLE_ISLAND_IDS.map((id) =>
      id === 'table.moveRowUp' || id === 'table.moveColumnLeft'
        ? { ...semanticButton(id, id), disabled: true as const }
        : semanticButton(id, id),
    );
    const kept = resolveProviderLayout({
      placements: defaultToolbarPlacements(),
      pool: partial,
      context: context('froglight.blockpage', partial),
    });
    expect(kept.floating['float.selection'].map((c) => c.id)).toEqual(
      TABLE_ISLAND_IDS,
    );
    // Fully disabled: anyControlEnabled-style `when` hides the island.
    const dormant = TABLE_ISLAND_IDS.map((id) => ({
      ...semanticButton(id, id),
      disabled: true as const,
    }));
    const hidden = resolveProviderLayout({
      placements: defaultToolbarPlacements(),
      pool: dormant,
      context: context('froglight.blockpage', dormant),
    });
    expect(hidden.floating['float.selection']).toEqual([]);
  });

  it('wires selection unresolved + single-owner diagnostics into layout.diagnostics', () => {
    const pool = selectionPool(TABLE_ISLAND_IDS);
    const model = modelFor(pool, 'froglight.blockpage');
    // Island owns the table grid ops geometrically.
    const island = model.layout.groups.find(
      (group) => group.id === 'froglight.toolbar-placement.selection.table',
    );
    expect(island?.anchor).toBe('float.selection');
    expect(island?.controls.map((owned) => owned.control.id)).toEqual(
      TABLE_ISLAND_IDS,
    );
    // selection-only dormancy surfaces through layout.diagnostics.
    // These ids carry the `selection` projection only, so the normal shelf
    // graph can never report them — their presence proves the selection
    // graph is resolved in production, not just in unit specs.
    expect(model.layout.diagnostics).toContain(
      "unresolved toolbar item 'writing.insert.media.name'",
    );
    expect(model.layout.diagnostics).toContain(
      "unresolved toolbar item 'writing.insert.diagram.source'",
    );
    // island-claimed selection controls report single ownership
    // (mechanism, `composition selection` presenter) — never silent,
    // never double-rendered.
    expect(model.layout.diagnostics).toContain(
      "duplicate toolbar control 'table.addRow' in composition selection " +
        "'writing.structure.table.add-row' (already owned by geometric " +
        "placement 'froglight.toolbar-placement.selection.table')",
    );
    // Exactly once per surface: every island-claimed id lives in exactly
    // one resolved group (the shelf keeps its generic skip for the same
    // claimed set, so no second owner can present it).
    const claimedCounts = new Map<string, number>();
    for (const group of model.layout.groups) {
      for (const owned of group.controls) {
        claimedCounts.set(
          owned.control.id,
          (claimedCounts.get(owned.control.id) ?? 0) + 1,
        );
      }
    }
    for (const id of TABLE_ISLAND_IDS) {
      expect(claimedCounts.get(id)).toBe(1);
    }
    // Creation stays out of every geometric group (shelf-only one-path).
    for (const group of model.layout.groups) {
      for (const owned of group.controls) {
        expect(owned.control.id.startsWith('block.insert.')).toBe(false);
      }
    }
  });
});
