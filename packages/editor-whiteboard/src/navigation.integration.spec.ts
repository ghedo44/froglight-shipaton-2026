/// <reference types="node" />
// @vitest-environment jsdom
/**
 * Whiteboard navigation integration.
 *
 * Whiteboard owns no viewport code: it mounts the shared Ink surface over
 * an infinite frame (`navigationMode: 'standalone'`). These tests prove the
 * toolbar zoom/fit cluster routes to the inherited engine (`setZoomFactor`/
 * `fitToView`), that Card authoring is unaffected by navigation, and that
 * no pager/notebook seam leaks into the whiteboard mount.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  emptySurface,
  infiniteFrame,
  type SurfaceModel,
} from '@froglight/foundation';
import { installCanvasStub } from '@froglight/foundation/testing';
import { WhiteboardDocumentEditorProvider } from './editor.js';

type BoardHandle = ReturnType<WhiteboardDocumentEditorProvider['createEditor']>;

describe('whiteboard navigation integration', () => {
  let restoreCanvas: (() => void) | null = null;

  beforeEach(() => {
    restoreCanvas = installCanvasStub();
  });

  afterEach(() => {
    restoreCanvas?.();
    restoreCanvas = null;
    document.body.replaceChildren();
  });

  function mount(model?: SurfaceModel): {
    handle: BoardHandle;
    model: SurfaceModel;
    canonicalBefore: string;
    dirtyCount: () => number;
  } {
    const surface = model ?? emptySurface(infiniteFrame());
    const canonicalBefore = JSON.stringify(surface);
    let dirty = 0;
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const handle = new WhiteboardDocumentEditorProvider().createEditor({
      session: {
        model: surface,
        markDirty: () => {
          dirty += 1;
        },
      } as never,
      parent,
    });
    return { handle, model: surface, canonicalBefore, dirtyCount: () => dirty };
  }

  function zoomPercent(handle: BoardHandle): number {
    const tools = handle.tools;
    if (tools === undefined) throw new Error('expected whiteboard tools');
    const zoom = tools
      .snapshot()
      .controls.find(
        (control) => (control as { id: string }).id === 'whiteboard.zoom',
      );
    return (zoom as { value: number }).value;
  }

  function expectEphemeral(board: {
    model: SurfaceModel;
    canonicalBefore: string;
    dirtyCount: () => number;
    handle: BoardHandle;
  }): void {
    expect(JSON.stringify(board.model)).toBe(board.canonicalBefore);
    expect(board.dirtyCount()).toBe(0);
    expect(board.handle.canExecCommand?.('undo')).toBe(false);
    expect(board.handle.canExecCommand?.('redo')).toBe(false);
  }

  function pointer(
    type: string,
    id: number,
    x: number,
    y: number,
  ): PointerEvent {
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

  it('routes the full zoom cluster through the inherited setZoomFactor', () => {
    const board = mount();
    try {
      const tools = board.handle.tools;
      if (tools === undefined) throw new Error('expected whiteboard tools');
      expect(zoomPercent(board.handle)).toBe(100);

      // Step buttons scale around the inherited engine factor (1.2x).
      expect(tools.execute('whiteboard.zoom-in')).toBe(true);
      expect(zoomPercent(board.handle)).toBe(120);
      expect(tools.execute('whiteboard.zoom-out')).toBe(true);
      expect(zoomPercent(board.handle)).toBe(100);

      // Absolute entries convert percent to factor through the same seam.
      expect(tools.execute('whiteboard.zoom-slider', '150')).toBe(true);
      expect(zoomPercent(board.handle)).toBe(150);
      expect(tools.execute('whiteboard.zoom', '200')).toBe(true);
      expect(zoomPercent(board.handle)).toBe(200);

      // Reset returns to 100% without touching canonical state.
      expect(tools.execute('whiteboard.zoom-reset')).toBe(true);
      expect(zoomPercent(board.handle)).toBe(100);
      expectEphemeral(board);
    } finally {
      board.handle.destroy();
    }
  });

  it('rejects non-finite zoom input without touching the camera', () => {
    const board = mount();
    try {
      const tools = board.handle.tools;
      if (tools === undefined) throw new Error('expected whiteboard tools');
      expect(tools.execute('whiteboard.zoom-slider', '150')).toBe(true);
      expect(tools.execute('whiteboard.zoom', 'NaN')).toBe(false);
      expect(tools.execute('whiteboard.zoom-slider', 'Infinity')).toBe(false);
      expect(tools.execute('whiteboard.zoom', '-50')).toBe(false);
      expect(zoomPercent(board.handle)).toBe(150);
      expectEphemeral(board);
    } finally {
      board.handle.destroy();
    }
  });

  it('routes fit through the inherited fit and keeps card authoring intact', async () => {
    const board = mount();
    try {
      const tools = board.handle.tools;
      if (tools === undefined) throw new Error('expected whiteboard tools');
      expect(tools.execute('whiteboard.zoom-slider', '150')).toBe(true);
      expect(tools.execute('whiteboard.fit')).toBe(true);
      expect(zoomPercent(board.handle)).toBe(150);

      // Card (the sole whiteboard-specific draw tool) commits normally
      // after navigation ops: zoom/fit never disturb tool routing.
      expect(tools.execute('whiteboard.tool.card')).toBe(true);
      const canvas = document.querySelector('canvas');
      if (canvas === null) throw new Error('expected mounted canvas');
      canvas.dispatchEvent(pointer('pointerdown', 1, 100, 100));
      canvas.dispatchEvent(pointer('pointermove', 1, 300, 220));
      canvas.dispatchEvent(pointer('pointerup', 1, 300, 220));
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve(undefined)),
      );
      expect(board.model.order).toHaveLength(1);
      expect(
        board.model.objects[board.model.order[0]!] as unknown as Record<
          string,
          unknown
        >,
      ).toMatchObject({ type: 'froglight.card', text: 'New card' });
    } finally {
      board.handle.destroy();
    }
  });

  it('owns wheel navigation locally in standalone mode (no pager seam)', () => {
    const board = mount();
    try {
      const canvas = document.querySelector('canvas');
      if (canvas === null) throw new Error('expected mounted canvas');
      // Standalone mounts own the wheel: ctrl-wheel preventDefaults
      // and zooms the local camera. An embedded/pager mount would forward
      // to the pager preview path instead of zooming locally.
      const event = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: -120,
        ctrlKey: true,
        clientX: 400,
        clientY: 300,
      });
      canvas.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(zoomPercent(board.handle)).toBeGreaterThan(100);
      expectEphemeral(board);
    } finally {
      board.handle.destroy();
    }
  });

  it('declares no pager/notebook seam and no viewport fork in its wiring', () => {
    // Resolved from the repository layout (cwd is the workspace root under
    // both `pnpm --filter` and `nx run`; the package-dir form covers direct
    // `vitest` invocations from inside the package).
    const candidates = [
      'packages/editor-whiteboard/src/editor.ts',
      'src/editor.ts',
    ];
    const found = candidates
      .map((candidate) => resolve(process.cwd(), candidate))
      .find((path) => existsSync(path));
    if (found === undefined)
      throw new Error('unable to locate whiteboard editor.ts');
    const source = readFileSync(found, 'utf8');
    // Whiteboard mounts the shared engine instead of forking it: the only
    // surface import is the Ink mount seam, never a notebook or pager
    // module (prose may reference sibling editors; seams are imports).
    expect(source).toContain('mountInkSurface');
    expect(source).toContain("navigationMode: 'standalone'");
    expect(source).not.toMatch(/from\s+['"][^'"]*(pager|notebook)[^'"]*['"]/i);
    expect(source).not.toMatch(/require\(\s*['"][^'"]*(pager|notebook)/i);
    // No local zoom/viewport/camera/physics engine: camera math identifiers
    // from the Ink engine must not be redefined in whiteboard wiring.
    expect(source).not.toMatch(
      /elasticZoom|boundedCamera|fitCameraToFrame|zoomCameraAroundPoint|rubberBand|stepSpring|stepDecay/,
    );
  });
});
