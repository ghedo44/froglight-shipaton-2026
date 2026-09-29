import { expect, it } from 'vitest';
import { DocumentSessionImpl } from './session.js';
import { createMemoryVault } from './vault/memory.js';
import { documentId, resourceId } from './identity.js';
import { workspacePath } from './paths.js';
import { checksumOf } from './revisions.js';
import { whiteboardKind } from './whiteboard/kind.js';
import { inkStrokeObject, type SurfaceModel } from './surfaces/model.js';
import { FroglightError } from './errors.js';
import {
  applySurfaceDocumentDelta,
  type DocumentPersistence,
} from './surface-persistence.js';

async function fixture(
  options: {
    commitGate?: Promise<void>;
    failCommit?: () => boolean;
    failAck?: boolean;
  } = {},
) {
  const { vault } = createMemoryVault();
  const path = workspacePath('drawing.whiteboard');
  const ref = {
    documentId: documentId('journal'),
    kindId: whiteboardKind.id,
    location: { resourceId: resourceId('drawing') },
  };
  const initial = whiteboardKind.creation!.createInitialModel('Drawing');
  const data = whiteboardKind.encode(initial, ref);
  await vault.write(path, data);
  let mirror = whiteboardKind.decode(data, ref).model;
  let durable = 0,
    attempts = 0,
    disposed = false;
  const persistence: DocumentPersistence = {
    open: async () => ({
      sequence: durable,
      publishedSequence: 0,
      baseChecksum: checksumOf(data),
    }),
    reset: async (bytes, sequence) => {
      mirror = whiteboardKind.decode(bytes, ref).model;
      durable = sequence;
      return {
        sequence,
        publishedSequence: sequence,
        baseChecksum: checksumOf(bytes),
      };
    },
    commit: async (sequence, delta) => {
      if (++attempts === 1) await options.commitGate;
      if (options.failCommit?.())
        throw new FroglightError('QUOTA_EXCEEDED', 'Journal quota');
      mirror = applySurfaceDocumentDelta(mirror, delta, false) as SurfaceModel;
      durable = sequence;
    },
    snapshot: async () => {
      const bytes = whiteboardKind.encode(mirror, ref);
      return { sequence: durable, data: bytes, checksum: checksumOf(bytes) };
    },
    published: async () => {
      if (options.failAck)
        throw new FroglightError('IO', 'Acknowledgement stopped');
    },
    rebase: async () => undefined,
    dispose: () => {
      disposed = true;
    },
  };
  const session = new DocumentSessionImpl({
    ref,
    kind: whiteboardKind,
    vault,
    persistence,
    revisions: null,
    resolveResourcePath: () => path,
  });
  await session.open();
  const stroke = (id: string) => {
    session.model.objects[id] = inkStrokeObject(id, {
      points: [{ x: 1, y: 2, pressure: 0.5 }],
      width: 2,
    });
    session.model.order.push(id);
    session.markDirty();
  };
  return {
    session,
    stroke,
    vault,
    path,
    durable: () => durable,
    disposed: () => disposed,
  };
}

it('close drains edits queued behind an admitted journal transaction before disposing its owner', async () => {
  let release!: () => void;
  const state = await fixture({
    commitGate: new Promise<void>((resolve) => {
      release = resolve;
    }),
  });
  state.stroke('a');
  await Promise.resolve();
  state.stroke('b');
  await Promise.resolve();
  const sequence = state.session.editedSeq;
  const closing = state.session.close();
  expect(state.disposed()).toBe(false);
  release();
  await closing;
  expect(state.durable()).toBe(sequence);
  expect(state.disposed()).toBe(true);
});

it('a journal quota failure retains the batch and a save retry protects every edit', async () => {
  let failing = true;
  const state = await fixture({ failCommit: () => failing });
  state.stroke('a');
  expect((await state.session.save()).error).toMatchObject({
    code: 'QUOTA_EXCEEDED',
  });
  expect(state.session.canRetrySave).toBe(true);
  state.stroke('b');
  failing = false;
  expect((await state.session.save()).committed).toBe(true);
  const model = whiteboardKind.decode(
    await state.vault.read(state.path),
    state.session.document,
  ).model;
  expect(model.order).toEqual(['a', 'b']);
  expect(state.session.durableSeq).toBe(state.session.editedSeq);
  await state.session.close();
});

it('a lost local publication acknowledgement remains a visible derived failure', async () => {
  const state = await fixture({ failAck: true });
  state.stroke('a');
  const result = await state.session.save();
  expect(result.committed).toBe(true);
  expect(result.derivedError).toMatchObject({ code: 'IO' });
  expect(state.session.lastDerivedError).toBe(result.derivedError);
  expect(state.session.persistenceError).toBe(result.derivedError);
  await state.session.close();
});

it('save and close wait for an accepted erasure and capture only its prepared transaction', async () => {
  const {
    InkToolController,
    createDefaultSurfaceToolRegistry,
    SURFACE_TOOL_IDS,
  } = await import('./surfaces/tools.js');
  const { InkPresetStore } = await import('./surfaces/ink/presets.js');
  const { createDefaultSurfaceObjectTypeRegistry } = await import(
    './surfaces/objects.js'
  );
  const { createTestErasurePreparation } = await import(
    './testing/erasure-preparation.js'
  );
  const state = await fixture();
  state.session.model.objects.s = inkStrokeObject('s', {
    points: [
      { x: 0, y: 50 },
      { x: 100, y: 50 },
    ],
    width: 5,
  });
  state.session.model.order.push('s');
  state.session.markDirty();
  expect((await state.session.save()).committed).toBe(true);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const preparation = createTestErasurePreparation();
  const presets = new InkPresetStore();
  presets.setEraser({ mode: 'precision', radius: 5 });
  const controller = new InkToolController({
    model: state.session.model,
    objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
    toolRegistry: createDefaultSurfaceToolRegistry({ presets }),
    erasurePreparation: {
      ...preparation,
      finish: async (job) => {
        await gate;
        return preparation.finish(job);
      },
    },
    onMutate: () => state.session.markDirty(),
  });
  controller.setTool(SURFACE_TOOL_IDS.eraser);
  controller.pointerDown({ point: { x: 50, y: 30 } });
  controller.pointerMove({ point: { x: 50, y: 70 } });
  controller.pointerUp({ point: { x: 50, y: 70 } });
  let saved = false;
  const saving = state.session.save().then((result) => {
    saved = true;
    return result;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(saved).toBe(false);
  expect(state.disposed()).toBe(false);
  release();
  expect((await saving).committed).toBe(true);
  const reopened = whiteboardKind.decode(await state.vault.read(state.path), {
    documentId: documentId('journal'),
    kindId: whiteboardKind.id,
    location: { resourceId: resourceId('drawing') },
  }).model;
  expect(reopened.order).toHaveLength(2);
  expect(
    Object.values(reopened.objects).filter(
      (r) => r.type === 'froglight.ink.source',
    ),
  ).toHaveLength(1);
  await state.session.close();
  expect(state.disposed()).toBe(true);
  controller.destroy();
});
