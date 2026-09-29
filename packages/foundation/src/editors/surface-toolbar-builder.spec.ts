/**
 * Unit tests for the shared surface toolbar builder (problem 6, spec #52).
 *
 * The builder owns the shareable Surface subset (draw tools, stroke style,
 * eraser radius, image insertion, zoom cluster, fit) behind the
 * provider-neutral Document Tools seam. Tests drive it through a stub host —
 * no DOM, no Canvas, no engine — and pin exact control shapes plus command
 * routing so the three family adapters cannot diverge again.
 */
import { describe, expect, it } from 'vitest';
import { SURFACE_TOOL_IDS } from '../surfaces/tools.js';
import {
  buildSurfaceArrangeControls,
  buildSurfaceDrawControls,
  buildSurfaceExportControl,
  buildSurfaceFitControl,
  buildSurfaceImageControl,
  buildSurfaceStyleControls,
  buildSurfaceZoomControls,
  createSharedSurfaceEraserTools,
  executeSurfaceToolbarControl,
  SURFACE_ERASER_MODES,
  SURFACE_HIGHLIGHTER_GLYPH_OPACITY,
  SURFACE_PEN_SLOT_WIDTHS,
  surfaceSlotSwatchesForFamily,
  surfaceSlotWidthsForFamily,
  type SurfaceToolbarDrawTool,
  type SurfaceToolbarHost,
} from './surface-toolbar-builder.js';

const DRAW: readonly SurfaceToolbarDrawTool[] = [
  {
    key: 's.select',
    toolId: 'surface.select',
    label: 'Select',
    icon: 'cursor',
  },
  {
    key: 's.pen',
    toolId: 'surface.pen',
    label: 'Pen',
    shortLabel: 'Pen',
    icon: 'pen',
    group: 'draw',
  },
];

function stubHost(
  overrides: Partial<SurfaceToolbarHost> = {},
): SurfaceToolbarHost & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    activeToolId: () => 'surface.pen',
    setTool: (toolId: string) => {
      calls.push(`setTool:${toolId}`);
    },
    penColor: () => '#111111',
    setPenColor: (color: string) => {
      calls.push(`setPenColor:${color}`);
    },
    penWidth: () => 2,
    setPenWidth: (width: number) => {
      calls.push(`setPenWidth:${width}`);
    },
    eraserRadius: () => 10,
    setEraserRadius: (radius: number) => {
      calls.push(`setEraserRadius:${radius}`);
    },
    zoomFactor: () => 1,
    setZoomFactor: (zoom: number) => {
      calls.push(`setZoomFactor:${zoom}`);
    },
    canInsertImage: () => true,
    chooseImage: () => {
      calls.push('chooseImage');
    },
    fitToView: () => {
      calls.push('fitToView');
    },
    ...overrides,
  };
}

describe('buildSurfaceDrawControls', () => {
  it('emits one button per tool with prefix ids and live active state', () => {
    const controls = buildSurfaceDrawControls(stubHost(), {
      prefix: 'ink',
      tools: DRAW,
    });
    // DRAW uses unknown engine ids: semantic role/toolId ride along, but no
    // role is guessed — unknown ids carry no toolRole rather than a wrong one.
    expect(controls).toEqual([
      {
        kind: 'button',
        id: 'ink.tool.s.select',
        group: 'draw',
        label: 'Select',
        shortLabel: 'Select',
        icon: 'cursor',
        active: false,
        role: 'surface-tool',
        activationRole: 'tool',
        toolId: 'surface.select',
      },
      {
        kind: 'button',
        id: 'ink.tool.s.pen',
        group: 'draw',
        label: 'Pen',
        shortLabel: 'Pen',
        icon: 'pen',
        active: true,
        role: 'surface-tool',
        activationRole: 'tool',
        toolId: 'surface.pen',
      },
    ]);
  });

  it('derives toolRole exactly for core engine ids and declared family roles', () => {
    const controls = buildSurfaceDrawControls(stubHost(), {
      prefix: 'ink',
      tools: [
        {
          key: 'froglight.ink.eraser',
          toolId: 'froglight.ink.eraser',
          label: 'Eraser',
          icon: 'eraser',
        },
        {
          key: 'froglight.ink.rect',
          toolId: 'froglight.ink.rect',
          label: 'Rectangle',
          icon: 'rect',
          toolRole: 'shape',
        },
        {
          key: 'acme.mystery',
          toolId: 'acme.mystery',
          label: 'Mystery',
          icon: 'cursor',
        },
      ],
    });
    const roles = controls.map(
      (control) =>
        (control as unknown as { toolRole?: string }).toolRole ?? null,
    );
    expect(roles).toEqual(['eraser', 'shape', null]);
  });

  it('maps the pen family (pen/fountain/brush/pencil) to toolRole pen', () => {
    // Ink/Notebook declare no per-call-site toolRole for the core
    // pen family, so the centralized default must carry all four. This keeps
    // squeeze ordering and accessory routing identical to Whiteboard, which
    // declares the same mapping explicitly at its call site.
    const controls = buildSurfaceDrawControls(stubHost(), {
      prefix: 'ink',
      tools: [
        SURFACE_TOOL_IDS.select,
        SURFACE_TOOL_IDS.pen,
        SURFACE_TOOL_IDS.fountain,
        SURFACE_TOOL_IDS.brush,
        SURFACE_TOOL_IDS.pencil,
        SURFACE_TOOL_IDS.highlighter,
        SURFACE_TOOL_IDS.eraser,
        SURFACE_TOOL_IDS.lasso,
      ].map((toolId) => ({
        key: toolId,
        toolId,
        label: toolId,
        icon: 'pen',
      })),
    });
    const roles = controls.map(
      (control) =>
        (control as unknown as { toolRole?: string }).toolRole ?? null,
    );
    expect(roles).toEqual([
      'select',
      'pen',
      'pen',
      'pen',
      'pen',
      'highlighter',
      'eraser',
      'lasso',
    ]);
  });

  it('honors per-tool groups and a custom active predicate', () => {
    const controls = buildSurfaceDrawControls(stubHost(), {
      prefix: 'whiteboard',
      tools: [
        {
          key: 'pen',
          toolId: 'surface.pen',
          label: 'Pen',
          icon: 'pen',
          group: 'draw',
        },
        {
          key: 'card',
          toolId: 'whiteboard.card',
          label: 'Card',
          icon: 'blocks',
          group: 'insert',
        },
      ],
      isActive: (toolId) => toolId === 'whiteboard.card',
    });
    expect(controls.map((control) => control.group)).toEqual([
      'draw',
      'insert',
    ]);
    expect(
      controls.map(
        (control) =>
          (control as unknown as { active?: boolean }).active ?? false,
      ),
    ).toEqual([false, true]);
  });
});

describe('buildSurfaceStyleControls', () => {
  it('emits color, width, and eraser controls with declared presets', () => {
    const controls = buildSurfaceStyleControls(
      stubHost({ eraserMode: () => 'precision' }),
      {
        prefix: 'notebook',
        swatches: ['#111111', '#222222'],
        widths: [1, 3],
      },
    );
    expect(controls).toEqual([
      {
        kind: 'color',
        id: 'notebook.color',
        group: 'style',
        label: 'Stroke color',
        semanticRole: 'surface.style.color',
        value: '#111111',
        options: ['#111111', '#222222'],
      },
      {
        kind: 'choice',
        id: 'notebook.width',
        group: 'style',
        label: 'Stroke width',
        semanticRole: 'surface.style.width',
        value: '2',
        options: [
          { value: '1', label: '1 px' },
          { value: '3', label: '3 px' },
        ],
      },
      {
        kind: 'range',
        id: 'notebook.eraser-radius',
        group: 'style',
        label: 'Eraser size',
        semanticRole: 'surface.erase.size',
        value: 10,
        min: 2,
        max: 40,
        step: 1,
      },
    ]);
  });

  it('honors compact label overrides', () => {
    const controls = buildSurfaceStyleControls(
      stubHost({ eraserMode: () => 'precision' }),
      {
        prefix: 'whiteboard',
        swatches: ['#111111'],
        widths: [2],
        colorLabel: 'Color',
        widthLabel: 'Width',
      },
    );
    expect(controls.map((control) => control.label)).toEqual([
      'Color',
      'Width',
      'Eraser size',
    ]);
  });

  it('uses the active brush preset for contextual style controls', () => {
    const calls: string[] = [];
    const host = stubHost({
      activeToolId: () => 'surface.highlighter',
      toolPreset: () => ({ color: '#ffee00', size: 12 }),
      setToolPreset: (_tool, patch) => calls.push(JSON.stringify(patch)),
    });
    const controls = buildSurfaceStyleControls(host, {
      prefix: 'ink',
      swatches: ['#ffee00'],
      widths: [2, 12],
    });
    expect(controls[0]).toMatchObject({ value: '#ffee00' });
    expect(controls[1]).toMatchObject({ value: '12' });
    const executeOptions = { prefix: 'ink', tools: DRAW } as const;
    expect(
      executeSurfaceToolbarControl(
        host,
        executeOptions,
        'ink.color',
        '#00ff00',
      ),
    ).toBe(true);
    expect(
      executeSurfaceToolbarControl(host, executeOptions, 'ink.width', '6'),
    ).toBe(true);
    expect(calls).toEqual(['{"color":"#00ff00"}', '{"size":6}']);
  });
});

describe('buildSurfaceZoomControls', () => {
  it('emits the zoom cluster with live percentage and declared range', () => {
    const controls = buildSurfaceZoomControls(
      stubHost({ zoomFactor: () => 1.5 }),
      { prefix: 'ink', min: 25, max: 800 },
    );
    expect(controls).toEqual([
      {
        kind: 'button',
        id: 'ink.zoom-out',
        group: 'view',
        label: 'Zoom out',
        shortLabel: '−',
        icon: 'minus',
      },
      {
        kind: 'button',
        id: 'ink.zoom-reset',
        group: 'view',
        label: 'Zoom 150%, activate to reset to 100%',
        shortLabel: '150%',
      },
      {
        kind: 'number',
        id: 'ink.zoom',
        group: 'view',
        label: 'Zoom',
        value: 150,
        min: 25,
        max: 800,
        step: 1,
        suffix: '%',
      },
      {
        kind: 'range',
        id: 'ink.zoom-slider',
        group: 'view',
        label: 'Zoom slider',
        value: 150,
        min: 25,
        max: 800,
        step: 5,
      },
      {
        kind: 'button',
        id: 'ink.zoom-in',
        group: 'view',
        label: 'Zoom in',
        shortLabel: '+',
        icon: 'plus',
      },
    ]);
  });

  it('marks the cluster disabled only when requested', () => {
    const enabled = buildSurfaceZoomControls(stubHost(), { prefix: 'ink' });
    expect(enabled.some((control) => 'disabled' in control)).toBe(false);
    const disabled = buildSurfaceZoomControls(stubHost(), {
      prefix: 'notebook',
      disabled: true,
      label: 'Notebook zoom',
      sliderLabel: 'Notebook zoom slider',
      resetLabel: (zoom) => `Notebook zoom ${zoom}%, activate to reset to 100%`,
    });
    expect(disabled.map((control) => control.id)).toEqual([
      'notebook.zoom-out',
      'notebook.zoom-reset',
      'notebook.zoom',
      'notebook.zoom-slider',
      'notebook.zoom-in',
    ]);
    for (const control of disabled) {
      expect(control).toMatchObject({ disabled: true });
    }
    expect((disabled[1] as { label: string }).label).toBe(
      'Notebook zoom 100%, activate to reset to 100%',
    );
  });
});

describe('buildSurfaceImageControl / buildSurfaceFitControl', () => {
  it('disables image insertion honestly when no asset store is bound', () => {
    expect(
      buildSurfaceImageControl(stubHost({ canInsertImage: () => false }), {
        prefix: 'ink',
        icon: 'image',
      }),
    ).toEqual({
      kind: 'button',
      id: 'ink.image',
      group: 'insert',
      label: 'Insert image',
      semanticRole: 'surface.insert.image',
      shortLabel: 'Image',
      icon: 'image',
      disabled: true,
    });
  });

  it('emits fit with declared labels', () => {
    expect(
      buildSurfaceFitControl({
        prefix: 'whiteboard',
        label: 'Fit board',
        shortLabel: 'Fit',
      }),
    ).toEqual({
      kind: 'button',
      id: 'whiteboard.fit',
      group: 'view',
      label: 'Fit board',
      semanticRole: 'surface.view.fit',
      shortLabel: 'Fit',
    });
  });

  it('emits export buttons with declared identity', () => {
    expect(
      buildSurfaceExportControl({
        prefix: 'ink',
        group: 'view',
        label: 'Export PNG',
        shortLabel: 'Export',
      }),
    ).toEqual({
      kind: 'button',
      id: 'ink.export',
      group: 'view',
      label: 'Export PNG',
      shortLabel: 'Export',
    });
    expect(
      buildSurfaceExportControl({
        prefix: 'notebook',
        id: 'export-all',
        group: 'export',
        label: 'Export all pages as PNG',
        shortLabel: 'All PNG',
      }),
    ).toEqual({
      kind: 'button',
      id: 'notebook.export-all',
      group: 'export',
      label: 'Export all pages as PNG',
      shortLabel: 'All PNG',
    });
  });
});

describe('executeSurfaceToolbarControl', () => {
  const options = {
    prefix: 'ink',
    tools: DRAW,
  } as const;

  it('routes tool selection through the key-to-surface mapping', () => {
    const host = stubHost();
    expect(executeSurfaceToolbarControl(host, options, 'ink.tool.s.pen')).toBe(
      true,
    );
    expect(host.calls).toEqual(['setTool:surface.pen']);
  });

  it('rejects unknown tool keys without touching the host', () => {
    const host = stubHost();
    expect(executeSurfaceToolbarControl(host, options, 'ink.tool.s.nope')).toBe(
      false,
    );
    expect(host.calls).toEqual([]);
  });

  it('routes style commands and requires a value', () => {
    const host = stubHost();
    expect(
      executeSurfaceToolbarControl(host, options, 'ink.color', '#222'),
    ).toBe(true);
    expect(executeSurfaceToolbarControl(host, options, 'ink.width', '6')).toBe(
      true,
    );
    expect(
      executeSurfaceToolbarControl(host, options, 'ink.eraser-radius', '20'),
    ).toBe(true);
    expect(executeSurfaceToolbarControl(host, options, 'ink.color')).toBe(
      false,
    );
    expect(host.calls).toEqual([
      'setPenColor:#222',
      'setPenWidth:6',
      'setEraserRadius:20',
    ]);
  });

  it('routes zoom commands through the shared factor math', () => {
    const host = stubHost({ zoomFactor: () => 1.25 });
    expect(
      executeSurfaceToolbarControl(host, options, 'ink.zoom-slider', '150'),
    ).toBe(true);
    expect(executeSurfaceToolbarControl(host, options, 'ink.zoom-in')).toBe(
      true,
    );
    expect(executeSurfaceToolbarControl(host, options, 'ink.zoom-out')).toBe(
      true,
    );
    expect(executeSurfaceToolbarControl(host, options, 'ink.zoom-reset')).toBe(
      true,
    );
    expect(host.calls[0]).toBe('setZoomFactor:1.5');
    expect(Number(host.calls[1]!.replace('setZoomFactor:', ''))).toBeCloseTo(
      1.5,
      10,
    );
    expect(Number(host.calls[2]!.replace('setZoomFactor:', ''))).toBeCloseTo(
      1.25 / 1.2,
      10,
    );
    expect(host.calls[3]).toBe('setZoomFactor:1');
  });

  it('routes image and fit commands and rejects foreign ids', () => {
    const host = stubHost();
    expect(executeSurfaceToolbarControl(host, options, 'ink.image')).toBe(true);
    expect(executeSurfaceToolbarControl(host, options, 'ink.fit')).toBe(true);
    expect(executeSurfaceToolbarControl(host, options, 'ink.export')).toBe(
      false,
    );
    expect(
      executeSurfaceToolbarControl(host, options, 'notebook.zoom-in'),
    ).toBe(false);
    expect(host.calls).toEqual(['chooseImage', 'fitToView']);
  });
});

describe('buildSurfaceArrangeControls', () => {
  function arrangeHost(
    overrides: Partial<SurfaceToolbarHost> = {},
  ): SurfaceToolbarHost & { calls: string[] } {
    const calls: string[] = [];
    return {
      ...stubHost(),
      calls,
      selectionIds: () => [],
      alignSelection: () => {
        calls.push('alignSelection');
        return [];
      },
      distributeSelection: () => {
        calls.push('distributeSelection');
        return [];
      },
      reorderSelection: () => {
        calls.push('reorderSelection');
        return [];
      },
      setLocked: () => {
        calls.push('setLocked');
        return [];
      },
      groupSelection: () => {
        calls.push('groupSelection');
        return [];
      },
      ungroupSelection: () => {
        calls.push('ungroupSelection');
        return [];
      },
      duplicateSelection: () => {
        calls.push('duplicateSelection');
        return [];
      },
      connectSelected: () => {
        calls.push('connectSelected');
        return null;
      },
      ...overrides,
    };
  }

  it('projects editable selection geometry and routes changes to the owner', () => {
    const moves: { x: number; y: number }[] = [];
    const scales: number[] = [];
    const rotations: number[] = [];
    const host = arrangeHost({
      selectionIds: () => ['item'],
      selectionContext: () => ({
        ids: ['item'],
        bounds: { x: 10, y: 20, width: 100, height: 50 },
        rotation: 0,
        kinds: ['shapes'],
        colorMixed: false,
        widthMixed: false,
        opacityMixed: false,
        groups: [],
      }),
      moveSelectionBy: (delta) => {
        moves.push(delta);
        return ['item'];
      },
      scaleSelection: (factor) => {
        scales.push(factor);
        return ['item'];
      },
      rotateSelection: (delta) => {
        rotations.push(delta);
        return ['item'];
      },
    });
    const controls = buildSurfaceArrangeControls(host, { prefix: 'ink' });
    expect(
      controls
        .filter((control) =>
          control.semanticRole?.startsWith('surface.selection.'),
        )
        .map((control) => control.id),
    ).toEqual([
      'ink.selection.position-x',
      'ink.selection.position-y',
      'ink.selection.bounds-width',
      'ink.selection.bounds-height',
      'ink.selection.rotation',
      'ink.duplicate',
    ]);
    expect(
      executeSurfaceToolbarControl(
        host,
        { prefix: 'ink', tools: DRAW },
        'ink.selection.position-x',
        '25',
      ),
    ).toBe(true);
    expect(
      executeSurfaceToolbarControl(
        host,
        { prefix: 'ink', tools: DRAW },
        'ink.selection.bounds-height',
        '100',
      ),
    ).toBe(true);
    expect(moves).toEqual([{ x: 15, y: 0 }]);
    expect(scales).toEqual([2]);
    expect(
      executeSurfaceToolbarControl(
        host,
        { prefix: 'ink', tools: DRAW },
        'ink.selection.rotation',
        '90',
      ),
    ).toBe(true);
    expect(rotations).toEqual([Math.PI / 2]);
  });

  it.each(['ink', 'highlighter'] as const)(
    'selects the shared %s palette for stroke controls',
    (kind) => {
      const host = arrangeHost({
        selectionIds: () => ['stroke'],
        selectionContext: () => ({
          ids: ['stroke'],
          bounds: { x: 0, y: 0, width: 30, height: 40 },
          kinds: [kind],
          color: '#123456',
          colorMixed: false,
          width: 3,
          widthMixed: false,
          opacityMixed: false,
          groups: [],
        }),
        setSelectionStyle: () => ['stroke'],
      });
      const controls = buildSurfaceArrangeControls(host, {
        prefix: 'test',
        swatches: ['#123456'],
        widths: [1, 3, 5],
      });
      expect(
        controls.find(
          (control) => control.semanticRole === 'surface.selection.color',
        ),
      ).toMatchObject({
        kind: 'color',
        slotFamily: kind === 'highlighter' ? 'highlighter' : 'pen',
      });
      expect(
        controls.some(
          (control) =>
            control.semanticRole === 'surface.selection.stroke-width',
        ),
      ).toBe(true);
    },
  );

  it('emits the arrange group only for supporting hosts', () => {
    expect(buildSurfaceArrangeControls(stubHost(), { prefix: 'ink' })).toEqual(
      [],
    );
    const controls = buildSurfaceArrangeControls(arrangeHost(), {
      prefix: 'wb',
    });
    expect(controls.map((c) => c.id)).toEqual([
      'wb.align',
      'wb.distribute',
      'wb.order',
      'wb.lock',
      'wb.unlock',
      'wb.group',
      'wb.ungroup',
      'wb.duplicate',
      'wb.connect',
    ]);
    for (const control of controls) {
      expect(control.group).toBe('arrange');
    }
  });

  it('disables controls below their selection thresholds', () => {
    const controls = buildSurfaceArrangeControls(
      arrangeHost({ selectionIds: () => ['a', 'b', 'c'] }),
      { prefix: 'wb' },
    );
    const byId = new Map(controls.map((c) => [c.id, c]));
    expect((byId.get('wb.align') as { disabled?: boolean }).disabled).toBe(
      false,
    );
    expect((byId.get('wb.distribute') as { disabled?: boolean }).disabled).toBe(
      false,
    );
    const single = buildSurfaceArrangeControls(
      arrangeHost({ selectionIds: () => ['a'] }),
      { prefix: 'wb' },
    );
    const singleById = new Map(single.map((c) => [c.id, c]));
    expect(
      (singleById.get('wb.align') as { disabled?: boolean }).disabled,
    ).toBe(true);
    expect(
      (singleById.get('wb.distribute') as { disabled?: boolean }).disabled,
    ).toBe(true);
    expect(
      (singleById.get('wb.duplicate') as { disabled?: boolean }).disabled,
    ).toBe(false);
  });

  it('routes arrange commands with value validation', () => {
    const host = arrangeHost({ selectionIds: () => ['a', 'b', 'c'] });
    const options = { prefix: 'wb', tools: DRAW } as const;
    expect(
      executeSurfaceToolbarControl(host, options, 'wb.align', 'left'),
    ).toBe(true);
    expect(
      executeSurfaceToolbarControl(host, options, 'wb.align', 'diagonal'),
    ).toBe(false);
    expect(
      executeSurfaceToolbarControl(host, options, 'wb.distribute', 'x'),
    ).toBe(true);
    expect(
      executeSurfaceToolbarControl(host, options, 'wb.order', 'front'),
    ).toBe(true);
    expect(
      executeSurfaceToolbarControl(host, options, 'wb.order', 'sideways'),
    ).toBe(false);
    expect(executeSurfaceToolbarControl(host, options, 'wb.lock')).toBe(true);
    expect(executeSurfaceToolbarControl(host, options, 'wb.unlock')).toBe(true);
    expect(executeSurfaceToolbarControl(host, options, 'wb.group')).toBe(true);
    expect(executeSurfaceToolbarControl(host, options, 'wb.ungroup')).toBe(
      true,
    );
    expect(executeSurfaceToolbarControl(host, options, 'wb.duplicate')).toBe(
      true,
    );
    expect(executeSurfaceToolbarControl(host, options, 'wb.connect')).toBe(
      true,
    );
    expect(host.calls).toEqual([
      'alignSelection',
      'distributeSelection',
      'reorderSelection',
      'setLocked',
      'setLocked',
      'groupSelection',
      'ungroupSelection',
      'duplicateSelection',
      'connectSelected',
    ]);
  });

  it('returns false for arrange ids without host support', () => {
    const host = stubHost();
    const options = { prefix: 'wb', tools: DRAW } as const;
    expect(
      executeSurfaceToolbarControl(host, options, 'wb.align', 'left'),
    ).toBe(false);
    expect(executeSurfaceToolbarControl(host, options, 'wb.duplicate')).toBe(
      false,
    );
    expect(executeSurfaceToolbarControl(host, options, 'wb.connect')).toBe(
      false,
    );
    expect(host.calls).toEqual([]);
  });
});

describe('settled exclusive-tool derivation', () => {
  const PEN = SURFACE_TOOL_IDS.pen;
  const FOUNTAIN = SURFACE_TOOL_IDS.fountain;
  const ERASER = SURFACE_TOOL_IDS.eraser;
  const TOOLS = [PEN, FOUNTAIN, ERASER].map((toolId) => ({
    key: toolId,
    toolId,
    label: toolId,
    icon: 'pen',
  }));

  it('derives draw active from the settled tool while temp is held', () => {
    // Temp-held eraser: live reports eraser, settled stays pen. The
    // snapshot must keep pen active so sticky per-group memory ignores
    // the hold while manual selection below stays honest.
    const host = stubHost({
      activeToolId: () => ERASER,
      settledActiveToolId: () => PEN,
    });
    const controls = buildSurfaceDrawControls(host, {
      prefix: 'ink',
      tools: TOOLS,
    });
    const active = new Map(
      controls.map((control) => [
        (control as unknown as { toolId: string }).toolId,
        (control as unknown as { active?: boolean }).active,
      ]),
    );
    expect(active.get(PEN)).toBe(true);
    expect(active.get(FOUNTAIN)).toBe(false);
    expect(active.get(ERASER)).toBe(false);
  });

  it('sources contextual style values from the settled preset during temp', () => {
    const host = stubHost({
      activeToolId: () => ERASER,
      settledActiveToolId: () => FOUNTAIN,
      toolPreset: () => ({ color: '#7c6cf0', size: 6 }),
      setToolPreset: () => undefined,
    });
    const controls = buildSurfaceStyleControls(host, {
      prefix: 'ink',
      swatches: ['#7c6cf0'],
      widths: [2, 6],
    });
    // Fountain preset (settled), never the pen fallback nor eraser state.
    expect(controls[0]).toMatchObject({ value: '#7c6cf0' });
    expect(controls[1]).toMatchObject({ value: '6' });
  });

  it('falls back to the live tool on hosts without a temporary seam', () => {
    // Notebook pager: no temp entries exist, so live is settled by
    // construction and the builder must not require the seam.
    const host = stubHost({ activeToolId: () => ERASER });
    expect(
      'settledActiveToolId' in host &&
        typeof (host as { settledActiveToolId?: unknown })
          .settledActiveToolId === 'function',
    ).toBe(false);
    const controls = buildSurfaceDrawControls(host, {
      prefix: 'notebook',
      tools: TOOLS,
    });
    const active = new Map(
      controls.map((control) => [
        (control as unknown as { toolId: string }).toolId,
        (control as unknown as { active?: boolean }).active,
      ]),
    );
    expect(active.get(ERASER)).toBe(true);
    expect(active.get(PEN)).toBe(false);
  });

  it('lets an explicit isActive override win over the settled tool', () => {
    // Notebook PDF source-select policy: select reads active while the
    // engine still holds the pen, and the override must survive settled.
    const host = stubHost({
      activeToolId: () => PEN,
      settledActiveToolId: () => PEN,
    });
    const controls = buildSurfaceDrawControls(host, {
      prefix: 'notebook',
      tools: TOOLS.map((tool) => ({ ...tool })),
      isActive: (toolId) => toolId === ERASER,
    });
    const active = new Map(
      controls.map((control) => [
        (control as unknown as { toolId: string }).toolId,
        (control as unknown as { active?: boolean }).active,
      ]),
    );
    expect(active.get(ERASER)).toBe(true);
    expect(active.get(PEN)).toBe(false);
  });
});

describe('eraser tools', () => {
  const ERASER = SURFACE_TOOL_IDS.eraser;
  const erasers = () => createSharedSurfaceEraserTools(ERASER);
  const activeByKey = (
    controls: ReturnType<typeof buildSurfaceDrawControls>,
  ): Map<string, boolean> =>
    new Map(
      controls.map((control) => [
        control.id,
        (control as unknown as { active?: boolean }).active ?? false,
      ]),
    );

  it('exposes two distinct fixed-mode tools over the single eraser engine', () => {
    expect(SURFACE_ERASER_MODES).toEqual(['stroke', 'precision']);
    const tools = erasers();
    expect(tools.map((tool) => tool.toolId)).toEqual([ERASER, ERASER]);
    expect(tools.map((tool) => tool.eraserMode)).toEqual([
      'stroke',
      'precision',
    ]);
    expect(tools.map((tool) => tool.semanticRole)).toEqual([
      'surface.erase.stroke',
      'surface.erase.precision',
    ]);
    // Distinct control keys, labels, and icons per tool (Stroke keeps the
    // legacy eraser glyph); one shared coarse role and draw group.
    expect(new Set(tools.map((tool) => tool.key)).size).toBe(2);
    expect(new Set(tools.map((tool) => tool.label)).size).toBe(2);
    expect(new Set(tools.map((tool) => tool.icon)).size).toBe(2);
    expect(tools.map((tool) => tool.toolRole)).toEqual(['eraser', 'eraser']);
    expect(tools.map((tool) => tool.group)).toEqual(['draw', 'draw']);
  });

  it('pins exactly one eraser active from the live preset mode', () => {
    for (const mode of ['stroke', 'precision'] as const) {
      const host = stubHost({
        activeToolId: () => ERASER,
        eraserMode: () => mode,
      });
      const active = activeByKey(
        buildSurfaceDrawControls(host, { prefix: 'ink', tools: erasers() }),
      );
      for (const entry of erasers()) {
        expect(active.get(`ink.tool.${entry.key}`)).toBe(
          entry.eraserMode === mode,
        );
      }
    }
    // Hosts without the mode seam read as the default mode: the Stroke
    // tool stays active, preserving legacy single-eraser behavior.
    const legacy = stubHost({ activeToolId: () => ERASER });
    expect(
      'eraserMode' in legacy &&
        typeof (legacy as { eraserMode?: unknown }).eraserMode === 'function',
    ).toBe(false);
    const legacyActive = activeByKey(
      buildSurfaceDrawControls(legacy, { prefix: 'ink', tools: erasers() }),
    );
    expect([...legacyActive.values()]).toEqual([true, false]);
  });

  it('keeps both erasers exclusive-settled while a temporary tool is held', () => {
    // Temp-held eraser over a settled pen: both read inactive.
    const host = stubHost({
      activeToolId: () => ERASER,
      settledActiveToolId: () => SURFACE_TOOL_IDS.pen,
      eraserMode: () => 'precision',
    });
    const tools = [
      {
        key: SURFACE_TOOL_IDS.pen,
        toolId: SURFACE_TOOL_IDS.pen,
        label: 'Pen',
        icon: 'pen',
      },
      ...erasers(),
    ];
    const active = activeByKey(
      buildSurfaceDrawControls(host, { prefix: 'ink', tools }),
    );
    expect(active.get(`ink.tool.${SURFACE_TOOL_IDS.pen}`)).toBe(true);
    for (const entry of erasers()) {
      expect(active.get(`ink.tool.${entry.key}`)).toBe(false);
    }
  });

  it('fixes the preset mode before activating the engine on execute', () => {
    const calls: string[] = [];
    const host = stubHost({
      eraserMode: () => 'stroke',
      setTool: (toolId: string) => {
        calls.push(`setTool:${toolId}`);
      },
      setEraserMode: (mode) => {
        calls.push(`setEraserMode:${mode}`);
      },
    });
    const options = { prefix: 'ink', tools: erasers() } as const;
    for (const entry of erasers()) {
      calls.length = 0;
      expect(
        executeSurfaceToolbarControl(host, options, `ink.tool.${entry.key}`),
      ).toBe(true);
      // Mode first, engine activation second.
      expect(calls).toEqual([
        `setEraserMode:${entry.eraserMode}`,
        `setTool:${ERASER}`,
      ]);
    }
    // Engine activation still follows when the host lacks the mode seam.
    const legacy = stubHost();
    expect(
      executeSurfaceToolbarControl(
        legacy,
        options,
        `ink.tool.${erasers()[1]!.key}`,
      ),
    ).toBe(true);
    expect(legacy.calls).toEqual([`setTool:${ERASER}`]);
  });

  it('honors short dialect keys for Whiteboard-style call sites', () => {
    const tools = createSharedSurfaceEraserTools(ERASER, {
      stroke: 'eraser-stroke',
      precision: 'eraser-precision',
    });
    expect(tools.map((tool) => tool.key)).toEqual([
      'eraser-stroke',
      'eraser-precision',
    ]);
    expect(tools.map((tool) => tool.toolId)).toEqual([ERASER, ERASER]);
    expect(tools.map((tool) => tool.semanticRole)).toEqual([
      'surface.erase.stroke',
      'surface.erase.precision',
    ]);
  });
});

describe('family slot defaults', () => {
  it('resolves independent width/swatch triples per family', () => {
    // Pen family keeps the shared fast widths verbatim (the provider
    // `widths` option stays the single popover source); the highlighter
    // triple centers on its tuned 14pt base so slots stay usable.
    expect(surfaceSlotWidthsForFamily('pen')).toEqual([2, 3.5, 6]);
    expect(surfaceSlotWidthsForFamily('highlighter')).toEqual([8, 14, 20]);
    expect(surfaceSlotSwatchesForFamily('pen')).toEqual([
      '#37352f',
      '#7c6cf0',
      '#c4554d',
    ]);
    expect(surfaceSlotSwatchesForFamily('highlighter')).toEqual([
      '#ffd54f',
      '#7c6cf0',
      '#c4554d',
    ]);
    // Fresh arrays per call: mutating a result never aliases the constants.
    const widths = surfaceSlotWidthsForFamily('pen');
    (widths as number[]).push(99);
    expect(surfaceSlotWidthsForFamily('pen')).toEqual([2, 3.5, 6]);
    expect(SURFACE_PEN_SLOT_WIDTHS).toEqual([2, 3.5, 6]);
  });

  it('pins the highlighter glyph translucency to the tuned brush opacity', () => {
    expect(SURFACE_HIGHLIGHTER_GLYPH_OPACITY).toBe(0.35);
  });
});
