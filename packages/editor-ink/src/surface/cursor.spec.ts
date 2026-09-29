import { describe, expect, it } from 'vitest';
import {
  FOUNTAIN_PEN_BRUSH,
  HIGHLIGHTER_BRUSH,
  SURFACE_TOOL_IDS,
  resolveBrushSpec,
} from '@froglight/foundation';
import {
  createSurfaceCursorPresenter,
  cursorToolKind,
  resolveSurfaceCursor,
  type SurfaceCursorTool,
} from './cursor.js';

describe('surface cursor resolution', () => {
  it('uses resolved brush geometry in surface units and applies zoom once', () => {
    const brush = resolveBrushSpec(
      { size: 8, pressure: { enabled: false } },
      FOUNTAIN_PEN_BRUSH,
    );
    const cursor = resolveSurfaceCursor({
      tool: { kind: 'brush', brush },
      camera: { x: 0, y: 0, zoom: 0.5 },
    });
    expect(cursor).toMatchObject({
      kind: 'custom',
      shape: 'ellipse',
      width: 4,
      height: 1.4,
    });

    const highlighter = resolveSurfaceCursor({
      tool: { kind: 'brush', brush: HIGHLIGHTER_BRUSH },
      camera: { x: 0, y: 0, zoom: 2 },
    });
    expect(highlighter).toMatchObject({
      kind: 'custom',
      shape: 'circle',
      width: 28,
      height: 28,
    });
  });

  it('keeps eraser view radius independent of zoom and distinguishes whole stroke', () => {
    for (const zoom of [0.5, 1, 4]) {
      expect(
        resolveSurfaceCursor({
          tool: { kind: 'eraser', radiusView: 10, mode: 'precision' },
          camera: { x: 0, y: 0, zoom },
        }),
      ).toMatchObject({ kind: 'custom', width: 20, height: 20, dashed: false });
    }
    expect(
      resolveSurfaceCursor({
        tool: { kind: 'eraser', radiusView: 6, mode: 'stroke' },
        camera: { x: 0, y: 0, zoom: 1 },
      }),
    ).toMatchObject({ dashed: true, marker: 'stroke-eraser' });
  });

  it('gives semantic actions priority and never infers foreign tools by suffix', () => {
    expect(cursorToolKind(SURFACE_TOOL_IDS.select)).toBe('select');
    expect(cursorToolKind('plugin.example.eraser')).toBe('unknown');
    expect(
      resolveSurfaceCursor({
        tool: { kind: 'brush', brush: HIGHLIGHTER_BRUSH },
        camera: { x: 0, y: 0, zoom: 1 },
        action: 'nwse-resize',
      }),
    ).toEqual({ kind: 'native', cursor: 'nwse-resize' });
    expect(
      resolveSurfaceCursor({
        tool: { kind: 'select' },
        camera: { x: 0, y: 0, zoom: 1 },
      }),
    ).toEqual({ kind: 'native', cursor: 'default' });
    expect(
      resolveSurfaceCursor({
        tool: { kind: 'lasso', mode: 'rectangle' },
        camera: { x: 0, y: 0, zoom: 1 },
      }),
    ).toEqual({ kind: 'native', cursor: 'crosshair' });
  });
});

describe('surface cursor presentation', () => {
  function host() {
    const canvas = document.createElement('canvas');
    const indicator = document.createElement('div');
    Object.defineProperties(canvas, {
      clientWidth: { value: 200 },
      clientHeight: { value: 100 },
    });
    canvas.getBoundingClientRect = () =>
      ({
        x: 10,
        y: 20,
        left: 10,
        top: 20,
        right: 410,
        bottom: 220,
        width: 400,
        height: 200,
        toJSON: () => ({}),
      }) as DOMRect;
    document.body.append(canvas, indicator);
    return { canvas, indicator };
  }

  it('updates stationary geometry, maps host transforms once, and tears down', () => {
    const { canvas, indicator } = host();
    let zoom = 1;
    let tool: SurfaceCursorTool = {
      kind: 'brush',
      brush: resolveBrushSpec(
        { size: 4, pressure: { enabled: false } },
        HIGHLIGHTER_BRUSH,
      ),
    };
    const presenter = createSurfaceCursorPresenter({
      canvas,
      indicator,
      resolveTool: () => tool,
      camera: () => ({ x: 0, y: 0, zoom }),
      supportsCustomCursor: () => true,
    });
    presenter.update({
      pointerId: 1,
      pointerType: 'mouse',
      clientX: 210,
      clientY: 120,
      contact: false,
    });
    expect(canvas.style.cursor).toBe('none');
    expect(indicator.style.left).toBe('100px');
    expect(indicator.style.top).toBe('50px');
    expect(indicator.style.width).toBe('4px');

    zoom = 2;
    presenter.refresh();
    expect(indicator.style.width).toBe('8px');

    tool = { kind: 'text' };
    presenter.refresh();
    expect(indicator.style.display).toBe('none');
    expect(canvas.style.cursor).toBe('text');

    presenter.destroy();
    expect(canvas.style.cursor).toBe('');
    canvas.remove();
    indicator.remove();
  });

  it('allows only the active fine pointer surface to retain a custom cursor', () => {
    const first = host();
    const second = host();
    const tool: SurfaceCursorTool = {
      kind: 'eraser',
      radiusView: 10,
      mode: 'precision',
    };
    const make = (target: ReturnType<typeof host>) =>
      createSurfaceCursorPresenter({
        ...target,
        resolveTool: () => tool,
        camera: () => ({ x: 0, y: 0, zoom: 1 }),
        supportsCustomCursor: () => true,
      });
    const a = make(first);
    const b = make(second);
    const sample = {
      pointerId: 1,
      pointerType: 'mouse',
      clientX: 100,
      clientY: 100,
      contact: false,
    } as const;
    a.update(sample);
    expect(first.indicator.style.display).toBe('block');
    b.update(sample);
    expect(first.indicator.style.display).toBe('none');
    expect(second.indicator.style.display).toBe('block');

    // Touch navigation cannot seize or move the fine-pointer cursor.
    b.update({ ...sample, pointerId: 2, pointerType: 'touch' });
    expect(second.indicator.style.display).toBe('block');
    a.destroy();
    b.destroy();
    first.canvas.remove();
    first.indicator.remove();
    second.canvas.remove();
    second.indicator.remove();
  });

  it('uses one native fallback when custom cursor suppression is unavailable', () => {
    const target = host();
    const presenter = createSurfaceCursorPresenter({
      ...target,
      resolveTool: () => ({ kind: 'brush', brush: HIGHLIGHTER_BRUSH }),
      camera: () => ({ x: 0, y: 0, zoom: 1 }),
      supportsCustomCursor: () => false,
    });
    presenter.update({
      pointerId: 8,
      pointerType: 'pen',
      clientX: 100,
      clientY: 100,
      contact: false,
    });
    expect(target.indicator.style.display).toBe('none');
    expect(target.canvas.style.cursor).toBe('crosshair');
    presenter.destroy();
    target.canvas.remove();
    target.indicator.remove();
  });
});
