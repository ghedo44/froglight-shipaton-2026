import { describe, expect, it } from 'vitest';
import {
  createToolbarCompositionRegistry,
  groupCategoriesByStripGroup,
  resolveToolbarComposition,
  slotIdForItem,
  stripGroupIdForCategory,
  type ResolvedToolbarGraph,
} from './composition-registry.js';

const category = {
  id: 'surface.write',
  familyId: 'surface',
  label: 'Write',
  icon: 'pen',
};
const item = {
  id: 'surface.write.fountain',
  categoryId: category.id,
  semanticRole: 'surface.pen.fountain',
  projections: ['normal', 'squeeze'] as const,
};

describe('toolbar composition registry', () => {
  it('shadows and restores contributions deterministically', () => {
    const created = createToolbarCompositionRegistry();
    const first = created.registry.registerCategory(category);
    const second = created.registry.registerCategory({
      ...category,
      label: 'Draw',
    });
    expect(created.registry.snapshot().categories[0]?.label).toBe('Draw');
    second.dispose();
    expect(created.registry.snapshot().categories[0]?.label).toBe('Write');
    first.dispose();
    expect(created.registry.snapshot().categories).toEqual([]);
  });

  it('keeps cross-plugin items dormant and restores them with their category', () => {
    const created = createToolbarCompositionRegistry();
    const itemOwner = created.registry.registerItem(item);
    const kindOwner = created.registry.registerKindExtension({
      id: 'ink-family',
      kindIds: ['froglight.ink'],
      familyIds: ['surface'],
    });
    const controls = [
      {
        kind: 'button',
        id: 'ink.fountain',
        group: 'draw',
        label: 'Fountain Pen',
        semanticRole: 'surface.pen.fountain',
      },
    ] as const;
    expect(
      resolveToolbarComposition({
        snapshot: created.registry.snapshot(),
        kindId: 'froglight.ink',
        controls,
      }).categories,
    ).toEqual([]);
    const categoryOwner = created.registry.registerCategory(category);
    expect(
      resolveToolbarComposition({
        snapshot: created.registry.snapshot(),
        kindId: 'froglight.ink',
        controls,
      }).categories[0]?.items[0]?.control.id,
    ).toBe('ink.fountain');
    categoryOwner.dispose();
    expect(
      resolveToolbarComposition({
        snapshot: created.registry.snapshot(),
        kindId: 'froglight.ink',
        controls,
      }).unresolved,
    ).toContain(item.id);
    const restored = created.registry.registerCategory(category);
    expect(
      resolveToolbarComposition({
        snapshot: created.registry.snapshot(),
        kindId: 'froglight.ink',
        controls,
      }).categories,
    ).toHaveLength(1);
    restored.dispose();
    kindOwner.dispose();
    itemOwner.dispose();
  });

  it('uses one semantic graph for normal and squeeze projections', () => {
    const snapshot = {
      categories: [category],
      items: [item],
      extensions: [
        {
          id: 'surface-kind',
          kindIds: ['froglight.ink'],
          familyIds: ['surface'],
        },
      ],
    };
    const controls = [
      {
        kind: 'button',
        id: 'provider.fountain',
        group: 'draw',
        label: 'Fountain Pen',
        semanticRole: 'surface.pen.fountain',
      },
    ] as const;
    const normal = resolveToolbarComposition({
      snapshot,
      kindId: 'froglight.ink',
      controls,
      projection: 'normal',
    });
    const squeeze = resolveToolbarComposition({
      snapshot,
      kindId: 'froglight.ink',
      controls,
      projection: 'squeeze',
    });
    expect(squeeze.categories[0]?.items[0]?.control).toBe(
      normal.categories[0]?.items[0]?.control,
    );
  });
});

describe('toolbar strip grouping/slot contract', () => {
  const writeCategory = {
    id: 'surface.write',
    familyId: 'surface',
    label: 'Write',
    icon: 'pen',
    order: 10,
  };
  const eraseCategory = {
    id: 'surface.erase',
    familyId: 'surface',
    label: 'Erase',
    icon: 'eraser',
    order: 20,
  };
  const familyExtension = {
    id: 'surface.ink',
    kindIds: ['froglight.ink'],
    familyIds: ['surface'],
  };
  const fountainControls = [
    {
      kind: 'button',
      id: 'ink.fountain',
      group: 'draw',
      label: 'Fountain Pen',
      semanticRole: 'surface.pen.fountain',
    },
    {
      kind: 'button',
      id: 'ink.ball',
      group: 'draw',
      label: 'Ball Pen',
      semanticRole: 'surface.pen.ball',
    },
    {
      kind: 'button',
      id: 'ink.eraser',
      group: 'draw',
      label: 'Eraser',
      semanticRole: 'surface.erase',
    },
  ] as const;

  /** Resolved graph minus grouping/slot metadata (explicit allowlist). */
  const withoutGroupingMeta = (graph: ResolvedToolbarGraph) => ({
    familyIds: graph.familyIds,
    unresolved: graph.unresolved,
    diagnostics: graph.diagnostics,
    settings: graph.settings,
    categories: graph.categories.map((category) => ({
      id: category.id,
      label: category.label,
      icon: category.icon,
      familyId: category.familyId,
      order: category.order,
      priority: category.priority,
      items: category.items.map((item) => ({
        id: item.id,
        semanticRole: item.semanticRole,
        order: item.order,
        priority: item.priority,
        projections: item.projections,
        control: item.control,
      })),
    })),
  });

  it('passes groupId/slotId through verbatim; ungrouped graphs stay identical', () => {
    const grouped = {
      categories: [
        { ...writeCategory, groupId: 'strip.draw' },
        { ...eraseCategory, groupId: 'strip.erase' },
      ],
      items: [
        {
          id: 'surface.write.fountain',
          categoryId: writeCategory.id,
          semanticRole: 'surface.pen.fountain',
          order: 20,
          slotId: 'pen-slot-2',
        },
        {
          id: 'surface.write.ball',
          categoryId: writeCategory.id,
          semanticRole: 'surface.pen.ball',
          order: 10,
          slotId: 'pen-slot-1',
        },
        {
          id: 'surface.erase.tool',
          categoryId: eraseCategory.id,
          semanticRole: 'surface.erase',
          order: 10,
        },
      ],
      extensions: [familyExtension],
    };
    const plain = {
      categories: [writeCategory, eraseCategory],
      items: grouped.items.map(({ slotId: _slot, ...item }) => {
        void _slot;
        return item;
      }),
      extensions: [familyExtension],
    };
    const groupedGraph = resolveToolbarComposition({
      snapshot: {
        categories: grouped.categories,
        items: grouped.items,
        extensions: grouped.extensions,
      },
      kindId: 'froglight.ink',
      controls: fountainControls,
    });
    expect(groupedGraph.categories[0]?.groupId).toBe('strip.draw');
    expect(groupedGraph.categories[1]?.groupId).toBe('strip.erase');
    expect(
      groupedGraph.categories[0]?.items.map((item) => item.slotId),
    ).toEqual(['pen-slot-1', 'pen-slot-2']);
    expect(
      groupedGraph.categories[1]?.items[0]?.slotId,
    ).toBeUndefined();
    const plainGraph = resolveToolbarComposition({
      snapshot: plain,
      kindId: 'froglight.ink',
      controls: fountainControls,
    });
    expect(plainGraph.categories[0]?.groupId).toBeUndefined();
    expect(plainGraph.categories[0]?.items[0]?.slotId).toBeUndefined();
    // Same contributions minus metadata resolve identically.
    expect(withoutGroupingMeta(groupedGraph)).toEqual(
      withoutGroupingMeta(plainGraph),
    );
  });

  it('never reorders by groupId/slotId: order/priority stay authoritative', () => {
    const snapshot = {
      categories: [
        { ...eraseCategory, groupId: 'strip.a' },
        { ...writeCategory, groupId: 'strip.b' },
      ],
      items: [
        {
          id: 'surface.write.fountain',
          categoryId: writeCategory.id,
          semanticRole: 'surface.pen.fountain',
          order: 20,
          slotId: 'pen-slot-1',
        },
        {
          id: 'surface.write.ball',
          categoryId: writeCategory.id,
          semanticRole: 'surface.pen.ball',
          order: 10,
          slotId: 'pen-slot-2',
        },
        {
          id: 'surface.erase.tool',
          categoryId: eraseCategory.id,
          semanticRole: 'surface.erase',
          order: 10,
        },
      ],
      extensions: [familyExtension],
    };
    const graph = resolveToolbarComposition({
      snapshot,
      kindId: 'froglight.ink',
      controls: fountainControls,
    });
    // order wins over declaration position and slot identity.
    expect(graph.categories.map((category) => category.id)).toEqual([
      'surface.write',
      'surface.erase',
    ]);
    expect(graph.categories[0]?.items.map((item) => item.id)).toEqual([
      'surface.write.ball',
      'surface.write.fountain',
    ]);
  });

  it('never excludes by slot: two items may share one slotId', () => {
    const snapshot = {
      categories: [writeCategory],
      items: [
        {
          id: 'surface.write.fountain',
          categoryId: writeCategory.id,
          semanticRole: 'surface.pen.fountain',
          order: 10,
          slotId: 'pen-slot-shared',
        },
        {
          id: 'surface.write.ball',
          categoryId: writeCategory.id,
          semanticRole: 'surface.pen.ball',
          order: 20,
          slotId: 'pen-slot-shared',
        },
      ],
      extensions: [familyExtension],
    };
    const graph = resolveToolbarComposition({
      snapshot,
      kindId: 'froglight.ink',
      controls: fountainControls,
    });
    expect(graph.categories[0]?.items.map((item) => item.id)).toEqual([
      'surface.write.fountain',
      'surface.write.ball',
    ]);
    expect(graph.unresolved).toEqual([]);
  });

  it('keeps grouped entries dormant until category and control return', () => {
    const created = createToolbarCompositionRegistry();
    const itemOwner = created.registry.registerItem({
      id: 'surface.write.fountain',
      categoryId: writeCategory.id,
      semanticRole: 'surface.pen.fountain',
      slotId: 'pen-slot-2',
    });
    const kindOwner = created.registry.registerKindExtension(familyExtension);
    // Missing category: dormant, never an error.
    expect(
      resolveToolbarComposition({
        snapshot: created.registry.snapshot(),
        kindId: 'froglight.ink',
        controls: fountainControls,
      }).unresolved,
    ).toContain('surface.write.fountain');
    const categoryOwner = created.registry.registerCategory({
      ...writeCategory,
      groupId: 'strip.draw',
    });
    // Missing control: dormant.
    expect(
      resolveToolbarComposition({
        snapshot: created.registry.snapshot(),
        kindId: 'froglight.ink',
        controls: [],
      }).unresolved,
    ).toContain('surface.write.fountain');
    // Both return: live again with grouping metadata intact.
    const revived = resolveToolbarComposition({
      snapshot: created.registry.snapshot(),
      kindId: 'froglight.ink',
      controls: fountainControls,
    });
    expect(revived.categories[0]?.groupId).toBe('strip.draw');
    expect(revived.categories[0]?.items[0]?.slotId).toBe('pen-slot-2');
    expect(revived.unresolved).not.toContain('surface.write.fountain');
    categoryOwner.dispose();
    itemOwner.dispose();
    kindOwner.dispose();
  });

  it('preserves the duplicate-presenter diagnostic with the sole Text-pair allowlist', () => {
    const textControls = [
      {
        kind: 'button',
        id: 'ink.text',
        group: 'draw',
        label: 'Text',
        semanticRole: 'surface.insert.text',
      },
    ] as const;
    const snapshot = {
      categories: [
        { ...writeCategory, groupId: 'strip.draw' },
        {
          id: 'surface.insert',
          familyId: 'surface',
          label: 'Insert',
          icon: 'plus',
          order: 50,
          groupId: 'strip.insert',
        },
        {
          id: 'surface.text',
          familyId: 'surface',
          label: 'Text',
          icon: 'type',
          order: 60,
          groupId: 'strip.insert',
        },
      ],
      items: [
        {
          id: 'surface.write.fountain',
          categoryId: writeCategory.id,
          semanticRole: 'surface.pen.fountain',
          order: 10,
          slotId: 'pen-slot-2',
        },
        {
          id: 'surface.insert.text',
          categoryId: 'surface.insert',
          semanticRole: 'surface.insert.text',
          order: 10,
          slotId: 'text-slot-insert',
        },
        {
          id: 'surface.text.create',
          categoryId: 'surface.text',
          semanticRole: 'surface.insert.text',
          order: 0,
          slotId: 'text-slot-direct',
        },
      ],
      extensions: [familyExtension],
    };
    const allowlisted = resolveToolbarComposition({
      snapshot,
      kindId: 'froglight.ink',
      controls: textControls,
    });
    expect(
      allowlisted.diagnostics.filter((entry) =>
        entry.startsWith('duplicate presenter'),
      ),
    ).toEqual([]);
    // Both presenters share one strip group (one active indicator per group).
    expect(
      groupCategoriesByStripGroup(allowlisted.categories).get('strip.insert'),
    ).toHaveLength(2);
    const duplicated = resolveToolbarComposition({
      snapshot: {
        ...snapshot,
        items: [
          ...snapshot.items,
          {
            id: 'surface.insert.text.copy',
            categoryId: 'surface.insert',
            semanticRole: 'surface.insert.text',
            order: 20,
            slotId: 'text-slot-copy',
          },
        ],
      },
      kindId: 'froglight.ink',
      controls: textControls,
    });
    expect(duplicated.diagnostics).toContain(
      "duplicate presenter for semantic role 'surface.insert.text' " +
        '(surface.insert.text, surface.insert.text.copy, surface.text.create)',
    );
  });

  it('shadows and restores grouped contributions across the lifecycle invariant', () => {
    const created = createToolbarCompositionRegistry();
    // activate -> one registration
    const first = created.registry.registerCategory({
      ...writeCategory,
      groupId: 'strip.draw',
    });
    expect(created.registry.snapshot().categories).toHaveLength(1);
    expect(created.registry.snapshot().categories[0]?.groupId).toBe(
      'strip.draw',
    );
    // shadow -> top wins
    const shadow = created.registry.registerCategory({
      ...writeCategory,
      label: 'Draw',
      groupId: 'strip.draw-alt',
    });
    expect(created.registry.snapshot().categories[0]?.groupId).toBe(
      'strip.draw-alt',
    );
    const itemFirst = created.registry.registerItem({
      id: 'surface.write.fountain',
      categoryId: writeCategory.id,
      semanticRole: 'surface.pen.fountain',
      slotId: 'pen-slot-2',
    });
    const itemShadow = created.registry.registerItem({
      id: 'surface.write.fountain',
      categoryId: writeCategory.id,
      semanticRole: 'surface.pen.fountain',
      slotId: 'pen-slot-override',
    });
    expect(created.registry.snapshot().items[0]?.slotId).toBe(
      'pen-slot-override',
    );
    itemShadow.dispose();
    expect(created.registry.snapshot().items[0]?.slotId).toBe('pen-slot-2');
    // dispose shadow -> restore
    shadow.dispose();
    expect(created.registry.snapshot().categories[0]?.groupId).toBe(
      'strip.draw',
    );
    // dispose -> zero registrations
    itemFirst.dispose();
    first.dispose();
    expect(created.registry.snapshot().categories).toEqual([]);
    expect(created.registry.snapshot().items).toEqual([]);
    // reactivate -> one registration again
    const revived = created.registry.registerCategory({
      ...writeCategory,
      groupId: 'strip.draw',
    });
    expect(created.registry.snapshot().categories).toHaveLength(1);
    expect(created.registry.snapshot().categories[0]?.groupId).toBe(
      'strip.draw',
    );
    revived.dispose();
    expect(created.registry.snapshot().categories).toEqual([]);
    created.dispose();
  });

  it('resolves extension-carried grouping like snapshot-carried grouping', () => {
    const fromExtension = resolveToolbarComposition({
      snapshot: {
        categories: [],
        items: [],
        extensions: [
          {
            ...familyExtension,
            categories: [{ ...writeCategory, groupId: 'strip.draw' }],
            items: [
              {
                id: 'surface.write.fountain',
                categoryId: writeCategory.id,
                semanticRole: 'surface.pen.fountain',
                order: 10,
                slotId: 'pen-slot-2',
              },
            ],
          },
        ],
      },
      kindId: 'froglight.ink',
      controls: fountainControls,
    });
    expect(fromExtension.categories[0]?.groupId).toBe('strip.draw');
    expect(fromExtension.categories[0]?.items[0]?.slotId).toBe('pen-slot-2');
    const fromSnapshot = resolveToolbarComposition({
      snapshot: {
        categories: [{ ...writeCategory, groupId: 'strip.draw' }],
        items: [
          {
            id: 'surface.write.fountain',
            categoryId: writeCategory.id,
            semanticRole: 'surface.pen.fountain',
            order: 10,
            slotId: 'pen-slot-2',
          },
        ],
        extensions: [familyExtension],
      },
      kindId: 'froglight.ink',
      controls: fountainControls,
    });
    expect(withoutGroupingMeta(fromExtension)).toEqual(
      withoutGroupingMeta(fromSnapshot),
    );
    expect(fromExtension.categories[0]?.groupId).toBe(
      fromSnapshot.categories[0]?.groupId,
    );
    expect(fromExtension.categories[0]?.items[0]?.slotId).toBe(
      fromSnapshot.categories[0]?.items[0]?.slotId,
    );
  });

  it('derives effective strip/slot keys with singleton fallback, never guessing', () => {
    expect(stripGroupIdForCategory({ id: 'surface.write' })).toBe(
      'surface.write',
    );
    expect(
      stripGroupIdForCategory({
        id: 'surface.write',
        groupId: 'strip.draw',
      }),
    ).toBe('strip.draw');
    expect(stripGroupIdForCategory({ id: 'surface.write', groupId: '' })).toBe(
      'surface.write',
    );
    expect(
      stripGroupIdForCategory({ id: 'surface.write', groupId: '   ' }),
    ).toBe('surface.write');
    expect(slotIdForItem({ id: 'surface.write.fountain' })).toBe(
      'surface.write.fountain',
    );
    expect(
      slotIdForItem({ id: 'surface.write.fountain', slotId: 'pen-slot-2' }),
    ).toBe('pen-slot-2');
    expect(slotIdForItem({ id: 'surface.write.fountain', slotId: '' })).toBe(
      'surface.write.fountain',
    );
  });

  it('buckets categories by strip group in verbatim order (first-seen groups)', () => {
    const buckets = groupCategoriesByStripGroup([
      { id: 'surface.write', groupId: 'strip.draw' },
      { id: 'surface.erase' },
      { id: 'surface.select', groupId: 'strip.draw' },
    ]);
    expect([...buckets.keys()]).toEqual(['strip.draw', 'surface.erase']);
    expect(
      buckets.get('strip.draw')?.map((category) => category.id),
    ).toEqual(['surface.write', 'surface.select']);
    // Blank group ids never merge into a phantom group.
    const blank = groupCategoriesByStripGroup([
      { id: 'surface.write', groupId: '' },
      { id: 'surface.erase', groupId: '   ' },
    ]);
    expect([...blank.keys()]).toEqual(['surface.write', 'surface.erase']);
  });
});
