/**
 * Text-overlay replaceability proof.
 *
 * The replaceable-provider rule: the same text edit through the
 * production overlay path and through a headless/mock path must produce
 * identical canonical bytes via the same `session.save()` flow, and the
 * saved bytes must reopen to the same model. Unknown members survive
 * both paths verbatim; legacy fixtures open on both.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  WorkspaceServiceImpl,
  InMemoryDocumentRegistry,
  InMemoryMetadataService,
  InMemoryRelationshipService,
  InMemorySearchService,
  VaultRevisionService,
  createMemoryVault,
  workspacePath,
  inkPageKind,
  inkPageKindId,
  encodeSurfacePayload,
  boundedFrame,
  emptySurface,
  textObject,
  type SurfaceModel,
} from '@froglight/foundation';
import {
  mountInkSurface,
  type InkSkeleton,
} from '../index.js';
import { HeadlessInkEditorHandle } from '../editor.js';
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

function makeWorkspace() {
  const { vault } = createMemoryVault();
  const registry = new InMemoryDocumentRegistry();
  registry.register(inkPageKind);
  const metadata = new InMemoryMetadataService();
  const relationships = new InMemoryRelationshipService();
  const search = new InMemorySearchService();
  const revisions = new VaultRevisionService({ vault, resolveResource: () => undefined });
  const wsPromise = WorkspaceServiceImpl.create({
    vault,
    registry,
    metadata,
    relationships,
    revisions,
    search,
    workspaceId: 'ws-text-overlay-replaceability',
  });
  return { vault, wsPromise };
}

/** Initial model: one legacy text + one forward-compatible wrapped text. */
function initialModel(): SurfaceModel {
  const model = emptySurface(boundedFrame(800, 600));
  model.objects['legacy'] = {
    id: 'legacy',
    type: 'froglight.text',
    x: 50,
    y: 60,
    text: 'old',
  };
  model.order.push('legacy');
  const wrapped = textObject('wrapped', {
    x: 100,
    y: 120,
    text: 'line one\nline two',
  }) as unknown as Record<string, unknown>;
  // Forward-compatible unknown members (verbatim preservation proof).
  wrapped['appearance'] = { align: 'center', wrapWidth: 200 };
  wrapped['role'] = 'heading';
  wrapped['customFuture'] = 'keep-me';
  model.objects['wrapped'] = wrapped as unknown as SurfaceModel['objects'][string];
  model.order.push('wrapped');
  return model;
}

const EDIT_TEXT = 'edited via overlay path';

let restoreCanvas: (() => void) | null = null;

beforeEach(() => {
  restoreCanvas?.();
  restoreCanvas = installCanvasStub();
  document.body.replaceChildren();
});

/** Apply the edit through the production overlay commit path. */
async function editViaProductionOverlay(model: SurfaceModel): Promise<void> {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const skeletonRef: { current: InkSkeleton | null } = { current: null };
  const root: Root = createRoot(parent);
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
  if (skeleton === null) throw new Error('skeleton failed to commit');
  let dirty = 0;
  const surface = mountInkSurface({
    model,
    markDirty: () => (dirty += 1),
    host: skeleton,
  });
  // Drive the real overlay: tap the wrapped text, replace, Ctrl+Enter.
  const camera = surface.camera();
  const view = {
    x: (100 - camera.x) * camera.zoom,
    y: (120 - camera.y) * camera.zoom,
  };
  const canvas = parent.querySelector('.fl-ink-canvas')!;
  const down = new MouseEvent('dblclick', {
    bubbles: true,
    cancelable: true,
    clientX: view.x,
    clientY: view.y,
    button: 0,
  }) as unknown as PointerEvent;
  Object.defineProperty(down, 'pointerId', { value: 1 });
  Object.defineProperty(down, 'pointerType', { value: 'mouse' });
  Object.defineProperty(down, 'pressure', { value: 0.5 });
  surface.setTool('froglight.ink.text');
  canvas.dispatchEvent(down);
  const area = parent.querySelector('textarea.fl-ink-text-input');
  if (area === null) throw new Error('expected the wrapped text to open a textarea');
  (area as HTMLTextAreaElement).value = EDIT_TEXT;
  area.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ctrlKey: true }),
  );
  expect(dirty).toBe(1);
  root.unmount();
  surface.destroy();
  parent.remove();
}

/** Apply the same edit through the headless/mock path (plain-data only). */
function editViaHeadless(model: SurfaceModel, markDirty: () => void): void {
  // The mock never touches unknown payloads: it swaps only the text.
  const record = model.objects['wrapped'];
  if (record === undefined || record.type !== 'froglight.text') {
    throw new Error('expected wrapped text');
  }
  (record as unknown as Record<string, unknown>).text = EDIT_TEXT;
  markDirty();
  // The headless handle itself proves open/save/reopen without Canvas 2D.
  const handle = new HeadlessInkEditorHandle({ markDirty });
  expect(handle.hasFocus()).toBe(true);
  handle.destroy();
}

describe('text overlay replaceability', () => {
  it('production overlay and headless edits save identical canonical bytes', async () => {
    async function run(
      edit: (model: SurfaceModel, markDirty: () => void) => void | Promise<void>,
      name: string,
    ): Promise<Uint8Array> {
      const { vault, wsPromise } = makeWorkspace();
      const ws = await wsPromise;
      const created = await ws.createDocument({
        kindId: inkPageKindId,
        path: workspacePath(`overlay-${name}.ink`),
        initialModel: initialModel(),
      });
      const session = (await ws.openDocument(
        created.documentId as never,
      )) as unknown as {
        model: SurfaceModel;
        markDirty(): void;
        save(): Promise<{ committed: boolean }>;
        close(): Promise<void>;
      };
      await edit(session.model, () => session.markDirty());
      const result = await session.save();
      expect(result.committed).toBe(true);
      const bytes = await vault.read(workspacePath(`overlay-${name}.ink`));
      // Reopen from canonical bytes: both texts present, unknowns kept.
      const reopened = (await ws.openDocument(created.documentId as never)) as unknown as {
        model: SurfaceModel;
        close(): Promise<void>;
      };
      expect(reopened.model.objects['wrapped']!.text).toBe(EDIT_TEXT);
      expect(reopened.model.objects['legacy']!.text).toBe('old');
      expect(
        (reopened.model.objects['wrapped']! as unknown as Record<string, unknown>)
          .customFuture,
      ).toBe('keep-me');
      await session.close();
      await reopened.close();
      await ws.dispose();
      return bytes.slice();
    }

    const viaOverlay = await run(
      (model) => editViaProductionOverlay(model),
      'overlay',
    );
    const viaHeadless = await run(
      (model, markDirty) => editViaHeadless(model, markDirty),
      'headless',
    );
    expect(viaOverlay.length).toBe(viaHeadless.length);
    expect(
      viaOverlay.every((byte, index) => byte === viaHeadless[index]),
    ).toBe(true);
    // And both equal a direct re-encode of the edited model.
    const expected = initialModel();
    (expected.objects['wrapped']! as unknown as Record<string, unknown>).text =
      EDIT_TEXT;
    const reencoded = encodeSurfacePayload(expected);
    expect(viaOverlay.length).toBe(reencoded.length);
    expect(viaOverlay.every((byte, index) => byte === reencoded[index])).toBe(
      true,
    );
  });
});
