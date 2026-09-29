import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  boundedFrame,
  emptySurface,
  infiniteFrame,
  imageObject,
  inkStrokeObject,
  lineObject,
  rectangleObject,
  textObject,
  SURFACE_TOOL_IDS,
  type Point,
} from '@froglight/foundation';
import { installCanvasStub } from '@froglight/foundation/testing';
import { mountInkSurface, type InkSkeleton } from '../surface.js';
import { INK_TOOL_IDS } from './shape-tools.js';
import { borderHitMode, frameRectView } from './frame-resize.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  document.body.replaceChildren();
});

function event(
  type: string,
  point: Point,
  pointerType = 'touch',
  id = 1,
): PointerEvent {
  const result = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: point.x,
    clientY: point.y,
    button: 0,
  });
  Object.defineProperties(result, {
    pointerType: { value: pointerType },
    pointerId: { value: id },
    pressure: { value: 0.5 },
  });
  return result as PointerEvent;
}

function mount(
  family: 'ink' | 'whiteboard' | 'embedded' = 'ink',
  textPosition: Point = { x: 100, y: 100 },
) {
  cleanups.push(installCanvasStub());
  const root = document.createElement('div');
  const page = document.createElement('div');
  const canvas = document.createElement('canvas');
  const badge = document.createElement('div');
  const pointerIndicator = document.createElement('div');
  const overlayRoot = document.createElement('div');
  page.append(canvas, badge, pointerIndicator, overlayRoot);
  root.append(page);
  document.body.append(root);
  const rect = {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 800,
    bottom: 600,
    width: 800,
    height: 600,
    toJSON: () => ({}),
  };
  page.getBoundingClientRect = () => rect;
  canvas.getBoundingClientRect = () => rect;
  Object.defineProperties(page, {
    clientWidth: { value: 800 },
    clientHeight: { value: 600 },
  });
  const host: InkSkeleton = {
    root,
    page,
    canvas,
    badge,
    pointerIndicator,
    overlayRoot,
  };
  const model = emptySurface(
    family === 'whiteboard' ? infiniteFrame() : boundedFrame(800, 600),
  );
  model.objects.text = textObject('text', {
    ...textPosition,
    text: 'Finger target',
  });
  model.objects.rect = rectangleObject('rect', {
    x: 300,
    y: 100,
    width: 100,
    height: 80,
  });
  model.objects.line = lineObject('line', { x: 300, y: 300, x2: 450, y2: 300 });
  model.objects.stroke = inkStrokeObject('stroke', {
    points: [
      { x: 100, y: 300 },
      { x: 200, y: 300 },
    ],
    width: 3,
  });
  model.objects.image = imageObject('image', {
    x: 550,
    y: 100,
    width: 120,
    height: 90,
    src: 'assets/finger-target.png',
    sha256: 'a'.repeat(64),
  });
  model.order.push('text', 'rect', 'line', 'stroke', 'image');
  const dirty = vi.fn();
  const handle = mountInkSurface({
    model,
    host,
    markDirty: dirty,
    frameResizable: family === 'ink',
    ...(family === 'embedded'
      ? { navigationMode: 'embedded', delegateTouchNavigation: true }
      : {}),
  });
  cleanups.push(() => handle.destroy());
  const view = (p: Point): Point => {
    const camera = handle.camera();
    return {
      x: (p.x - camera.x) * camera.zoom,
      y: (p.y - camera.y) * camera.zoom,
    };
  };
  const send = (type: string, p: Point, pointerType = 'touch', id = 1) =>
    canvas.dispatchEvent(event(type, view(p), pointerType, id));
  const down = (p: Point) => {
    const e = event('pointerdown', view(p));
    if (family === 'embedded') return handle.claimTouchInteraction(e);
    canvas.dispatchEvent(e);
    return e.defaultPrevented;
  };
  return { handle, model, canvas, page, dirty, send, down, view, overlayRoot };
}

for (const family of ['ink', 'whiteboard', 'embedded'] as const) {
  describe(`${family} contextual finger routing`, () => {
    it('selects objects without changing live/settled Pen or opening input', () => {
      const { handle, model, dirty, down, send, overlayRoot } = mount(family);
      const before = JSON.stringify(model);
      for (const [id, point] of [
        ['stroke', { x: 150, y: 300 }],
        ['image', { x: 600, y: 140 }],
        ['rect', { x: 350, y: 130 }],
        ['line', { x: 380, y: 300 }],
      ] as const) {
        down(point);
        expect(handle.selectionIds()).toEqual([]);
        send('pointerup', point);
        expect(handle.selectionIds()).toEqual([id]);
        handle.setSelection([]);
      }
      down({ x: 110, y: 105 });
      expect(handle.selectionIds()).toEqual([]);
      send('pointerup', { x: 110, y: 105 });
      expect(handle.selectionIds()).toEqual(['text']);
      expect(handle.selectionViewportBounds()).not.toBeNull();
      expect(handle.activeToolId()).toBe(SURFACE_TOOL_IDS.pen);
      expect(handle.settledActiveToolId()).toBe(SURFACE_TOOL_IDS.pen);
      expect(overlayRoot.querySelector('textarea, input')).toBeNull();
      expect(dirty).not.toHaveBeenCalled();
      expect(handle.canUndo()).toBe(false);
      expect(JSON.stringify(model)).toBe(before);
    });

    it('a swipe starting over unselected text navigates without moving or selecting it', () => {
      const { handle, model, dirty, down, send } = mount(family);
      const before = JSON.stringify(model);
      const camera = handle.camera();
      expect(down({ x: 110, y: 105 })).toBe(family !== 'embedded');
      send('pointermove', { x: 110, y: 180 });
      send('pointerup', { x: 110, y: 180 });
      expect(handle.selectionIds()).toEqual([]);
      expect(JSON.stringify(model)).toBe(before);
      expect(dirty).not.toHaveBeenCalled();
      expect(handle.canUndo()).toBe(false);
      if (family !== 'embedded') expect(handle.camera()).not.toEqual(camera);
    });

    for (const [id, point] of [
      ['rect', { x: 350, y: 130 }],
      ['line', { x: 380, y: 300 }],
      ['stroke', { x: 150, y: 300 }],
      ['image', { x: 600, y: 140 }],
    ] as const) {
      it(`Select taps ${id}, while a swipe over it navigates`, () => {
        const { handle, model, dirty, down, send } = mount(family);
        handle.setTool(SURFACE_TOOL_IDS.select);
        const before = JSON.stringify(model);
        down(point);
        send('pointermove', { x: point.x, y: point.y + 60 });
        send('pointerup', { x: point.x, y: point.y + 60 });
        expect(handle.selectionIds()).toEqual([]);
        expect(JSON.stringify(model)).toBe(before);
        down(point);
        send('pointerup', point);
        expect(handle.selectionIds()).toEqual([id]);
        expect(dirty).not.toHaveBeenCalled();
      });
    }

    for (const tool of [SURFACE_TOOL_IDS.select, INK_TOOL_IDS.text]) {
      it(`${tool}: a second finger tap edits selected text only after lift`, () => {
        const { handle, model, down, send, overlayRoot, dirty } = mount(family);
        handle.setTool(tool);
        const point = { x: 110, y: 105 };
        const before = JSON.stringify(model);
        down(point);
        send('pointerup', point);
        expect(handle.selectionIds()).toEqual(['text']);
        expect(overlayRoot.querySelector('input, textarea')).toBeNull();
        down(point);
        expect(overlayRoot.querySelector('input, textarea')).toBeNull();
        // Normal finger jitter must not leave a movement history entry.
        send('pointermove', { x: point.x + 3, y: point.y + 2 });
        send('pointerup', { x: point.x + 3, y: point.y + 2 });
        const input = overlayRoot.querySelector(
          'input, textarea',
        ) as HTMLInputElement;
        expect(input).not.toBeNull();
        expect(document.activeElement).toBe(input);
        expect(input.value).toBe('Finger target');
        expect(JSON.stringify(model)).toBe(before);
        expect(dirty).not.toHaveBeenCalled();
      });
    }

    it('anchors selection to the page even when the rendered bitmap is clipped and CSS scaled', () => {
      const { handle, canvas, page } = mount(family);
      handle.setSelection(['rect']);
      const camera = handle.camera();
      page.getBoundingClientRect = () => new DOMRect(100, 50, 1600, 1200);
      canvas.getBoundingClientRect = () => new DOMRect(400, 250, 600, 400);
      expect(handle.selectionViewportBounds()).toEqual({
        x: 100 + (300 - camera.x) * camera.zoom * 2,
        y: 50 + (100 - camera.y) * camera.zoom * 2,
        width: 100 * camera.zoom * 2,
        height: 80 * camera.zoom * 2,
      });
    });

    it('Text swipes on blank paper never open an editor', () => {
      const { handle, dirty, down, send, overlayRoot } = mount(family);
      handle.setTool(INK_TOOL_IDS.text);
      down({ x: 500, y: 400 });
      send('pointermove', { x: 500, y: 460 });
      send('pointerup', { x: 500, y: 460 });
      expect(overlayRoot.querySelector('input, textarea')).toBeNull();
      expect(dirty).not.toHaveBeenCalled();
    });

    it('formatting pointerdown preserves a draft through WebKit blur without relatedTarget', () => {
      const { handle, down, send, overlayRoot, model } = mount(family);
      handle.setTool(INK_TOOL_IDS.text);
      down({ x: 500, y: 400 });
      send('pointerup', { x: 500, y: 400 });
      const input = overlayRoot.querySelector(
        'input, textarea',
      ) as HTMLInputElement;
      input.value = 'Draft';
      const toolbar = document.createElement('div');
      toolbar.dataset.activeToolMenu = '';
      toolbar.dataset.toolShelf = 'surface.insert';
      const button = document.createElement('button');
      toolbar.append(button);
      document.body.append(toolbar);
      button.dispatchEvent(event('pointerdown', { x: 0, y: 0 }));
      button.focus();
      expect(document.activeElement).toBe(input);
      input.dispatchEvent(new FocusEvent('blur', { relatedTarget: null }));
      expect(overlayRoot.querySelector('input, textarea')).toBe(input);
      handle.setTextStyle({ textBold: true, color: '#ff0000' });
      expect(input.style.fontWeight).toBe('700');
      expect(input.style.color).toBe('rgb(255, 0, 0)');
      handle.flush();
      expect(model.objects[model.order.at(-1)!]?.text).toBe('Draft');
    });

    it('keeps native formatting inputs and keyboard navigation focusable during a draft', () => {
      const { handle, down, send, overlayRoot } = mount(family);
      handle.setTool(INK_TOOL_IDS.text);
      down({ x: 500, y: 400 });
      send('pointerup', { x: 500, y: 400 });
      const editor = overlayRoot.querySelector(
        'input, textarea',
      ) as HTMLInputElement;
      const toolbar = document.createElement('div');
      toolbar.dataset.activeToolMenu = '';
      const button = document.createElement('button');
      const size = document.createElement('input');
      size.type = 'number';
      toolbar.append(button, size);
      document.body.append(toolbar);
      button.dispatchEvent(event('pointerdown', { x: 0, y: 0 }));
      button.focus();
      expect(document.activeElement).toBe(editor);
      editor.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
      button.focus();
      expect(document.activeElement).toBe(button);
      const pointer = event('pointerdown', { x: 0, y: 0 });
      size.dispatchEvent(pointer);
      expect(pointer.defaultPrevented).toBe(false);
      size.focus();
      expect(document.activeElement).toBe(size);
      expect(overlayRoot.querySelector('input, textarea')).toBe(editor);
    });

    it('tapping a different object replaces selection without dragging either', () => {
      const { handle, model, down, send } = mount(family);
      handle.setSelection(['text']);
      const before = JSON.stringify(model);
      down({ x: 350, y: 130 });
      expect(handle.selectionIds()).toEqual([]);
      send('pointerup', { x: 350, y: 130 });
      expect(handle.selectionIds()).toEqual(['rect']);
      expect(JSON.stringify(model)).toBe(before);
      expect(handle.canUndo()).toBe(false);
    });

    it('the explicit Text tool accepts a finger on empty paper', () => {
      const { handle, down, send, overlayRoot } = mount(family);
      handle.setTool(INK_TOOL_IDS.text);
      down({ x: 500, y: 400 });
      send('pointerup', { x: 500, y: 400 });
      expect(overlayRoot.querySelector('input, textarea')).not.toBeNull();
      expect(handle.activeToolId()).toBe(INK_TOOL_IDS.text);
    });

    for (const [id, point] of [
      ['text', { x: 110, y: 105 }],
      ['rect', { x: 350, y: 130 }],
      ['stroke', { x: 150, y: 300 }],
      ['image', { x: 600, y: 140 }],
    ] as const) {
      it(`moves selected ${id} ephemerally, commits once, and undoes/redoes`, () => {
        const { handle, model, dirty, down, send } = mount(family);
        handle.setSelection([id]);
        const before = JSON.stringify(model.objects[id]);
        down(point);
        const end = { x: point.x + 40, y: point.y + 40 };
        send('pointermove', end);
        handle.flush();
        expect(JSON.stringify(model.objects[id])).toBe(before);
        expect(dirty).not.toHaveBeenCalled();
        send('pointerup', end);
        const after = JSON.stringify(model.objects[id]);
        expect(after).not.toBe(before);
        expect(handle.activeToolId()).toBe(SURFACE_TOOL_IDS.pen);
        expect(handle.settledActiveToolId()).toBe(SURFACE_TOOL_IDS.pen);
        expect(handle.undo()).toBe(true);
        expect(JSON.stringify(model.objects[id])).toBe(before);
        expect(handle.canUndo()).toBe(false);
        expect(handle.redo()).toBe(true);
        expect(JSON.stringify(model.objects[id])).toBe(after);
      });
    }

    for (const tool of [
      SURFACE_TOOL_IDS.select,
      INK_TOOL_IDS.text,
      SURFACE_TOOL_IDS.pen,
    ]) {
      for (const id of ['text', 'image', 'rect']) {
        it(`${tool}: finger resizes selected ${id} from its handle instead of moving it`, () => {
          const { handle, model, down, send, overlayRoot } = mount(family);
          if (id === 'text')
            model.objects.text!.appearance = { wrapWidth: 180 };
          handle.setTool(tool);
          handle.setSelection([id]);
          const bounds = handle.selectionViewportBounds()!;
          const camera = handle.camera();
          const point = {
            x: camera.x + (bounds.x + bounds.width + 8) / camera.zoom,
            y:
              camera.y +
              (bounds.y +
                (id === 'text' ? bounds.height / 2 : bounds.height + 8)) /
                camera.zoom,
          };
          const before = JSON.stringify(model.objects[id]);
          const origin = { x: model.objects[id]!.x, y: model.objects[id]!.y };
          down(point);
          const end = { x: point.x + 40, y: point.y + 30 };
          send('pointermove', end);
          send('pointerup', end);
          expect(overlayRoot.querySelector('input, textarea')).toBeNull();
          expect(model.objects[id]).toMatchObject(origin);
          if (id === 'text')
            expect(model.objects[id]!.appearance).toMatchObject({
              wrapWidth: 220,
            });
          else
            expect(model.objects[id]).toMatchObject({
              width: expect.closeTo((id === 'image' ? 120 : 100) + 40),
              height: expect.closeTo((id === 'image' ? 90 : 80) + 30),
            });
          expect(handle.activeToolId()).toBe(tool);
          const after = JSON.stringify(model.objects[id]);
          expect(handle.undo()).toBe(true);
          expect(JSON.stringify(model.objects[id])).toBe(before);
          expect(handle.canUndo()).toBe(false);
          expect(handle.redo()).toBe(true);
          expect(JSON.stringify(model.objects[id])).toBe(after);
        });
      }
    }

    for (const end of [
      'pointercancel',
      'navigation',
      'second-finger',
    ] as const) {
      it(`rolls back a finger resize when interrupted by ${end}`, () => {
        const { handle, model, down, send } = mount(family);
        handle.setSelection(['image']);
        const before = JSON.stringify(model);
        const point = { x: 670, y: 190 };
        down(point);
        const moved = { x: 710, y: 230 };
        send('pointermove', moved);
        expect(model.objects.image).toMatchObject({
          width: expect.closeTo(160),
          height: expect.closeTo(130),
        });
        if (end === 'pointercancel') send('pointercancel', moved);
        else if (end === 'navigation' || family === 'embedded') {
          // Notebook hands the claimed page contact back to its pager before
          // routing the second finger into navigation.
          handle.cancelTouchInteraction();
        } else {
          send('pointerdown', { x: 500, y: 350 }, 'touch', 2);
          send('pointerup', { x: 500, y: 350 }, 'touch', 2);
          send('pointerup', moved);
        }
        expect(JSON.stringify(model)).toBe(before);
        expect(handle.canUndo()).toBe(false);
      });
    }

    it('scrolls from an unselected image corner instead of resizing or moving it', () => {
      const { handle, model, down, send, overlayRoot, dirty } = mount(family);
      handle.setTool(SURFACE_TOOL_IDS.select);
      const before = JSON.stringify(model);
      down({ x: 668, y: 188 });
      send('pointermove', { x: 628, y: 148 });
      send('pointerup', { x: 628, y: 148 });
      expect(JSON.stringify(model)).toBe(before);
      expect(handle.selectionIds()).toEqual([]);
      expect(dirty).not.toHaveBeenCalled();
      expect(overlayRoot.querySelector('input, textarea')).toBeNull();
    });

    it('dismisses outside selection immediately without a write and leaves navigation eligible', () => {
      const { handle, model, dirty, canvas, down, send, view } = mount(family);
      handle.setSelection(['text']);
      const before = JSON.stringify(model);
      expect(handle.selectionViewportBounds()).not.toBeNull();
      const camera = handle.camera();
      const claimed = down({ x: 550, y: 400 });
      expect(handle.selectionIds()).toEqual([]);
      expect(handle.selectionViewportBounds()).toBeNull();
      expect(dirty).not.toHaveBeenCalled();
      expect(handle.canUndo()).toBe(false);
      if (family === 'embedded') {
        expect(claimed).toBe(false);
        const move = event('pointermove', view({ x: 580, y: 420 }));
        canvas.dispatchEvent(move);
        expect(move.defaultPrevented).toBe(false);
      } else {
        send('pointermove', { x: 580, y: 420 });
        expect(handle.camera()).not.toEqual(camera);
      }
      expect(JSON.stringify(model)).toBe(before);
    });

    it('clears stale selection on the same Pencil down and keeps its first sample', () => {
      const { handle, model, down, send } = mount(family);
      down({ x: 110, y: 105 });
      send('pointerup', { x: 110, y: 105 });
      send('pointerdown', { x: 500, y: 350 }, 'pen', 2);
      expect(handle.selectionIds()).toEqual([]);
      expect(handle.selectionViewportBounds()).toBeNull();
      send('pointermove', { x: 520, y: 370 }, 'pen', 2);
      send('pointerup', { x: 540, y: 390 }, 'pen', 2);
      const stroke = model.objects[model.order.at(-1)!];
      expect(stroke?.type).toBe('froglight.ink.stroke');
      expect(stroke?.points).toEqual(
        expect.arrayContaining([expect.objectContaining({ x: 500, y: 350 })]),
      );
    });
  });
}

describe('shared authoring dismissal and touch priority', () => {
  it('suppresses native canvas touch selection and releases the listener on destroy', () => {
    const { handle, canvas } = mount();
    const touch = () =>
      new Event('touchstart', { bubbles: true, cancelable: true });
    const before = touch();
    canvas.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(true);
    handle.destroy();
    const after = touch();
    canvas.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  for (const ending of [
    'pointercancel',
    'second finger',
    'swipe back',
  ] as const) {
    it(`${ending} cannot select the pending text tap`, () => {
      const { handle, down, send } = mount('embedded');
      down({ x: 110, y: 105 });
      if (ending === 'pointercancel') send('pointercancel', { x: 110, y: 105 });
      else if (ending === 'second finger')
        send('pointerdown', { x: 400, y: 400 }, 'touch', 2);
      else send('pointermove', { x: 110, y: 150 });
      send('pointerup', { x: 110, y: 105 });
      expect(handle.selectionIds()).toEqual([]);
    });
  }
  for (const tool of [
    SURFACE_TOOL_IDS.pen,
    SURFACE_TOOL_IDS.eraser,
    INK_TOOL_IDS.text,
    INK_TOOL_IDS.rect,
  ]) {
    it(`explicit ${tool} clears selection without history/dirty`, () => {
      const { handle, dirty } = mount();
      handle.setSelection(['text']);
      handle.setTool(tool);
      expect(handle.selectionIds()).toEqual([]);
      expect(handle.selectionViewportBounds()).toBeNull();
      expect(dirty).not.toHaveBeenCalled();
      expect(handle.canUndo()).toBe(false);
    });
  }
  for (const tool of [
    SURFACE_TOOL_IDS.eraser,
    SURFACE_TOOL_IDS.highlighter,
    INK_TOOL_IDS.text,
    INK_TOOL_IDS.rect,
  ]) {
    it(`contextual touch preserves ${tool} and never opens text input`, () => {
      const { handle, dirty, down, send, overlayRoot } = mount();
      handle.setTool(tool);
      down({ x: 110, y: 105 });
      send('pointerup', { x: 110, y: 105 });
      expect(handle.selectionIds()).toEqual(['text']);
      expect(handle.activeToolId()).toBe(tool);
      expect(handle.settledActiveToolId()).toBe(tool);
      expect(overlayRoot.querySelector('input, textarea')).toBeNull();
      expect(dirty).not.toHaveBeenCalled();
      expect(handle.canUndo()).toBe(false);
    });
  }
  for (const tool of [SURFACE_TOOL_IDS.select, SURFACE_TOOL_IDS.lasso]) {
    it(`${tool} retains selection context`, () => {
      const { handle } = mount();
      handle.setSelection(['rect']);
      handle.setTool(tool);
      expect(handle.selectionIds()).toEqual(['rect']);
    });
  }
  it('second finger cancels an ephemeral selection move and begins pinch', () => {
    const { handle, model, dirty, down, send } = mount('whiteboard');
    handle.setSelection(['rect']);
    const before = JSON.stringify(model);
    down({ x: 350, y: 130 });
    send('pointermove', { x: 390, y: 170 });
    handle.flush();
    send('pointerdown', { x: 550, y: 300 }, 'touch', 2);
    send('pointermove', { x: 600, y: 350 }, 'touch', 2);
    send('pointerup', { x: 600, y: 350 }, 'touch', 2);
    send('pointerup', { x: 390, y: 170 });
    expect(JSON.stringify(model)).toBe(before);
    expect(handle.canUndo()).toBe(false);
    expect(dirty).not.toHaveBeenCalled();
  });
  it('palm touch cannot select or interrupt an active Pencil stroke', () => {
    const { handle, model, send } = mount();
    send('pointerdown', { x: 500, y: 350 }, 'pen', 2);
    send('pointerdown', { x: 110, y: 105 }, 'touch', 1);
    expect(handle.selectionIds()).toEqual([]);
    send('pointermove', { x: 520, y: 370 }, 'pen', 2);
    send('pointerup', { x: 540, y: 390 }, 'pen', 2);
    expect(model.order).toHaveLength(6);
  });
  it('frame resize wins over selection and rebases content with one undo entry', () => {
    const { handle, model, canvas, dirty } = mount('ink', { x: 10, y: 280 });
    handle.setSelection(['text']);
    const before = JSON.stringify(model);
    const rect = frameRectView(handle.camera(), { width: 800, height: 600 });
    const point = { x: rect.x + 18, y: rect.y + rect.height / 2 };
    expect(borderHitMode(point, rect, true, 'mouse')).toBeNull();
    canvas.dispatchEvent(event('pointerdown', point));
    canvas.dispatchEvent(event('pointermove', { x: point.x - 40, y: point.y }));
    canvas.dispatchEvent(event('pointerup', { x: point.x - 40, y: point.y }));
    expect(handle.frameSize()?.width).toBeGreaterThan(800);
    expect(model.objects.text?.x).toBeGreaterThan(10);
    expect(dirty).toHaveBeenCalled();
    expect(handle.undo()).toBe(true);
    expect(JSON.stringify(model)).toBe(before);
    expect(handle.canUndo()).toBe(false);
    expect(handle.redo()).toBe(true);
  });
});
