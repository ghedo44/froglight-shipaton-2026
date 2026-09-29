// @vitest-environment jsdom
/**
 *  whiteboard revealAddress seams.
 *
 * TDD anchor: the canvas handle focuses/frames the exact object
 * (select + return true on hit, false on unknown) and the headless
 * handle resolves-only. Both are focus-neutral and never mutate
 * canonical bytes.
 */
import { describe, expect, it } from 'vitest';
import { WhiteboardDocumentEditorProvider } from './editor.js';
import {
  emptySurface,
  infiniteFrame,
  type SurfaceModel,
} from '@froglight/foundation';

type CtxLog = Array<[string, ...unknown[]]>;

function installCanvasStub(): { restore: () => void } {
  const record =
    (log: CtxLog, name: string) =>
    (...args: unknown[]) =>
      void log.push([name, ...args]);
  const log: CtxLog = [];
  const ctx = {
    save: record(log, 'save'),
    restore: record(log, 'restore'),
    clearRect: record(log, 'clearRect'),
    fillRect: record(log, 'fillRect'),
    strokeRect: record(log, 'strokeRect'),
    fillText: record(log, 'fillText'),
    drawImage: record(log, 'drawImage'),
    setTransform: record(log, 'setTransform'),
    setLineDash: record(log, 'setLineDash'),
    beginPath: record(log, 'beginPath'),
    moveTo: record(log, 'moveTo'),
    lineTo: record(log, 'lineTo'),
    arc: record(log, 'arc'),
    fill: record(log, 'fill'),
    stroke: record(log, 'stroke'),
    translate: record(log, 'translate'),
    rotate: record(log, 'rotate'),
    clip: record(log, 'clip'),
    fillStyle: '',
    strokeStyle: '',
    font: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    globalAlpha: 1,
  };
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function () {
    return ctx as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  return { restore: () => (HTMLCanvasElement.prototype.getContext = original) };
}

function seededModel(): SurfaceModel {
  const model = emptySurface(infiniteFrame());
  model.objects['obj-1'] = {
    id: 'obj-1',
    type: 'froglight.text',
    x: 5,
    y: 5,
    text: 'board label',
  };
  model.objects['obj-2'] = {
    id: 'obj-2',
    type: 'froglight.text',
    x: 60,
    y: 60,
    text: 'second',
  };
  model.order.push('obj-1', 'obj-2');
  return model;
}

function mountHeadless(model: SurfaceModel) {
  const provider = new WhiteboardDocumentEditorProvider();
  const session = { model, markDirty: () => undefined } as unknown as never;
  // A non-HTMLElement parent forces the headless fallback in any env.
  const handle = provider.createEditor({ session, parent: {} });
  return { handle, session };
}

describe('whiteboard headless revealAddress (resolve-only)', () => {
  it('returns true iff the object id exists', () => {
    const { handle } = mountHeadless(seededModel());
    try {
      expect(handle.revealAddress?.('obj-1')).toBe(true);
      expect(handle.revealAddress?.('obj-2')).toBe(true);
      expect(handle.revealAddress?.('missing')).toBe(false);
      expect(handle.revealAddress?.('')).toBe(false);
    } finally {
      handle.destroy();
    }
  });

  it('starts unfocused and reveal never takes focus', () => {
    const { handle } = mountHeadless(seededModel());
    try {
      expect(handle.hasFocus()).toBe(false);
      expect(handle.revealAddress?.('obj-1')).toBe(true);
      expect(handle.hasFocus()).toBe(false);
      expect(handle.revealAddress?.('missing')).toBe(false);
      expect(handle.hasFocus()).toBe(false);
    } finally {
      handle.destroy();
    }
  });

  it('tracks focus like the headless blockpage handle', () => {
    const { handle } = mountHeadless(seededModel());
    try {
      expect(handle.hasFocus()).toBe(false);
      handle.focus();
      expect(handle.hasFocus()).toBe(true);
      handle.destroy();
      expect(handle.hasFocus()).toBe(false);
    } finally {
      handle.destroy();
    }
  });

  it('never marks dirty, rejects non-string addresses, stays silent after destroy', () => {
    let dirtyCalls = 0;
    const provider = new WhiteboardDocumentEditorProvider();
    const model = seededModel();
    const session = {
      model,
      markDirty: () => {
        dirtyCalls += 1;
      },
    } as unknown as never;
    const handle = provider.createEditor({ session, parent: {} });
    try {
      expect(handle.revealAddress?.('obj-1')).toBe(true);
      expect(handle.revealAddress?.('missing')).toBe(false);
      for (const bad of [42, null, undefined, {}, []] as unknown[]) {
        expect(handle.revealAddress?.(bad as string)).toBe(false);
      }
      expect(dirtyCalls).toBe(0);
      expect(model.order).toEqual(['obj-1', 'obj-2']);
      handle.destroy();
      expect(handle.revealAddress?.('obj-1')).toBe(false);
      expect(handle.hasFocus()).toBe(false);
      expect(dirtyCalls).toBe(0);
    } finally {
      handle.destroy();
    }
  });
});

describe('whiteboard canvas revealAddress (select exact object)', () => {
  it('selects the exact object and returns true on hit', () => {
    const stub = installCanvasStub();
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const model = seededModel();
    const session = { model, markDirty: () => undefined } as unknown as never;
    const handle = new WhiteboardDocumentEditorProvider().createEditor({
      session,
      parent,
    });
    try {
      expect(handle.revealAddress?.('obj-2')).toBe(true);
      const selected = (
        handle as unknown as {
          getSelectionIdsForTest?: () => readonly string[];
        }
      ).getSelectionIdsForTest?.();
      expect(selected ?? handle.tools!.snapshot()).toContain('obj-2');
      // Canonical bytes untouched by the ephemeral selection.
      expect(model.order).toEqual(['obj-1', 'obj-2']);
      expect(Object.keys(model.objects).sort()).toEqual(['obj-1', 'obj-2']);
    } finally {
      handle.destroy();
      parent.remove();
      stub.restore();
      document.body.replaceChildren();
    }
  });

  it('returns false on unknown addresses without moving selection', () => {
    const stub = installCanvasStub();
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const model = seededModel();
    const session = { model, markDirty: () => undefined } as unknown as never;
    const handle = new WhiteboardDocumentEditorProvider().createEditor({
      session,
      parent,
    });
    try {
      const selectedOf = (h: unknown): readonly string[] =>
        (
          h as {
            getSelectionIdsForTest?: () => readonly string[];
          }
        ).getSelectionIdsForTest?.() ?? [];
      const before = [...selectedOf(handle)];
      expect(handle.revealAddress?.('missing')).toBe(false);
      expect(handle.revealAddress?.('')).toBe(false);
      expect([...selectedOf(handle)]).toEqual(before);
      expect(model.order).toEqual(['obj-1', 'obj-2']);
    } finally {
      handle.destroy();
      parent.remove();
      stub.restore();
      document.body.replaceChildren();
    }
  });

  it('is focus-neutral and never marks dirty', () => {
    const stub = installCanvasStub();
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const model = seededModel();
    let dirtyCalls = 0;
    const session = {
      model,
      markDirty: () => {
        dirtyCalls += 1;
      },
    } as unknown as never;
    const handle = new WhiteboardDocumentEditorProvider().createEditor({
      session,
      parent,
    });
    try {
      expect(handle.hasFocus()).toBe(false);
      expect(handle.revealAddress?.('obj-1')).toBe(true);
      expect(handle.hasFocus()).toBe(false);
      expect(dirtyCalls).toBe(0);
      expect(handle.revealAddress?.('missing')).toBe(false);
      expect(handle.hasFocus()).toBe(false);
      expect(dirtyCalls).toBe(0);
      expect(model.order).toEqual(['obj-1', 'obj-2']);
    } finally {
      handle.destroy();
      parent.remove();
      stub.restore();
      document.body.replaceChildren();
    }
  });

  it('rejects non-string addresses and stays silent after destroy', () => {
    const stub = installCanvasStub();
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const model = seededModel();
    let dirtyCalls = 0;
    const session = {
      model,
      markDirty: () => {
        dirtyCalls += 1;
      },
    } as unknown as never;
    const handle = new WhiteboardDocumentEditorProvider().createEditor({
      session,
      parent,
    });
    try {
      for (const bad of [42, null, undefined, {}, []] as unknown[]) {
        expect(handle.revealAddress?.(bad as string)).toBe(false);
      }
      expect(dirtyCalls).toBe(0);
      handle.destroy();
      expect(handle.revealAddress?.('obj-1')).toBe(false);
      expect(handle.revealAddress?.('missing')).toBe(false);
      expect(dirtyCalls).toBe(0);
    } finally {
      handle.destroy();
      parent.remove();
      stub.restore();
      document.body.replaceChildren();
    }
  });
});
