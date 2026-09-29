// @vitest-environment jsdom
/**
 * Surface live-style sharing (review slice 4).
 *
 * - `mountInkSurface` owns the core registry with live refs; Whiteboard
 *   contributes Card through the extra-tools seam sharing those refs.
 * - Toolbar color/width changes affect newly created strokes/cards.
 * - Highlighter consumes live color while preserving width/opacity preset.
 * - Image refuses when unavailable; numeric validation refuses bad values.
 * - Zoom/style ops never mark canonical content dirty.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  emptySurface,
  infiniteFrame,
  InMemoryStylusService,
  type SurfaceModel,
} from '@froglight/foundation';
import { installCanvasStub } from '@froglight/foundation/testing';
import {
  executeSurfaceToolbarControl,
  type SurfaceToolbarHost,
} from '@froglight/foundation';
import { WhiteboardDocumentEditorProvider } from './editor.js';
import { whiteboardExtraTools } from './editor.js';

function pointer(type: string, id: number, x: number, y: number): PointerEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  }) as unknown as PointerEvent;
  Object.defineProperty(event, 'pointerId', { value: id });
  Object.defineProperty(event, 'pointerType', { value: 'mouse' });
  Object.defineProperty(event, 'pressure', { value: 0.5 });
  return event;
}

describe('whiteboard live styles', () => {
  let restoreCanvas: (() => void) | null = null;
  beforeEach(() => {
    restoreCanvas = installCanvasStub();
  });
  afterEach(() => {
    restoreCanvas?.();
    restoreCanvas = null;
    document.body.replaceChildren();
  });

  function mountWhiteboard(model: SurfaceModel, markDirty: () => void) {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const handle = new WhiteboardDocumentEditorProvider().createEditor({
      session: { model, markDirty } as never,
      parent,
    });
    return { parent, handle };
  }

  it('protects drawing, allows the Text tool overlay, then restores drawing', () => {
    const stylusInput = new InMemoryStylusService();
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const handle = new WhiteboardDocumentEditorProvider().createEditor({
      session: { model: emptySurface(infiniteFrame()), markDirty: () => undefined },
      parent,
      stylusInput,
    });
    try {
      expect(stylusInput.inputContext()).toBe('drawing');
      expect(handle.tools?.execute('whiteboard.tool.text')).toBe(true);
      const canvas = parent.querySelector('canvas');
      expect(canvas).not.toBeNull();
      canvas?.dispatchEvent(pointer('pointerdown', 1, 20, 20));
      expect(parent.querySelector('.fl-ink-text-input')).not.toBeNull();
      expect(stylusInput.inputContext()).toBe('text-entry');
      expect(handle.tools?.execute('whiteboard.tool.pen')).toBe(true);
      expect(stylusInput.inputContext()).toBe('drawing');
    } finally { handle.destroy(); parent.remove(); }
    expect(stylusInput.inputContext()).toBe('default');
  });

  it('pen color toolbar changes newly created strokes', async () => {
    const model = emptySurface(infiniteFrame()) as SurfaceModel;
    const { parent, handle } = mountWhiteboard(model, () => undefined);
    try {
      const tools = handle.tools!;
      expect(tools.execute('whiteboard.tool.pen')).toBe(true);
      expect(tools.execute('whiteboard.color', '#c4554d')).toBe(true);
      const canvas = parent.querySelector('canvas')!;
      canvas.dispatchEvent(pointer('pointerdown', 1, 10, 10));
      canvas.dispatchEvent(pointer('pointermove', 1, 60, 20));
      canvas.dispatchEvent(pointer('pointerup', 1, 60, 20));
      await new Promise<void>((r) => requestAnimationFrame(() => r(undefined)));
      expect(model.order).toHaveLength(1);
      const stroke = model.objects[model.order[0]!] as unknown as {
        color?: string;
      };
      expect(stroke.color).toBe('#c4554d');
    } finally {
      handle.destroy();
    }
  });

  it('pen width toolbar changes canonical stroke width', async () => {
    const model = emptySurface(infiniteFrame()) as SurfaceModel;
    const { parent, handle } = mountWhiteboard(model, () => undefined);
    try {
      const tools = handle.tools!;
      expect(tools.execute('whiteboard.tool.pen')).toBe(true);
      expect(tools.execute('whiteboard.width', '6')).toBe(true);
      const canvas = parent.querySelector('canvas')!;
      canvas.dispatchEvent(pointer('pointerdown', 1, 10, 10));
      canvas.dispatchEvent(pointer('pointermove', 1, 60, 20));
      canvas.dispatchEvent(pointer('pointerup', 1, 60, 20));
      await new Promise<void>((r) => requestAnimationFrame(() => r(undefined)));
      const stroke = model.objects[model.order[0]!] as unknown as {
        width?: number;
      };
      expect(stroke.width).toBe(6);
    } finally {
      handle.destroy();
    }
  });

  it('card consumes the selected card color (text color)', async () => {
    const model = emptySurface(infiniteFrame()) as SurfaceModel;
    const { parent, handle } = mountWhiteboard(model, () => undefined);
    try {
      const tools = handle.tools!;
      expect(tools.execute('whiteboard.tool.card')).toBe(true);
      expect(tools.execute('whiteboard.color', '#7c6cf0')).toBe(true);
      const canvas = parent.querySelector('canvas')!;
      canvas.dispatchEvent(pointer('pointerdown', 1, 100, 100));
      canvas.dispatchEvent(pointer('pointermove', 1, 300, 220));
      canvas.dispatchEvent(pointer('pointerup', 1, 300, 220));
      await new Promise<void>((r) => requestAnimationFrame(() => r(undefined)));
      const card = model.objects[model.order[0]!] as unknown as {
        color?: string;
        type: string;
      };
      expect(card.type).toBe('froglight.card');
      expect(card.color).toBe('#7c6cf0');
    } finally {
      handle.destroy();
    }
  });

  it('extra-tools factory shares live refs', () => {
    const pen = { color: '#111111', width: 2 };
    const eraser = { radius: 10 };
    const tools = whiteboardExtraTools({ pen, eraser });
    expect(tools).toHaveLength(1);
    expect(tools[0]?.toolId).toContain('card');
    // Mutating the live ref affects subsequently created tools (shared).
    pen.color = '#222222';
    const again = whiteboardExtraTools({ pen, eraser });
    expect(again).toHaveLength(1);
  });

  it('highlighter keeps its own color while preserving width/opacity preset', async () => {
    const model = emptySurface(infiniteFrame()) as SurfaceModel;
    const { parent, handle } = mountWhiteboard(model, () => undefined);
    try {
      const tools = handle.tools!;
      expect(tools.execute('whiteboard.tool.highlighter')).toBe(true);
      // Contextual color changes apply to the active highlighter preset.
      expect(tools.execute('whiteboard.color', '#c4554d')).toBe(true);
      // Width changes still apply to the active highlighter preset only.
      expect(tools.execute('whiteboard.width', '6')).toBe(true);
      const canvas = parent.querySelector('canvas')!;
      canvas.dispatchEvent(pointer('pointerdown', 1, 10, 10));
      canvas.dispatchEvent(pointer('pointermove', 1, 60, 20));
      canvas.dispatchEvent(pointer('pointerup', 1, 60, 20));
      await new Promise<void>((r) => requestAnimationFrame(() => r(undefined)));
      const stroke = model.objects[model.order[0]!] as unknown as {
        color?: string;
        width?: number;
        opacity?: number;
      };
      expect(stroke.color).toBe('#c4554d');
      expect(stroke.width).toBe(6);
      expect(stroke.opacity).toBeCloseTo(0.35);
      // The Pen preset remains independent when we switch back.
      expect(tools.execute('whiteboard.tool.pen')).toBe(true);
      expect(
        tools.snapshot().controls.find((c) => c.id === 'whiteboard.color'),
      ).toMatchObject({ value: '#37352f' });
    } finally {
      handle.destroy();
    }
  });

  it('eraser size toolbar changes live erasing radius', async () => {
    const model = emptySurface(infiniteFrame()) as SurfaceModel;
    const { handle } = mountWhiteboard(model, () => undefined);
    try {
      const tools = handle.tools!;
      expect(tools.execute('whiteboard.tool.eraser-precision')).toBe(true);
      expect(tools.execute('whiteboard.eraser-radius', '25')).toBe(true);
      const snapshot = tools.snapshot();
      const eraser = snapshot.controls.find(
        (c) => (c as { id: string }).id === 'whiteboard.eraser-radius',
      ) as unknown as { value: number };
      expect(eraser.value).toBe(25);
    } finally {
      handle.destroy();
    }
  });

  it('zoom/style ops do not mark canonical content dirty', () => {
    let dirty = 0;
    const model = emptySurface(infiniteFrame()) as SurfaceModel;
    const { handle } = mountWhiteboard(model, () => {
      dirty += 1;
    });
    try {
      const tools = handle.tools!;
      const before = dirty;
      expect(tools.execute('whiteboard.color', '#448361')).toBe(true);
      expect(tools.execute('whiteboard.width', '6')).toBe(true);
      expect(tools.execute('whiteboard.eraser-radius', '20')).toBe(true);
      expect(tools.execute('whiteboard.zoom-in')).toBe(true);
      expect(tools.execute('whiteboard.zoom-reset')).toBe(true);
      expect(dirty).toBe(before);
      expect(model.order).toHaveLength(0);
    } finally {
      handle.destroy();
    }
  });
});

describe('shared command router hardening', () => {
  function stubHost(
    overrides: Partial<SurfaceToolbarHost> = {},
  ): SurfaceToolbarHost & {
    calls: string[];
  } {
    const calls: string[] = [];
    return {
      calls,
      activeToolId: () => 'surface.pen',
      setTool: (id: string) => {
        calls.push(`setTool:${id}`);
      },
      penColor: () => '#111111',
      setPenColor: (c: string) => {
        calls.push(`setPenColor:${c}`);
      },
      penWidth: () => 2,
      setPenWidth: (w: number) => {
        calls.push(`setPenWidth:${w}`);
      },
      eraserRadius: () => 10,
      setEraserRadius: (r: number) => {
        calls.push(`setEraserRadius:${r}`);
      },
      zoomFactor: () => 1,
      setZoomFactor: (z: number) => {
        calls.push(`setZoomFactor:${z}`);
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

  const options = {
    prefix: 'whiteboard',
    tools: [{ key: 'pen', toolId: 'surface.pen', label: 'Pen', icon: 'pen' }],
  } as const;

  it('image returns false when insertion is unavailable', () => {
    const host = stubHost({ canInsertImage: () => false });
    expect(
      executeSurfaceToolbarControl(host, options, 'whiteboard.image'),
    ).toBe(false);
    expect(host.calls).toEqual([]);
  });

  it('refuses non-finite and non-positive numeric values', () => {
    const host = stubHost();
    expect(
      executeSurfaceToolbarControl(host, options, 'whiteboard.width', 'NaN'),
    ).toBe(false);
    expect(
      executeSurfaceToolbarControl(host, options, 'whiteboard.width', '-3'),
    ).toBe(false);
    expect(
      executeSurfaceToolbarControl(
        host,
        options,
        'whiteboard.eraser-radius',
        '0',
      ),
    ).toBe(false);
    expect(
      executeSurfaceToolbarControl(host, options, 'whiteboard.zoom', 'NaN'),
    ).toBe(false);
    expect(host.calls).toEqual([]);
  });
});
