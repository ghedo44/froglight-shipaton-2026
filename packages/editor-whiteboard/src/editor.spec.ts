// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { WhiteboardDocumentEditorProvider } from './editor.js';
import {
  emptySurface,
  infiniteFrame,
  whiteboardKindId,
  workspacePath,
  type DocumentAssetStore,
} from '@froglight/foundation';

type CtxLog = Array<[string, ...unknown[]]>;

/** Recording Canvas2D stub so the canvas handle path runs under jsdom. */
function installCanvasStub(): { log: CtxLog; restore: () => void } {
  const log: CtxLog = [];
  const record =
    (name: string) =>
    (...args: unknown[]) =>
      void log.push([name, ...args]);
  const ctx = {
    save: record('save'),
    restore: record('restore'),
    clearRect: record('clearRect'),
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    fillText: record('fillText'),
    drawImage: record('drawImage'),
    setTransform: record('setTransform'),
    setLineDash: record('setLineDash'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    arc: record('arc'),
    fill: record('fill'),
    stroke: record('stroke'),
    translate: record('translate'),
    rotate: record('rotate'),
    clip: record('clip'),
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
  return {
    log,
    restore: () => (HTMLCanvasElement.prototype.getContext = original),
  };
}

describe('whiteboard provider', () => {
  it('creates a headless editor when Canvas2D is unavailable', () => {
    const provider = new WhiteboardDocumentEditorProvider();
    expect(provider.kindIds).toContain(whiteboardKindId);
    const model = emptySurface(infiniteFrame());
    const session = { model, markDirty: () => undefined } as unknown as never;
    // In jsdom without real canvas, hasCanvas2d may still be true if jsdom provides canvas,
    // but we test headless path by passing a non-HTMLElement parent.
    const handle = provider.createEditor({ session, parent: {} });
    expect(handle).toBeDefined();
    expect(() => handle.focus()).not.toThrow();
    expect(handle.execCommand('undo')).toBe(false);
    handle.destroy();
  });

  it('creates a canvas editor when parent is HTMLElement and canvas is available', () => {
    const provider = new WhiteboardDocumentEditorProvider();
    const model = emptySurface(infiniteFrame());
    const session = { model, markDirty: () => undefined } as unknown as never;
    const parent = document.createElement('div');
    const handle = provider.createEditor({ session, parent });
    expect(handle).toBeDefined();
    handle.destroy();
  });
});

describe('whiteboard image support', () => {
  let canvasStub: ReturnType<typeof installCanvasStub>;

  beforeEach(() => {
    canvasStub?.restore();
    canvasStub = installCanvasStub();
  });

  function assets(): DocumentAssetStore {
    return {
      async put(bytes) {
        void bytes;
        return { path: workspacePath('attachments/x'), sha256: 'x' };
      },
      async read() {
        return new Uint8Array();
      },
    };
  }

  it('offers image insertion when an asset store is wired', () => {
    const model = emptySurface(infiniteFrame());
    const session = { model, markDirty: () => undefined } as unknown as never;
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = new WhiteboardDocumentEditorProvider().createEditor({
      session,
      parent,
      assets: assets(),
    });

    const control = handle
      .tools!.snapshot()
      .controls.find((entry) => 'id' in entry && entry.id === 'whiteboard.image');
    expect(control).toBeDefined();
    expect((control as { disabled?: boolean }).disabled).toBe(false);
    expect(handle.tools!.execute('whiteboard.image')).toBe(true);
    handle.destroy();
  });

  it('disables image insertion without an asset store', () => {
    const model = emptySurface(infiniteFrame());
    const session = { model, markDirty: () => undefined } as unknown as never;
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = new WhiteboardDocumentEditorProvider().createEditor({ session, parent });

    const control = handle
      .tools!.snapshot()
      .controls.find((entry) => 'id' in entry && entry.id === 'whiteboard.image');
    expect(control).toBeDefined();
    expect((control as { disabled?: boolean }).disabled).toBe(true);
    handle.destroy();
  });

  it('exposes one connector and a compact zoom-reset', () => {
    const model = emptySurface(infiniteFrame());
    const session = { model, markDirty: () => undefined } as unknown as never;
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const handle = new WhiteboardDocumentEditorProvider().createEditor({
      session,
      parent,
    });
    const ids = handle
      .tools!.snapshot()
      .controls.map((entry) => (entry as { id: string }).id);
    expect(ids).toContain('whiteboard.tool.line');
    expect(ids).not.toContain('whiteboard.tool.arrow');
    expect(ids).toContain('whiteboard.zoom-reset');
    expect(ids).toContain('whiteboard.zoom-out');
    expect(ids).toContain('whiteboard.zoom-in');
    expect(ids).toContain('whiteboard.fit');
    // Exact controls stay exposed but unplaced.
    expect(ids).toContain('whiteboard.zoom');
    expect(ids).toContain('whiteboard.zoom-slider');
    expect(handle.tools!.execute('whiteboard.zoom-slider', '150')).toBe(true);
    const reset = handle
      .tools!.snapshot()
      .controls.find((entry) => (entry as { id: string }).id === 'whiteboard.zoom-reset');
    expect((reset as { label: string }).label).toContain('150%');
    expect(handle.tools!.execute('whiteboard.zoom-reset')).toBe(true);
    handle.destroy();
  });
});
