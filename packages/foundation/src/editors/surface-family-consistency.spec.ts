/**
 * Surface family convergence: Ink, Notebook, and
 * Whiteboard expose identical Write/Erase/Select/Shapes/Insert grammar
 * through the shared builder profile plus shared style/settings builders.
 *
 * Equivalent roles must share category (via semanticRole → composition),
 * label, icon, group, coarse role, ordering, style controls, and settings
 * schema across the three families. Only control-id dialects
 * (provider-owned ids) and documented additions (Notebook pages/PDF,
 * Whiteboard Card, Ink bounded canvas) may differ.
 *
 * The dialects below mirror each provider's production call site
 * (editor-ink/editor.ts, editor-notebook/editor.ts,
 * editor-whiteboard/editor.ts): same engine tool ids, same short keys for
 * Whiteboard. If a provider drifts from the shared factory, its own golden
 * spec fails; this spec proves the factory itself cannot diverge.
 */
import { describe, expect, it } from 'vitest';
import { SURFACE_TOOL_IDS } from '../surfaces/tools.js';
import {
  buildSurfaceDrawControls,
  buildSurfaceImageControl,
  buildSurfaceStyleControls,
  createSharedSurfaceDrawTools,
  SURFACE_SHARED_ERASER_RANGE,
  SURFACE_SHARED_SWATCHES,
  SURFACE_SHARED_WIDTHS,
  type SharedSurfaceDrawDialect,
  type SharedSurfaceDrawKeys,
  type SurfaceToolbarHost,
} from './surface-toolbar-builder.js';
import { buildActiveToolSettingsControls } from './surface-tool-settings.js';
import type { SurfaceToolSettingsHost } from './surface-tool-settings.js';
import {
  buildSurfaceTextControls,
  SURFACE_TEXT_ORDER,
  surfaceTextControlIds,
} from './surface-text-builder.js';
import { deriveSurfaceTextSelectionState } from './surface-text-selection.js';
import { executeSurfaceTextControl } from './surface-text-execute.js';
import type { DocumentToolControl } from './tools.js';

/** Production Ink dialect: full surface tool ids as control-id keys. */
const INK_DIALECT: SharedSurfaceDrawDialect = {
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
};

/** Production Notebook dialect: page tool ids, Notebook text id. */
const NOTEBOOK_DIALECT: SharedSurfaceDrawDialect = {
  ...INK_DIALECT,
  text: 'froglight.notebook.text',
};

/** Production Whiteboard dialect: shared engine ids with short keys. */
const WHITEBOARD_DIALECT: SharedSurfaceDrawDialect = { ...INK_DIALECT };
const WHITEBOARD_KEYS: SharedSurfaceDrawKeys = {
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
};

/**
 * Provider-owned identity stripped: control `id`, control-id `key`, and
 * engine `toolId` vary by family dialect. Everything else (label,
 * shortLabel, icon, group, active, role, activationRole, toolRole,
 * semanticRole) must be identical across families given identical state.
 */
function presentationOf(control: DocumentToolControl): Record<string, unknown> {
  const { id, key, toolId, ...presentation } = control as unknown as Record<
    string,
    unknown
  > & { id?: unknown; key?: unknown; toolId?: unknown };
  void id;
  void key;
  void toolId;
  return presentation;
}

function stubHost(
  overrides: Partial<SurfaceToolbarHost> = {},
): SurfaceToolbarHost {
  return {
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
}

function stubSettingsHost(activeToolId: string): SurfaceToolSettingsHost {
  return {
    activeToolId: () => activeToolId,
    setTool: () => undefined,
    toolPreset: () => ({ color: '#37352f', size: 3.5 }),
    setToolPreset: () => undefined,
    savedStyles: () => [],
    currentStyleId: () => null,
    saveCurrentStyle: () => null,
    applySavedStyle: () => false,
    updateSavedStyle: () => false,
    renameSavedStyle: () => false,
    favoriteSavedStyle: () => false,
    reorderSavedStyles: () => false,
    deleteSavedStyle: () => false,
    resetSavedStyle: () => false,
    savedStyleModified: () => false,
    lineArrows: () => 'none',
    setLineArrows: () => undefined,
    eraserPreset: () => ({ radius: 10, mode: 'stroke', filter: 'all' }),
    setEraserPreset: () => undefined,
    lassoPreset: () => ({ mode: 'freehand', filter: 'all' }),
    setLassoPreset: () => undefined,
    recentColors: () => [],
    gestures: () => ({}),
    setGestures: () => undefined,
  };
}

describe('surface family convergence', () => {
  it('pins the twelve canonical draw tools with shared presentation and order', () => {
    expect(createSharedSurfaceDrawTools(INK_DIALECT)).toEqual([
      {
        key: SURFACE_TOOL_IDS.pen,
        toolId: SURFACE_TOOL_IDS.pen,
        label: 'Pen',
        icon: 'pen',
        group: 'draw',
        toolRole: 'pen',
        semanticRole: 'surface.pen.ball',
      },
      {
        key: SURFACE_TOOL_IDS.fountain,
        toolId: SURFACE_TOOL_IDS.fountain,
        label: 'Fountain Pen',
        icon: 'fountain',
        group: 'draw',
        toolRole: 'pen',
        semanticRole: 'surface.pen.fountain',
      },
      {
        key: SURFACE_TOOL_IDS.brush,
        toolId: SURFACE_TOOL_IDS.brush,
        label: 'Brush Pen',
        icon: 'brush',
        group: 'draw',
        toolRole: 'pen',
        semanticRole: 'surface.pen.brush',
      },
      {
        key: SURFACE_TOOL_IDS.pencil,
        toolId: SURFACE_TOOL_IDS.pencil,
        label: 'Pencil',
        icon: 'pencil',
        group: 'draw',
        toolRole: 'pen',
        semanticRole: 'surface.pencil',
      },
      {
        key: SURFACE_TOOL_IDS.highlighter,
        toolId: SURFACE_TOOL_IDS.highlighter,
        label: 'Highlighter',
        icon: 'highlighter',
        group: 'draw',
        toolRole: 'highlighter',
        semanticRole: 'surface.highlighter',
      },
      {
        key: SURFACE_TOOL_IDS.eraser,
        toolId: SURFACE_TOOL_IDS.eraser,
        label: 'Eraser',
        icon: 'eraser',
        group: 'draw',
        toolRole: 'eraser',
        semanticRole: 'surface.erase',
      },
      {
        key: SURFACE_TOOL_IDS.select,
        toolId: SURFACE_TOOL_IDS.select,
        label: 'Select',
        icon: 'cursor',
        group: 'draw',
        toolRole: 'select',
        semanticRole: 'surface.select',
      },
      {
        key: SURFACE_TOOL_IDS.lasso,
        toolId: SURFACE_TOOL_IDS.lasso,
        label: 'Lasso',
        icon: 'lasso',
        group: 'draw',
        toolRole: 'lasso',
        semanticRole: 'surface.lasso',
      },
      {
        key: 'froglight.ink.line',
        toolId: 'froglight.ink.line',
        label: 'Line',
        icon: 'arrow-line',
        group: 'draw',
        toolRole: 'shape',
        semanticRole: 'surface.shape.line',
      },
      {
        key: 'froglight.ink.rect',
        toolId: 'froglight.ink.rect',
        label: 'Rectangle',
        icon: 'rect',
        group: 'draw',
        toolRole: 'shape',
        semanticRole: 'surface.shape.rectangle',
      },
      {
        key: 'froglight.ink.ellipse',
        toolId: 'froglight.ink.ellipse',
        label: 'Ellipse',
        icon: 'ellipse',
        group: 'draw',
        toolRole: 'shape',
        semanticRole: 'surface.shape.ellipse',
      },
      {
        key: 'froglight.ink.text',
        toolId: 'froglight.ink.text',
        label: 'Text',
        icon: 'type',
        group: 'draw',
        toolRole: 'text',
        semanticRole: 'surface.insert.text',
      },
    ]);
  });

  it('gives the pen family distinct shared-vocabulary icons with one coarse role', () => {
    // (27): Ball/Fountain/Brush/Pencil/Highlighter
    // stay visually distinct through approved registry names — never one
    // shared `pen` alias — while keeping the single `pen` coarse role for
    // squeeze ordering and accessory routing.
    const tools = createSharedSurfaceDrawTools(INK_DIALECT);
    const bySlot = new Map(tools.map((tool) => [tool.label, tool]));
    const icons = [
      bySlot.get('Pen')?.icon,
      bySlot.get('Fountain Pen')?.icon,
      bySlot.get('Brush Pen')?.icon,
      bySlot.get('Pencil')?.icon,
      bySlot.get('Highlighter')?.icon,
    ];
    expect(icons).toEqual([
      'pen',
      'fountain',
      'brush',
      'pencil',
      'highlighter',
    ]);
    expect(new Set(icons).size).toBe(icons.length);
    expect(
      tools
        .filter((tool) =>
          ['Pen', 'Fountain Pen', 'Brush Pen'].includes(tool.label),
        )
        .map((tool) => tool.toolRole),
    ).toEqual(['pen', 'pen', 'pen']);
  });

  it('shares label/icon/group/role/semantics/order across Ink, Notebook, and Whiteboard', () => {
    const ink = buildSurfaceDrawControls(stubHost(), {
      prefix: 'ink',
      tools: createSharedSurfaceDrawTools(INK_DIALECT),
    });
    const notebook = buildSurfaceDrawControls(stubHost(), {
      prefix: 'notebook',
      tools: createSharedSurfaceDrawTools(NOTEBOOK_DIALECT),
    });
    const whiteboard = buildSurfaceDrawControls(stubHost(), {
      prefix: 'whiteboard',
      tools: createSharedSurfaceDrawTools(WHITEBOARD_DIALECT, WHITEBOARD_KEYS),
    });
    expect(ink).toHaveLength(12);
    expect(notebook).toHaveLength(12);
    expect(whiteboard).toHaveLength(12);
    // Same presentation and ordering per position; only provider-owned
    // control ids (and the Notebook text engine id) differ by dialect.
    expect(notebook.map(presentationOf)).toEqual(ink.map(presentationOf));
    expect(whiteboard.map(presentationOf)).toEqual(ink.map(presentationOf));
    // Semantic roles resolve every shared composition item exactly once.
    const roles = ink.map(
      (control) =>
        (control as unknown as { semanticRole?: string }).semanticRole,
    );
    expect(roles).toEqual([
      'surface.pen.ball',
      'surface.pen.fountain',
      'surface.pen.brush',
      'surface.pencil',
      'surface.highlighter',
      'surface.erase',
      'surface.select',
      'surface.lasso',
      'surface.shape.line',
      'surface.shape.rectangle',
      'surface.shape.ellipse',
      'surface.insert.text',
    ]);
  });

  it('shares style controls (color/width/eraser) across the three families', () => {
    expect(SURFACE_SHARED_SWATCHES).toEqual([
      '#37352f',
      '#7c6cf0',
      '#c4554d',
      '#448361',
      '#a08430',
    ]);
    expect(SURFACE_SHARED_WIDTHS).toEqual([2, 3.5, 6]);
    expect(SURFACE_SHARED_ERASER_RANGE).toEqual({ min: 2, max: 40, step: 1 });
    const options = {
      swatches: [...SURFACE_SHARED_SWATCHES],
      widths: [...SURFACE_SHARED_WIDTHS],
      eraserMin: SURFACE_SHARED_ERASER_RANGE.min,
      eraserMax: SURFACE_SHARED_ERASER_RANGE.max,
      eraserStep: SURFACE_SHARED_ERASER_RANGE.step,
    };
    const stripId = (control: DocumentToolControl): DocumentToolControl => {
      const record = { ...(control as unknown as Record<string, unknown>) };
      delete record.id;
      return record as unknown as DocumentToolControl;
    };
    const ink = buildSurfaceStyleControls(
      stubHost({ eraserMode: () => 'precision' }),
      {
        prefix: 'ink',
        ...options,
      },
    ).map(stripId);
    const notebook = buildSurfaceStyleControls(
      stubHost({ eraserMode: () => 'precision' }),
      {
        prefix: 'notebook',
        ...options,
      },
    ).map(stripId);
    const whiteboard = buildSurfaceStyleControls(
      stubHost({ eraserMode: () => 'precision' }),
      {
        prefix: 'whiteboard',
        ...options,
      },
    ).map(stripId);
    expect(ink).toEqual([
      {
        kind: 'color',
        group: 'style',
        label: 'Stroke color',
        value: '#37352f',
        options: ['#37352f', '#7c6cf0', '#c4554d', '#448361', '#a08430'],
        semanticRole: 'surface.style.color',
      },
      {
        kind: 'choice',
        group: 'style',
        label: 'Stroke width',
        value: '3.5',
        options: [
          { value: '2', label: '2 px' },
          { value: '3.5', label: '3.5 px' },
          { value: '6', label: '6 px' },
        ],
        semanticRole: 'surface.style.width',
      },
      {
        kind: 'range',
        group: 'style',
        label: 'Eraser size',
        value: 10,
        min: 2,
        max: 40,
        step: 1,
        semanticRole: 'surface.erase.size',
      },
    ]);
    expect(notebook).toEqual(ink);
    expect(whiteboard).toEqual(ink);
  });

  it('shares image insertion presentation across the three families', () => {
    const stripId = (control: DocumentToolControl): DocumentToolControl => {
      const record = { ...(control as unknown as Record<string, unknown>) };
      delete record.id;
      return record as unknown as DocumentToolControl;
    };
    const ink = stripId(
      buildSurfaceImageControl(stubHost(), { prefix: 'ink', icon: 'image' }),
    );
    const notebook = stripId(
      buildSurfaceImageControl(stubHost(), {
        prefix: 'notebook',
        icon: 'image',
      }),
    );
    const whiteboard = stripId(
      buildSurfaceImageControl(stubHost(), {
        prefix: 'whiteboard',
        icon: 'image',
      }),
    );
    expect(ink).toEqual({
      kind: 'button',
      group: 'insert',
      label: 'Insert image',
      shortLabel: 'Image',
      icon: 'image',
      disabled: false,
      semanticRole: 'surface.insert.image',
    });
    expect(notebook).toEqual(ink);
    expect(whiteboard).toEqual(ink);
  });

  it('shares the settings schema modulo prefix for every active tool', () => {
    const stripPrefix = (
      prefix: string,
      control: DocumentToolControl,
    ): string =>
      JSON.stringify(control).split(`${prefix}.settings.`).join('<p>.');
    for (const activeToolId of [
      SURFACE_TOOL_IDS.pen,
      SURFACE_TOOL_IDS.fountain,
      SURFACE_TOOL_IDS.brush,
      SURFACE_TOOL_IDS.pencil,
      SURFACE_TOOL_IDS.highlighter,
      SURFACE_TOOL_IDS.eraser,
      SURFACE_TOOL_IDS.lasso,
      'froglight.ink.line',
    ]) {
      const options = {
        swatches: [...SURFACE_SHARED_SWATCHES],
        widths: [...SURFACE_SHARED_WIDTHS],
      };
      const ink = buildActiveToolSettingsControls(
        stubSettingsHost(activeToolId),
        { prefix: 'ink', ...options },
      ).map((control) => stripPrefix('ink', control));
      const notebook = buildActiveToolSettingsControls(
        stubSettingsHost(activeToolId),
        { prefix: 'notebook', ...options },
      ).map((control) => stripPrefix('notebook', control));
      const whiteboard = buildActiveToolSettingsControls(
        stubSettingsHost(activeToolId),
        { prefix: 'whiteboard', ...options },
      ).map((control) => stripPrefix('whiteboard', control));
      expect(notebook, `settings diverge for ${activeToolId}`).toEqual(ink);
      expect(whiteboard, `settings diverge for ${activeToolId}`).toEqual(ink);
    }
  });

  it('shares grouped surface text across Ink/Notebook/Whiteboard dialects', () => {
    // Canonical order Style, Size, Bold, Italic, Align, Color, Wrap is the
    // single presentation table for all three families.
    expect(SURFACE_TEXT_ORDER).toEqual([
      'style',
      'size',
      'bold',
      'italic',
      'align',
      'color',
      'wrap',
    ]);
    const state = {
      hasText: true as const,
      style: 'h1' as const,
      size: 24 as const,
      bold: { active: true, mixed: false },
      italic: { active: false, mixed: true },
      align: 'center' as const,
      color: '#c4554d' as const,
      wrap: { active: false, mixed: false },
    };
    const stripId = (control: DocumentToolControl): unknown => {
      const record = { ...(control as unknown as Record<string, unknown>) };
      delete record.id;
      return record;
    };
    const ink = buildSurfaceTextControls(
      surfaceTextControlIds('ink'),
      state,
    ).map(stripId);
    const notebook = buildSurfaceTextControls(
      surfaceTextControlIds('notebook'),
      state,
    ).map(stripId);
    const whiteboard = buildSurfaceTextControls(
      surfaceTextControlIds('whiteboard'),
      state,
    ).map(stripId);
    // Same labels/icons/groups/roles/order; only provider-owned ids differ.
    expect(notebook).toEqual(ink);
    expect(whiteboard).toEqual(ink);
    expect(ink).toHaveLength(7);
    expect(
      (ink as { semanticRole?: string }[]).map(
        (control) =>
          (control as unknown as { semanticRole?: string }).semanticRole,
      ),
    ).toEqual([
      'surface.text.style',
      'surface.text.size',
      'surface.text.bold',
      'surface.text.italic',
      'surface.text.align',
      'surface.text.color',
      'surface.text.wrap',
    ]);
    // Dormant without text: no synthesis, composition stays unresolved.
    for (const prefix of ['ink', 'notebook', 'whiteboard'] as const) {
      expect(
        buildSurfaceTextControls(surfaceTextControlIds(prefix), {
          hasText: false,
          style: 'mixed',
          size: 'mixed',
          bold: { active: false, mixed: false },
          italic: { active: false, mixed: false },
          align: 'mixed',
          color: 'mixed',
          wrap: { active: false, mixed: false },
        }),
      ).toEqual([]);
    }
    // One shared derivation: identical records + ids read identically for
    // every dialect prefix (only ids differ at the builder call site).
    expect(deriveSurfaceTextSelectionState(null, ['t1'])).toMatchObject({
      hasText: false,
    });
    // One shared execute mapping: style values and toggle direction agree
    // modulo prefix; unknown values never mutate.
    for (const prefix of ['ink', 'notebook', 'whiteboard'] as const) {
      const seen: unknown[] = [];
      const host = {
        textSelectionState: () => state,
        setSelectionStyle: (style: unknown) => {
          seen.push(style);
          return ['t1'];
        },
      };
      expect(
        executeSurfaceTextControl(host, prefix, `${prefix}.text.style`, 'h1'),
      ).toBe(true);
      expect(seen).toEqual([{ textRole: 'heading', textSize: 24 }]);
      expect(
        executeSurfaceTextControl(host, prefix, `${prefix}.text.style`, 'h3'),
      ).toBe(true);
      expect(seen.at(-1)).toEqual({ textRole: 'heading', textSize: 18 });
      // Cross-dialect ids never resolve (no per-family literal drift).
      expect(
        executeSurfaceTextControl(
          host,
          prefix,
          'notebook.text.bold',
          undefined,
        ),
      ).toBe(prefix === 'notebook');
    }
  });

  it('derives draw active from the settled tool uniformly while live diverges', () => {
    // Ink/Whiteboard hold a temp eraser (live) over a settled pen; the
    // Notebook pager has no temporary seam so live is settled there.
    // All three must still mark the pen active — temp never drives
    // exclusive-tool reconciliation on any family.
    const ink = buildSurfaceDrawControls(
      stubHost({
        activeToolId: () => SURFACE_TOOL_IDS.eraser,
        settledActiveToolId: () => SURFACE_TOOL_IDS.pen,
      }),
      { prefix: 'ink', tools: createSharedSurfaceDrawTools(INK_DIALECT) },
    );
    const notebook = buildSurfaceDrawControls(stubHost(), {
      prefix: 'notebook',
      tools: createSharedSurfaceDrawTools(NOTEBOOK_DIALECT),
    });
    const whiteboard = buildSurfaceDrawControls(
      stubHost({
        activeToolId: () => SURFACE_TOOL_IDS.eraser,
        settledActiveToolId: () => SURFACE_TOOL_IDS.pen,
      }),
      {
        prefix: 'whiteboard',
        tools: createSharedSurfaceDrawTools(
          WHITEBOARD_DIALECT,
          WHITEBOARD_KEYS,
        ),
      },
    );
    for (const family of [ink, notebook, whiteboard]) {
      const active = family.filter(
        (control) =>
          (control as unknown as { active?: boolean }).active === true,
      );
      // Exactly one exclusive tool, and it is the settled pen everywhere.
      expect(active).toHaveLength(1);
      expect(
        (active[0] as unknown as { semanticRole?: string }).semanticRole,
      ).toBe('surface.pen.ball');
    }
    // Same presentation per position across families (only provider-owned
    // ids differ by dialect) even with temp held on two of them.
    expect(notebook.map(presentationOf)).toEqual(ink.map(presentationOf));
    expect(whiteboard.map(presentationOf)).toEqual(ink.map(presentationOf));
  });

  it('sources style slot values from the settled preset on every family', () => {
    const withFountainSettled = (
      overrides: Partial<SurfaceToolbarHost> = {},
    ): SurfaceToolbarHost => ({
      ...stubHost(),
      activeToolId: () => SURFACE_TOOL_IDS.eraser,
      settledActiveToolId: () => SURFACE_TOOL_IDS.fountain,
      toolPreset: () => ({ color: '#7c6cf0', size: 6 }),
      setToolPreset: () => undefined,
      ...overrides,
    });
    const options = {
      swatches: [...SURFACE_SHARED_SWATCHES],
      widths: [...SURFACE_SHARED_WIDTHS],
    };
    const stripId = (control: DocumentToolControl): DocumentToolControl => {
      const record = { ...(control as unknown as Record<string, unknown>) };
      delete record.id;
      return record as unknown as DocumentToolControl;
    };
    // Temp-held families source the settled fountain preset; the live-only
    // family sources its live pen preset — the seam is uniform, only the
    // temp-ignorant source differs by construction.
    const ink = buildSurfaceStyleControls(withFountainSettled(), {
      prefix: 'ink',
      ...options,
    }).map(stripId);
    expect(ink[0]).toMatchObject({ value: '#7c6cf0' });
    expect(ink[1]).toMatchObject({ value: '6' });
    const whiteboard = buildSurfaceStyleControls(withFountainSettled(), {
      prefix: 'whiteboard',
      ...options,
    }).map(stripId);
    expect(whiteboard).toEqual(ink);
    const notebook = buildSurfaceStyleControls(stubHost(), {
      prefix: 'notebook',
      ...options,
    }).map(stripId);
    expect(notebook).toEqual(
      buildSurfaceStyleControls(stubHost(), {
        prefix: 'ink',
        ...options,
      }).map(stripId),
    );
  });
});
