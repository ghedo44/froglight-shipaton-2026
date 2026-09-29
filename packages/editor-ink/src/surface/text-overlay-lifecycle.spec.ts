/**
 * Surface text-overlay lifecycle at the mount seam (..).
 *
 * Proves over the real `mountInkSurface` + history path (jsdom canvas
 * stub, React-committed skeleton):
 * - tap / double-click / Enter enter edit; single-line Enter vs
 *   multiline Ctrl+Enter; Esc and click-away commit without loss
 * - every canonical commit is ONE history gesture (one-step undo + redo)
 * - edits preserve role/appearance/color/unknown members verbatim
 * - legacy fixtures (plain text records) open and edit
 * - keystrokes stay ephemeral (no dirty, no model change per keystroke)
 * - flush / destroy / tool-switch / read-only commit pending text
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  emptySurface,
  boundedFrame,
  cardObject,
  textObject,
  SURFACE_TOOL_IDS,
  InMemoryStylusService,
  type StylusInputContext,
  type SurfaceModel,
} from '@froglight/foundation';
import {
  mountInkSurface,
  INK_TOOL_IDS,
  type InkSkeleton,
  type InkSurfaceHandle,
} from '../index.js';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { InkSurfaceSkeleton } from '../react/InkSurfaceSkeleton.jsx';

function installCanvasStub(): () => void {
  const noop = (): void => undefined;
  const ctx = {
    save: noop,
    restore: noop,
    beginPath: noop,
    clip: noop,
    fill: noop,
    stroke: noop,
    rect: noop,
    fillRect: noop,
    strokeRect: noop,
    fillText: noop,
    ellipse: noop,
    translate: noop,
    rotate: noop,
    setTransform: noop,
    setLineDash: noop,
    clearRect: noop,
    drawImage: noop,
    moveTo: noop,
    lineTo: noop,
    closePath: noop,
    arc: noop,
    fillStyle: '',
    strokeStyle: '',
    font: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    globalAlpha: 1,
    textAlign: 'left',
    textBaseline: 'alphabetic',
  };
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function () {
    return ctx as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  return () => {
    HTMLCanvasElement.prototype.getContext = original;
  };
}

function pointer(
  type: string,
  id: number,
  x: number,
  y: number,
  pointerType = 'mouse',
): PointerEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  }) as unknown as PointerEvent;
  Object.defineProperty(event, 'pointerId', { value: id });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  Object.defineProperty(event, 'pressure', { value: 0.5 });
  return event;
}

function keydown(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { bubbles: true, ...init, key });
}

interface Mount {
  parent: HTMLElement;
  root: Root;
  model: SurfaceModel;
  handle: InkSurfaceHandle;
  dirty: () => number;
  cleanup: () => void;
}

function mount(stylusInput?: InMemoryStylusService, readOnly = false): Mount {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const model = emptySurface(boundedFrame(800, 600));
  let dirtyCount = 0;
  const skeletonRef: { current: InkSkeleton | null } = { current: null };
  const root = createRoot(parent);
  flushSync(() => {
    root.render(
      createElement(InkSurfaceSkeleton, {
        presentation: 'paint-stage',
        navigationMode: 'standalone',
        skeletonRef,
      }),
    );
  });
  const skeleton = skeletonRef.current;
  if (skeleton === null) throw new Error('test skeleton failed to commit');
  const page = parent.querySelector<HTMLElement>('.fl-ink-page')!;
  Object.defineProperties(page, {
    clientWidth: { value: 800 },
    clientHeight: { value: 600 },
    getBoundingClientRect: { value: () => new DOMRect(0, 0, 800, 600) },
  });
  const handle = mountInkSurface({
    model,
    markDirty: () => (dirtyCount += 1),
    host: skeleton,
    stylusInput,
    readOnly,
  });
  return {
    parent,
    root,
    model,
    handle,
    dirty: () => dirtyCount,
    cleanup: () => {
      root.unmount();
      handle.destroy();
      parent.remove();
    },
  };
}

/** View (client) coords for a surface point under the live camera. */
function viewOf(
  handle: InkSurfaceHandle,
  p: { x: number; y: number },
): { x: number; y: number } {
  const c = handle.camera();
  return { x: (p.x - c.x) * c.zoom, y: (p.y - c.y) * c.zoom };
}

function canvasOf(m: Mount): HTMLCanvasElement {
  return m.parent.querySelector('.fl-ink-canvas')!;
}

function editorOf(m: Mount): HTMLElement | null {
  return m.parent.querySelector('.fl-ink-text-input');
}

function seedText(
  model: SurfaceModel,
  id: string,
  geo: { x: number; y: number; text: string } & Record<string, unknown>,
): void {
  const record = textObject(id, {
    x: geo.x,
    y: geo.y,
    text: geo.text,
  }) as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(geo)) {
    if (k !== 'x' && k !== 'y' && k !== 'text') record[k] = v;
  }
  model.objects[id] = record as unknown as SurfaceModel['objects'][string];
  model.order.push(id);
}

let restoreCanvas: (() => void) | null = null;

beforeEach(() => {
  restoreCanvas?.();
  restoreCanvas = installCanvasStub();
  document.body.replaceChildren();
});

describe('text overlay lifecycle (mount)', () => {
  it('protects each mounted drawing owner and restores default on final teardown', () => {
    const service = new InMemoryStylusService();
    const seen: StylusInputContext[] = [];
    service.onInputContextChange((context) => seen.push(context));
    const a = mount(service);
    const b = mount(service);
    try {
      expect(seen).toEqual(['drawing']);
      a.root.unmount();
      a.handle.destroy();
      a.handle.destroy();
      expect(service.inputContext()).toBe('drawing');
      b.root.unmount();
      b.handle.destroy();
      expect(seen).toEqual(['drawing', 'default']);
    } finally { a.cleanup(); b.cleanup(); }
  });

  it('does not claim drawing for read-only mounts and releases on read-only transitions', () => {
    const service = new InMemoryStylusService();
    const seen: StylusInputContext[] = [];
    service.onInputContextChange((context) => seen.push(context));
    const m = mount(service, true);
    try {
      expect(seen).toEqual([]);
      m.handle.setReadOnly(false);
      m.handle.setReadOnly(false);
      expect(seen).toEqual(['drawing']);
      m.handle.setReadOnly(true);
      expect(seen).toEqual(['drawing', 'default']);
    } finally { m.cleanup(); }
    expect(service.inputContext()).toBe('default');
  });

  it.each(['flush', 'destroy', 'tool', 'readonly', 'blur', 'escape'] as const)(
    'allows text input until %s closes the overlay and releases all ownership',
    (settle) => {
      const service = new InMemoryStylusService();
      const m = mount(service);
      try {
        expect(service.inputContext()).toBe('drawing');
        m.handle.setTool(INK_TOOL_IDS.text);
        canvasOf(m).dispatchEvent(pointer('pointerdown', 1, 20, 20));
        const editor = editorOf(m) as HTMLInputElement | HTMLTextAreaElement;
        expect(editor).not.toBeNull();
        expect(service.inputContext()).toBe('text-entry');
        editor.value = 'Handwritten text';
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        expect(service.inputContext()).toBe('text-entry');
        if (settle === 'flush') m.handle.flush?.();
        if (settle === 'destroy') { m.root.unmount(); m.handle.destroy(); }
        if (settle === 'tool') m.handle.setTool(INK_TOOL_IDS.pen);
        if (settle === 'readonly') m.handle.setReadOnly(true);
        if (settle === 'blur') editor.dispatchEvent(new FocusEvent('blur'));
        if (settle === 'escape') editor.dispatchEvent(keydown('Escape'));
        expect(service.inputContext()).toBe(
          settle === 'destroy' || settle === 'readonly' ? 'default' : 'drawing',
        );
        expect(editorOf(m)).toBeNull();
      } finally { m.cleanup(); }
      expect(service.inputContext()).toBe('default');
    },
  );

  it('tap + Enter creates text as one undo step with redo', () => {
    const m = mount();
    try {
      m.handle.setTool(INK_TOOL_IDS.text);
      canvasOf(m).dispatchEvent(pointer('pointerdown', 1, 20, 20));
      const input = editorOf(m) as HTMLInputElement;
      expect(input).not.toBeNull();
      input.value = 'Glycolysis';
      input.dispatchEvent(keydown('Enter'));
      expect(m.model.order).toHaveLength(1);
      expect(m.handle.activeToolId()).toBe(INK_TOOL_IDS.text);
      expect(m.handle.settledActiveToolId()).toBe(INK_TOOL_IDS.text);
      expect(m.handle.selectionIds()).toEqual([]);
      const id = m.model.order[0]!;
      expect(m.model.objects[id]!.text).toBe('Glycolysis');
      expect(m.dirty()).toBe(1);

      expect(m.handle.undo()).toBe(true);
      expect(m.model.order).toHaveLength(0);
      expect(m.handle.undo()).toBe(false);
      expect(m.handle.redo()).toBe(true);
      expect(m.model.order).toEqual([id]);
      expect(m.model.objects[id]!.text).toBe('Glycolysis');
    } finally {
      m.cleanup();
    }
  });

  it('preformats newly created text and previews the chosen appearance', () => {
    const m = mount();
    try {
      m.handle.setTextStyle({
        textRole: 'heading',
        textSize: 24,
        textBold: true,
        textItalic: true,
        textAlign: 'center',
        color: '#c4554d',
        textWrap: true,
      });
      m.handle.setTool(INK_TOOL_IDS.text);
      canvasOf(m).dispatchEvent(pointer('pointerdown', 1, 20, 20));
      const input = editorOf(m) as HTMLTextAreaElement;
      expect(Number.parseFloat(input.style.fontSize)).toBeGreaterThan(16);
      expect(input.style.fontWeight).toBe('700');
      expect(input.style.fontStyle).toBe('italic');
      expect(input.style.textAlign).toBe('center');
      expect(input.style.color).toBe('rgb(196, 85, 77)');
      input.value = 'Prepared heading';
      input.dispatchEvent(keydown('Enter', { ctrlKey: true }));

      const record = m.model.objects[m.model.order[0]!]! as Record<
        string,
        unknown
      >;
      expect(record).toMatchObject({
        type: 'froglight.text',
        role: 'heading',
        size: 24,
        color: '#c4554d',
        appearance: {
          bold: true,
          italic: true,
          align: 'center',
        },
      });
      expect(
        (record.appearance as Record<string, unknown>).wrapWidth,
      ).toBeGreaterThan(0);
    } finally {
      m.cleanup();
    }
  });

  it('double-click on existing text with the text tool edits in place (no duplicate)', () => {
    const m = mount();
    try {
      seedText(m.model, 't-1', { x: 50, y: 60, text: 'before' });
      m.handle.setTool(INK_TOOL_IDS.text);
      const view = viewOf(m.handle, { x: 55, y: 65 });
      canvasOf(m).dispatchEvent(
        new MouseEvent('dblclick', {
          bubbles: true,
          clientX: view.x,
          clientY: view.y,
        }),
      );
      const input = editorOf(m) as HTMLInputElement;
      expect(input).not.toBeNull();
      expect(input.value).toBe('before');
      input.value = 'after';
      // Esc commits (never discards).
      input.dispatchEvent(keydown('Escape'));
      expect(m.model.order).toEqual(['t-1']);
      expect(m.model.objects['t-1']!.text).toBe('after');
      expect(m.dirty()).toBe(1);

      expect(m.handle.undo()).toBe(true);
      expect(m.model.objects['t-1']!.text).toBe('before');
      expect(m.handle.redo()).toBe(true);
      expect(m.model.objects['t-1']!.text).toBe('after');
    } finally {
      m.cleanup();
    }
  });

  it('drags existing text with Text active, with one undo step and no editor', async () => {
    const m = mount();
    try {
      seedText(m.model, 't-1', { x: 50, y: 60, text: 'Move me' });
      m.handle.setTool(INK_TOOL_IDS.text);
      const start = viewOf(m.handle, { x: 65, y: 70 });
      const end = viewOf(m.handle, { x: 135, y: 110 });
      canvasOf(m).dispatchEvent(pointer('pointerdown', 1, start.x, start.y));
      expect(editorOf(m)).toBeNull();
      canvasOf(m).dispatchEvent(pointer('pointermove', 1, end.x, end.y));
      await expect
        .poll(() => m.handle.selectionViewportBounds()!.x)
        .toBeCloseTo(viewOf(m.handle, { x: 120, y: 100 }).x);
      expect(m.model.objects['t-1']).toMatchObject({ x: 50, y: 60 });
      canvasOf(m).dispatchEvent(pointer('pointerup', 1, end.x, end.y));
      expect(m.model.objects['t-1']).toMatchObject({ x: 120, y: 100 });
      expect(m.handle.activeToolId()).toBe(INK_TOOL_IDS.text);
      expect(m.model.order).toEqual(['t-1']);
      expect(m.handle.undo()).toBe(true);
      expect(m.model.objects['t-1']).toMatchObject({ x: 50, y: 60 });
    } finally {
      m.cleanup();
    }
  });

  it('connects text to a card, rebinds a free endpoint and undoes each gesture', () => {
    const m = mount();
    try {
      seedText(m.model, 'source', { x: 50, y: 60, text: 'Source' });
      m.model.objects.card = cardObject('card', {
        x: 250,
        y: 160,
        width: 120,
        height: 80,
        text: 'Card',
      });
      m.model.order.push('card');
      m.handle.setTool(INK_TOOL_IDS.text);
      m.handle.setSelection(['source']);
      const handles = m.handle.selectionContext()!.handles!;
      expect(handles).toHaveLength(4);
      expect(
        handles.every((h) => h.kind === 'anchor' && h.anchor !== 'center'),
      ).toBe(true);
      const anchor = handles.find(
        (h) => h.kind === 'anchor' && h.anchor === 'e',
      )!;
      const start = viewOf(m.handle, anchor);
      const end = viewOf(m.handle, { x: 252, y: 200 });
      canvasOf(m).dispatchEvent(pointer('pointerdown', 1, start.x, start.y));
      canvasOf(m).dispatchEvent(pointer('pointermove', 1, end.x, end.y));
      canvasOf(m).dispatchEvent(pointer('pointerup', 1, end.x, end.y));
      const line = Object.values(m.model.objects).find(
        (r) => r.type === 'froglight.line',
      )!;
      expect(line).toMatchObject({
        source: { objectId: 'source', anchor: 'e' },
        target: { objectId: 'card', anchor: 'w' },
      });
      expect(m.model.order).toHaveLength(3);
      expect(m.handle.undo()).toBe(true);
      expect(m.model.order).toEqual(['source', 'card']);
      expect(m.handle.redo()).toBe(true);
      m.handle.setSelection([line.id]);
      const endpoint = m.handle
        .selectionContext()!
        .handles!.find(
          (h) => h.kind === 'connector-endpoint' && h.end === 'target',
        )!;
      const from = viewOf(m.handle, endpoint);
      const free = viewOf(m.handle, { x: 400, y: 300 });
      canvasOf(m).dispatchEvent(pointer('pointerdown', 2, from.x, from.y));
      canvasOf(m).dispatchEvent(pointer('pointermove', 2, free.x, free.y));
      canvasOf(m).dispatchEvent(pointer('pointerup', 2, free.x, free.y));
      expect(m.model.objects[line.id]!.target).toBeUndefined();
      expect(m.model.objects[line.id]).toMatchObject({ x2: 400, y2: 300 });
      expect(m.handle.undo()).toBe(true);
      expect(m.model.objects[line.id]!.target).toEqual({
        objectId: 'card',
        anchor: 'w',
      });
      m.handle.setSelection([line.id]);
      m.parent.querySelector('.fl-ink-root')!.dispatchEvent(keydown('Delete'));
      expect(m.model.order).toEqual(['source', 'card']);
      expect(m.handle.undo()).toBe(true);
      expect(m.model.objects[line.id]!.target).toEqual({
        objectId: 'card',
        anchor: 'w',
      });
    } finally {
      m.cleanup();
    }
  });

  it('double-click with the select tool edits the hit text', () => {
    const m = mount();
    try {
      seedText(m.model, 't-1', { x: 50, y: 60, text: 'before' });
      m.handle.setTool(SURFACE_TOOL_IDS.select);
      const view = viewOf(m.handle, { x: 55, y: 65 });
      // First click selects (move-drag no-op); dblclick enters edit.
      canvasOf(m).dispatchEvent(pointer('pointerdown', 1, view.x, view.y));
      canvasOf(m).dispatchEvent(pointer('pointerup', 1, view.x, view.y));
      canvasOf(m).dispatchEvent(
        new MouseEvent('dblclick', {
          bubbles: true,
          cancelable: true,
          clientX: view.x,
          clientY: view.y,
        }),
      );
      const input = editorOf(m) as HTMLInputElement;
      expect(input).not.toBeNull();
      expect(input.value).toBe('before');
      m.cleanup();
    } catch (error) {
      m.cleanup();
      throw error;
    }
  });

  it('Enter with a single text selection enters edit', () => {
    const m = mount();
    try {
      seedText(m.model, 't-1', { x: 50, y: 60, text: 'before' });
      m.handle.setTool(SURFACE_TOOL_IDS.select);
      m.handle.setSelection(['t-1']);
      const rootEl = m.parent.querySelector('.fl-ink-root')!;
      rootEl.dispatchEvent(keydown('Enter'));
      const input = editorOf(m) as HTMLInputElement;
      expect(input).not.toBeNull();
      expect(input.value).toBe('before');
      m.cleanup();
    } catch (error) {
      m.cleanup();
      throw error;
    }
  });

  it('updates the open text editor without replacing its draft or caret', () => {
    const m = mount();
    try {
      seedText(m.model, 'live', { x: 50, y: 60, text: 'before' });
      m.handle.setTool(SURFACE_TOOL_IDS.select);
      m.handle.setSelection(['live']);
      m.parent.querySelector('.fl-ink-root')!.dispatchEvent(keydown('Enter'));
      const input = editorOf(m) as HTMLInputElement;
      input.value = 'draft in progress';
      input.setSelectionRange(3, 8);
      const beforeSize = Number.parseFloat(input.style.fontSize);
      m.handle.setTextStyle({ textSize: 32, textBold: true });
      expect(editorOf(m)).toBe(input);
      expect(input.style.fontSize).toBe(`${beforeSize * 2}px`);
      expect(input.style.fontWeight).toBe('700');
      expect(input.value).toBe('draft in progress');
      expect([input.selectionStart, input.selectionEnd]).toEqual([3, 8]);
      expect(m.model.objects['live']?.text).toBe('before');
      m.handle.flush();
      expect(m.model.objects['live']?.text).toBe('draft in progress');
    } finally {
      m.cleanup();
    }
  });

  it.each([INK_TOOL_IDS.text, INK_TOOL_IDS.select])(
    'resizes the text border without opening an editor with %s active',
    (tool) => {
      const m = mount();
      try {
        seedText(m.model, 'border', {
          x: 50,
          y: 60,
          text: 'Resize this text',
          appearance: { wrapWidth: 160, bold: true },
        });
        m.handle.setTool(tool);
        m.handle.setSelection(['border']);
        const start = viewOf(m.handle, { x: 210, y: 65 });
        const end = viewOf(m.handle, { x: 250, y: 65 });
        canvasOf(m).dispatchEvent(pointer('pointermove', 1, start.x, start.y));
        canvasOf(m).dispatchEvent(pointer('pointerdown', 1, start.x, start.y));
        canvasOf(m).dispatchEvent(pointer('pointermove', 1, end.x, end.y));
        canvasOf(m).dispatchEvent(pointer('pointerup', 1, end.x, end.y));
        expect(editorOf(m)).toBeNull();
        expect(m.model.objects.border!.appearance).toMatchObject({
          wrapWidth: expect.closeTo(200),
          bold: true,
        });
        expect(m.handle.undo()).toBe(true);
        expect(m.model.objects.border!.appearance).toMatchObject({
          wrapWidth: 160,
          bold: true,
        });
      } finally {
        m.cleanup();
      }
    },
  );

  it('resizes an existing text box as one undoable change and preserves appearance', () => {
    const m = mount();
    try {
      seedText(m.model, 't-resize', {
        x: 50,
        y: 60,
        text: 'before',
        appearance: { wrapWidth: 120, align: 'center', futureTrait: 7 },
      });
      m.handle.setTool(SURFACE_TOOL_IDS.select);
      m.handle.setSelection(['t-resize']);
      m.parent.querySelector('.fl-ink-root')!.dispatchEvent(keydown('Enter'));
      const input = editorOf(m) as HTMLTextAreaElement;
      const handle = m.parent.querySelector<HTMLButtonElement>(
        '.fl-ink-text-resize-handle',
      )!;
      expect(handle).not.toBeNull();
      Object.defineProperty(input, 'getBoundingClientRect', {
        value: () => ({
          width: Number.parseFloat(input.style.width),
          height: 25,
        }),
      });
      handle.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, clientX: 100 }),
      );
      handle.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientX: 180 }),
      );
      handle.dispatchEvent(
        new MouseEvent('pointerup', { bubbles: true, clientX: 180 }),
      );
      input.dispatchEvent(keydown('Enter', { ctrlKey: true }));
      const changed = m.model.objects['t-resize'] as Record<string, unknown>;
      expect(changed.appearance).toMatchObject({
        align: 'center',
        futureTrait: 7,
      });
      expect(
        (changed.appearance as Record<string, unknown>).wrapWidth,
      ).toBeGreaterThan(120);
      expect(m.dirty()).toBe(1);
      expect(m.handle.undo()).toBe(true);
      expect(
        (m.model.objects['t-resize']!.appearance as Record<string, unknown>)
          .wrapWidth,
      ).toBe(120);
    } finally {
      m.cleanup();
    }
  });

  it('grows a card when its font increases and restores its size with undo', () => {
    const m = mount();
    try {
      m.model.objects.card = cardObject('card', { x: 50, y: 60, width: 120, height: 60, text: 'A longer card description that needs more room' });
      m.model.order.push('card');
      m.handle.setSelection(['card']);
      m.handle.setSelectionStyle({ textSize: 32 });
      expect(m.model.objects.card!.size).toBe(32);
      expect(m.model.objects.card!.height).toBeGreaterThan(60);
      expect(m.handle.undo()).toBe(true);
      expect(m.model.objects.card!.height).toBe(60);
      expect(m.model.objects.card!.size).toBeUndefined();
    } finally { m.cleanup(); }
  });

  it('double-click edits card text in place as one undo step', () => {
    const m = mount();
    try {
      m.model.objects['card-1'] = cardObject('card-1', {
        x: 50,
        y: 60,
        width: 200,
        height: 120,
        text: 'New card',
        size: 18,
        color: '#123456',
        fill: '#fff4cc',
        stroke: '#765432',
        rotation: 0.2,
      });
      (m.model.objects['card-1'] as Record<string, unknown>).customFuture =
        'keep-me';
      m.model.order.push('card-1');
      m.handle.setTool(SURFACE_TOOL_IDS.select);
      const view = viewOf(m.handle, { x: 100, y: 100 });
      canvasOf(m).dispatchEvent(
        new MouseEvent('dblclick', {
          bubbles: true,
          cancelable: true,
          clientX: view.x,
          clientY: view.y,
        }),
      );

      const input = editorOf(m) as HTMLInputElement;
      expect(input).not.toBeNull();
      expect(input.value).toBe('New card');
      expect(input.style.left).toBe(
        `${(58 - m.handle.camera().x) * m.handle.camera().zoom}px`,
      );
      input.value = 'Edited card review';
      input.dispatchEvent(keydown('Enter', { ctrlKey: true }));

      expect(m.model.order).toEqual(['card-1']);
      expect(m.model.objects['card-1']).toMatchObject({
        id: 'card-1',
        type: 'froglight.card',
        x: 50,
        y: 60,
        width: 200,
        height: 120,
        text: 'Edited card review',
        size: 18,
        color: '#123456',
        fill: '#fff4cc',
        stroke: '#765432',
        rotation: 0.2,
        customFuture: 'keep-me',
      });
      expect(m.dirty()).toBe(1);

      expect(m.handle.undo()).toBe(true);
      expect(m.model.objects['card-1']!.text).toBe('New card');
      expect(m.handle.undo()).toBe(false);
      expect(m.handle.redo()).toBe(true);
      expect(m.model.objects['card-1']!.text).toBe('Edited card review');
    } finally {
      m.cleanup();
    }
  });

  it('Enter edits a selected card and unchanged text stays a no-op', () => {
    const m = mount();
    try {
      m.model.objects['card-1'] = cardObject('card-1', {
        x: 50,
        y: 60,
        width: 200,
        height: 120,
        text: 'Same card',
      });
      m.model.order.push('card-1');
      m.handle.setTool(SURFACE_TOOL_IDS.select);
      m.handle.setSelection(['card-1']);
      m.parent
        .querySelector<HTMLElement>('.fl-ink-root')!
        .dispatchEvent(keydown('Enter'));

      const input = editorOf(m) as HTMLInputElement;
      expect(input).not.toBeNull();
      expect(input.value).toBe('Same card');
      input.dispatchEvent(keydown('Enter'));
      expect(m.model.order).toEqual(['card-1']);
      expect(m.dirty()).toBe(0);
      expect(m.handle.canUndo()).toBe(false);
    } finally {
      m.cleanup();
    }
  });

  it('edits preserve role/appearance/color/unknown members verbatim', () => {
    const m = mount();
    try {
      seedText(m.model, 't-1', {
        x: 50,
        y: 60,
        text: 'before',
        size: 20,
        color: '#123456',
        role: 'heading',
        appearance: { align: 'center', wrapWidth: 200 },
        customFuture: 'keep-me',
      });
      m.handle.setTool(INK_TOOL_IDS.text);
      const view = viewOf(m.handle, { x: 55, y: 65 });
      canvasOf(m).dispatchEvent(
        new MouseEvent('dblclick', {
          bubbles: true,
          clientX: view.x,
          clientY: view.y,
        }),
      );
      // Multiline record opens a textarea sized to the wrap box.
      const area = editorOf(m) as HTMLTextAreaElement;
      expect(area.tagName).toBe('TEXTAREA');
      const zoom = m.handle.camera().zoom;
      expect(area.style.width).toBe(`${200 * zoom}px`);
      area.value = 'after';
      area.dispatchEvent(keydown('Enter', { ctrlKey: true }));
      const record = m.model.objects['t-1']! as unknown as Record<
        string,
        unknown
      >;
      expect(record.text).toBe('after');
      expect(record.size).toBe(20);
      expect(record.color).toBe('#123456');
      expect(record.role).toBe('heading');
      expect(record.appearance).toEqual({ align: 'center', wrapWidth: 200 });
      expect(record.customFuture).toBe('keep-me');
      expect(m.dirty()).toBe(1);
      expect(m.handle.undo()).toBe(true);
      expect(
        (m.model.objects['t-1']! as unknown as Record<string, unknown>).text,
      ).toBe('before');
    } finally {
      m.cleanup();
    }
  });

  it('committing unchanged text is a no-op (no dirty, no undo entry)', () => {
    const m = mount();
    try {
      seedText(m.model, 't-1', { x: 50, y: 60, text: 'same' });
      m.handle.setTool(INK_TOOL_IDS.text);
      const view = viewOf(m.handle, { x: 55, y: 65 });
      canvasOf(m).dispatchEvent(
        new MouseEvent('dblclick', {
          bubbles: true,
          clientX: view.x,
          clientY: view.y,
        }),
      );
      const input = editorOf(m) as HTMLInputElement;
      input.value = 'same';
      input.dispatchEvent(keydown('Enter'));
      expect(m.dirty()).toBe(0);
      expect(m.handle.canUndo()).toBe(false);
    } finally {
      m.cleanup();
    }
  });

  it('legacy fixtures without appearance open single-line and edit cleanly', () => {
    const m = mount();
    try {
      // Legacy record: only the older members, no role/appearance.
      m.model.objects['legacy'] = {
        id: 'legacy',
        type: 'froglight.text',
        x: 50,
        y: 60,
        text: 'old',
      };
      m.model.order.push('legacy');
      m.handle.setTool(INK_TOOL_IDS.text);
      const view = viewOf(m.handle, { x: 55, y: 65 });
      canvasOf(m).dispatchEvent(
        new MouseEvent('dblclick', {
          bubbles: true,
          clientX: view.x,
          clientY: view.y,
        }),
      );
      const input = editorOf(m);
      expect(input?.tagName).toBe('INPUT');
      (input as HTMLInputElement).value = 'new';
      input!.dispatchEvent(keydown('Enter'));
      expect(m.model.objects['legacy']!.text).toBe('new');
      // No appearance was invented on write.
      expect('appearance' in m.model.objects['legacy']!).toBe(false);
    } finally {
      m.cleanup();
    }
  });

  it('keystrokes stay ephemeral: input events never dirty or mutate', () => {
    const m = mount();
    try {
      m.handle.setTool(INK_TOOL_IDS.text);
      canvasOf(m).dispatchEvent(pointer('pointerdown', 1, 20, 20));
      const input = editorOf(m) as HTMLInputElement;
      input.value = 'k';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.value = 'ke';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      expect(m.dirty()).toBe(0);
      expect(m.model.order).toHaveLength(0);
      expect(m.handle.canUndo()).toBe(false);
      input.value = 'kept';
      input.dispatchEvent(keydown('Enter'));
      expect(m.dirty()).toBe(1);
    } finally {
      m.cleanup();
    }
  });

  it('flush, destroy, tool-switch, and read-only commit pending text (no loss)', () => {
    for (const settle of ['flush', 'destroy', 'tool', 'readonly'] as const) {
      const m = mount();
      try {
        m.handle.setTool(INK_TOOL_IDS.text);
        canvasOf(m).dispatchEvent(pointer('pointerdown', 1, 20, 20));
        (editorOf(m) as HTMLInputElement).value = `pending-${settle}`;
        if (settle === 'flush') m.handle.flush();
        else if (settle === 'destroy') {
          // Production teardown order (whiteboard provider `destroy()`):
          // the provider unmounts its React root first, then destroys
          // the surface — which commits pending text off the detached
          // editor value. Destroy-first trips React unmount bookkeeping
          // in jsdom (NotFoundError unhandled error), so the test
          // follows production ordering.
          m.root.unmount();
          m.handle.destroy();
        } else if (settle === 'tool') m.handle.setTool(SURFACE_TOOL_IDS.select);
        else m.handle.setReadOnly(true);
        const texts = Object.values(m.model.objects).map(
          (o) => (o as unknown as Record<string, unknown>).text as string,
        );
        expect(texts).toContain(`pending-${settle}`);
        if (settle === 'destroy') {
          // Already unmounted + destroyed above (production order).
          m.parent.remove();
        } else m.cleanup();
      } catch (error) {
        try {
          m.cleanup();
        } catch {
          m.parent.remove();
        }
        throw error;
      }
    }
  });

  it('read-only blocks entering edit', () => {
    const m = mount();
    try {
      seedText(m.model, 't-1', { x: 50, y: 60, text: 'before' });
      m.handle.setReadOnly(true);
      m.handle.setTool(INK_TOOL_IDS.text);
      const view = viewOf(m.handle, { x: 55, y: 65 });
      canvasOf(m).dispatchEvent(
        new MouseEvent('dblclick', {
          bubbles: true,
          clientX: view.x,
          clientY: view.y,
        }),
      );
      expect(editorOf(m)).toBeNull();
    } finally {
      m.cleanup();
    }
  });

  it('toolbar undo with pending text commits first, then reverts (no keystroke loss)', () => {
    const m = mount();
    try {
      m.handle.setTool(INK_TOOL_IDS.text);
      canvasOf(m).dispatchEvent(pointer('pointerdown', 1, 20, 20));
      (editorOf(m) as HTMLInputElement).value = 'typed';
      expect(m.handle.undo()).toBe(true);
      // Committed then reverted: nothing visible, redo restores.
      expect(m.model.order).toHaveLength(0);
      expect(m.handle.redo()).toBe(true);
      const restored = Object.values(m.model.objects)[0] as unknown as Record<
        string,
        unknown
      >;
      expect(restored.text).toBe('typed');
    } finally {
      m.cleanup();
    }
  });
});
