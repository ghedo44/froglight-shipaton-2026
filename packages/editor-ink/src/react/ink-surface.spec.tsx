// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  boundedFrame,
  emptySurface,
  type SurfaceModel,
} from '@froglight/foundation';
import {
  HeadlessInkEditorHandle,
  InkDocumentEditorProvider,
  mountInkSurface,
} from '../index.js';
import {
  InkSurfaceSkeleton,
  type InkSkeleton,
} from './InkSurfaceSkeleton.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function installCanvasStub(): () => void {
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function () {
    return {
      fillRect() {
        return undefined;
      },
    } as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  return () => (HTMLCanvasElement.prototype.getContext = original);
}

function makeSession(): {
  model: SurfaceModel;
  session: { model: SurfaceModel; markDirty(): void; dirtyCount: number };
} {
  const model = emptySurface(boundedFrame(800, 600));
  const session = {
    model,
    dirtyCount: 0,
    markDirty() {
      this.dirtyCount += 1;
    },
  };
  return { model, session };
}

let restoreCanvas: (() => void) | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  restoreCanvas?.();
  restoreCanvas = installCanvasStub();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  restoreCanvas?.();
  restoreCanvas = null;
});

describe('ink surface skeleton (React chrome)', () => {
  it('commits the identical skeleton structure with refs populated', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const skeletonRef: { current: InkSkeleton | null } = { current: null };
    await act(async () => {
      root!.render(
        createElement(InkSurfaceSkeleton, {
          presentation: 'paint-stage',
          navigationMode: 'standalone',
          skeletonRef,
        }),
      );
    });
    const skeleton = skeletonRef.current;
    expect(skeleton).not.toBeNull();
    expect(skeleton!.root.className).toBe('fl-ink-root');
    expect(skeleton!.root.dataset.presentation).toBe('paint-stage');
    expect(skeleton!.root.dataset.navigation).toBe('standalone');
    expect(skeleton!.root.tabIndex).toBe(0);
    expect(skeleton!.page.className).toBe('fl-ink-page');
    expect(skeleton!.canvas.className).toBe('fl-ink-canvas');
    expect(skeleton!.badge.className).toBe('fl-ink-badge');
    expect(skeleton!.page.contains(skeleton!.canvas)).toBe(true);
    expect(skeleton!.page.contains(skeleton!.badge)).toBe(true);
    // the React-owned overlay container commits with the skeleton.
    expect(skeleton!.overlayRoot?.className).toBe('fl-ink-text-overlay-root');
    expect(skeleton!.page.contains(skeleton!.overlayRoot!)).toBe(true);
    // The root hosts the focused text input while editing, so it must stay
    // exposed to assistive technology. Decorative pointer chrome is hidden
    // on its own sibling instead.
    expect(skeleton!.overlayRoot?.hasAttribute('aria-hidden')).toBe(false);
    expect(skeleton!.root.contains(skeleton!.page)).toBe(true);
  });

  it('provider creation synchronously commits chrome the engine consumes', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { session } = makeSession();
    const provider = new InkDocumentEditorProvider();
    let handle: ReturnType<InkDocumentEditorProvider['createEditor']>;
    await act(async () => {
      handle = provider.createEditor({ session, parent });
    });
    // No extra flush: the canvas the engine draws into exists immediately,
    // preserving the synchronous createEditor contract.
    const canvas = parent.querySelector('.fl-ink-canvas');
    expect(canvas).not.toBeNull();
    expect(handle!.tools).toBeDefined();
    expect(handle!.execCommand('undo')).toBe(false);
    handle!.destroy();
    expect(parent.querySelector('canvas')).toBeNull();
    parent.remove();
  });

  it('engine attaches to React-committed refs with identical semantics', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const skeletonRef: { current: InkSkeleton | null } = { current: null };
    await act(async () => {
      root!.render(
        createElement(InkSurfaceSkeleton, {
          presentation: 'paint-stage',
          navigationMode: 'standalone',
          skeletonRef,
        }),
      );
    });
    const { session } = makeSession();
    const surface = mountInkSurface({
      model: session.model,
      markDirty: () => session.markDirty(),
      host: skeletonRef.current!,
    });
    expect(surface.root).toBe(skeletonRef.current!.root);
    expect(surface.canUndo()).toBe(false);
    const initialTool = surface.activeToolId();
    surface.setTool(initialTool);
    expect(surface.activeToolId()).toBe(initialTool);
    // Unmount the React owner before engine teardown: same order the
    // provider uses, so no React-managed node is yanked mid-teardown.
    act(() => root?.unmount());
    root = null;
    surface.destroy();
    expect(host.querySelector('canvas')).toBeNull();
  });

  it('falls back to the headless handle without a 2D context', () => {
    restoreCanvas?.();
    restoreCanvas = null;
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { session } = makeSession();
    const handle = new InkDocumentEditorProvider().createEditor({
      session,
      parent,
    });
    expect(handle).toBeInstanceOf(HeadlessInkEditorHandle);
    expect(parent.querySelector('canvas')).toBeNull();
    expect(handle.execCommand('undo')).toBe(false);
    handle.destroy();
    parent.remove();
  });
});
