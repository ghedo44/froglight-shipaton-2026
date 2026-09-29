/**
 * Active Tool settings schema (slice 8): per-tool property controls as
 * plain snapshot data for the second-tap popover, plus command routing.
 * React renders; providers interpret. No DOM or engine types cross it.
 */

import { describe, expect, it } from 'vitest';
import {
  activeSlotFamily,
  buildActiveToolSettingsControls,
  executeSurfaceToolSettingsControl,
  type SurfaceToolSettingsHost,
} from './surface-tool-settings.js';

function stubHost(
  overrides: Partial<SurfaceToolSettingsHost> = {},
): SurfaceToolSettingsHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    activeToolId: () => 'froglight.ink.pen',
    setTool: (toolId: string) => {
      calls.push(`setTool:${toolId}`);
    },
    toolPreset: () => ({}),
    setToolPreset: (tool, patch) => {
      calls.push(`setToolPreset:${tool}:${JSON.stringify(patch)}`);
    },
    eraserPreset: () => ({}),
    setEraserPreset: (patch) => {
      calls.push(`setEraserPreset:${JSON.stringify(patch)}`);
    },
    lassoPreset: () => ({}),
    setLassoPreset: (patch) => {
      calls.push(`setLassoPreset:${JSON.stringify(patch)}`);
    },
    recentColors: () => [],
    ...overrides,
  };
}

const OPTIONS = {
  prefix: 'ink',
  swatches: ['#111111', '#ff0000'],
  widths: [2, 3.5, 6],
} as const;

function ids(host: SurfaceToolSettingsHost): string[] {
  return buildActiveToolSettingsControls(host, OPTIONS).map((c) => c.id);
}

describe('buildActiveToolSettingsControls', () => {
  it('emits the ball-pen schema without nib/tilt/velocity controls', () => {
    // conditional props: the ball pen has a fixed round nib,
    // no tilt shading, and no velocity-derived pressure, so those
    // controls are not emitted (see BRUSH_ADVANCED_SUPPORT).
    expect(ids(stubHost())).toEqual([
      'ink.settings.pen.type',
      'ink.settings.pen.size',
      'ink.settings.pen.color',
      'ink.settings.pen.pressure',
      'ink.settings.pen.pressure-min',
      'ink.settings.pen.pressure-max',
      'ink.settings.pen.stabilization',
      'ink.settings.pen.streamline',
      'ink.settings.pen.taper-end',
    ]);
  });

  it('emits only real engine semantics per pen-family tool', () => {
    const fieldsOf = (toolId: string): string[] =>
      buildActiveToolSettingsControls(
        stubHost({ activeToolId: () => toolId }),
        OPTIONS,
      ).map((c) => c.id.slice(c.id.lastIndexOf('.') + 1));
    // Fountain: directional flat nib + taper, no velocity/tilt semantics.
    const fountain = fieldsOf('froglight.ink.fountain');
    expect(fountain).toContain('tip');
    expect(fountain).toContain('tip-flatness');
    expect(fountain).toContain('tip-angle');
    expect(fountain).toContain('cap');
    expect(fountain).toContain('taper-start');
    expect(fountain).not.toContain('velocity-pressure');
    expect(fountain).not.toContain('tilt-effect');
    // Brush: velocity-derived pressure + taper, fixed round nib, no tilt.
    const brush = fieldsOf('froglight.ink.brush');
    expect(brush).toContain('velocity-pressure');
    expect(brush).toContain('taper-start');
    expect(brush).not.toContain('tilt-effect');
    expect(brush).not.toContain('tip');
    expect(brush).not.toContain('tip-flatness');
    expect(brush).not.toContain('cap');
    // Pencil: tilt shading + elliptical nib, no velocity semantics.
    const pencil = fieldsOf('froglight.ink.pencil');
    expect(pencil).toContain('tilt-effect');
    expect(pencil).toContain('tip');
    expect(pencil).not.toContain('velocity-pressure');
    expect(pencil).not.toContain('taper-start');
    // Ball (pen): fixed round nib, no tilt/velocity semantics.
    const pen = fieldsOf('froglight.ink.pen');
    expect(pen).not.toContain('velocity-pressure');
    expect(pen).not.toContain('tilt-effect');
    expect(pen).not.toContain('tip');
    expect(pen).not.toContain('cap');
    expect(pen).not.toContain('taper-start');
  });

  it('resolves the schema from the settled tool while temp is held', () => {
    // Temp-held eraser over a settled pen: the slot editor must keep the
    // pen schema (matching settled draw active + style values), so edits
    // route to the settled preset instead of the held tool's.
    const tempHeld = stubHost({
      activeToolId: () => 'froglight.ink.eraser',
      settledActiveToolId: () => 'froglight.ink.pen',
    });
    expect(ids(tempHeld)).toEqual(ids(stubHost()));
    expect(ids(tempHeld)[0]).toBe('ink.settings.pen.type');
    // Live-only hosts (no temporary seam) keep resolving the live tool.
    const liveOnly = stubHost({ activeToolId: () => 'froglight.ink.eraser' });
    expect(
      'settledActiveToolId' in liveOnly &&
        typeof (liveOnly as { settledActiveToolId?: unknown })
          .settledActiveToolId === 'function',
    ).toBe(false);
    // no mode dropdown — selection happens via the toolbar
    // eraser tool, never via a setting.
    expect(ids(liveOnly)).toEqual([
      'ink.settings.eraser.filter',
      'ink.settings.eraser.auto-return',
    ]);
  });

  it('labels fast size presets thin/medium/thick', () => {
    const controls = buildActiveToolSettingsControls(stubHost(), OPTIONS);
    const size = controls.find((c) => c.id === 'ink.settings.pen.size')!;
    expect(size.kind).toBe('choice');
    if (size.kind !== 'choice') return;
    expect(size.options.map((o) => o.label)).toEqual([
      'Thin',
      'Medium',
      'Thick',
    ]);
  });

  it('merges recent colors ahead of swatches', () => {
    const controls = buildActiveToolSettingsControls(
      stubHost({ recentColors: () => ['#00ff00'] }),
      OPTIONS,
    );
    const color = controls.find((c) => c.id === 'ink.settings.pen.color')!;
    expect(color.kind).toBe('color');
    if (color.kind !== 'color') return;
    expect(color.options).toEqual(['#00ff00', '#111111', '#ff0000']);
  });

  it('emits highlighter color/size/opacity/straight controls', () => {
    const host = stubHost({
      activeToolId: () => 'froglight.ink.highlighter',
      toolPreset: () => ({ color: '#ffd54f', size: 14, opacity: 0.35 }),
    });
    expect(ids(host)).toEqual([
      'ink.settings.highlighter.color',
      'ink.settings.highlighter.size',
      'ink.settings.highlighter.opacity',
      'ink.settings.highlighter.straight',
    ]);
  });

  it('exposes size only for Precision Eraser', () => {
    const host = stubHost({
      activeToolId: () => 'froglight.ink.eraser',
      eraserPreset: () => ({ mode: 'precision' }),
    });
    expect(ids(host)).toEqual([
      'ink.settings.eraser.radius',
      'ink.settings.eraser.filter',
      'ink.settings.eraser.auto-return',
    ]);
    expect(
      ids(
        stubHost({
          activeToolId: () => 'froglight.ink.eraser',
          eraserPreset: () => ({ mode: 'stroke' }),
        }),
      ),
    ).toEqual([
      'ink.settings.eraser.filter',
      'ink.settings.eraser.auto-return',
    ]);
    const controls = buildActiveToolSettingsControls(host, OPTIONS);
    expect(controls.some((c) => c.id === 'ink.settings.eraser.mode')).toBe(
      false,
    );
    expect(
      controls.some(
        (c) =>
          (c as unknown as { semanticRole?: string }).semanticRole ===
          'surface.settings.eraser-mode',
      ),
    ).toBe(false);
  });

  it('keeps lasso mode/filter settings on Lasso, not the pointer tool', () => {
    const lasso = stubHost({ activeToolId: () => 'froglight.ink.lasso' });
    expect(ids(lasso)).toEqual([
      'ink.settings.lasso.mode',
      'ink.settings.lasso.filter',
    ]);
    const controls = buildActiveToolSettingsControls(lasso, OPTIONS);
    expect(controls[0]).toMatchObject({
      semanticRole: 'surface.settings.lasso-mode',
    });
    expect(controls[1]).toMatchObject({
      semanticRole: 'surface.settings.lasso-filter',
    });
    const select = stubHost({ activeToolId: () => 'froglight.ink.select' });
    expect(ids(select)).toEqual([]);
  });

  it('tags the pen-type selector with an explicit role', () => {
    const controls = buildActiveToolSettingsControls(stubHost(), OPTIONS);
    expect(
      controls.find((c) => c.id === 'ink.settings.pen.type'),
    ).toMatchObject({ semanticRole: 'surface.settings.pen-type' });
  });

  it('emits and routes line arrowhead settings', () => {
    const calls: string[] = [];
    const host = stubHost({
      activeToolId: () => 'froglight.ink.line',
      lineArrows: () => 'end',
      setLineArrows: (arrows) => calls.push(arrows),
    });
    const controls = buildActiveToolSettingsControls(host, OPTIONS);
    expect(controls).toHaveLength(3);
    expect(
      controls.find((c) => c.id === 'ink.settings.line.arrows'),
    ).toMatchObject({
      id: 'ink.settings.line.arrows',
      value: 'end',
    });
    expect(
      executeSurfaceToolSettingsControl(
        host,
        OPTIONS,
        'ink.settings.line.arrows',
        'none',
      ),
    ).toBe(true);
    expect(calls).toEqual(['none']);
  });
});

describe('executeSurfaceToolSettingsControl', () => {
  const options = OPTIONS;

  it('switches brush-kind tools through the pen type selector', () => {
    const host = stubHost();
    expect(
      executeSurfaceToolSettingsControl(
        host,
        options,
        'ink.settings.pen.type',
        'fountain',
      ),
    ).toBe(true);
    expect(host.calls).toEqual(['setTool:froglight.ink.fountain']);
  });

  it('writes size/color/pressure into the active tool preset', () => {
    const host = stubHost();
    expect(
      executeSurfaceToolSettingsControl(
        host,
        options,
        'ink.settings.pen.size',
        '6',
      ),
    ).toBe(true);
    expect(
      executeSurfaceToolbarControlSafe(
        host,
        options,
        'ink.settings.pen.color',
        '#ff0000',
      ),
    ).toBe(true);
    expect(
      executeSurfaceToolSettingsControl(
        host,
        options,
        'ink.settings.pen.pressure',
        '80',
      ),
    ).toBe(true);
    expect(host.calls).toEqual([
      'setToolPreset:pen:{"size":6}',
      'setToolPreset:pen:{"color":"#ff0000"}',
      'setToolPreset:pen:{"brush":{"pressure":{"enabled":true,"curve":2.5}}}',
    ]);
  });

  it('toggles straight-line and auto-return flags', () => {
    const host = stubHost({
      activeToolId: () => 'froglight.ink.highlighter',
      toolPreset: () => ({}),
    });
    expect(
      executeSurfaceToolSettingsControl(
        host,
        options,
        'ink.settings.highlighter.straight',
      ),
    ).toBe(true);
    const eraser = stubHost({
      activeToolId: () => 'froglight.ink.eraser',
      eraserPreset: () => ({}),
    });
    expect(
      executeSurfaceToolSettingsControl(
        eraser,
        options,
        'ink.settings.eraser.auto-return',
      ),
    ).toBe(true);
    expect(host.calls).toEqual(['setToolPreset:highlighter:{"straight":true}']);
    expect(eraser.calls).toEqual(['setEraserPreset:{"autoReturn":true}']);
  });

  it('routes eraser and lasso schema writes with validation', () => {
    const host = stubHost({ activeToolId: () => 'froglight.ink.eraser' });
    // legacy mode writes resolve to false without side
    // effects — the mode is fixed per toolbar tool now.
    expect(
      executeSurfaceToolSettingsControl(
        host,
        options,
        'ink.settings.eraser.mode',
        'unknown',
      ),
    ).toBe(false);
    expect(
      executeSurfaceToolbarControlSafe(
        host,
        options,
        'ink.settings.eraser.mode',
        'vaporize',
      ),
    ).toBe(false);
    expect(
      executeSurfaceToolSettingsControl(
        host,
        options,
        'ink.settings.eraser.radius',
        '12',
      ),
    ).toBe(true);
    expect(
      executeSurfaceToolSettingsControl(
        host,
        options,
        'ink.settings.eraser.filter',
        'ink',
      ),
    ).toBe(true);
    expect(host.calls).toEqual([
      'setEraserPreset:{"radius":12}',
      'setEraserPreset:{"filter":"ink"}',
    ]);
  });

  it('rejects unknown tools, fields, and values', () => {
    const host = stubHost();
    expect(
      executeSurfaceToolSettingsControl(
        host,
        options,
        'ink.settings.nope.size',
        '6',
      ),
    ).toBe(false);
    expect(
      executeSurfaceToolSettingsControl(
        host,
        options,
        'ink.settings.pen.nope',
        '6',
      ),
    ).toBe(false);
    expect(
      executeSurfaceToolSettingsControl(
        host,
        options,
        'ink.settings.pen.size',
        'huge',
      ),
    ).toBe(false);
    expect(
      executeSurfaceToolSettingsControl(
        host,
        options,
        'notebook.settings.pen.size',
        '6',
      ),
    ).toBe(false);
    expect(host.calls).toEqual([]);
  });

  it('routes complete saved-style management explicitly', () => {
    const calls: string[] = [];
    const styles = [
      {
        id: 'a',
        name: 'A',
        toolKind: 'pen' as const,
        preset: {},
        favorite: false,
        order: 0,
      },
      {
        id: 'b',
        name: 'B',
        toolKind: 'pen' as const,
        preset: {},
        favorite: false,
        order: 1,
      },
    ];
    const host = stubHost({
      savedStyles: () => styles,
      currentStyleId: () => 'b',
      renameSavedStyle: (id, name) => (
        calls.push(`rename:${id}:${name}`),
        true
      ),
      favoriteSavedStyle: (id, favorite) => (
        calls.push(`favorite:${id}:${favorite}`),
        true
      ),
      reorderSavedStyles: (_tool, ids) => (
        calls.push(`order:${ids.join(',')}`),
        true
      ),
      deleteSavedStyle: (id) => (calls.push(`delete:${id}`), true),
    });
    expect(
      executeSurfaceToolSettingsControl(
        host,
        options,
        'ink.settings.pen.rename-style',
        'Primary',
      ),
    ).toBe(true);
    expect(
      executeSurfaceToolSettingsControl(
        host,
        options,
        'ink.settings.pen.favorite-style',
      ),
    ).toBe(true);
    expect(
      executeSurfaceToolSettingsControl(
        host,
        options,
        'ink.settings.pen.move-style-earlier',
      ),
    ).toBe(true);
    expect(
      executeSurfaceToolSettingsControl(
        host,
        options,
        'ink.settings.pen.delete-style',
      ),
    ).toBe(true);
    expect(calls).toEqual([
      'rename:b:Primary',
      'favorite:b:true',
      'order:b,a',
      'delete:b',
    ]);
  });

  it('keeps slot-scoped writes isolated per tool', () => {
    // Fixed GoodNotes-style slots assign through these commands: a write
    // addressed to one slot must never leak into a sibling slot's preset.
    const host = stubHost();
    expect(
      executeSurfaceToolSettingsControl(
        host,
        options,
        'ink.settings.pen.size',
        '6',
      ),
    ).toBe(true);
    expect(
      executeSurfaceToolSettingsControl(
        host,
        options,
        'ink.settings.pen.color',
        '#ff0000',
      ),
    ).toBe(true);
    expect(
      executeSurfaceToolSettingsControl(
        host,
        options,
        'ink.settings.eraser.filter',
        'ink',
      ),
    ).toBe(true);
    expect(
      executeSurfaceToolSettingsControl(
        host,
        options,
        'ink.settings.fountain.size',
        '3',
      ),
    ).toBe(true);
    // Each write lands on exactly its addressed tool preset — pen writes
    // never touch fountain/eraser and vice versa.
    expect(host.calls).toEqual([
      'setToolPreset:pen:{"size":6}',
      'setToolPreset:pen:{"color":"#ff0000"}',
      'setEraserPreset:{"filter":"ink"}',
      'setToolPreset:fountain:{"size":3}',
    ]);
  });
});

describe('activeSlotFamily', () => {
  const familyOf = (toolId: string): unknown =>
    activeSlotFamily(stubHost({ activeToolId: () => toolId }));

  it('scopes the pen family to one shared set and the highlighter to its own', () => {
    for (const tool of ['pen', 'fountain', 'brush', 'pencil']) {
      expect(familyOf(`froglight.ink.${tool}`)).toBe('pen');
    }
    expect(familyOf('froglight.ink.highlighter')).toBe('highlighter');
  });

  it('resolves null for tools without size/color slots', () => {
    for (const tool of ['eraser', 'lasso', 'line', 'select']) {
      expect(familyOf(`froglight.ink.${tool}`)).toBeNull();
    }
    expect(familyOf('froglight.ink.unknown')).toBeNull();
  });

  it('follows the settled tool while a temporary tool is held', () => {
    // Held eraser over a settled highlighter: the slot scope stays
    // highlighter so edits route to the settled family, matching the
    // settled schema/values contract.
    const tempHeld = stubHost({
      activeToolId: () => 'froglight.ink.eraser',
      settledActiveToolId: () => 'froglight.ink.highlighter',
    });
    expect(activeSlotFamily(tempHeld)).toBe('highlighter');
    const settledPen = stubHost({
      activeToolId: () => 'froglight.ink.eraser',
      settledActiveToolId: () => 'froglight.ink.brush',
    });
    expect(activeSlotFamily(settledPen)).toBe('pen');
  });
});

function executeSurfaceToolbarControlSafe(
  host: SurfaceToolSettingsHost,
  options: typeof OPTIONS,
  id: string,
  value?: string,
): boolean {
  return executeSurfaceToolSettingsControl(host, options, id, value);
}
