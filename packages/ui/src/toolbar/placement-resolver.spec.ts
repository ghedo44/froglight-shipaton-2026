/**
 * Tests for the unified toolbar placement resolver.
 *
 * The resolver is a pure function over the flat semantic control pool plus
 * the active placement contributions. These tests pin single-owner conflict
 * behavior, deterministic anchor/order resolution, kind/context filtering,
 * absent-control tolerance, and the empty (no flat fallback) degradation for
 * kinds without placements.
 */

import { describe, expect, it } from 'vitest';
import type { DocumentToolControl } from '@froglight/foundation';
import type { DocumentToolbarContext } from '../document-toolbar-registry.js';
import type { ToolbarPlacementContribution } from './placement-registry.js';
import {
  bucketStripGroupsForResolver,
  dedupeGroupedSqueezeEntries,
  effectiveShelfSlotIdForResolver,
  effectiveStripGroupIdForResolver,
  exclusiveActiveControlIdForEntries,
  GROUPED_SQUEEZE_MAX_PRIMARY,
  groupedSqueezeTierForEntry,
  liveSettingsForActiveTool,
  partitionGroupedShelf,
  assembleOwnedPool,
  resolveToolbarGroups,
  splitGroupedSqueezeItems,
  verbatimShelfItemOrder,
  type GroupedSqueezeEntry,
  type ShelfCapacityCell,
} from './placement-resolver.js';
import type {
  ResolvedToolbarGraph,
  ResolvedToolbarSettings,
} from './composition-registry.js';
import { SQUEEZE_MAX_PRIMARY } from '../stylus-palette-model.js';

const button = (id: string): DocumentToolControl => ({
  kind: 'button',
  id,
  group: 'test',
  label: id,
});

function context(kindId: string): DocumentToolbarContext {
  return {
    pane: 'main',
    documentId: 'doc-1',
    kindId,
    editor: { context: 'Paragraph', controls: [] },
  };
}

describe('resolveToolbarGroups', () => {
  const resolveProviderControls = (input: {
    readonly placements: readonly ToolbarPlacementContribution[];
    readonly pool: readonly DocumentToolControl[];
    readonly context: DocumentToolbarContext;
  }) =>
    resolveToolbarGroups({
      placements: input.placements,
      ownedPool: assembleOwnedPool({
        providerControls: input.pool,
      }).ownedPool,
      context: input.context,
    });

  const controlsAt = (
    groups: ReturnType<typeof resolveToolbarGroups>['groups'],
    anchor: ToolbarPlacementContribution['anchor'],
  ) =>
    groups
      .filter((group) => group.anchor === anchor)
      .flatMap((group) => group.controls.map((owned) => owned.control));

  it('degrades to no groups when no placement matches the kind', () => {
    const resolved = resolveProviderControls({
      placements: [],
      pool: [button('a'), button('b')],
      context: context('froglight.unknown'),
    });
    expect(resolved.groups).toEqual([]);
    expect(resolved.unplaced).toEqual(['a', 'b']);
  });

  it('resolves controls into the requested anchors in placement/control order', () => {
    const placements: ToolbarPlacementContribution[] = [
      {
        id: 'second',
        anchor: 'topbar-center',
        order: 20,
        controlIds: ['b'],
      },
      {
        id: 'first',
        anchor: 'float.top-center',
        order: 5,
        controlIds: ['a', 'missing.control'],
      },
    ];
    const resolved = resolveProviderControls({
      placements,
      pool: [button('a'), button('b')],
      context: context('froglight.markdown'),
    });
    expect(
      controlsAt(resolved.groups, 'float.top-center').map((c) => c.id),
    ).toEqual(['a']);
    expect(
      controlsAt(resolved.groups, 'topbar-center').map((c) => c.id),
    ).toEqual(['b']);
  });

  it('filters placements by kindIds and when predicates', () => {
    const placements: ToolbarPlacementContribution[] = [
      {
        id: 'ink-only',
        kindIds: ['froglight.ink'],
        anchor: 'topbar-center',
        controlIds: ['ink.tool'],
      },
      {
        id: 'conditional',
        anchor: 'float.top-center',
        controlIds: ['markdown.bold'],
        when: ({ editor }) => editor?.context === 'Markdown heading 2',
      },
    ];
    const inkLayout = resolveProviderControls({
      placements,
      pool: [button('ink.tool'), button('markdown.bold')],
      context: context('froglight.ink'),
    });
    expect(
      controlsAt(inkLayout.groups, 'topbar-center').map((c) => c.id),
    ).toEqual(['ink.tool']);
    expect(controlsAt(inkLayout.groups, 'float.top-center')).toEqual([]);

    const headingLayout = resolveProviderControls({
      placements,
      pool: [button('markdown.bold')],
      context: {
        pane: 'main',
        documentId: 'doc-1',
        kindId: 'froglight.markdown',
        editor: { context: 'Markdown heading 2', controls: [] },
      },
    });
    expect(
      controlsAt(headingLayout.groups, 'float.top-center').map((c) => c.id),
    ).toEqual(['markdown.bold']);
  });

  it('renders one visible owner per control id and reports duplicates', () => {
    const placements: ToolbarPlacementContribution[] = [
      {
        id: 'a-first',
        anchor: 'topbar-center',
        order: 1,
        controlIds: ['shared'],
      },
      {
        id: 'b-second',
        anchor: 'float.top-center',
        order: 2,
        controlIds: ['shared'],
      },
    ];
    const resolved = resolveProviderControls({
      placements,
      pool: [button('shared')],
      context: context('froglight.markdown'),
    });
    expect(
      controlsAt(resolved.groups, 'topbar-center').map((c) => c.id),
    ).toEqual(['shared']);
    expect(controlsAt(resolved.groups, 'float.top-center')).toEqual([]);
    expect(resolved.diagnostics.length).toBe(1);
    expect(resolved.diagnostics[0]).toContain('shared');
    expect(resolved.diagnostics[0]).toContain('b-second');
  });

  it('concatenates multiple groups at one anchor in deterministic order', () => {
    const placements: ToolbarPlacementContribution[] = [
      {
        id: 'b',
        anchor: 'float.bottom-right',
        order: 2,
        controlIds: ['zoom-in'],
      },
      {
        id: 'a',
        anchor: 'float.bottom-right',
        order: 1,
        controlIds: ['zoom-out'],
      },
    ];
    const resolved = resolveProviderControls({
      placements,
      pool: [button('zoom-out'), button('zoom-in')],
      context: context('froglight.ink'),
    });
    expect(
      controlsAt(resolved.groups, 'float.bottom-right').map((c) => c.id),
    ).toEqual(['zoom-out', 'zoom-in']);
  });
});

describe('grouped squeeze projection', () => {
  function squeezeEntry(
    id: string,
    controlId: string,
    extra: Partial<Extract<DocumentToolControl, { kind: 'button' }>> = {},
  ): GroupedSqueezeEntry {
    return {
      id,
      control: {
        kind: 'button',
        id: controlId,
        group: 'draw',
        label: id,
        ...extra,
      },
    };
  }

  /** Realistic full Surface squeeze order (composition order). */
  function fullSurfaceEntries(activeControlId: string): GroupedSqueezeEntry[] {
    const defs: Array<
      [
        string,
        string,
        Partial<Extract<DocumentToolControl, { kind: 'button' }>>,
      ]
    > = [
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
      squeezeEntry(id, controlId, {
        ...meta,
        ...(controlId === activeControlId
          ? { active: true as const, activationRole: 'tool' as const }
          : {}),
      }),
    );
  }

  const entryIds = (entries: readonly GroupedSqueezeEntry[]): string[] =>
    entries.map((entry) => entry.id);

  it('pins the single-row bound to the stylus crescent (no second row)', () => {
    expect(GROUPED_SQUEEZE_MAX_PRIMARY).toBe(5);
    expect(GROUPED_SQUEEZE_MAX_PRIMARY).toBe(SQUEEZE_MAX_PRIMARY);
  });

  it('bounds the crescent to one row with pen siblings sharing one slot', () => {
    const entries = fullSurfaceEntries('ink.tool.pen.ball');
    const { primary, secondary } = splitGroupedSqueezeItems(entries, {
      activeControlId: 'ink.tool.pen.ball',
    });
    expect(primary.length).toBeLessThanOrEqual(GROUPED_SQUEEZE_MAX_PRIMARY);
    expect(primary.length).toBe(5);
    expect(entryIds(primary)).toEqual([
      'pen.ball',
      'highlighter',
      'eraser',
      'select',
      'shape.line',
    ]);
    expect(entryIds(secondary)).toEqual([
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
    // Partition covers every entry exactly once: overflow goes to the
    // secondary strip / More, never into a second full-width row.
    expect([...primary, ...secondary]).toHaveLength(entries.length);
    expect(primary.length).toBeLessThanOrEqual(5);
  });

  it('dedupes the Text dual presenter by control id, first wins', () => {
    const sharedControl = {
      kind: 'button',
      id: 'ink.tool.text.create',
      group: 'draw',
      label: 'Text',
      toolRole: 'text',
      semanticRole: 'surface.insert.text',
    } as const;
    const entries: GroupedSqueezeEntry[] = [
      { id: 'surface.insert.text', control: { ...sharedControl } },
      {
        id: 'surface.text.create',
        control: { ...sharedControl },
        slotId: 'slot:text',
      },
    ];
    const deduped = dedupeGroupedSqueezeEntries(entries);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.id).toBe('surface.insert.text');
    const split = splitGroupedSqueezeItems(entries, { activeControlId: null });
    expect([...split.primary, ...split.secondary]).toHaveLength(1);
  });

  it('tracks active changes without reordering inside each tier', () => {
    const fountainActive = splitGroupedSqueezeItems(
      fullSurfaceEntries('ink.tool.pen.fountain'),
      { activeControlId: 'ink.tool.pen.fountain' },
    );
    expect(entryIds(fountainActive.primary)).toEqual([
      'pen.fountain',
      'highlighter',
      'eraser',
      'select',
      'shape.line',
    ]);
    expect(entryIds(fountainActive.secondary)).toContain('pen.ball');

    const rectActive = splitGroupedSqueezeItems(
      fullSurfaceEntries('ink.tool.shape.rectangle'),
      { activeControlId: 'ink.tool.shape.rectangle' },
    );
    expect(entryIds(rectActive.primary)).toEqual([
      'pen.ball',
      'highlighter',
      'eraser',
      'select',
      'shape.rect',
    ]);

    const lassoActive = splitGroupedSqueezeItems(
      fullSurfaceEntries('ink.tool.lasso'),
      { activeControlId: 'ink.tool.lasso' },
    );
    expect(entryIds(lassoActive.primary)).toContain('lasso');
    expect(entryIds(lassoActive.primary)).not.toContain('select');
    expect(entryIds(lassoActive.secondary)).toContain('select');
  });

  it('keeps role-less community commands secondary even when active', () => {
    const entries = fullSurfaceEntries(
      'community.example.diagram.diamond.command',
    );
    const { primary, secondary } = splitGroupedSqueezeItems(entries, {
      activeControlId: 'community.example.diagram.diamond.command',
    });
    expect(entryIds(primary)).toEqual([
      'pen.ball',
      'highlighter',
      'eraser',
      'select',
      'shape.line',
    ]);
    expect(entryIds(secondary)).toContain('community');
    expect(primary.length).toBeLessThanOrEqual(GROUPED_SQUEEZE_MAX_PRIMARY);
  });

  it('preserves composition order verbatim inside each tier', () => {
    const entries = fullSurfaceEntries('ink.tool.pen.ball').reverse();
    const { primary, secondary } = splitGroupedSqueezeItems(entries, {
      activeControlId: 'ink.tool.pen.ball',
    });
    const indexOf = new Map(entries.map((entry, index) => [entry.id, index]));
    const isOrdered = (list: readonly GroupedSqueezeEntry[]): boolean =>
      list.every(
        (entry, i, arr) =>
          i === 0 ||
          (indexOf.get(arr[i - 1]?.id ?? '') ?? 0) <
            (indexOf.get(entry.id) ?? 0),
      );
    expect(isOrdered(primary)).toBe(true);
    expect(isOrdered(secondary)).toBe(true);
  });

  it('keys tiers on toolRole/semanticRole only, never id text', () => {
    for (const toolRole of [
      'pen',
      'highlighter',
      'eraser',
      'select',
      'lasso',
    ] as const) {
      expect(
        groupedSqueezeTierForEntry(
          squeezeEntry(`weird.id.${toolRole}`, `odd-control-${toolRole}`, {
            toolRole,
          }),
        ),
      ).toBe('primary');
    }
    // Misleading ids never promote: a pen-labeled community command with
    // no toolRole stays secondary even when its id screams "pen".
    expect(
      groupedSqueezeTierForEntry(
        squeezeEntry('pen.ball', 'community.tool.pen.ball', {
          semanticRole: 'community.example.pen',
        }),
      ),
    ).toBe('secondary');
    expect(
      groupedSqueezeTierForEntry(
        squeezeEntry('shape', 'x', {
          toolRole: 'shape',
          semanticRole: 'surface.shape.line',
        }),
      ),
    ).toBe('secondary');
  });

  it('preserves grouping passthrough and returns structure without execution', () => {
    const entries: GroupedSqueezeEntry[] = [
      {
        id: 'surface.write.ball',
        control: {
          kind: 'button',
          id: 'ink.tool.pen.ball',
          group: 'draw',
          label: 'Ball Pen',
          toolRole: 'pen',
          semanticRole: 'surface.pen.ball',
        },
        slotId: 'slot:pen:0',
      },
    ];
    const { primary } = splitGroupedSqueezeItems(entries);
    expect(primary[0]).toBe(entries[0]);
    expect(primary[0]?.slotId).toBe('slot:pen:0');
    for (const entry of [...primary]) {
      expect(entry.control).not.toHaveProperty('execute');
      expect(typeof (entry as Record<string, unknown>)['execute']).toBe(
        'undefined',
      );
    }
  });

  it('does not mutate inputs (pure projection)', () => {
    const entries = fullSurfaceEntries('ink.tool.pen.ball');
    const snapshot = entries.map((entry) => entry.id);
    splitGroupedSqueezeItems(entries, { activeControlId: 'ink.tool.lasso' });
    dedupeGroupedSqueezeEntries(entries);
    expect(entries.map((entry) => entry.id)).toEqual(snapshot);
  });
});

describe('verbatim shelf order (no active-first)', () => {
  const categoryItems = [
    { id: 'surface.write.ball', control: { id: 'ink.tool.pen.ball' } },
    { id: 'surface.write.fountain', control: { id: 'ink.tool.pen.fountain' } },
    { id: 'surface.write.brush', control: { id: 'ink.tool.pen.brush' } },
    { id: 'surface.write.pencil', control: { id: 'ink.tool.pen.pencil' } },
    {
      id: 'surface.write.highlighter',
      control: { id: 'ink.tool.pen.highlighter' },
    },
  ] as const;

  it('keeps composition order across 5+ active switches (active marked in place)', () => {
    const baseline = categoryItems.map((item) => item.id);
    const actives = [
      'ink.tool.pen.ball',
      'ink.tool.pen.fountain',
      'ink.tool.pen.brush',
      'ink.tool.pen.pencil',
      'ink.tool.pen.highlighter',
      'ink.tool.pen.ball',
    ];
    for (const activeId of actives) {
      const ordered = verbatimShelfItemOrder([...categoryItems]);
      expect(ordered.map((item: { id: string }) => item.id)).toEqual(baseline);
      // Active is marked where it sits (presenters use aria-pressed /
      // data-contains-active-tool); the sequence itself never moves.
      const activeIndex = ordered.findIndex(
        (item: { control: { id: string } }) => item.control.id === activeId,
      );
      expect(activeIndex).toBeGreaterThanOrEqual(0);
      expect(ordered).not.toBe(categoryItems);
    }
  });

  it('derives the exclusive active id without toggle hijack', () => {
    const entries: GroupedSqueezeEntry[] = [
      {
        id: 'bold',
        control: {
          kind: 'button',
          id: 'md.bold',
          group: 'format',
          label: 'Bold',
          active: true,
          activationRole: 'toggle',
        },
      },
      {
        id: 'pen',
        control: {
          kind: 'button',
          id: 'ink.tool.pen.ball',
          group: 'draw',
          label: 'Ball Pen',
          toolRole: 'pen',
          semanticRole: 'surface.pen.ball',
          active: true,
          activationRole: 'tool',
        },
      },
    ];
    expect(exclusiveActiveControlIdForEntries(entries)).toBe(
      'ink.tool.pen.ball',
    );
    const togglesOnly: GroupedSqueezeEntry[] = [
      entries[0] as GroupedSqueezeEntry,
    ];
    expect(exclusiveActiveControlIdForEntries(togglesOnly)).toBeNull();
    expect(exclusiveActiveControlIdForEntries([])).toBeNull();
  });
});

describe('grouped shelf partition via shared planner', () => {
  function d013Cells(): ShelfCapacityCell[] {
    return [
      {
        id: 'shelf:tool:active',
        order: 0,
        priority: 100,
        width: 48,
        required: true,
      },
      {
        id: 'shelf:settings',
        order: 5,
        priority: 95,
        width: 44,
        required: true,
      },
      { id: 'shelf:tool:sibling', order: 1, priority: 90, width: 48 },
      { id: 'shelf:favorites', order: 6, priority: 70, width: 136 },
      { id: 'shelf:widths', order: 7, priority: 60, width: 148 },
      { id: 'shelf:colors', order: 8, priority: 55, width: 244 },
      { id: 'shelf:mode:0', order: 9, priority: 40, width: 128 },
    ];
  }

  it('keeps required cells inline and overflows lowest priority first', () => {
    const planned = partitionGroupedShelf(d013Cells(), 500, {
      overflowWidth: 44,
      overflowGap: 4,
    });
    expect(planned.visible).toContain('shelf:tool:active');
    expect(planned.visible).toContain('shelf:settings');
    // Lowest priority overflows before higher-priority quicks.
    expect(planned.overflow).toContain('shelf:mode:0');
    // Partition covers every cell exactly once: visible + overflow is the
    // whole shelf, never a second row.
    const all = new Set([...planned.visible, ...planned.overflow]);
    expect(all.size).toBe(d013Cells().length);
    expect(
      planned.visible.filter((id: string) => planned.overflow.includes(id)),
    ).toEqual([]);
  });

  it('holds overflowed cells across 1px dither with hysteresis', () => {
    const cells: ShelfCapacityCell[] = [
      { id: 'shelf:tool:b', order: 0, priority: 90, width: 100 },
      { id: 'shelf:colors', order: 1, priority: 55, width: 100 },
    ];
    const tight = partitionGroupedShelf(cells, 144, {
      overflowWidth: 40,
      overflowGap: 4,
    });
    expect(tight.overflow).toEqual(['shelf:colors']);
    const held = partitionGroupedShelf(cells, 145, {
      overflowWidth: 40,
      overflowGap: 4,
      hysteresis: 8,
      overflowIds: new Set(tight.overflow),
    });
    expect(held.overflow).toEqual(['shelf:colors']);
    const returned = partitionGroupedShelf(cells, 260, {
      overflowWidth: 40,
      overflowGap: 4,
      hysteresis: 8,
      overflowIds: new Set(tight.overflow),
    });
    expect(returned.overflow).toEqual([]);
  });

  it('treats non-finite budgets as unmeasured first paint (show-all, no row)', () => {
    for (const budget of [Number.NaN, -1]) {
      const planned = partitionGroupedShelf(d013Cells(), budget, {
        overflowWidth: 44,
      });
      expect(planned.overflow).toEqual([]);
      expect(planned.visible).toHaveLength(d013Cells().length);
    }
  });
});

describe('grouping preservation via fallbacks (before/after/user-order intact)', () => {
  it('buckets strip groups first-seen without re-sorting members', () => {
    const categories = [
      { id: 'surface.write', groupId: 'draw' },
      { id: 'surface.erase', groupId: 'draw' },
      { id: 'surface.select' },
    ];
    expect(
      effectiveStripGroupIdForResolver(
        categories[0] as { id: string; groupId?: string },
      ),
    ).toBe('draw');
    expect(
      effectiveStripGroupIdForResolver(
        categories[2] as { id: string; groupId?: string },
      ),
    ).toBe('surface.select');
    expect(effectiveStripGroupIdForResolver({ id: 'x', groupId: '  ' })).toBe(
      'x',
    );
    const bucketed = bucketStripGroupsForResolver(categories);
    expect([...bucketed.keys()]).toEqual(['draw', 'surface.select']);
    expect(
      bucketed.get('draw')?.map((entry: { id: string }) => entry.id),
    ).toEqual(['surface.write', 'surface.erase']);
  });

  it('keys shelf slots without re-sorting (verbatim order authority)', () => {
    expect(
      effectiveShelfSlotIdForResolver({ id: 'a', slotId: 'slot:pen:0' }),
    ).toBe('slot:pen:0');
    expect(effectiveShelfSlotIdForResolver({ id: 'b' })).toBe('b');
    expect(effectiveShelfSlotIdForResolver({ id: 'c', slotId: '  ' })).toBe(
      'c',
    );
  });
});

describe('target-scoped shelf settings (Repair 2 semanticRole-only)', () => {
  function graphWithSettings(): ResolvedToolbarGraph {
    const tool = (id: string, semanticRole: string): DocumentToolControl => ({
      kind: 'button',
      id,
      group: 'draw',
      label: id,
      toolRole: 'pen',
      semanticRole,
      activationRole: 'tool',
    });
    const setting = (
      id: string,
      target: string,
      role: string,
    ): ResolvedToolbarSettings => ({
      id,
      targetSemanticRole: target,
      semanticRole: role,
      order: 0,
      priority: 0,
      projections: ['normal', 'compact'],
      control: {
        kind: 'choice',
        id: `${id}.control`,
        group: 'settings',
        label: id,
        value: 'a',
        options: [{ value: 'a', label: 'A' }],
        semanticRole: role,
      } as DocumentToolControl,
    });
    return {
      familyIds: ['surface'],
      categories: [
        {
          id: 'surface.write',
          label: 'Write',
          icon: 'pen',
          familyId: 'surface',
          order: 10,
          priority: 100,
          items: [
            {
              id: 'pen.ball',
              semanticRole: 'surface.pen.ball',
              order: 10,
              priority: 0,
              projections: ['normal'],
              control: tool('ink.pen.ball', 'surface.pen.ball'),
            },
          ],
        },
      ],
      settings: [
        setting('pen.color', 'surface.pen.ball', 'surface.settings.color'),
      ],
      unresolved: ['eraser.size'],
      diagnostics: [],
    };
  }

  it('scopes live settings to the active tool role; dormant stays unresolved', () => {
    const graph = graphWithSettings();
    expect(
      liveSettingsForActiveTool(graph, 'surface.pen.ball').map(
        (entry: { id: string }) => entry.id,
      ),
    ).toEqual(['pen.color']);
    expect(liveSettingsForActiveTool(graph, 'surface.erase')).toEqual([]);
    expect(graph.unresolved).toContain('eraser.size');
    expect(liveSettingsForActiveTool(null, 'surface.pen.ball')).toEqual([]);
    expect(liveSettingsForActiveTool(graph, null)).toEqual([]);
    expect(liveSettingsForActiveTool(graph, '')).toEqual([]);
  });
});
