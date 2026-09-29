/**
 * Surface text formatting via `setSelectionStyle`.
 *
 * Proves over the real `mountInkSurface` + history path (jsdom canvas stub,
 * React-committed skeleton):
 * - H1/H2 map to `role: 'heading'` + H1/H2 size (24/20); Body maps to
 *   `role: 'body'` leaving size alone (outline feed: heading roles outline,
 *   body does not)
 * - bold/italic toggle additively without normalizing unknowns
 * - align sets verbatim; wrap toggles the fixed default (never measured)
 * - round-trip preserves unknown roles/aligns/appearance members byte-wise
 * - one commit is one history gesture (one-step undo + redo)
 * - no-op commits touch no history, no dirty
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  boundedFrame,
  emptySurface,
  inkStrokeObject,
  textObject,
  textRoleOf,
  type SurfaceModel,
} from '@froglight/foundation';
import {
  mountInkSurface,
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

interface Mount {
  parent: HTMLElement;
  root: Root;
  model: SurfaceModel;
  handle: InkSurfaceHandle;
  dirty: () => number;
  cleanup: () => void;
}

function mount(): Mount {
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
  const handle = mountInkSurface({
    model,
    markDirty: () => (dirtyCount += 1),
    host: skeleton,
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

describe('surface text formatting (write path)', () => {
  it('does not expose pending text formatting for a selected stroke', () => {
    const m = mount();
    try {
      m.model.objects['stroke'] = inkStrokeObject('stroke', {
        points: [
          { x: 10, y: 20 },
          { x: 40, y: 50 },
        ],
        width: 3,
      });
      m.model.order.push('stroke');
      m.handle.setSelection(['stroke']);
      expect(m.handle.textStyleState().hasText).toBe(false);
      m.handle.setSelection([]);
      expect(m.handle.textStyleState().hasText).toBe(true);
    } finally {
      m.cleanup();
    }
  });
  it('maps H1/H2 to heading + size and Body to body leaving size alone', () => {
    const m = mount();
    try {
      seedText(m.model, 't1', { x: 0, y: 0, text: 'Title' });
      m.handle.setSelection(['t1']);
      expect(m.handle.setSelectionStyle({ textRole: 'heading', textSize: 24 })).toEqual([
        't1',
      ]);
      expect(textRoleOf(m.model.objects['t1']!)).toBe('heading');
      expect(m.model.objects['t1']!.size).toBe(24);
      expect(m.dirty()).toBeGreaterThanOrEqual(1);

      // One commit is one history gesture.
      expect(m.handle.undo()).toBe(true);
      expect(textRoleOf(m.model.objects['t1']!)).toBe('body');
      expect(m.handle.undo()).toBe(false);
      expect(m.handle.redo()).toBe(true);
      expect(textRoleOf(m.model.objects['t1']!)).toBe('heading');

      // H2 writes the H2 size; Body leaves size alone.
      m.handle.setSelection(['t1']);
      m.handle.setSelectionStyle({ textRole: 'heading', textSize: 20 });
      expect(m.model.objects['t1']!.size).toBe(20);
      m.handle.setSelection(['t1']);
      const dirtyBefore = m.dirty();
      m.handle.setSelectionStyle({ textRole: 'body' });
      expect(textRoleOf(m.model.objects['t1']!)).toBe('body');
      expect(m.model.objects['t1']!.size).toBe(20);
      expect(m.dirty()).toBeGreaterThanOrEqual(dirtyBefore + 1);
    } finally {
      m.cleanup();
    }
  });

  it('toggles bold/italic additively across multi-selections in one gesture', () => {
    const m = mount();
    try {
      seedText(m.model, 'a', { x: 0, y: 0, text: 'a' });
      seedText(m.model, 'b', {
        x: 0,
        y: 30,
        text: 'b',
        appearance: { bold: true },
      });
      m.handle.setSelection(['a', 'b']);
      // Mixed bold → turn on for all in one commit.
      m.handle.setSelectionStyle({ textBold: true });
      expect(
        (m.model.objects['a']! as unknown as Record<string, unknown>)
          .appearance,
      ).toMatchObject({ bold: true });
      expect(
        (m.model.objects['b']! as unknown as Record<string, unknown>)
          .appearance,
      ).toMatchObject({ bold: true });
      const dirtyAfterOn = m.dirty();
      expect(dirtyAfterOn).toBeGreaterThanOrEqual(1);
      // One undo reverts both (one history gesture, not two).
      expect(m.handle.undo()).toBe(true);
      expect(
        (m.model.objects['a']! as unknown as Record<string, unknown>)
          .appearance,
      ).toBeUndefined();
      expect(m.handle.undo()).toBe(false);
      expect(m.handle.redo()).toBe(true);

      // Italic on, then off removes the key (minimal bytes).
      m.handle.setSelection(['a']);
      m.handle.setSelectionStyle({ textItalic: true });
      expect(
        (m.model.objects['a']! as unknown as Record<string, unknown>)
          .appearance,
      ).toMatchObject({ italic: true });
      m.handle.setSelection(['a']);
      m.handle.setSelectionStyle({ textItalic: false });
      const appearance = (
        m.model.objects['a']! as unknown as Record<string, unknown>
      ).appearance as Record<string, unknown> | undefined;
      expect(appearance?.italic).toBeUndefined();
    } finally {
      m.cleanup();
    }
  });

  it('sets align verbatim and toggles wrap with the fixed default', () => {
    const m = mount();
    try {
      seedText(m.model, 't1', { x: 0, y: 0, text: 'hi' });
      m.handle.setSelection(['t1']);
      m.handle.setSelectionStyle({ textAlign: 'center' });
      expect(
        (m.model.objects['t1']! as unknown as Record<string, unknown>)
          .appearance,
      ).toMatchObject({ align: 'center' });

      m.handle.setSelection(['t1']);
      m.handle.setSelectionStyle({ textWrap: true });
      expect(
        (m.model.objects['t1']! as unknown as Record<string, unknown>)
          .appearance,
      ).toMatchObject({ align: 'center', wrapWidth: 240 });

      m.handle.setSelection(['t1']);
      m.handle.setSelectionStyle({ textWrap: false });
      const appearance = (
        m.model.objects['t1']! as unknown as Record<string, unknown>
      ).appearance as Record<string, unknown>;
      expect(appearance.wrapWidth).toBeUndefined();
      expect(appearance.align).toBe('center');
    } finally {
      m.cleanup();
    }
  });

  it('preserves unknown roles/aligns/appearance members verbatim', () => {
    const m = mount();
    try {
      seedText(m.model, 't1', {
        x: 0,
        y: 0,
        text: 'future',
        role: 'pull-quote',
        customFuture: 'keep-me',
        appearance: {
          align: 'justify',
          wrapWidth: 120,
          customTrait: 'keep-too',
        },
      });
      m.handle.setSelection(['t1']);
      // Bold on must not normalize the unknown role/align or drop customs.
      m.handle.setSelectionStyle({ textBold: true });
      const record = m.model.objects['t1']! as unknown as Record<
        string,
        unknown
      >;
      expect(record.role).toBe('pull-quote');
      expect(textRoleOf(m.model.objects['t1']!)).toBe('body');
      expect(record.customFuture).toBe('keep-me');
      expect(record.appearance).toMatchObject({
        align: 'justify',
        bold: true,
        wrapWidth: 120,
        customTrait: 'keep-too',
      });
      expect(m.handle.undo()).toBe(true);
      const reverted = m.model.objects['t1']! as unknown as Record<
        string,
        unknown
      >;
      expect(reverted.appearance).toMatchObject({
        align: 'justify',
        wrapWidth: 120,
        customTrait: 'keep-too',
      });
      expect(
        (reverted.appearance as Record<string, unknown>).bold,
      ).toBeUndefined();
    } finally {
      m.cleanup();
    }
  });

  it('ignores non-text records and no-ops without history or dirty', () => {
    const m = mount();
    try {
      seedText(m.model, 't1', { x: 0, y: 0, text: 'same' });
      m.handle.setSelection(['t1']);
      const dirtyBefore = m.dirty();
      // Already body: setting body again is a no-op (empty mutation).
      expect(m.handle.setSelectionStyle({ textRole: 'body' })).toEqual([]);
      expect(m.dirty()).toBe(dirtyBefore);
      expect(m.handle.canUndo()).toBe(false);

      // Unknown role values never corrupt records.
      expect(m.handle.setSelectionStyle({ textRole: 'pull-quote' })).toEqual(
        [],
      );
      expect(
        (m.model.objects['t1']! as unknown as Record<string, unknown>).role,
      ).toBeUndefined();
    } finally {
      m.cleanup();
    }
  });
});
