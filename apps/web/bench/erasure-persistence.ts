import { createWorkerPersistence } from '@froglight/provider-opfs/persistence';
import {
  DocumentRecoveryError,
  appendPage,
  infiniteFrame,
  boundedFrame,
  emptyNotebook,
  emptySurface,
  notebookPage,
  notebookKind,
  whiteboardKind,
  inkPageKind,
  inkStrokeObject,
  InkToolController,
  InkPresetStore,
  createDefaultSurfaceToolRegistry,
  createDefaultSurfaceObjectTypeRegistry,
  SURFACE_TOOL_IDS,
  SurfaceDeltaCollector,
  type SurfaceModel,
  type SurfaceDocumentDelta,
  type DocumentKindDescriptor,
} from '@froglight/foundation';
import { createErasurePreparation } from '@froglight/editor-ink';

/** Actual worker + IndexedDB admission/restart coverage, using disposable test identities. */
export async function runErasurePersistence(): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const kind of [
    inkPageKind,
    whiteboardKind,
    notebookKind,
  ] as DocumentKindDescriptor[]) {
    const surface = emptySurface(
      kind.id === whiteboardKind.id ? infiniteFrame() : boundedFrame(1000, 800),
    );
    surface.objects.s = inkStrokeObject('s', {
      points: Array.from({ length: 1000 }, (_, x) => ({
        x,
        y: 50,
        pressure: 0.6,
        dt: x,
      })),
      width: 8,
      brush: { kind: 'highlighter' },
      opacity: 0.3,
    });
    surface.order.push('s');
    const notebook = emptyNotebook();
    appendPage(notebook, notebookPage('page', { surface }));
    const model = kind.id === notebookKind.id ? notebook : surface;
    const ref = {
      documentId: `precision-${kind.id}`,
      kindId: kind.id,
      location: { resourceId: `precision-${kind.id}` },
    };
    const seed = kind.encode(model, ref);
    let worker = createWorkerPersistence();
    let persistence = worker.factory('precision-disposable', ref, kind)!;
    await persistence.open(seed);
    const collector = new SurfaceDeltaCollector(
      model,
      kind.id === notebookKind.id,
    );
    collector.seed();
    const presets = new InkPresetStore();
    presets.setEraser({ mode: 'precision', radius: 8 });
    const controller = new InkToolController({
      model: surface,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      toolRegistry: createDefaultSurfaceToolRegistry({ presets }),
      erasurePreparation: createErasurePreparation(),
    });
    controller.setTool(SURFACE_TOOL_IDS.eraser);
    let sequence = 0;
    for (const x of [200, 400, 600, 800, 100, 300]) {
      controller.pointerDown({ point: { x, y: 30 } });
      controller.pointerMove({ point: { x, y: 70 } });
      controller.pointerUp({ point: { x, y: 70 } });
      await controller.drainErasure();
      const delta = collector.take();
      await persistence.commit(++sequence, delta);
      // A repeat acknowledgement must not apply order edits twice.
      await persistence.commit(sequence, delta);
    }
    const saved = await persistence.snapshot(sequence);
    const before = kind.decode(saved.data, ref).model;
    const envelope = collector.take();
    const draft: SurfaceDocumentDelta = {
      shell: envelope.shell,
      surfaces: [
        {
          pageId: kind.id === notebookKind.id ? 'page' : null,
          order: [],
          shell: envelope.surfaces[0]!.shell,
          objects: { s: { ...surface.objects.s!, sourceId: 'missing' } },
        },
      ],
    };
    let rejected = false;
    try {
      await persistence.commit(sequence + 1, draft);
    } catch {
      rejected = true;
    }
    if (!rejected)
      throw new Error('Invalid reference was durably acknowledged');
    const unchanged = await persistence.snapshot(sequence);
    if (
      JSON.stringify(kind.decode(unchanged.data, ref).model) !==
      JSON.stringify(before)
    )
      throw new Error('Rejected edit mutated persistence mirror');
    // Terminate the actual owner; retain its IndexedDB checkpoint and unpublished journal.
    worker.dispose();
    worker = createWorkerPersistence();
    persistence = worker.factory('precision-disposable', ref, kind)!;
    const recovered = await persistence.open(seed);
    if (
      recovered.sequence !== sequence ||
      recovered.recoveredData === undefined
    )
      throw new Error('Unpublished erasure journal did not recover');
    const reopened = kind.decode(recovered.recoveredData, ref).model as
      | SurfaceModel
      | typeof notebook;
    const reopenedSurface =
      'objects' in reopened
        ? reopened
        : (
            reopened.pages.page as ReturnType<typeof notebookPage> & {
              surface: SurfaceModel;
            }
          ).surface;
    if (reopenedSurface.order.length !== 7)
      throw new Error('Fragment paint order lost during cold recovery');
    const sources = Object.values(reopenedSurface.objects).filter(
      (r) => r.type === 'froglight.ink.source',
    );
    const samples = sources.reduce(
      (n, r) =>
        n +
        (r.chunks as { points: unknown[] }[]).reduce(
          (n, c) => n + c.points.length,
          0,
        ),
      0,
    );
    if (samples !== 1000 || sources.length !== 1)
      throw new Error('Source stream was amplified during persistence');
    // Corrupt only this disposable fixture's newest journal transaction. Opening
    // must offer a read-only last-valid export and leave every stored row intact.
    worker.dispose();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('froglight-persistence', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const key = JSON.stringify([
      'precision-disposable',
      ref.documentId,
      ref.location.resourceId,
    ]);
    const corruptHead = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        const request = db
          .transaction('records')
          .objectStore('records')
          .get(`${key}/head`);
        request.onsuccess = () =>
          resolve(request.result as Record<string, unknown>);
        request.onerror = () => reject(request.error);
      },
    );
    corruptHead.durableSeq = sequence + 1;
    corruptHead.journal = [sequence + 1];
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('records', 'readwrite'),
        store = transaction.objectStore('records');
      store.put(corruptHead, `${key}/head`);
      store.put(draft, `${key}/journal/${sequence + 1}`);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
    worker = createWorkerPersistence();
    persistence = worker.factory('precision-disposable', ref, kind)!;
    let failure: unknown;
    try {
      await persistence.open(seed);
    } catch (error) {
      failure = error;
    }
    if (
      !(failure instanceof DocumentRecoveryError) ||
      failure.recovery.sequence !== sequence
    )
      throw new Error('Missing explicit last-valid recovery export');
    if (
      JSON.stringify(kind.decode(failure.recovery.data, ref).model) !==
      JSON.stringify(before)
    )
      throw new Error('Recovery export lost last-valid erasure');
    const rows = await new Promise<unknown[]>((resolve, reject) => {
      const request = db.transaction('records').objectStore('records').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (
      !rows.some(
        (row) => JSON.stringify(row) === JSON.stringify(corruptHead),
      ) ||
      !rows.some((row) => JSON.stringify(row) === JSON.stringify(draft))
    )
      throw new Error('Failed recovery overwrote original material');
    db.close();
    result[kind.id] = saved.data.byteLength;
    collector.dispose();
    controller.destroy();
    worker.dispose();
  }
  return result;
}
