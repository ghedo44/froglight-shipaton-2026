import { ToolbarCustomizationStore } from './toolbar/toolbar-customization.js';
import { describe, expect, it } from 'vitest';
import {
  buildActiveToolSettingsControls,
  InMemorySettingsService,
  InkPresetStore,
  SurfaceStyleLibrary,
} from '@froglight/foundation';
import type { DocumentToolSnapshot } from '@froglight/foundation';
import {
  buildStylusPaletteModel,
  SQUEEZE_MAX_PRIMARY,
  splitSqueezeTools,
  squeezeToolTier,
  type StylusPaletteTool,
} from './stylus-palette-model.js';
import {
  createToolbarCompositionRegistry,
  resolveToolbarComposition,
} from './toolbar/composition-registry.js';
import { defaultToolbarComposition } from './toolbar/default-composition.js';
import { assembleOwnedPool } from './toolbar/placement-resolver.js';

function button(
  id: string,
  label: string,
  extra: Record<string, unknown> = {},
): DocumentToolSnapshot['controls'][number] {
  return { kind: 'button', id, group: 'draw', label, ...extra } as DocumentToolSnapshot['controls'][number];
}

function surfaceSnapshot(): DocumentToolSnapshot {
  return {
    context: 'Ink canvas',
    controls: [
      button('ink.tool.froglight.ink.pen', 'Pen', {
        role: 'surface-tool',
        toolRole: 'pen',
        toolId: 'froglight.ink.pen',
        semanticRole: 'surface.pen.ball',
        active: true,
      }),
      button('ink.tool.froglight.ink.eraser', 'Eraser', {
        role: 'surface-tool',
        toolRole: 'eraser',
        toolId: 'froglight.ink.eraser',
        semanticRole: 'surface.erase',
      }),
      button('ink.tool.froglight.ink.highlighter', 'Highlighter', {
        role: 'surface-tool',
        toolRole: 'highlighter',
        toolId: 'froglight.ink.highlighter',
        semanticRole: 'surface.highlighter',
      }),
      {
        kind: 'color',
        id: 'ink.color',
        group: 'style',
        label: 'Stroke color',
        value: '#37352f',
        options: ['#37352f', '#7c6cf0'],
        semanticRole: 'surface.style.color',
      },
      {
        kind: 'choice',
        id: 'ink.width',
        group: 'style',
        label: 'Stroke width',
        value: '3.5',
        options: [{ value: '3.5', label: '3.5 px' }],
        semanticRole: 'surface.style.width',
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
        semanticRole: 'surface.erase.size',
      },
    ],
  };
}

describe('buildStylusPaletteModel', () => {
  it('maps semantic roles with active tool and reuses provider options', () => {
    const model = buildStylusPaletteModel(surfaceSnapshot(), { canUndo: true });
    expect(model).not.toBeNull();
    expect(model?.tools.map((tool) => tool.toolRole)).toEqual(['pen', 'highlighter', 'eraser']);
    expect(model?.activeToolId).toBe('ink.tool.froglight.ink.pen');
    expect(model?.color?.options).toEqual(['#37352f', '#7c6cf0']);
    expect(model?.width?.value).toBe('3.5');
    expect(model?.eraserSize?.value).toBe(10);
    expect(model?.canUndo).toBe(true);
    expect(model?.canRedo).toBe(false);
  });

  it('returns null for non-surface editors', () => {
    const model = buildStylusPaletteModel({
      context: 'Paragraph',
      controls: [{ kind: 'button', id: 'markdown.bold', group: 'text', label: 'Bold' }],
    });
    expect(model).toBeNull();
    expect(buildStylusPaletteModel(null)).toBeNull();
  });

  it('keeps registry contributions alongside core tools', () => {
    const model = buildStylusPaletteModel(surfaceSnapshot(), {
      contributions: [{ label: 'Acme recipe' }],
    });
    expect(model?.tools.length).toBeGreaterThan(0);
    expect(model?.contributions).toEqual([{ label: 'Acme recipe' }]);
  });
});

describe('buildStylusPaletteModel composition order (A1)', () => {
  const KIND = 'froglight.ink';

  function compositionButton(
    id: string,
    semanticRole: string,
    toolRole?: 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'select',
  ): DocumentToolSnapshot['controls'][number] {
    return {
      kind: 'button',
      id,
      group: 'draw',
      label: id,
      role: 'surface-tool',
      ...(toolRole !== undefined ? { toolRole } : {}),
      semanticRole,
    } as DocumentToolSnapshot['controls'][number];
  }

  it('preserves category order over role buckets (erase category before write)', () => {
    const created = createToolbarCompositionRegistry();
    try {
      // Category order contradicts ROLE_PRIORITY (pen-first): the erase
      // category (order 10) resolves before write (order 20), so the
      // eraser must lead even though pen sorts first by coarse role.
      created.registry.registerCategory({
        id: 'surface.write',
        familyId: 'surface',
        label: 'Write',
        icon: 'pen',
        order: 20,
      });
      created.registry.registerCategory({
        id: 'surface.erase',
        familyId: 'surface',
        label: 'Erase',
        icon: 'eraser',
        order: 10,
      });
      created.registry.registerItem({
        id: 'test.write.ball',
        categoryId: 'surface.write',
        semanticRole: 'surface.pen.ball',
        order: 10,
        projections: ['normal', 'compact', 'squeeze'],
      });
      created.registry.registerItem({
        id: 'test.erase.tool',
        categoryId: 'surface.erase',
        semanticRole: 'surface.erase',
        order: 10,
        projections: ['normal', 'compact', 'squeeze'],
      });
      created.registry.registerKindExtension({
        id: 'test-ink-family',
        kindIds: [KIND],
        familyIds: ['surface'],
      });
      const assembled = assembleOwnedPool({
        providerControls: [
          compositionButton('test.pen', 'surface.pen.ball', 'pen'),
          compositionButton('test.eraser', 'surface.erase', 'eraser'),
        ],
      });
      const poolControls = assembled.ownedPool.map((owned) => owned.control);
      const composition = resolveToolbarComposition({
        snapshot: created.registry.snapshot(),
        kindId: KIND,
        controls: poolControls,
        projection: 'squeeze',
      });
      const model = buildStylusPaletteModel(
        { context: 'Ink canvas', controls: poolControls },
        { composition, ownedPool: assembled.ownedPool },
      );
      expect(model?.tools.map((tool) => tool.id)).toEqual([
        'test.eraser',
        'test.pen',
      ]);
      expect(model?.owned?.map((owned) => owned.control.id)).toEqual([
        'test.eraser',
        'test.pen',
      ]);
    } finally {
      created.dispose();
    }
  });

  it('keeps a community showInSqueeze item in composition position, not bucketed last', () => {
    const created = createToolbarCompositionRegistry();
    try {
      created.registry.registerCategory({
        id: 'surface.write',
        familyId: 'surface',
        label: 'Write',
        icon: 'pen',
        order: 10,
      });
      created.registry.registerCategory({
        id: 'surface.erase',
        familyId: 'surface',
        label: 'Erase',
        icon: 'eraser',
        order: 20,
      });
      // Community item (no coarse toolRole) sits between ball and eraser
      // in composition order: write.ball (10), community diamond (20 in
      // the same write category), erase.tool (erase category order 20).
      // ROLE_PRIORITY would bucket the role-less community control last.
      created.registry.registerItem({
        id: 'test.write.ball',
        categoryId: 'surface.write',
        semanticRole: 'surface.pen.ball',
        order: 10,
        projections: ['normal', 'compact', 'squeeze'],
      });
      created.registry.registerItem({
        id: 'community.example.diagram.diamond.item',
        categoryId: 'surface.write',
        semanticRole: 'community.example.diagram.diamond',
        order: 20,
        projections: ['normal', 'compact', 'squeeze'],
      });
      created.registry.registerItem({
        id: 'test.erase.tool',
        categoryId: 'surface.erase',
        semanticRole: 'surface.erase',
        order: 10,
        projections: ['normal', 'compact', 'squeeze'],
      });
      created.registry.registerKindExtension({
        id: 'test-ink-family',
        kindIds: [KIND],
        familyIds: ['surface'],
      });
      const assembled = assembleOwnedPool({
        providerControls: [
          compositionButton('test.pen', 'surface.pen.ball', 'pen'),
          compositionButton('test.eraser', 'surface.erase', 'eraser'),
          // Community controls carry a semanticRole but no toolRole.
          compositionButton(
            'community.example.diagram.diamond.command',
            'community.example.diagram.diamond',
          ),
        ],
      });
      const poolControls = assembled.ownedPool.map((owned) => owned.control);
      const composition = resolveToolbarComposition({
        snapshot: created.registry.snapshot(),
        kindId: KIND,
        controls: poolControls,
        projection: 'squeeze',
      });
      const model = buildStylusPaletteModel(
        { context: 'Ink canvas', controls: poolControls },
        { composition, ownedPool: assembled.ownedPool },
      );
      expect(model?.tools.map((tool) => tool.id)).toEqual([
        'test.pen',
        'community.example.diagram.diamond.command',
        'test.eraser',
      ]);
    } finally {
      created.dispose();
    }
  });

  it('respects before/after constraints over numeric order and role priority', () => {
    const created = createToolbarCompositionRegistry();
    try {
      created.registry.registerCategory({
        id: 'surface.write',
        familyId: 'surface',
        label: 'Write',
        icon: 'pen',
        order: 10,
      });
      // Numeric order says highlighter (10), custom (15), ball (20), but
      // the custom item declares after:ball, so resolved order must be
      // highlighter, ball, custom. ROLE_PRIORITY would order ball (pen 0)
      // before highlighter (1) and bucket custom (no role) last anyway in
      // a different arrangement; the exact equality below pins the
      // topological result.
      created.registry.registerItem({
        id: 'test.write.highlighter',
        categoryId: 'surface.write',
        semanticRole: 'surface.highlighter',
        order: 10,
        projections: ['normal', 'compact', 'squeeze'],
      });
      created.registry.registerItem({
        id: 'test.write.custom',
        categoryId: 'surface.write',
        semanticRole: 'community.example.custom',
        order: 15,
        after: ['test.write.ball'],
        projections: ['normal', 'compact', 'squeeze'],
      });
      created.registry.registerItem({
        id: 'test.write.ball',
        categoryId: 'surface.write',
        semanticRole: 'surface.pen.ball',
        order: 20,
        projections: ['normal', 'compact', 'squeeze'],
      });
      created.registry.registerKindExtension({
        id: 'test-ink-family',
        kindIds: [KIND],
        familyIds: ['surface'],
      });
      const assembled = assembleOwnedPool({
        providerControls: [
          compositionButton('test.pen', 'surface.pen.ball', 'pen'),
          compositionButton(
            'test.highlighter',
            'surface.highlighter',
            'highlighter',
          ),
          compositionButton(
            'community.example.custom.command',
            'community.example.custom',
          ),
        ],
      });
      const poolControls = assembled.ownedPool.map((owned) => owned.control);
      const composition = resolveToolbarComposition({
        snapshot: created.registry.snapshot(),
        kindId: KIND,
        controls: poolControls,
        projection: 'squeeze',
      });
      expect(
        composition.categories.flatMap((category) =>
          category.items.map((item) => item.control.id),
        ),
      ).toEqual([
        'test.highlighter',
        'test.pen',
        'community.example.custom.command',
      ]);
      const model = buildStylusPaletteModel(
        { context: 'Ink canvas', controls: poolControls },
        { composition, ownedPool: assembled.ownedPool },
      );
      expect(model?.tools.map((tool) => tool.id)).toEqual([
        'test.highlighter',
        'test.pen',
        'community.example.custom.command',
      ]);
    } finally {
      created.dispose();
    }
  });

  it('orders the pen family by composition order regardless of pool order', () => {
    const created = createToolbarCompositionRegistry();
    try {
      created.registry.registerCategory({
        id: 'surface.write',
        familyId: 'surface',
        label: 'Write',
        icon: 'pen',
        order: 10,
      });
      const family: Array<{
        itemId: string;
        semanticRole: string;
        order: number;
      }> = [
        { itemId: 'test.write.ball', semanticRole: 'surface.pen.ball', order: 10 },
        {
          itemId: 'test.write.fountain',
          semanticRole: 'surface.pen.fountain',
          order: 20,
        },
        { itemId: 'test.write.brush', semanticRole: 'surface.pen.brush', order: 30 },
        { itemId: 'test.write.pencil', semanticRole: 'surface.pencil', order: 40 },
        {
          itemId: 'test.write.highlighter',
          semanticRole: 'surface.highlighter',
          order: 50,
        },
      ];
      for (const entry of family) {
        created.registry.registerItem({
          id: entry.itemId,
          categoryId: 'surface.write',
          semanticRole: entry.semanticRole,
          order: entry.order,
          projections: ['normal', 'compact', 'squeeze'],
        });
      }
      created.registry.registerKindExtension({
        id: 'test-ink-family',
        kindIds: [KIND],
        familyIds: ['surface'],
      });
      // Pool arrives scrambled; composition (ball 10 → highlighter 50)
      // is the single ordering authority.
      const assembled = assembleOwnedPool({
        providerControls: [
          compositionButton('test.highlighter', 'surface.highlighter', 'highlighter'),
          compositionButton('test.pencil', 'surface.pencil', 'pen'),
          compositionButton('test.fountain', 'surface.pen.fountain', 'pen'),
          compositionButton('test.brush', 'surface.pen.brush', 'pen'),
          compositionButton('test.ball', 'surface.pen.ball', 'pen'),
        ],
      });
      const poolControls = assembled.ownedPool.map((owned) => owned.control);
      const composition = resolveToolbarComposition({
        snapshot: created.registry.snapshot(),
        kindId: KIND,
        controls: poolControls,
        projection: 'squeeze',
      });
      const model = buildStylusPaletteModel(
        { context: 'Ink canvas', controls: poolControls },
        { composition, ownedPool: assembled.ownedPool },
      );
      // Fountain/brush/pencil share the pen role (A0) yet keep their
      // composition slots between ball and highlighter.
      expect(model?.tools.map((tool) => tool.id)).toEqual([
        'test.ball',
        'test.fountain',
        'test.brush',
        'test.pencil',
        'test.highlighter',
      ]);
    } finally {
      created.dispose();
    }
  });

  it('keeps the legacy no-composition role sort unchanged', () => {
    const model = buildStylusPaletteModel({
      context: 'Ink canvas',
      controls: [
        // Snapshot arrives eraser-first; legacy behavior sorts pen first.
        compositionButton('test.eraser', 'surface.erase', 'eraser'),
        compositionButton('test.pen', 'surface.pen.ball', 'pen'),
      ].map((control) => ({
        ...control,
        role: 'surface-tool' as const,
      })),
    });
    expect(model?.tools.map((tool) => tool.id)).toEqual([
      'test.pen',
      'test.eraser',
    ]);
  });
});

describe('squeeze tool tiers (§25: primary / secondary / More)', () => {
  it('tiers surface tools as primary and role-less community actions as secondary', () => {
    expect(
      squeezeToolTier({
        id: 'test.pen',
        label: 'Pen',
        toolRole: 'pen',
        active: true,
      }),
    ).toBe('primary');
    expect(
      squeezeToolTier({
        id: 'community.example.diagram.diamond.command',
        label: 'Decision diamond',
        active: false,
      }),
    ).toBe('secondary');
  });

  it('splits without reordering inside each bucket', () => {
    const tools = [
      { id: 'test.pen', label: 'Pen', toolRole: 'pen' as const, active: true },
      {
        id: 'community.example.diagram.diamond.command',
        label: 'Decision diamond',
        active: false,
      },
      {
        id: 'test.eraser',
        label: 'Eraser',
        toolRole: 'eraser' as const,
        active: false,
      },
      {
        id: 'community.example.other.command',
        label: 'Other',
        active: false,
      },
    ];
    const { primary, secondary } = splitSqueezeTools(tools);
    expect(primary.map((tool) => tool.id)).toEqual([
      'test.pen',
      'test.eraser',
    ]);
    expect(secondary.map((tool) => tool.id)).toEqual([
      'community.example.diagram.diamond.command',
      'community.example.other.command',
    ]);
    // Stable identities survive tiering for owner routing.
    expect([...primary, ...secondary]).toHaveLength(tools.length);
  });

  it('keeps an empty secondary for first-party-only palettes', () => {
    const model = buildStylusPaletteModel(surfaceSnapshot());
    expect(model).not.toBeNull();
    const { primary, secondary } = splitSqueezeTools(model?.tools ?? []);
    expect(primary.length).toBeGreaterThan(0);
    expect(secondary).toEqual([]);
  });

  it('demotes shape/text coarse roles to secondary (no over-broad toolRole=>primary)', () => {
    expect(
      squeezeToolTier({
        id: 'test.line',
        label: 'Line',
        toolRole: 'shape',
        semanticRole: 'surface.shape.line',
        active: false,
      }),
    ).toBe('secondary');
    expect(
      squeezeToolTier({
        id: 'test.text',
        label: 'Text',
        toolRole: 'text',
        semanticRole: 'surface.insert.text',
        active: false,
      }),
    ).toBe('secondary');
    for (const toolRole of ['pen', 'highlighter', 'eraser', 'select', 'lasso'] as const) {
      expect(
        squeezeToolTier({ id: `test.${toolRole}`, label: toolRole, toolRole, active: false }),
      ).toBe('primary');
    }
  });
});

describe('squeeze compact tier model (Repair 3: bounded crescent ~5)', () => {
  function compactTool(
    id: string,
    extra: Partial<StylusPaletteTool> = {},
  ): StylusPaletteTool {
    return { id, label: id, active: false, ...extra };
  }

  /** Realistic full Surface squeeze order (composition order). */
  function fullSurfaceTools(activeId: string): StylusPaletteTool[] {
    const defs: Array<[string, Partial<StylusPaletteTool>]> = [
      ['ink.tool.pen.ball', { toolRole: 'pen', semanticRole: 'surface.pen.ball' }],
      ['ink.tool.pen.fountain', { toolRole: 'pen', semanticRole: 'surface.pen.fountain' }],
      ['ink.tool.pen.brush', { toolRole: 'pen', semanticRole: 'surface.pen.brush' }],
      ['ink.tool.pen.pencil', { toolRole: 'pen', semanticRole: 'surface.pencil' }],
      ['ink.tool.highlighter', { toolRole: 'highlighter', semanticRole: 'surface.highlighter' }],
      ['ink.tool.eraser', { toolRole: 'eraser', semanticRole: 'surface.erase' }],
      ['ink.tool.select', { toolRole: 'select', semanticRole: 'surface.select' }],
      ['ink.tool.lasso', { toolRole: 'lasso', semanticRole: 'surface.lasso' }],
      ['ink.tool.shape.line', { toolRole: 'shape', semanticRole: 'surface.shape.line' }],
      ['ink.tool.shape.rectangle', { toolRole: 'shape', semanticRole: 'surface.shape.rectangle' }],
      ['ink.tool.shape.ellipse', { toolRole: 'shape', semanticRole: 'surface.shape.ellipse' }],
      ['ink.tool.insert.text', { toolRole: 'text', semanticRole: 'surface.insert.text' }],
      ['ink.tool.insert.image', { semanticRole: 'surface.insert.image' }],
      ['community.example.diagram.diamond.command', { semanticRole: 'community.example.diagram.diamond' }],
    ];
    return defs.map(([id, meta]) =>
      compactTool(id, { ...meta, active: id === activeId }),
    );
  }

  function ids(tools: readonly StylusPaletteTool[]): string[] {
    return tools.map((tool) => tool.id);
  }

  it('bounds the main crescent to one grid row with a full Ink graph', () => {
    const tools = fullSurfaceTools('ink.tool.pen.ball');
    const { primary, secondary } = splitSqueezeTools(tools, {
      activeToolId: 'ink.tool.pen.ball',
    });
    // Single grid row: the overlay uses repeat(5, …).
    expect(primary.length).toBeLessThanOrEqual(SQUEEZE_MAX_PRIMARY);
    expect(SQUEEZE_MAX_PRIMARY).toBe(5);
    expect(primary.length).toBe(5);
    // Pen siblings never consume extra crescent slots.
    expect(ids(primary)).toEqual([
      'ink.tool.pen.ball',
      'ink.tool.highlighter',
      'ink.tool.eraser',
      'ink.tool.select',
      'ink.tool.shape.line',
    ]);
    // Siblings, remaining shapes/inserts, and community stay secondary in
    // composition order with owners untouched.
    expect(ids(secondary)).toEqual([
      'ink.tool.pen.fountain',
      'ink.tool.pen.brush',
      'ink.tool.pen.pencil',
      'ink.tool.lasso',
      'ink.tool.shape.rectangle',
      'ink.tool.shape.ellipse',
      'ink.tool.insert.text',
      'ink.tool.insert.image',
      'community.example.diagram.diamond.command',
    ]);
    expect([...primary, ...secondary]).toHaveLength(tools.length);
  });

  it('tracks active tool changes without reordering inside each tier', () => {
    // Active fountain replaces ball in the crescent; ball drops to
    // secondary in its composition slot.
    const fountainActive = splitSqueezeTools(
      fullSurfaceTools('ink.tool.pen.fountain'),
      { activeToolId: 'ink.tool.pen.fountain' },
    );
    expect(ids(fountainActive.primary)).toEqual([
      'ink.tool.pen.fountain',
      'ink.tool.highlighter',
      'ink.tool.eraser',
      'ink.tool.select',
      'ink.tool.shape.line',
    ]);
    expect(ids(fountainActive.secondary)).toContain('ink.tool.pen.ball');

    // Active rectangle promotes as the one contextual tool.
    const rectActive = splitSqueezeTools(
      fullSurfaceTools('ink.tool.shape.rectangle'),
      { activeToolId: 'ink.tool.shape.rectangle' },
    );
    expect(ids(rectActive.primary)).toEqual([
      'ink.tool.pen.ball',
      'ink.tool.highlighter',
      'ink.tool.eraser',
      'ink.tool.select',
      'ink.tool.shape.rectangle',
    ]);
    expect(ids(rectActive.secondary)).toContain('ink.tool.shape.line');

    // Active lasso replaces select as the one select-family slot.
    const lassoActive = splitSqueezeTools(fullSurfaceTools('ink.tool.lasso'), {
      activeToolId: 'ink.tool.lasso',
    });
    expect(ids(lassoActive.primary)).toContain('ink.tool.lasso');
    expect(ids(lassoActive.primary)).not.toContain('ink.tool.select');
    expect(ids(lassoActive.secondary)).toContain('ink.tool.select');

    // Active eraser stays in the crescent; pen rep survives for switching.
    const eraserActive = splitSqueezeTools(fullSurfaceTools('ink.tool.eraser'), {
      activeToolId: 'ink.tool.eraser',
    });
    expect(ids(eraserActive.primary)).toEqual([
      'ink.tool.pen.ball',
      'ink.tool.highlighter',
      'ink.tool.eraser',
      'ink.tool.select',
      'ink.tool.shape.line',
    ]);
  });

  it('keeps role-less community commands secondary even when flagged active', () => {
    const tools = fullSurfaceTools('community.example.diagram.diamond.command');
    const { primary, secondary } = splitSqueezeTools(tools, {
      activeToolId: 'community.example.diagram.diamond.command',
    });
    // Commands are actions, not drawing tools: never promoted to the
    // crescent, even when active.
    expect(ids(primary)).toEqual([
      'ink.tool.pen.ball',
      'ink.tool.highlighter',
      'ink.tool.eraser',
      'ink.tool.select',
      'ink.tool.shape.line',
    ]);
    expect(ids(secondary)).toContain(
      'community.example.diagram.diamond.command',
    );
    expect(primary.length).toBeLessThanOrEqual(SQUEEZE_MAX_PRIMARY);
  });

  it('preserves composition order verbatim inside each tier', () => {
    // Scrambled input in reverse composition order: tiers still emit in
    // incoming (composition) order, not priority buckets.
    const tools = fullSurfaceTools('ink.tool.pen.ball').reverse();
    const { primary, secondary } = splitSqueezeTools(tools, {
      activeToolId: 'ink.tool.pen.ball',
    });
    const incoming = new Map(tools.map((tool, index) => [tool.id, index]));
    const isOrdered = (list: readonly StylusPaletteTool[]): boolean =>
      list.every((tool, index) => {
        if (index === 0) return true;
        const prev = list[index - 1];
        if (prev === undefined) return true;
        return (incoming.get(prev.id) ?? 0) < (incoming.get(tool.id) ?? 0);
      });
    expect(isOrdered(primary)).toBe(true);
    expect(isOrdered(secondary)).toBe(true);
  });

  it('collapses the pen family: only the active pen reaches the crescent', () => {
    const pens: StylusPaletteTool[] = [
      compactTool('test.ball', { toolRole: 'pen', semanticRole: 'surface.pen.ball' }),
      compactTool('test.fountain', { toolRole: 'pen', semanticRole: 'surface.pen.fountain', active: true }),
      compactTool('test.brush', { toolRole: 'pen', semanticRole: 'surface.pen.brush' }),
      compactTool('test.pencil', { toolRole: 'pen', semanticRole: 'surface.pencil' }),
      compactTool('test.highlighter', { toolRole: 'highlighter', semanticRole: 'surface.highlighter' }),
      compactTool('test.eraser', { toolRole: 'eraser', semanticRole: 'surface.erase' }),
    ];
    const { primary, secondary } = splitSqueezeTools(pens, {
      activeToolId: 'test.fountain',
    });
    expect(ids(primary)).toEqual(['test.fountain', 'test.highlighter', 'test.eraser']);
    expect(ids(secondary)).toEqual(['test.ball', 'test.brush', 'test.pencil']);
  });

  it('bounds Ink/Notebook/Whiteboard squeeze graphs through the default composition', () => {
    for (const kindId of ['froglight.ink', 'froglight.notebook', 'froglight.whiteboard'] as const) {
      const created = createToolbarCompositionRegistry();
      try {
        const defaults = defaultToolbarComposition();
        for (const entry of defaults.categories)
          created.registry.registerCategory(entry);
        for (const entry of defaults.items)
          created.registry.registerItem(entry);
        for (const entry of defaults.extensions)
          created.registry.registerKindExtension(entry);
        const assembled = assembleOwnedPool({
          providerControls: [
            { kind: 'button', id: `${kindId}.tool.pen`, group: 'draw', label: 'Pen', role: 'surface-tool', toolRole: 'pen', semanticRole: 'surface.pen.ball', active: true, activationRole: 'tool' },
            { kind: 'button', id: `${kindId}.tool.fountain`, group: 'draw', label: 'Fountain Pen', role: 'surface-tool', toolRole: 'pen', semanticRole: 'surface.pen.fountain', activationRole: 'tool' },
            { kind: 'button', id: `${kindId}.tool.brush`, group: 'draw', label: 'Brush Pen', role: 'surface-tool', toolRole: 'pen', semanticRole: 'surface.pen.brush', activationRole: 'tool' },
            { kind: 'button', id: `${kindId}.tool.pencil`, group: 'draw', label: 'Pencil', role: 'surface-tool', toolRole: 'pen', semanticRole: 'surface.pencil', activationRole: 'tool' },
            { kind: 'button', id: `${kindId}.tool.highlighter`, group: 'draw', label: 'Highlighter', role: 'surface-tool', toolRole: 'highlighter', semanticRole: 'surface.highlighter', activationRole: 'tool' },
            { kind: 'button', id: `${kindId}.tool.eraser`, group: 'draw', label: 'Eraser', role: 'surface-tool', toolRole: 'eraser', semanticRole: 'surface.erase', activationRole: 'tool' },
            { kind: 'button', id: `${kindId}.tool.select`, group: 'draw', label: 'Select', role: 'surface-tool', toolRole: 'select', semanticRole: 'surface.select', activationRole: 'tool' },
            { kind: 'button', id: `${kindId}.tool.lasso`, group: 'draw', label: 'Lasso', role: 'surface-tool', toolRole: 'lasso', semanticRole: 'surface.lasso', activationRole: 'tool' },
            { kind: 'button', id: `${kindId}.tool.line`, group: 'draw', label: 'Line', role: 'surface-tool', toolRole: 'shape', semanticRole: 'surface.shape.line', activationRole: 'tool' },
            { kind: 'button', id: `${kindId}.tool.rect`, group: 'draw', label: 'Rectangle', role: 'surface-tool', toolRole: 'shape', semanticRole: 'surface.shape.rectangle', activationRole: 'tool' },
            { kind: 'button', id: `${kindId}.tool.ellipse`, group: 'draw', label: 'Ellipse', role: 'surface-tool', toolRole: 'shape', semanticRole: 'surface.shape.ellipse', activationRole: 'tool' },
            { kind: 'button', id: `${kindId}.tool.text`, group: 'draw', label: 'Text', role: 'surface-tool', toolRole: 'text', semanticRole: 'surface.insert.text', activationRole: 'tool' },
            { kind: 'button', id: `${kindId}.tool.image`, group: 'insert', label: 'Image', semanticRole: 'surface.insert.image' },
          ] as DocumentToolSnapshot['controls'],
        });
        const poolControls = assembled.ownedPool.map((owned) => owned.control);
        const composition = resolveToolbarComposition({
          snapshot: created.registry.snapshot(),
          kindId,
          controls: poolControls,
          projection: 'squeeze',
        });
        const model = buildStylusPaletteModel(
          { context: 'Surface canvas', controls: poolControls },
          { composition, ownedPool: assembled.ownedPool },
        );
        expect(model, kindId).not.toBeNull();
        const { primary, secondary } = splitSqueezeTools(model?.tools ?? [], {
          activeToolId: model?.activeToolId,
        });
        // One grid row for every Surface family; pen siblings and extra
        // shapes/inserts never crowd the crescent.
        expect(primary.length, kindId).toBeLessThanOrEqual(5);
        expect(secondary.length, kindId).toBeGreaterThan(0);
        // Active pen survives in the crescent with its semantic identity.
        const activePrimary = primary.find((tool) => tool.id === `${kindId}.tool.pen`);
        expect(activePrimary?.semanticRole, kindId).toBe('surface.pen.ball');
      } finally {
        created.dispose();
      }
    }
  });

  it('carries semanticRole without parsing control ids', () => {
    // Misleading ids: `pen` in the id must not promote, and a plain id
    // with explicit metadata must still tier correctly.
    expect(
      squeezeToolTier(
        compactTool('ink.tool.totally-pen-thing', {
          semanticRole: 'community.example.action',
          active: false,
        }),
      ),
    ).toBe('secondary');
    expect(
      squeezeToolTier(
        compactTool('plain', { toolRole: 'pen', semanticRole: 'surface.pen.ball' }),
      ),
    ).toBe('primary');
    const created = createToolbarCompositionRegistry();
    try {
      created.registry.registerCategory({ id: 'surface.write', familyId: 'surface', label: 'Write', icon: 'pen', order: 10 });
      created.registry.registerItem({
        id: 'test.write.ball',
        categoryId: 'surface.write',
        semanticRole: 'surface.pen.ball',
        order: 10,
        projections: ['normal', 'compact', 'squeeze'],
      });
      created.registry.registerKindExtension({ id: 'test-ink', kindIds: ['froglight.ink'], familyIds: ['surface'] });
      const assembled = assembleOwnedPool({
        providerControls: [
          { kind: 'button', id: 'opaque-id-1', group: 'draw', label: 'Pen', role: 'surface-tool', toolRole: 'pen', semanticRole: 'surface.pen.ball', active: true },
        ] as DocumentToolSnapshot['controls'],
      });
      const poolControls = assembled.ownedPool.map((owned) => owned.control);
      const composition = resolveToolbarComposition({
        snapshot: created.registry.snapshot(),
        kindId: 'froglight.ink',
        controls: poolControls,
        projection: 'squeeze',
      });
      const model = buildStylusPaletteModel(
        { context: 'Ink canvas', controls: poolControls },
        { composition, ownedPool: assembled.ownedPool },
      );
      expect(model?.tools[0]?.semanticRole).toBe('surface.pen.ball');
      const { primary } = splitSqueezeTools(model?.tools ?? [], {
        activeToolId: model?.activeToolId,
      });
      expect(primary.map((tool) => tool.id)).toEqual(['opaque-id-1']);
    } finally {
      created.dispose();
    }
  });
});

describe('squeeze style projection (A2: composition-driven styles)', () => {
  const KIND = 'froglight.ink';

  function styleButton(
    id: string,
    semanticRole: string,
    toolRole?: 'pen' | 'eraser',
  ): DocumentToolSnapshot['controls'][number] {
    return {
      kind: 'button',
      id,
      group: 'draw',
      label: id,
      role: 'surface-tool',
      ...(toolRole !== undefined ? { toolRole } : {}),
      semanticRole,
    } as DocumentToolSnapshot['controls'][number];
  }

  function quickColor(
    id = 'ink.color',
  ): DocumentToolSnapshot['controls'][number] {
    return {
      kind: 'color',
      id,
      group: 'style',
      label: 'Stroke color',
      value: '#37352f',
      options: ['#37352f', '#7c6cf0'],
      semanticRole: 'surface.style.color',
    } as DocumentToolSnapshot['controls'][number];
  }

  function quickWidth(
    id = 'ink.width',
  ): DocumentToolSnapshot['controls'][number] {
    return {
      kind: 'choice',
      id,
      group: 'style',
      label: 'Stroke width',
      value: '3.5',
      options: [{ value: '3.5', label: '3.5 px' }],
      semanticRole: 'surface.style.width',
    } as DocumentToolSnapshot['controls'][number];
  }

  function quickEraser(
    id = 'ink.eraser-radius',
  ): DocumentToolSnapshot['controls'][number] {
    return {
      kind: 'range',
      id,
      group: 'style',
      label: 'Eraser size',
      value: 10,
      min: 2,
      max: 40,
      step: 1,
      semanticRole: 'surface.erase.size',
    } as DocumentToolSnapshot['controls'][number];
  }

  function savedStyles(
    id = 'ink.settings.pen.saved-style',
  ): DocumentToolSnapshot['controls'][number] {
    return {
      kind: 'choice',
      id,
      group: 'style',
      label: 'Saved styles',
      value: 'a',
      options: [
        { value: '', label: 'Working style' },
        { value: 'a', label: 'A' },
      ],
      semanticRole: 'surface.style.saved',
    } as DocumentToolSnapshot['controls'][number];
  }

  function registerSurfaceFrame(
    registry: ReturnType<
      typeof createToolbarCompositionRegistry
    >['registry'],
    opts: { readonly withStyles: boolean },
  ): void {
    registry.registerCategory({
      id: 'surface.write',
      familyId: 'surface',
      label: 'Write',
      icon: 'pen',
      order: 10,
    });
    registry.registerCategory({
      id: 'surface.erase',
      familyId: 'surface',
      label: 'Erase',
      icon: 'eraser',
      order: 20,
    });
    registry.registerItem({
      id: 'test.write.ball',
      categoryId: 'surface.write',
      semanticRole: 'surface.pen.ball',
      order: 10,
      projections: ['normal', 'compact', 'squeeze'],
    });
    registry.registerItem({
      id: 'test.erase.tool',
      categoryId: 'surface.erase',
      semanticRole: 'surface.erase',
      order: 10,
      projections: ['normal', 'compact', 'squeeze'],
    });
    if (opts.withStyles) {
      // Mirror the default composition: explicit squeeze-only style items
      // keyed by semanticRole, never by id shape.
      registry.registerItem({
        id: 'test.write.color',
        categoryId: 'surface.write',
        semanticRole: 'surface.style.color',
        order: 90,
        projections: ['squeeze'],
      });
      registry.registerItem({
        id: 'test.write.width',
        categoryId: 'surface.write',
        semanticRole: 'surface.style.width',
        order: 100,
        projections: ['squeeze'],
      });
      registry.registerItem({
        id: 'test.write.saved-style',
        categoryId: 'surface.write',
        semanticRole: 'surface.style.saved',
        order: 110,
        projections: ['squeeze'],
      });
      registry.registerItem({
        id: 'test.erase.size',
        categoryId: 'surface.erase',
        semanticRole: 'surface.erase.size',
        order: 90,
        projections: ['squeeze'],
      });
    }
    registry.registerKindExtension({
      id: 'test-ink-family',
      kindIds: [KIND],
      familyIds: ['surface'],
    });
  }

  function fullStylePool(): DocumentToolSnapshot['controls'] {
    return [
      styleButton('test.pen', 'surface.pen.ball', 'pen'),
      styleButton('test.eraser', 'surface.erase', 'eraser'),
      quickColor(),
      quickWidth(),
      quickEraser(),
      savedStyles(),
    ] as DocumentToolSnapshot['controls'];
  }

  it('hides styles absent from the squeeze projection while keeping tools (no id inference)', () => {
    const created = createToolbarCompositionRegistry();
    try {
      // Same control ids, no style items: proves style membership is the
      // composition graph, not the presence of style controls in the pool.
      registerSurfaceFrame(created.registry, { withStyles: false });
      const assembled = assembleOwnedPool({
        providerControls: fullStylePool(),
      });
      const poolControls = assembled.ownedPool.map((owned) => owned.control);
      const composition = resolveToolbarComposition({
        snapshot: created.registry.snapshot(),
        kindId: KIND,
        controls: poolControls,
        projection: 'squeeze',
      });
      const model = buildStylusPaletteModel(
        { context: 'Ink canvas', controls: poolControls },
        { composition, ownedPool: assembled.ownedPool },
      );
      // Tools still resolve from the projection.
      expect(model?.tools.map((tool) => tool.id)).toEqual([
        'test.pen',
        'test.eraser',
      ]);
      // Every style slot stays hidden: nothing in the squeeze graph
      // projects these semanticRoles.
      expect(model?.color).toBeNull();
      expect(model?.width).toBeNull();
      expect(model?.eraserSize).toBeNull();
      expect(model?.styles).toBeNull();
      // Unprojected styles never enter owner routing either.
      expect(model?.owned?.map((owned) => owned.control.id)).toEqual([
        'test.pen',
        'test.eraser',
      ]);
    } finally {
      created.dispose();
    }
  });

  it('shows projected styles with preserved owner routing and unchanged tool order', () => {
    const created = createToolbarCompositionRegistry();
    try {
      registerSurfaceFrame(created.registry, { withStyles: true });
      const assembled = assembleOwnedPool({
        providerControls: fullStylePool(),
      });
      const poolControls = assembled.ownedPool.map((owned) => owned.control);
      const composition = resolveToolbarComposition({
        snapshot: created.registry.snapshot(),
        kindId: KIND,
        controls: poolControls,
        projection: 'squeeze',
      });
      const model = buildStylusPaletteModel(
        { context: 'Ink canvas', controls: poolControls },
        { composition, ownedPool: assembled.ownedPool },
      );
      // A1 invariant holds: composition order, not role buckets.
      expect(model?.tools.map((tool) => tool.id)).toEqual([
        'test.pen',
        'test.eraser',
      ]);
      expect(model?.color?.id).toBe('ink.color');
      expect(model?.color?.options).toEqual(['#37352f', '#7c6cf0']);
      expect(model?.width?.id).toBe('ink.width');
      expect(model?.eraserSize?.id).toBe('ink.eraser-radius');
      expect(model?.styles?.id).toBe('ink.settings.pen.saved-style');
      // Styles keep their provider owner for execution routing.
      const byId = new Map(
        (model?.owned ?? []).map((owned) => [owned.control.id, owned.owner]),
      );
      expect(byId.get('ink.color')).toEqual({ kind: 'provider' });
      expect(byId.get('ink.width')).toEqual({ kind: 'provider' });
      expect(byId.get('ink.eraser-radius')).toEqual({ kind: 'provider' });
      expect(byId.get('ink.settings.pen.saved-style')).toEqual({
        kind: 'provider',
      });
    } finally {
      created.dispose();
    }
  });

  it('keeps legacy no-composition style resolution unchanged', () => {
    // No composition passed: the ownedPool/snapshot role match still
    // applies, so legacy callers see no behavior change.
    const model = buildStylusPaletteModel({
      context: 'Ink canvas',
      controls: fullStylePool(),
    });
    expect(model?.color?.id).toBe('ink.color');
    expect(model?.width?.id).toBe('ink.width');
    expect(model?.eraserSize?.id).toBe('ink.eraser-radius');
    expect(model?.styles?.id).toBe('ink.settings.pen.saved-style');
  });

  it('default composition projects quick styles to squeeze only, never normal/compact', () => {
    const created = createToolbarCompositionRegistry();
    try {
      const defaults = defaultToolbarComposition();
      for (const entry of defaults.categories)
        created.registry.registerCategory(entry);
      for (const entry of defaults.items)
        created.registry.registerItem(entry);
      for (const entry of defaults.extensions)
        created.registry.registerKindExtension(entry);
      const assembled = assembleOwnedPool({
        // Quick roles plus one control per settings fallback role: every
        // default squeeze style item needs a matching pool control to
        // resolve (dormant items stay unresolved, never inferred).
        providerControls: [
          ...fullStylePool(),
          {
            kind: 'color',
            id: 'ink.settings.pen.color',
            group: 'style',
            label: 'Color',
            value: '#111111',
            options: ['#111111'],
            semanticRole: 'surface.settings.color',
          },
          {
            kind: 'choice',
            id: 'ink.settings.pen.size',
            group: 'style',
            label: 'Size',
            value: '2',
            options: [{ value: '2', label: '2 px' }],
            semanticRole: 'surface.settings.size',
          },
          {
            kind: 'range',
            id: 'ink.settings.eraser.radius',
            group: 'style',
            label: 'Eraser size',
            value: 12,
            min: 2,
            max: 40,
            step: 1,
            semanticRole: 'surface.settings.eraser-size',
          },
        ] as DocumentToolSnapshot['controls'],
      });
      const poolControls = assembled.ownedPool.map((owned) => owned.control);
      const rolesOf = (projection: 'normal' | 'compact' | 'squeeze'): string[] =>
        resolveToolbarComposition({
          snapshot: created.registry.snapshot(),
          kindId: KIND,
          controls: poolControls,
          projection,
        }).categories.flatMap((category) =>
          category.items.map((item) => item.semanticRole),
        );
      const quickRoles = [
        'surface.style.color',
        'surface.style.width',
        'surface.style.saved',
        'surface.erase.size',
      ];
      const fallbackRoles = [
        'surface.settings.color',
        'surface.settings.size',
        'surface.settings.eraser-size',
      ];
      const squeezeRoles = rolesOf('squeeze');
      for (const role of [...quickRoles, ...fallbackRoles]) {
        expect(squeezeRoles).toContain(role);
      }
      // Squeeze-only by design (may widen): the normal and
      // compact graphs — and therefore the category strip and tool shelf —
      // are untouched by style items.
      for (const projection of ['normal', 'compact'] as const) {
        const roles = rolesOf(projection);
        for (const role of [...quickRoles, ...fallbackRoles]) {
          expect(roles).not.toContain(role);
        }
      }
      // End to end: the default squeeze graph drives visible styles.
      const squeeze = resolveToolbarComposition({
        snapshot: created.registry.snapshot(),
        kindId: KIND,
        controls: poolControls,
        projection: 'squeeze',
      });
      const model = buildStylusPaletteModel(
        { context: 'Ink canvas', controls: poolControls },
        { composition: squeeze, ownedPool: assembled.ownedPool },
      );
      expect(model?.color?.id).toBe('ink.color');
      expect(model?.width?.id).toBe('ink.width');
      expect(model?.eraserSize?.id).toBe('ink.eraser-radius');
      expect(model?.styles?.id).toBe('ink.settings.pen.saved-style');
    } finally {
      created.dispose();
    }
  });

  it('settings fallback roles resolve through the default squeeze projection when quick is absent', () => {
    const created = createToolbarCompositionRegistry();
    try {
      const defaults = defaultToolbarComposition();
      for (const entry of defaults.categories)
        created.registry.registerCategory(entry);
      for (const entry of defaults.items)
        created.registry.registerItem(entry);
      for (const entry of defaults.extensions)
        created.registry.registerKindExtension(entry);
      // A settings-only dialect: no quick roles anywhere in the pool.
      const pool = [
        styleButton('test.pen', 'surface.pen.ball', 'pen'),
        styleButton('test.eraser', 'surface.erase', 'eraser'),
        {
          kind: 'color',
          id: 'ink.settings.pen.color',
          group: 'style',
          label: 'Color',
          value: '#111111',
          options: ['#111111'],
          semanticRole: 'surface.settings.color',
        },
        {
          kind: 'choice',
          id: 'ink.settings.pen.size',
          group: 'style',
          label: 'Size',
          value: '2',
          options: [{ value: '2', label: '2 px' }],
          semanticRole: 'surface.settings.size',
        },
        {
          kind: 'range',
          id: 'ink.settings.eraser.radius',
          group: 'style',
          label: 'Eraser size',
          value: 12,
          min: 2,
          max: 40,
          step: 1,
          semanticRole: 'surface.settings.eraser-size',
        },
      ] as DocumentToolSnapshot['controls'];
      const assembled = assembleOwnedPool({ providerControls: pool });
      const poolControls = assembled.ownedPool.map((owned) => owned.control);
      const squeeze = resolveToolbarComposition({
        snapshot: created.registry.snapshot(),
        kindId: KIND,
        controls: poolControls,
        projection: 'squeeze',
      });
      const model = buildStylusPaletteModel(
        { context: 'Ink canvas', controls: poolControls },
        { composition: squeeze, ownedPool: assembled.ownedPool },
      );
      expect(model?.color?.id).toBe('ink.settings.pen.color');
      expect(model?.width?.id).toBe('ink.settings.pen.size');
      expect(model?.eraserSize?.id).toBe('ink.settings.eraser.radius');
    } finally {
      created.dispose();
    }
  });
});
describe('squeeze favorite styles (Repair 6: favorites-first, never first-N)', () => {
  type StyleEntry = {
    readonly id: string;
    readonly name: string;
    readonly favorite: boolean;
  };

  function favoriteChoice(
    entries: readonly StyleEntry[],
    current: string,
    id = 'ink.settings.pen.saved-style',
  ): DocumentToolSnapshot['controls'][number] {
    return {
      kind: 'choice',
      id,
      group: 'style',
      label: 'Saved styles',
      value: current,
      options: [
        { value: '', label: 'Working style' },
        ...entries.map((entry) => ({
          value: entry.id,
          label: `${entry.favorite ? 'Favorite · ' : ''}${entry.name}, #37352f, 3.5 pt`,
        })),
      ],
      semanticRole: 'surface.style.saved',
      savedStyles: entries.map((entry) => ({
        id: entry.id,
        name: entry.name,
        toolKind: 'pen',
        favorite: entry.favorite,
        preset: { color: '#37352f', size: 3.5 },
      })),
    } as DocumentToolSnapshot['controls'][number];
  }

  function paletteFor(
    saved: DocumentToolSnapshot['controls'][number],
  ): ReturnType<typeof buildStylusPaletteModel> {
    return buildStylusPaletteModel({
      context: 'Ink canvas',
      controls: [
        button('test.pen', 'Pen', {
          role: 'surface-tool',
          toolRole: 'pen',
          semanticRole: 'surface.pen.ball',
          active: true,
        }),
        saved,
      ],
    });
  }

  it('shows favorites in user order, excluding non-favorites and working style', () => {
    const saved = favoriteChoice(
      [
        { id: 'p1', name: 'Draft', favorite: false },
        { id: 'f1', name: 'Daily', favorite: true },
        { id: 'p2', name: 'Notes', favorite: false },
        { id: 'f2', name: 'Fine', favorite: true },
        { id: 'f3', name: 'Sketch', favorite: true },
      ],
      'f1',
    );
    const model = paletteFor(saved);
    expect(model?.styles?.options.map((option) => option.value)).toEqual([
      'f1',
      'f2',
      'f3',
    ]);
    expect(
      model?.styles?.options.some((option) => option.value === ''),
    ).toBe(false);
    expect(model?.styles?.value).toBe('f1');
  });

  it('never fills favorite slots from non-favorites (caps at four favorites)', () => {
    const saved = favoriteChoice(
      [
        { id: 'f1', name: 'One', favorite: true },
        { id: 'f2', name: 'Two', favorite: true },
        { id: 'f3', name: 'Three', favorite: true },
        { id: 'f4', name: 'Four', favorite: true },
        { id: 'f5', name: 'Five', favorite: true },
        { id: 'p1', name: 'Draft', favorite: false },
        { id: 'p2', name: 'Plain', favorite: false },
      ],
      'f1',
    );
    const model = paletteFor(saved);
    expect(model?.styles?.options.map((option) => option.value)).toEqual([
      'f1',
      'f2',
      'f3',
      'f4',
    ]);
  });

  it('shows nothing from non-favorites when no favorites exist', () => {
    const saved = favoriteChoice(
      [
        { id: 'p1', name: 'Draft', favorite: false },
        { id: 'p2', name: 'Plain', favorite: false },
      ],
      '',
    );
    const model = paletteFor(saved);
    expect(model?.styles?.options ?? []).toEqual([]);
  });

  it('drops deleted styles (no synthetic entries from either side)', () => {
    const saved = {
      kind: 'choice',
      id: 'ink.settings.pen.saved-style',
      group: 'style',
      label: 'Saved styles',
      value: 'f1',
      options: [
        { value: '', label: 'Working style' },
        { value: 'f1', label: 'Favorite · Daily, #37352f, 3.5 pt' },
        { value: 'ghost', label: 'Ghost, #37352f, 3.5 pt' },
      ],
      semanticRole: 'surface.style.saved',
      savedStyles: [
        {
          id: 'f1',
          name: 'Daily',
          toolKind: 'pen',
          favorite: true,
          preset: { color: '#37352f', size: 3.5 },
        },
        {
          id: 'f2',
          name: 'Gone',
          toolKind: 'pen',
          favorite: true,
          preset: { color: '#37352f', size: 3.5 },
        },
      ],
    } as unknown as DocumentToolSnapshot['controls'][number];
    const model = paletteFor(saved);
    expect(model?.styles?.options.map((option) => option.value)).toEqual([
      'f1',
    ]);
  });

  it('preserves user reorder (savedStyles order wins over options order)', () => {
    const saved = {
      kind: 'choice',
      id: 'ink.settings.pen.saved-style',
      group: 'style',
      label: 'Saved styles',
      value: 'f2',
      options: [
        { value: '', label: 'Working style' },
        { value: 'f1', label: 'Favorite · Daily, #37352f, 3.5 pt' },
        { value: 'f2', label: 'Favorite · Fine, #37352f, 3.5 pt' },
      ],
      semanticRole: 'surface.style.saved',
      savedStyles: [
        {
          id: 'f2',
          name: 'Fine',
          toolKind: 'pen',
          favorite: true,
          preset: { color: '#37352f', size: 3.5 },
        },
        {
          id: 'f1',
          name: 'Daily',
          toolKind: 'pen',
          favorite: true,
          preset: { color: '#37352f', size: 3.5 },
        },
      ],
    } as unknown as DocumentToolSnapshot['controls'][number];
    const model = paletteFor(saved);
    expect(model?.styles?.options.map((option) => option.value)).toEqual([
      'f2',
      'f1',
    ]);
  });

  it('never lets the working style masquerade as a favorite', () => {
    const working = favoriteChoice(
      [
        { id: 'f1', name: 'Daily', favorite: true },
        { id: 'p1', name: 'Draft', favorite: false },
      ],
      '',
    );
    const workingModel = paletteFor(working);
    expect(workingModel?.styles?.value).toBe('');
    expect(
      workingModel?.styles?.options.some((option) => option.value === ''),
    ).toBe(false);
    expect(
      workingModel?.styles?.options.some(
        (option) => option.value === workingModel?.styles?.value,
      ),
    ).toBe(false);

    const nonFavoriteCurrent = favoriteChoice(
      [
        { id: 'f1', name: 'Daily', favorite: true },
        { id: 'p1', name: 'Draft', favorite: false },
      ],
      'p1',
    );
    const nonFavoriteModel = paletteFor(nonFavoriteCurrent);
    expect(nonFavoriteModel?.styles?.options.map((o) => o.value)).toEqual([
      'f1',
    ]);
    expect(
      nonFavoriteModel?.styles?.options.some(
        (option) => option.value === nonFavoriteModel?.styles?.value,
      ),
    ).toBe(false);
  });

  it('never mutates the snapshot on open', () => {
    const saved = favoriteChoice(
      [
        { id: 'p1', name: 'Draft', favorite: false },
        { id: 'f1', name: 'Daily', favorite: true },
      ],
      'f1',
    );
    const snapshot = {
      context: 'Ink canvas',
      controls: [
        button('test.pen', 'Pen', {
          role: 'surface-tool',
          toolRole: 'pen',
          semanticRole: 'surface.pen.ball',
          active: true,
        }),
        saved,
      ],
    } as DocumentToolSnapshot;
    const before = JSON.parse(JSON.stringify(snapshot)) as unknown;
    paletteFor(saved);
    buildStylusPaletteModel(snapshot);
    expect(snapshot).toEqual(before);
  });

  it('keeps legacy first-N behavior when the structured payload is absent', () => {
    const legacy = {
      kind: 'choice',
      id: 'ink.settings.pen.saved-style',
      group: 'style',
      label: 'Saved styles',
      value: 'a',
      options: [
        { value: '', label: 'Working style' },
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
      semanticRole: 'surface.style.saved',
    } as DocumentToolSnapshot['controls'][number];
    const model = paletteFor(legacy);
    expect(model?.styles?.options.map((option) => option.value)).toEqual([
      'a',
      'b',
    ]);
  });

  it('tracks shared state live: favorite toggle and reorder change the projection', () => {
    const first = favoriteChoice(
      [
        { id: 'f1', name: 'Daily', favorite: true },
        { id: 'f2', name: 'Fine', favorite: true },
        { id: 'p1', name: 'Draft', favorite: false },
      ],
      'f1',
    );
    const docA = paletteFor(first);
    const docB = paletteFor(first);
    expect(docB?.styles?.options.map((o) => o.value)).toEqual(
      docA?.styles?.options.map((o) => o.value),
    );

    const unfavorited = favoriteChoice(
      [
        { id: 'f1', name: 'Daily', favorite: false },
        { id: 'f2', name: 'Fine', favorite: true },
        { id: 'p1', name: 'Draft', favorite: false },
      ],
      'f2',
    );
    const afterToggle = paletteFor(unfavorited);
    expect(afterToggle?.styles?.options.map((o) => o.value)).toEqual(['f2']);

    const reordered = {
      ...(first as unknown as Record<string, unknown>),
      savedStyles: [
        {
          id: 'f2',
          name: 'Fine',
          toolKind: 'pen',
          favorite: true,
          preset: { color: '#37352f', size: 3.5 },
        },
        {
          id: 'f1',
          name: 'Daily',
          toolKind: 'pen',
          favorite: true,
          preset: { color: '#37352f', size: 3.5 },
        },
        {
          id: 'p1',
          name: 'Draft',
          toolKind: 'pen',
          favorite: false,
          preset: { color: '#37352f', size: 3.5 },
        },
      ],
    } as unknown as DocumentToolSnapshot['controls'][number];
    const afterReorder = paletteFor(reordered);
    expect(afterReorder?.styles?.options.map((o) => o.value)).toEqual([
      'f2',
      'f1',
    ]);
  });

  it('projects real library favorites end to end (style-library contract)', () => {
    const settings = new InMemorySettingsService();
    const presets = new InkPresetStore({ settings });
    let next = 0;
    const library = new SurfaceStyleLibrary({
      presets,
      settings,
      idFactory: () => `style-${++next}`,
    });
    try {
      presets.setTool('pen', { color: '#37352f', size: 3.5 });
      const draftId = library.saveCurrent('pen', 'Draft');
      presets.setTool('pen', { color: '#7c6cf0', size: 6 });
      const dailyId = library.saveCurrent('pen', 'Daily');
      expect(draftId).not.toBeNull();
      expect(dailyId).not.toBeNull();
      expect(library.setFavorite(dailyId!, true)).toBe(true);
      const host = {
        activeToolId: () => 'froglight.ink.pen',
        setTool: () => undefined,
        toolPreset: (tool: string) =>
          presets.getTool(tool as never) as never,
        setToolPreset: () => undefined,
        savedStyles: (tool: string) =>
          tool === 'pen' ? library.styles('pen' as never) : [],
        currentStyleId: (tool: string) =>
          tool === 'pen'
            ? (library.snapshot().currentStyleByTool.pen ?? null)
            : null,
        saveCurrentStyle: () => null,
        applySavedStyle: () => false,
        updateSavedStyle: () => false,
        renameSavedStyle: () => false,
        favoriteSavedStyle: () => false,
        reorderSavedStyles: () => false,
        deleteSavedStyle: () => false,
        resetSavedStyle: () => false,
        savedStyleModified: () => false,
        eraserPreset: () => ({ radius: 12, mode: 'stroke', filter: 'all' }),
        setEraserPreset: () => undefined,
        lassoPreset: () => ({ mode: 'freehand', filter: 'all' }),
        setLassoPreset: () => undefined,
        recentColors: () => [] as string[],
      };
      const controls = buildActiveToolSettingsControls(
        host as never,
        { prefix: 'ink', swatches: ['#37352f'], widths: [3.5] },
      );
      const saved = controls.find(
        (control) =>
          control.kind === 'choice' &&
          control.semanticRole === 'surface.style.saved',
      );
      expect(saved).toBeDefined();
      const model = paletteFor(
        saved as DocumentToolSnapshot['controls'][number],
      );
      expect(model?.styles?.options.map((o) => o.value)).toEqual([dailyId!]);
      expect(library.setFavorite(dailyId!, false)).toBe(true);
      const rebuilt = buildActiveToolSettingsControls(
        host as never,
        { prefix: 'ink', swatches: ['#37352f'], widths: [3.5] },
      );
      const savedAfter = rebuilt.find(
        (control) =>
          control.kind === 'choice' &&
          control.semanticRole === 'surface.style.saved',
      );
      const afterModel = paletteFor(
        savedAfter as DocumentToolSnapshot['controls'][number],
      );
      expect(afterModel?.styles?.options ?? []).toEqual([]);
    } finally {
      library.dispose();
    }
  });
});

describe('squeeze dual-presenter dedupe', () => {
  function textCreationControl(
    id: string,
    active: boolean,
  ): DocumentToolSnapshot['controls'][number] {
    return {
      kind: 'button',
      id,
      group: 'draw',
      label: 'Text',
      role: 'surface-tool',
      toolRole: 'text',
      semanticRole: 'surface.insert.text',
      active,
      activationRole: 'tool',
    } as DocumentToolSnapshot['controls'][number];
  }

  it('dedupes splitSqueezeTools by control id, first occurrence wins', () => {
    const duplicated: StylusPaletteTool[] = [
      { id: 'ink.tool.text', label: 'Text', toolRole: 'text', semanticRole: 'surface.insert.text', active: true },
      { id: 'ink.tool.text', label: 'Text', toolRole: 'text', semanticRole: 'surface.insert.text', active: true },
      { id: 'ink.tool.pen', label: 'Pen', toolRole: 'pen', semanticRole: 'surface.pen.ball', active: false },
    ];
    const { primary, secondary } = splitSqueezeTools(duplicated, {
      activeToolId: 'ink.tool.text',
    });
    const all = [...primary, ...secondary];
    expect(all.filter((tool) => tool.id === 'ink.tool.text')).toHaveLength(1);
    expect(all).toHaveLength(2);
  });

  it('presents Text once through the default squeeze graph with a bounded crescent', () => {
    const created = createToolbarCompositionRegistry();
    try {
      const defaults = defaultToolbarComposition();
      for (const entry of defaults.categories)
        created.registry.registerCategory(entry);
      for (const entry of defaults.items)
        created.registry.registerItem(entry);
      for (const entry of defaults.extensions)
        created.registry.registerKindExtension(entry);
      const textId = 'ink.tool.text';
      const assembled = assembleOwnedPool({
        providerControls: [
          { kind: 'button', id: 'ink.tool.pen', group: 'draw', label: 'Pen', role: 'surface-tool', toolRole: 'pen', semanticRole: 'surface.pen.ball', activationRole: 'tool' },
          { kind: 'button', id: 'ink.tool.highlighter', group: 'draw', label: 'Highlighter', role: 'surface-tool', toolRole: 'highlighter', semanticRole: 'surface.highlighter', activationRole: 'tool' },
          { kind: 'button', id: 'ink.tool.eraser', group: 'draw', label: 'Eraser', role: 'surface-tool', toolRole: 'eraser', semanticRole: 'surface.erase', activationRole: 'tool' },
          { kind: 'button', id: 'ink.tool.select', group: 'draw', label: 'Select', role: 'surface-tool', toolRole: 'select', semanticRole: 'surface.select', activationRole: 'tool' },
          { kind: 'button', id: 'ink.tool.line', group: 'draw', label: 'Line', role: 'surface-tool', toolRole: 'shape', semanticRole: 'surface.shape.line', activationRole: 'tool' },
          textCreationControl(textId, true),
        ] as DocumentToolSnapshot['controls'],
      });
      const poolControls = assembled.ownedPool.map((owned) => owned.control);
      const composition = resolveToolbarComposition({
        snapshot: created.registry.snapshot(),
        kindId: 'froglight.ink',
        controls: poolControls,
        projection: 'squeeze',
      });
      // The authorized alias stays silent (sole exception); any other
      // duplicate presenter still reports.
      expect(
        composition.diagnostics.filter((message) =>
          message.includes('duplicate presenter'),
        ),
      ).toEqual([]);
      const model = buildStylusPaletteModel(
        { context: 'Surface canvas', controls: poolControls },
        { composition, ownedPool: assembled.ownedPool },
      );
      expect(model).not.toBeNull();
      // Text appears exactly once despite two live presenters.
      expect(
        model?.tools.filter((tool) => tool.id === textId),
      ).toHaveLength(1);
      const { primary, secondary } = splitSqueezeTools(model?.tools ?? [], {
        activeToolId: model?.activeToolId,
      });
      const allIds = [...primary, ...secondary].map((tool) => tool.id);
      expect(new Set(allIds).size).toBe(allIds.length);
      // Bounded crescent: one grid row, active Text included.
      expect(primary.length).toBeLessThanOrEqual(SQUEEZE_MAX_PRIMARY);
      expect(SQUEEZE_MAX_PRIMARY).toBe(5);
      expect(allIds).toContain(textId);
    } finally {
      created.dispose();
    }
  });

  it('reports unauthorized duplicate presenters', () => {
    const created = createToolbarCompositionRegistry();
    try {
      created.registry.registerCategory({
        id: 'surface.write',
        familyId: 'surface',
        label: 'Write',
        icon: 'pen',
        order: 10,
      });
      created.registry.registerItem({
        id: 'test.write.ball-a',
        categoryId: 'surface.write',
        semanticRole: 'surface.pen.ball',
        order: 10,
        projections: ['normal', 'compact', 'squeeze'],
      });
      created.registry.registerItem({
        id: 'test.write.ball-b',
        categoryId: 'surface.write',
        semanticRole: 'surface.pen.ball',
        order: 20,
        projections: ['normal', 'compact', 'squeeze'],
      });
      created.registry.registerKindExtension({
        id: 'test-ink-family',
        kindIds: ['froglight.ink'],
        familyIds: ['surface'],
      });
      const composition = resolveToolbarComposition({
        snapshot: created.registry.snapshot(),
        kindId: 'froglight.ink',
        controls: [
          {
            kind: 'button',
            id: 'test.pen',
            group: 'draw',
            label: 'Pen',
            semanticRole: 'surface.pen.ball',
          },
        ] as DocumentToolSnapshot['controls'],
      });
      expect(composition.diagnostics.join('\n')).toContain(
        "duplicate presenter for semantic role 'surface.pen.ball' (test.write.ball-a, test.write.ball-b)",
      );
    } finally {
      created.dispose();
    }
  });
});

describe('squeeze toolbar preset parity', () => {
  it('uses the same edited pen/highlighter triples and follows the active tool', () => {
    const slots = new ToolbarCustomizationStore();
    slots.setSlotColorAt('pen', 1, '#123456');
    slots.setSlotSizeAt('pen', 1, 6);
    const snapshot = surfaceSnapshot();
    const model = buildStylusPaletteModel(snapshot, { slots });
    expect(model?.color?.options).toEqual(slots.slotColorsForFamily('pen'));
    expect(model?.width?.options.map((option) => Number(option.value))).toEqual(
      slots.slotSizesForFamily('pen'),
    );
    const highlighter = buildStylusPaletteModel(
      {
        ...snapshot,
        controls: snapshot.controls.map((control) =>
          control.kind === 'button'
            ? { ...control, active: control.toolRole === 'highlighter' }
            : control,
        ),
      },
      { slots },
    );
    expect(highlighter?.color?.options).toEqual(
      slots.slotColorsForFamily('highlighter'),
    );
    expect(highlighter?.width?.options).toHaveLength(3);
    const eraser = buildStylusPaletteModel(
      {
        ...snapshot,
        controls: snapshot.controls.map((control) =>
          control.kind === 'button'
            ? { ...control, active: control.toolRole === 'eraser' }
            : control,
        ),
      },
      { slots },
    );
    expect(eraser?.color).toBeNull();
    expect(eraser?.width?.id).toBe('ink.eraser-radius');
    expect(eraser?.width?.options.map(option => Number(option.value))).toEqual(slots.slotSizesForEraser());
    slots.dispose();
  });
});
