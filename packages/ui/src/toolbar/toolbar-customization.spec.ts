/**
 * Toolbar preference overlay for ordering, visibility, favorites, and slots.
 * Defaults resolve without user preferences; applying preferences does not
 * mutate registry contributions or canonical document content.
 */
import { describe, expect, it } from 'vitest';
import { InMemorySettingsService } from '@froglight/foundation';
import {
  resolveToolbarComposition,
  type ToolbarCompositionSnapshot,
} from './composition-registry.js';
import {
  DEFAULT_TOOLBAR_CATEGORIES,
  DEFAULT_TOOLBAR_ITEMS,
  DEFAULT_TOOLBAR_KIND_EXTENSIONS,
} from './default-composition.js';
import {
  TOOLBAR_CUSTOMIZATION_STORAGE_KEY,
  TOOLBAR_CUSTOMIZATION_VERSION,
  DEFAULT_COLOR_SLOT_COUNT,
  DEFAULT_PEN_SLOT_COUNT,
  DEFAULT_SIZE_SLOT_COUNT,
  SLOT_VALUE_COUNT,
  ToolbarCustomizationStore,
  applySlotOrder,
  groupSlotIdsByStripGroup,
  parseToolbarCustomization,
  resolveColorSlotPositions,
  resolveFavoriteToolIds,
  resolveFixedSlotPositions,
  resolvePenSlotPositions,
  resolveSizeSlotPositions,
  resolveSlotColorsForFamily,
  resolveSlotSizesForFamily,
} from './toolbar-customization.js';

const categoryA = {
  id: 'test.alpha',
  familyId: 'test',
  label: 'Alpha',
  icon: 'pen',
  order: 10,
};
const categoryB = {
  id: 'test.beta',
  familyId: 'test',
  label: 'Beta',
  icon: 'eraser',
  order: 20,
};
const itemA1 = {
  id: 'test.alpha.first',
  categoryId: categoryA.id,
  semanticRole: 'test.role.a1',
  order: 10,
  projections: ['normal', 'compact', 'squeeze'] as const,
};
const itemA2 = {
  id: 'test.alpha.second',
  categoryId: categoryA.id,
  semanticRole: 'test.role.a2',
  order: 20,
  projections: ['normal', 'compact', 'squeeze'] as const,
};
const itemA3 = {
  id: 'test.alpha.third',
  categoryId: categoryA.id,
  semanticRole: 'test.role.a3',
  order: 30,
  projections: ['normal', 'compact', 'squeeze'] as const,
};
const itemB1 = {
  id: 'test.beta.first',
  categoryId: categoryB.id,
  semanticRole: 'test.role.b1',
  order: 10,
  projections: ['normal', 'compact', 'squeeze'] as const,
};

const snapshot: ToolbarCompositionSnapshot = {
  categories: [categoryA, categoryB],
  items: [itemA1, itemA2, itemA3, itemB1],
  extensions: [
    { id: 'test-kind', kindIds: ['test.kind'], familyIds: ['test'] },
  ],
};

const controls = [
  {
    kind: 'button',
    id: 'c-a1',
    group: 'g',
    label: 'A1',
    semanticRole: 'test.role.a1',
  },
  {
    kind: 'button',
    id: 'c-a2',
    group: 'g',
    label: 'A2',
    semanticRole: 'test.role.a2',
  },
  {
    kind: 'button',
    id: 'c-a3',
    group: 'g',
    label: 'A3',
    semanticRole: 'test.role.a3',
  },
  {
    kind: 'button',
    id: 'c-b1',
    group: 'g',
    label: 'B1',
    semanticRole: 'test.role.b1',
  },
] as const;

const resolve = (
  overrides?: Parameters<typeof resolveToolbarComposition>[0]['overrides'],
  projection?: 'normal' | 'squeeze',
) =>
  resolveToolbarComposition({
    snapshot,
    kindId: 'test.kind',
    controls,
    ...(projection !== undefined ? { projection } : {}),
    ...(overrides !== undefined ? { overrides } : {}),
  });

describe('toolbar customization stable identifiers', () => {
  it('pins the first-party category identifier set', () => {
    expect(DEFAULT_TOOLBAR_CATEGORIES.map((entry) => entry.id).sort()).toEqual(
      [
        'pdf.annotate',
        'pdf.pages',
        'pdf.select',
        'surface.erase',
        'surface.highlighter',
        'surface.insert',
        'surface.select',
        'surface.shapes',
        'surface.text',
        'surface.write',
        'writing.insert',
        'writing.structure',
        'writing.style',
      ].sort(),
    );
  });

  it('pins the first-party item identifier set', () => {
    expect(
      [
        ...DEFAULT_TOOLBAR_ITEMS.map((entry) => entry.id),
        ...DEFAULT_TOOLBAR_KIND_EXTENSIONS.flatMap((entry) => [
          ...(entry.categories ?? []).map((category) => category.id),
          ...(entry.items ?? []).map((item) => item.id),
        ]),
      ].sort(),
    ).toEqual(
      [
        'surface.write.ball',
        'surface.write.fountain',
        'surface.write.brush',
        'surface.write.pencil',
        'surface.write.highlighter',
        'surface.erase.tool',
        'surface.select.object',
        'surface.select.lasso',
        'surface.shapes.line',
        'surface.shapes.rectangle',
        'surface.shapes.ellipse',
        'surface.shapes.triangle',
        'surface.shapes.diamond',
        'surface.insert.image',
        'surface.text.create',
        'surface.write.color',
        'surface.write.width',
        'surface.write.saved-style',
        'surface.write.settings-color',
        'surface.write.settings-size',
        'surface.erase.size',
        'surface.erase.settings-size',
        'surface.erase.stroke',
        'surface.erase.precision',
        'pdf.pages.previous',
        'pdf.pages.next',
        'pdf.select.source',
        'pdf.annotate.notebook',
        'writing.style.block',
        'writing.format.bold',
        'writing.format.italic',
        'writing.format.strike',
        'writing.insert.markdown-table',
        'markdown.insert.divider',
        'markdown.style.quote',
        'markdown.style.bullet',
        'markdown.style.numbered',
        'markdown.style.task',
        'writing.format.code',
        'writing.insert.audio',
        'writing.insert.link',
        'writing.insert.code-block',
        'writing.insert.diagram',
        'writing.insert.diagram.retry',
        'writing.insert.diagram.source',
        'writing.insert.embed',
        'writing.insert.file',
        'writing.insert.image',
        'writing.insert.import-image',
        'writing.insert.math',
        'writing.insert.math.retry',
        'writing.insert.math.source',
        'writing.insert.media.alt',
        'writing.insert.media.replace',
        'writing.insert.media.caption',
        'writing.insert.media.clear-remote',
        'writing.insert.media.name',
        'writing.insert.media.remote-url',
        'writing.insert.media.retry',
        'writing.insert.note-link',
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
        'notebook.insert.pdf.before',
        'notebook.insert.pdf.after',
        'whiteboard.insert.card',
        'latex.math',
        'latex.references',
        'latex.math.inline',
        'latex.math.display',
        'latex.insert.itemize',
        'latex.insert.enumerate',
        'latex.insert.quote',
        'latex.references.label',
        'latex.references.ref',
        'latex.references.cite',
      ].sort(),
    );
  });
});

describe('toolbar customization resolver overrides', () => {
  it('resolves identically with no overrides (defaults stay the authority)', () => {
    expect(resolve(undefined)).toEqual(
      resolveToolbarComposition({ snapshot, kindId: 'test.kind', controls }),
    );
  });

  it('reorders categories without mutating the registry snapshot', () => {
    const graph = resolve({ categoryOrder: [categoryB.id, categoryA.id] });
    expect(graph.categories.map((entry) => entry.id)).toEqual([
      categoryB.id,
      categoryA.id,
    ]);
    expect(snapshot.categories.map((entry) => entry.id)).toEqual([
      categoryA.id,
      categoryB.id,
    ]);
  });

  it('ignores unknown category ids in the order list', () => {
    const graph = resolve({
      categoryOrder: ['missing.category', categoryB.id, categoryA.id],
    });
    expect(graph.categories.map((entry) => entry.id)).toEqual([
      categoryB.id,
      categoryA.id,
    ]);
  });

  it('reorders items within a category, keeping unlisted items in default order after', () => {
    const graph = resolve({
      itemOrder: { [categoryA.id]: [itemA3.id, 'missing.item', itemA1.id] },
    });
    expect(
      graph.categories
        .find((entry) => entry.id === categoryA.id)
        ?.items.map((item) => item.id),
    ).toEqual([itemA3.id, itemA1.id, itemA2.id]);
  });

  it('hides categories and items without reporting them as dormant', () => {
    const graph = resolve({
      hiddenCategories: [categoryB.id, 'missing.category'],
      hiddenItems: [itemA1.id, 'missing.item'],
    });
    expect(graph.categories.map((entry) => entry.id)).toEqual([categoryA.id]);
    expect(graph.categories[0]?.items.map((item) => item.id)).toEqual([
      itemA2.id,
      itemA3.id,
    ]);
    expect(graph.unresolved).toEqual([]);
  });

  it('reorders the squeeze projection via squeezeOrder without touching normal order', () => {
    const squeeze = resolve(
      {
        itemOrder: { [categoryA.id]: [itemA2.id, itemA1.id, itemA3.id] },
        squeezeOrder: [itemA3.id, itemA1.id, itemA2.id],
      },
      'squeeze',
    );
    expect(
      squeeze.categories
        .find((entry) => entry.id === categoryA.id)
        ?.items.map((item) => item.id),
    ).toEqual([itemA3.id, itemA1.id, itemA2.id]);
    const normal = resolve(
      {
        itemOrder: { [categoryA.id]: [itemA2.id, itemA1.id, itemA3.id] },
        squeezeOrder: [itemA3.id, itemA1.id, itemA2.id],
      },
      'normal',
    );
    expect(
      normal.categories
        .find((entry) => entry.id === categoryA.id)
        ?.items.map((item) => item.id),
    ).toEqual([itemA2.id, itemA1.id, itemA3.id]);
  });

  it('keeps hidden items hidden in the squeeze projection', () => {
    const squeeze = resolve({ hiddenItems: [itemA2.id] }, 'squeeze');
    expect(
      squeeze.categories
        .find((entry) => entry.id === categoryA.id)
        ?.items.map((item) => item.id),
    ).toEqual([itemA1.id, itemA3.id]);
  });
});

describe('toolbar customization preference schema', () => {
  it('round-trips overrides through the settings envelope outside canonical bytes', () => {
    const settings = new InMemorySettingsService();
    const store = new ToolbarCustomizationStore({ settings });
    expect(store.snapshot()).toEqual({
      version: TOOLBAR_CUSTOMIZATION_VERSION,
    });
    store.setCategoryOrder([categoryB.id, categoryA.id]);
    store.setItemOrder(categoryA.id, [itemA2.id, itemA1.id]);
    store.setHiddenItems([itemB1.id]);
    store.setSqueezeOrder([itemA3.id]);
    store.setFavoriteTools([itemA1.id]);
    const raw = settings.get(TOOLBAR_CUSTOMIZATION_STORAGE_KEY);
    expect(typeof raw).toBe('string');
    expect(JSON.parse(raw as string)).toMatchObject({
      version: 1,
      categoryOrder: [categoryB.id, categoryA.id],
    });
    const reloaded = new ToolbarCustomizationStore({ settings });
    expect(reloaded.snapshot()).toEqual(store.snapshot());
    expect(reloaded.overrides()).toEqual({
      categoryOrder: [categoryB.id, categoryA.id],
      itemOrder: { [categoryA.id]: [itemA2.id, itemA1.id] },
      hiddenItems: [itemB1.id],
      squeezeOrder: [itemA3.id],
      favoriteTools: [itemA1.id],
    });
    store.dispose();
    reloaded.dispose();
  });

  it('degrades corrupt, foreign-version, and non-object payloads to defaults', () => {
    const settings = new InMemorySettingsService();
    settings.set(TOOLBAR_CUSTOMIZATION_STORAGE_KEY, '{not json');
    expect(new ToolbarCustomizationStore({ settings }).snapshot()).toEqual({
      version: TOOLBAR_CUSTOMIZATION_VERSION,
    });
    settings.set(
      TOOLBAR_CUSTOMIZATION_STORAGE_KEY,
      JSON.stringify({ version: 999, categoryOrder: [categoryB.id] }),
    );
    expect(new ToolbarCustomizationStore({ settings }).snapshot()).toEqual({
      version: TOOLBAR_CUSTOMIZATION_VERSION,
    });
    settings.set(TOOLBAR_CUSTOMIZATION_STORAGE_KEY, '42');
    expect(new ToolbarCustomizationStore({ settings }).snapshot()).toEqual({
      version: TOOLBAR_CUSTOMIZATION_VERSION,
    });
  });

  it('preserves unknown future fields across commits', () => {
    const settings = new InMemorySettingsService();
    settings.set(
      TOOLBAR_CUSTOMIZATION_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        categoryOrder: [categoryB.id],
        futureField: { pinned: true },
      }),
    );
    const store = new ToolbarCustomizationStore({ settings });
    expect(store.snapshot().categoryOrder).toEqual([categoryB.id]);
    store.setHiddenItems([itemA1.id]);
    expect(
      JSON.parse(settings.get(TOOLBAR_CUSTOMIZATION_STORAGE_KEY) as string),
    ).toMatchObject({
      futureField: { pinned: true },
      hiddenItems: [itemA1.id],
    });
    store.dispose();
  });

  it('reloads external changes and notifies listeners', () => {
    const settings = new InMemorySettingsService();
    const store = new ToolbarCustomizationStore({ settings });
    let notifications = 0;
    const sub = store.onChange(() => {
      notifications += 1;
    });
    settings.set(
      TOOLBAR_CUSTOMIZATION_STORAGE_KEY,
      JSON.stringify({ version: 1, hiddenItems: [itemA1.id] }),
    );
    expect(store.snapshot().hiddenItems).toEqual([itemA1.id]);
    expect(notifications).toBe(1);
    sub.dispose();
    store.dispose();
  });

  it('preserves unrelated user settings through customization migration', () => {
    const settings = new InMemorySettingsService();
    settings.set(
      'ink.style-library',
      JSON.stringify({ version: 1, styles: [] }),
    );
    settings.set('ink.preset.pen.color', '#37352f');
    const store = new ToolbarCustomizationStore({ settings });
    store.setCategoryOrder([categoryB.id, categoryA.id]);
    store.reset();
    expect(settings.get('ink.style-library')).toBe(
      JSON.stringify({ version: 1, styles: [] }),
    );
    expect(settings.get('ink.preset.pen.color')).toBe('#37352f');
    expect(store.snapshot()).toEqual({
      version: TOOLBAR_CUSTOMIZATION_VERSION,
    });
    store.dispose();
  });

  it('resolves favorite tool ids against the live graph, ignoring unknown ids', () => {
    const graph = resolve({ hiddenItems: [itemA2.id] });
    expect(
      resolveFavoriteToolIds(graph, [itemA2.id, 'missing.item', itemA1.id]),
    ).toEqual([itemA1.id]);
    expect(resolveFavoriteToolIds(graph, undefined)).toEqual([]);
  });
});

describe('toolbar customization Text single presenter (was dual)', () => {
  const textCreationControl = {
    kind: 'button',
    id: 'ink.tool.text',
    group: 'draw',
    label: 'Text',
    semanticRole: 'surface.insert.text',
  } as const;
  const imageControl = {
    kind: 'button',
    id: 'ink.image',
    group: 'insert',
    label: 'Image',
    semanticRole: 'surface.insert.image',
  } as const;

  const resolveDefault = (
    overrides?: Parameters<typeof resolveToolbarComposition>[0]['overrides'],
    projection: 'normal' | 'compact' | 'squeeze' = 'normal',
  ) =>
    resolveToolbarComposition({
      snapshot: {
        categories: [...DEFAULT_TOOLBAR_CATEGORIES],
        items: [...DEFAULT_TOOLBAR_ITEMS],
        extensions: [...DEFAULT_TOOLBAR_KIND_EXTENSIONS],
      },
      kindId: 'froglight.ink',
      controls: [textCreationControl, imageControl],
      projection,
      ...(overrides !== undefined ? { overrides } : {}),
    });

  const creationRoles = (
    graph: ReturnType<typeof resolveToolbarComposition>,
  ): string[] =>
    graph.categories.flatMap((category) =>
      category.items
        .filter((item) => item.semanticRole === 'surface.insert.text')
        .map((item) => `${category.id}:${item.id}`),
    );

  it('serves creation from the Text presenter only (retired Insert id ignored)', () => {
    // The retired Insert presenter id stays unknown-ignored while the
    // canonical Text button stays live.
    const hideRetired = resolveDefault({
      hiddenItems: ['surface.insert.text'],
    });
    expect(creationRoles(hideRetired)).toEqual([
      'surface.text:surface.text.create',
    ]);
    expect(hideRetired.unresolved).not.toContain('surface.text.create');
    // Hiding the Text presenter removes creation everywhere; Insert does
    // not act as a fallback presenter.
    const hideText = resolveDefault({
      hiddenItems: ['surface.text.create'],
    });
    expect(creationRoles(hideText)).toEqual([]);
    // Insert keeps its non-text item; Text (creation-only with zero
    // selection) drops because its sole live item is hidden.
    expect(
      hideText.categories
        .find((entry) => entry.id === 'surface.insert')
        ?.items.map((item) => item.id),
    ).toContain('surface.insert.image');
  });

  it('hiding the retired Insert id plus the Text id removes creation without dormant noise', () => {
    const graph = resolveDefault({
      hiddenItems: ['surface.insert.text', 'surface.text.create'],
    });
    expect(creationRoles(graph)).toEqual([]);
    expect(graph.unresolved).not.toContain('surface.insert.text');
    expect(graph.unresolved).not.toContain('surface.text.create');
    // Insert survives on its image item; Text drops (creation-only).
    expect(
      graph.categories
        .find((entry) => entry.id === 'surface.insert')
        ?.items.map((item) => item.id),
    ).toEqual(['surface.insert.image']);
    expect(graph.categories.some((entry) => entry.id === 'surface.text')).toBe(
      false,
    );
  });

  it('hides one Text category while Insert stays creation-free', () => {
    const hideTextCategory = resolveDefault({
      hiddenCategories: ['surface.text'],
    });
    // No fallback: creation is gone with its sole category.
    expect(creationRoles(hideTextCategory)).toEqual([]);
    const hideInsertCategory = resolveDefault({
      hiddenCategories: ['surface.insert'],
    });
    expect(creationRoles(hideInsertCategory)).toEqual([
      'surface.text:surface.text.create',
    ]);
  });

  it('resolves favorites by item id against the live single-presenter graph', () => {
    const graph = resolveDefault(undefined);
    // Only the live presenter id is a favorite slot; the retired id is
    // unknown-ignored.
    expect(
      resolveFavoriteToolIds(graph, [
        'surface.insert.text',
        'surface.text.create',
        'missing.item',
      ]),
    ).toEqual(['surface.text.create']);
    // Hiding the live presenter drops its favorite slot; unhide revives
    // it because storage preserves unknown ids.
    const hidden = resolveDefault({ hiddenItems: ['surface.text.create'] });
    expect(
      resolveFavoriteToolIds(hidden, [
        'surface.insert.text',
        'surface.text.create',
      ]),
    ).toEqual([]);
  });
});

describe('toolbar customization slot overrides', () => {
  it('pins factory fixed-slot counts 3/3/4 with empty placeholders', () => {
    expect(DEFAULT_SIZE_SLOT_COUNT).toBe(3);
    expect(DEFAULT_COLOR_SLOT_COUNT).toBe(3);
    expect(DEFAULT_PEN_SLOT_COUNT).toBe(4);
  });

  it('re-sorts by effective slot id via slotIdForItem, unknown ignored, unlisted keep order', () => {
    const entries = [
      { id: 'a', slotId: 'slot-1' },
      { id: 'b', slotId: 'slot-2' },
      { id: 'c', slotId: 'slot-3' },
    ];
    const reordered = applySlotOrder(entries, [
      'missing.slot',
      'slot-3',
      'slot-1',
    ]);
    expect(reordered.map((entry) => entry.id)).toEqual(['c', 'a', 'b']);
    // Input never mutated; no-override returns verbatim copy.
    expect(entries.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    expect(applySlotOrder(entries, undefined).map((entry) => entry.id)).toEqual(
      ['a', 'b', 'c'],
    );
    expect(applySlotOrder(entries, []).map((entry) => entry.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('falls back to item id for absent/blank slotId via the shared helper (never local)', () => {
    const entries = [
      { id: 'plain-a' },
      { id: 'plain-b', slotId: '' },
      { id: 'plain-c', slotId: '   ' },
      { id: 'slotted', slotId: 'slot-9' },
    ];
    const reordered = applySlotOrder(entries, ['slot-9', 'plain-b']);
    expect(reordered.map((entry) => entry.id)).toEqual([
      'slotted',
      'plain-b',
      'plain-a',
      'plain-c',
    ]);
  });

  it('pins fixed positions with null placeholders, dedupe, truncate, unknown-order dormant', () => {
    // Registry order first, overrides re-sort; unknown order ids ignored.
    expect(
      resolveFixedSlotPositions(['s1', 's2', 's3'], ['s3', 's1'], 3),
    ).toEqual(['s3', 's1', 's2']);
    expect(
      resolveFixedSlotPositions(['s1', 's2', 's3'], ['missing', 's2'], 3),
    ).toEqual(['s2', 's1', 's3']);
    // Empty pads with null placeholders that never collapse.
    expect(resolveFixedSlotPositions(['s1'], undefined, 3)).toEqual([
      's1',
      null,
      null,
    ]);
    expect(resolveFixedSlotPositions([], [], 4)).toEqual([
      null,
      null,
      null,
      null,
    ]);
    // Dedupe by first occurrence; overflow beyond count goes to More.
    expect(
      resolveFixedSlotPositions(
        ['s1', 's1', ' s2 ', '', 's3', 's4'],
        undefined,
        3,
      ),
    ).toEqual(['s1', 's2', 's3']);
    expect(
      resolveFixedSlotPositions(['s1', 's2', 's3', 's4', 's5'], undefined, 3),
    ).toEqual(['s1', 's2', 's3']);
  });

  it('resolves size/color/pen families through factory counts', () => {
    expect(resolveSizeSlotPositions(['s1', 's2'], ['s2', 's1'])).toEqual([
      's2',
      's1',
      null,
    ]);
    expect(resolveColorSlotPositions(['c1'], undefined)).toEqual([
      'c1',
      null,
      null,
    ]);
    expect(
      resolvePenSlotPositions(['p1', 'p2', 'p3', 'p4', 'p5'], undefined),
    ).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(resolvePenSlotPositions(['p2', 'p1'], ['p1', 'p2'])).toEqual([
      'p1',
      'p2',
      null,
      null,
    ]);
  });

  it('buckets slot ids by effective strip group via shared helpers', () => {
    const buckets = groupSlotIdsByStripGroup([
      {
        id: 'surface.write',
        groupId: 'strip.draw',
        items: [
          { id: 'surface.write.ball', slotId: 'pen-slot-1' },
          { id: 'surface.write.fountain' },
        ],
      },
      { id: 'surface.erase', items: [{ id: 'surface.erase.tool' }] },
      {
        id: 'surface.select',
        groupId: 'strip.draw',
        items: [{ id: 'surface.select.object', slotId: '' }],
      },
    ]);
    expect([...buckets.keys()]).toEqual(['strip.draw', 'surface.erase']);
    expect(buckets.get('strip.draw')).toEqual([
      'pen-slot-1',
      'surface.write.fountain',
      'surface.select.object',
    ]);
    expect(buckets.get('surface.erase')).toEqual(['surface.erase.tool']);
    // Blank group ids never merge into a phantom group (singleton fallback).
    const blank = groupSlotIdsByStripGroup([
      { id: 'a', groupId: '', items: [{ id: 'a.1' }] },
      { id: 'b', groupId: '   ', items: [{ id: 'b.1' }] },
    ]);
    expect([...blank.keys()]).toEqual(['a', 'b']);
  });

  it('round-trips slot overrides offline-local; reset restores factory', () => {
    const settings = new InMemorySettingsService();
    const store = new ToolbarCustomizationStore({ settings });
    expect(store.snapshot()).toEqual({
      version: TOOLBAR_CUSTOMIZATION_VERSION,
    });
    expect(store.overrides()).toEqual({});
    store.setSlotSizes(['size-slot-2', 'size-slot-1']);
    store.setSlotColors(['color-slot-1']);
    store.setSlotPens(['pen-slot-2', 'missing.pen', 'pen-slot-1']);
    expect(store.snapshot()).toMatchObject({
      slotSizes: ['size-slot-2', 'size-slot-1'],
      slotColors: ['color-slot-1'],
      slotPens: ['pen-slot-2', 'missing.pen', 'pen-slot-1'],
    });
    const raw = settings.get(TOOLBAR_CUSTOMIZATION_STORAGE_KEY);
    expect(typeof raw).toBe('string');
    expect(JSON.parse(raw as string)).toMatchObject({
      version: 1,
      slotSizes: ['size-slot-2', 'size-slot-1'],
      slotPens: ['pen-slot-2', 'missing.pen', 'pen-slot-1'],
    });
    // Unknown slot ids stay preserved in storage (dormant-safe) but are
    // ignored at resolve time.
    expect(
      applySlotOrder(
        [
          { id: 'a', slotId: 'pen-slot-1' },
          { id: 'b', slotId: 'pen-slot-2' },
        ],
        store.snapshot().slotPens,
      ).map((entry) => entry.id),
    ).toEqual(['b', 'a']);
    const reloaded = new ToolbarCustomizationStore({ settings });
    expect(reloaded.snapshot()).toEqual(store.snapshot());
    expect(reloaded.overrides()).toMatchObject({
      slotSizes: ['size-slot-2', 'size-slot-1'],
      slotPens: ['pen-slot-2', 'missing.pen', 'pen-slot-1'],
    });
    // Clearing with empty lists drops the keys (absent = factory).
    store.setSlotSizes([]);
    expect(store.snapshot().slotSizes).toBeUndefined();
    // reset() restores factory without reload and without touching siblings.
    settings.set(
      'ink.style-library',
      JSON.stringify({ version: 1, styles: [] }),
    );
    settings.set('ink.preset.pen.color', '#37352f');
    settings.set('surface.gesture.draw-hold', 'true');
    store.setSlotPens(['pen-slot-1']);
    store.reset();
    expect(store.snapshot()).toEqual({
      version: TOOLBAR_CUSTOMIZATION_VERSION,
    });
    expect(store.overrides()).toEqual({});
    expect(settings.get('ink.style-library')).toBe(
      JSON.stringify({ version: 1, styles: [] }),
    );
    expect(settings.get('ink.preset.pen.color')).toBe('#37352f');
    expect(settings.get('surface.gesture.draw-hold')).toBe('true');
    store.dispose();
    reloaded.dispose();
  });

  it('snapshot and overrides return fresh arrays (mutation never aliases store)', () => {
    const settings = new InMemorySettingsService();
    const store = new ToolbarCustomizationStore({ settings });
    store.setCategoryOrder([categoryB.id, categoryA.id]);
    store.setItemOrder(categoryA.id, [itemA2.id, itemA1.id]);
    store.setHiddenCategories([categoryB.id]);
    store.setHiddenItems([itemB1.id]);
    store.setSqueezeOrder([itemA3.id]);
    store.setFavoriteTools([itemA1.id]);
    store.setSlotSizes(['size-slot-1']);
    store.setSlotColors(['color-slot-1']);
    store.setSlotPens(['pen-slot-1']);
    const snap = store.snapshot();
    (snap.categoryOrder as string[]).push('mutated');
    (snap.hiddenCategories as string[]).push('mutated');
    (snap.hiddenItems as string[]).push('mutated');
    (snap.squeezeOrder as string[]).push('mutated');
    (snap.favoriteTools as string[]).push('mutated');
    (snap.slotSizes as string[]).push('mutated');
    (snap.slotColors as string[]).push('mutated');
    (snap.slotPens as string[]).push('mutated');
    (snap.itemOrder?.[categoryA.id] as unknown as string[])?.push('mutated');
    const fresh = store.snapshot();
    expect(fresh.categoryOrder).toEqual([categoryB.id, categoryA.id]);
    expect(fresh.hiddenCategories).toEqual([categoryB.id]);
    expect(fresh.hiddenItems).toEqual([itemB1.id]);
    expect(fresh.squeezeOrder).toEqual([itemA3.id]);
    expect(fresh.favoriteTools).toEqual([itemA1.id]);
    expect(fresh.slotSizes).toEqual(['size-slot-1']);
    expect(fresh.slotColors).toEqual(['color-slot-1']);
    expect(fresh.slotPens).toEqual(['pen-slot-1']);
    expect(fresh.itemOrder?.[categoryA.id]).toEqual([itemA2.id, itemA1.id]);
    const over = store.overrides();
    (over.categoryOrder as string[]).push('mutated');
    (over.hiddenCategories as string[]).push('mutated');
    (over.hiddenItems as string[]).push('mutated');
    (over.squeezeOrder as string[]).push('mutated');
    (over.favoriteTools as string[]).push('mutated');
    (over.slotSizes as string[]).push('mutated');
    (over.slotColors as string[]).push('mutated');
    (over.slotPens as string[]).push('mutated');
    (over.itemOrder as Record<string, string[]>)[categoryA.id]?.push('mutated');
    const after = store.snapshot();
    expect(after.categoryOrder).toEqual([categoryB.id, categoryA.id]);
    expect(after.hiddenItems).toEqual([itemB1.id]);
    expect(after.slotPens).toEqual(['pen-slot-1']);
    expect(after.itemOrder?.[categoryA.id]).toEqual([itemA2.id, itemA1.id]);
    store.dispose();
  });

  it('tolerant loader cleans slot fields; corrupt/foreign payloads degrade without throw', () => {
    // Non-array / non-string / blank / duplicate slot entries degrade to defaults.
    expect(
      parseToolbarCustomization(
        JSON.stringify({
          version: 1,
          slotSizes: 'not-an-array',
          slotColors: [42, '', '  ', 'c1', 'c1', 'c2'],
          slotPens: [{ id: 'x' }, 'p1'],
        }),
      ).customization,
    ).toEqual({
      version: 1,
      slotColors: ['c1', 'c2'],
      slotPens: ['p1'],
    });
    // Corrupt / foreign-version / non-object degrade to factory defaults.
    for (const raw of [
      '{not json',
      JSON.stringify({ version: 999, slotPens: ['p1'] }),
      '42',
      'null',
      '[]',
      undefined,
      '',
    ]) {
      expect(parseToolbarCustomization(raw).customization).toEqual({
        version: TOOLBAR_CUSTOMIZATION_VERSION,
      });
    }
    // Corrupt slot payload never clears sibling settings keys.
    const settings = new InMemorySettingsService();
    settings.set(
      'ink.style-library',
      JSON.stringify({ version: 1, styles: [] }),
    );
    settings.set(TOOLBAR_CUSTOMIZATION_STORAGE_KEY, '{not json');
    expect(new ToolbarCustomizationStore({ settings }).snapshot()).toEqual({
      version: TOOLBAR_CUSTOMIZATION_VERSION,
    });
    expect(settings.get('ink.style-library')).toBe(
      JSON.stringify({ version: 1, styles: [] }),
    );
  });

  it('preserves unknown slot ids and unknown future fields across commits (dormant-safe)', () => {
    const settings = new InMemorySettingsService();
    settings.set(
      TOOLBAR_CUSTOMIZATION_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        slotPens: ['future.pen', 'pen-slot-1'],
        futureSlotField: { pinned: true },
      }),
    );
    const store = new ToolbarCustomizationStore({ settings });
    expect(store.snapshot().slotPens).toEqual(['future.pen', 'pen-slot-1']);
    store.setSlotSizes(['size-slot-1']);
    const persisted = JSON.parse(
      settings.get(TOOLBAR_CUSTOMIZATION_STORAGE_KEY) as string,
    );
    expect(persisted).toMatchObject({
      slotPens: ['future.pen', 'pen-slot-1'],
      slotSizes: ['size-slot-1'],
      futureSlotField: { pinned: true },
    });
    store.dispose();
  });

  it('slot order never hides: hidden items stay hidden via hiddenItems without dormant noise', () => {
    const slotted = [
      { id: 'a', slotId: 'pen-slot-1' },
      { id: 'b', slotId: 'pen-slot-2' },
      { id: 'c', slotId: 'pen-slot-3' },
    ];
    // Ordering lists a hidden candidate first; visibility itself is via
    // hiddenItems by item id (dual-hide contract) — order never hides.
    const ordered = applySlotOrder(slotted, ['pen-slot-2', 'pen-slot-1']);
    expect(ordered.map((entry) => entry.id)).toEqual(['b', 'a', 'c']);
    const graph = resolve({ hiddenItems: ['test.alpha.second'] }, 'normal');
    expect(
      graph.categories
        .find((entry) => entry.id === categoryA.id)
        ?.items.map((item) => item.id),
    ).toEqual([itemA1.id, itemA3.id]);
    expect(graph.unresolved).toEqual([]);
  });

  it('follows the store lifecycle invariant: notify -> dispose -> silence -> reactivate', () => {
    const settings = new InMemorySettingsService();
    const store = new ToolbarCustomizationStore({ settings });
    let notifications = 0;
    const sub = store.onChange(() => {
      notifications += 1;
    });
    // activate -> one notification per commit.
    store.setSlotPens(['pen-slot-1']);
    expect(notifications).toBe(1);
    expect(store.snapshot().slotPens).toEqual(['pen-slot-1']);
    // dispose -> zero registrations/notifications afterwards.
    sub.dispose();
    store.dispose();
    store.setSlotPens(['pen-slot-2']);
    expect(notifications).toBe(1);
    expect(store.snapshot().slotPens).toEqual(['pen-slot-1']);
    // reset() after dispose is silenced: no state change, no settings write.
    const rawBefore = settings.get(TOOLBAR_CUSTOMIZATION_STORAGE_KEY);
    let postDisposeNotifications = 0;
    store.onChange(() => {
      postDisposeNotifications += 1;
    });
    store.reset();
    expect(store.snapshot().slotPens).toEqual(['pen-slot-1']);
    expect(settings.get(TOOLBAR_CUSTOMIZATION_STORAGE_KEY)).toBe(rawBefore);
    expect(postDisposeNotifications).toBe(0);
    // reactivate -> one registration again via a fresh store over same envelope.
    const revived = new ToolbarCustomizationStore({ settings });
    expect(revived.snapshot().slotPens).toEqual(['pen-slot-1']);
    revived.setSlotPens(['pen-slot-2']);
    expect(revived.snapshot().slotPens).toEqual(['pen-slot-2']);
    revived.dispose();
  });
});

describe('toolbar customization per-family slot sets', () => {
  it('pins the fixed slot-value count', () => {
    expect(SLOT_VALUE_COUNT).toBe(3);
  });

  it('migrates old v1 payloads without the family fields to family defaults', () => {
    // An older payload (order lists only) loads without throwing and
    // resolves both families to their defaults; the snapshot stays
    // additive-clean (no family keys materialize until edited).
    const settings = new InMemorySettingsService();
    settings.set(
      TOOLBAR_CUSTOMIZATION_STORAGE_KEY,
      JSON.stringify({ version: 1, slotPens: ['pen-slot-1'] }),
    );
    const store = new ToolbarCustomizationStore({ settings });
    expect(store.slotSizesForFamily('pen')).toEqual([2, 3.5, 6]);
    expect(store.slotSizesForFamily('highlighter')).toEqual([8, 14, 20]);
    expect(store.slotColorsForFamily('pen')).toEqual([
      '#37352f',
      '#7c6cf0',
      '#c4554d',
    ]);
    expect(store.slotColorsForFamily('highlighter')).toEqual([
      '#ffd54f',
      '#7c6cf0',
      '#c4554d',
    ]);
    expect(store.snapshot()).toEqual({
      version: TOOLBAR_CUSTOMIZATION_VERSION,
      slotPens: ['pen-slot-1'],
    });
    expect(store.overrides()).toEqual({ slotPens: ['pen-slot-1'] });
    store.dispose();
  });

  it('keeps pen-family and highlighter sets independent across edits', () => {
    const settings = new InMemorySettingsService();
    const store = new ToolbarCustomizationStore({ settings });
    // Pen-family tools share one set: a single write through the
    // 'pen' family is what pen/fountain/brush/pencil all resolve.
    store.setSlotSizesForFamily('pen', [1, 2, 3]);
    store.setSlotColorsForFamily('pen', ['#111111', '#222222', '#333333']);
    expect(store.slotSizesForFamily('pen')).toEqual([1, 2, 3]);
    expect(store.slotColorsForFamily('pen')).toEqual([
      '#111111',
      '#222222',
      '#333333',
    ]);
    // The highlighter set is untouched by pen writes and vice versa.
    expect(store.slotSizesForFamily('highlighter')).toEqual([8, 14, 20]);
    expect(store.slotColorsForFamily('highlighter')).toEqual([
      '#ffd54f',
      '#7c6cf0',
      '#c4554d',
    ]);
    store.setSlotSizesForFamily('highlighter', [10, 12, 14]);
    expect(store.slotSizesForFamily('pen')).toEqual([1, 2, 3]);
    expect(store.slotSizesForFamily('highlighter')).toEqual([10, 12, 14]);
    // Both sets persist and reload verbatim.
    const reloaded = new ToolbarCustomizationStore({ settings });
    expect(reloaded.snapshot()).toMatchObject({
      slotSizesPen: [1, 2, 3],
      slotSizesHighlighter: [10, 12, 14],
      slotColorsPen: ['#111111', '#222222', '#333333'],
    });
    expect(reloaded.slotSizesForFamily('highlighter')).toEqual([10, 12, 14]);
    store.dispose();
    reloaded.dispose();
  });

  it('edits a single slot preserving siblings and padding short rows', () => {
    const settings = new InMemorySettingsService();
    const store = new ToolbarCustomizationStore({ settings });
    // only slot 2 changes; slots 1/3 keep factory values.
    expect(store.setSlotSizeAt('pen', 1, 4.5)).toBe(true);
    expect(store.slotSizesForFamily('pen')).toEqual([2, 4.5, 6]);
    expect(store.setSlotColorAt('highlighter', 0, '#00ff00')).toBe(true);
    expect(store.slotColorsForFamily('highlighter')).toEqual([
      '#00ff00',
      '#7c6cf0',
      '#c4554d',
    ]);
    // Sibling family untouched by single-slot edits.
    expect(store.slotSizesForFamily('highlighter')).toEqual([8, 14, 20]);
    // Invalid edits never commit: out-of-range index, non-positive or
    // non-finite sizes, blank colors.
    const rawBefore = settings.get(TOOLBAR_CUSTOMIZATION_STORAGE_KEY);
    expect(store.setSlotSizeAt('pen', 3, 9)).toBe(false);
    expect(store.setSlotSizeAt('pen', -1, 9)).toBe(false);
    expect(store.setSlotSizeAt('pen', 0, 0)).toBe(false);
    expect(store.setSlotSizeAt('pen', 0, Number.NaN)).toBe(false);
    expect(store.setSlotColorAt('pen', 0, '   ')).toBe(false);
    expect(store.setSlotColorAt('pen', 9, '#123456')).toBe(false);
    expect(settings.get(TOOLBAR_CUSTOMIZATION_STORAGE_KEY)).toBe(rawBefore);
    expect(store.slotSizesForFamily('pen')).toEqual([2, 4.5, 6]);
    store.dispose();
  });

  it('persists three text colors without changing pen colors', () => {
    const settings = new InMemorySettingsService();
    const store = new ToolbarCustomizationStore({ settings });
    const penColors = store.slotColorsForFamily('pen');
    expect(store.slotColorsForText()).toEqual([
      '#37352f',
      '#7c6cf0',
      '#c4554d',
    ]);
    expect(store.setTextSlotColorAt(1, '#123456')).toBe(true);
    expect(store.setTextSlotColorAt(3, '#ffffff')).toBe(false);
    expect(store.slotColorsForFamily('pen')).toEqual(penColors);
    const reopened = new ToolbarCustomizationStore({ settings });
    expect(reopened.slotColorsForText()).toEqual([
      '#37352f',
      '#123456',
      '#c4554d',
    ]);
    store.dispose();
    reopened.dispose();
  });

  it('persists three Precision Eraser sizes independently and rejects out-of-range edits', () => {
    const settings = new InMemorySettingsService();
    const store = new ToolbarCustomizationStore({ settings });
    const penSizes = store.slotSizesForFamily('pen');
    expect(store.slotSizesForEraser()).toEqual([4, 12, 28]);
    expect(store.setEraserSlotSizeAt(1, 22)).toBe(true);
    expect(store.setEraserSlotSizeAt(3, 10)).toBe(false);
    expect(store.setEraserSlotSizeAt(0, 41)).toBe(false);
    expect(store.slotSizesForFamily('pen')).toEqual(penSizes);
    const reopened = new ToolbarCustomizationStore({ settings });
    expect(reopened.slotSizesForEraser()).toEqual([4, 22, 28]);
    store.dispose();
    reopened.dispose();
  });

  it('resolves short rows with defaults and truncates surplus verbatim', () => {
    expect(resolveSlotSizesForFamily('pen', undefined)).toEqual([2, 3.5, 6]);
    expect(resolveSlotSizesForFamily('highlighter', [9])).toEqual([9, 14, 20]);
    expect(resolveSlotSizesForFamily('pen', [1, 2, 3, 4, 5])).toEqual([
      1, 2, 3,
    ]);
    expect(resolveSlotColorsForFamily('highlighter', undefined)).toEqual([
      '#ffd54f',
      '#7c6cf0',
      '#c4554d',
    ]);
    expect(resolveSlotColorsForFamily('pen', ['#aaaaaa'])).toEqual([
      '#aaaaaa',
      '#7c6cf0',
      '#c4554d',
    ]);
    // Corrupt stored entries degrade per position, never as a whole row.
    expect(resolveSlotSizesForFamily('pen', [Number.NaN, 0, 5])).toEqual([
      2, 3.5, 5,
    ]);
    expect(resolveSlotColorsForFamily('pen', ['', '#bbbbbb'])).toEqual([
      '#37352f',
      '#bbbbbb',
      '#c4554d',
    ]);
  });

  it('cleans family fields entry-by-entry; corrupt payloads never throw', () => {
    expect(
      parseToolbarCustomization(
        JSON.stringify({
          version: 1,
          slotSizesPen: [2, 'x', -1, Number.NaN, Infinity, 4],
          slotSizesHighlighter: 'not-an-array',
          slotColorsPen: ['#111111', '', 42, '  #222222  '],
          slotColorsHighlighter: [{ id: 'x' }],
        }),
      ).customization,
    ).toEqual({
      version: 1,
      slotSizesPen: [2, 4],
      slotColorsPen: ['#111111', '#222222'],
    });
    for (const raw of [
      '{not json',
      JSON.stringify({ version: 999, slotSizesPen: [1] }),
      'null',
      undefined,
    ]) {
      expect(parseToolbarCustomization(raw).customization).toEqual({
        version: TOOLBAR_CUSTOMIZATION_VERSION,
      });
    }
  });

  it('round-trips family sets with unknown fields and clears them on reset', () => {
    const settings = new InMemorySettingsService();
    settings.set(
      TOOLBAR_CUSTOMIZATION_STORAGE_KEY,
      JSON.stringify({ version: 1, futureField: { pinned: true } }),
    );
    const store = new ToolbarCustomizationStore({ settings });
    store.setSlotSizeAt('pen', 0, 1.5);
    expect(
      JSON.parse(settings.get(TOOLBAR_CUSTOMIZATION_STORAGE_KEY) as string),
    ).toMatchObject({
      slotSizesPen: [1.5, 3.5, 6],
      futureField: { pinned: true },
    });
    // Family snapshots are fresh arrays (mutation never aliases store).
    const snap = store.snapshot();
    (snap.slotSizesPen as number[]).push(99);
    expect(store.slotSizesForFamily('pen')).toEqual([1.5, 3.5, 6]);
    // reset() restores factory for both families without touching siblings.
    settings.set('ink.preset.pen.color', '#37352f');
    store.reset();
    expect(store.slotSizesForFamily('pen')).toEqual([2, 3.5, 6]);
    expect(store.slotColorsForFamily('highlighter')).toEqual([
      '#ffd54f',
      '#7c6cf0',
      '#c4554d',
    ]);
    expect(store.snapshot()).toEqual({
      version: TOOLBAR_CUSTOMIZATION_VERSION,
    });
    expect(settings.get('ink.preset.pen.color')).toBe('#37352f');
    // Unknown future fields round-trip verbatim even across reset().
    expect(
      JSON.parse(settings.get(TOOLBAR_CUSTOMIZATION_STORAGE_KEY) as string),
    ).toMatchObject({ futureField: { pinned: true } });
    store.dispose();
  });

  it('preserves unknown fields from foreign-version payloads across commits', () => {
    // The loader still degrades to defaults without throwing, but keeps
    // the future payload's unknown fields for verbatim round-trip.
    const parsed = parseToolbarCustomization(
      JSON.stringify({
        version: 999,
        categoryOrder: [categoryB.id],
        futureField: { pinned: true },
      }),
    );
    expect(parsed.customization).toEqual({
      version: TOOLBAR_CUSTOMIZATION_VERSION,
    });
    expect(parsed.unknownFields).toEqual({ futureField: { pinned: true } });
    // A later commit upgrades the envelope version without dropping them.
    const settings = new InMemorySettingsService();
    settings.set(
      TOOLBAR_CUSTOMIZATION_STORAGE_KEY,
      JSON.stringify({ version: 999, futureField: { pinned: true } }),
    );
    const store = new ToolbarCustomizationStore({ settings });
    store.setHiddenItems([itemA1.id]);
    expect(
      JSON.parse(settings.get(TOOLBAR_CUSTOMIZATION_STORAGE_KEY) as string),
    ).toMatchObject({
      version: 1,
      hiddenItems: [itemA1.id],
      futureField: { pinned: true },
    });
    store.dispose();
  });
});
