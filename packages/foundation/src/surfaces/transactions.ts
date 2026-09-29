import type { SurfaceModel } from './model.js';

/** A positional edit, with only the affected ids retained for inversion. */
export interface SurfaceOrderEdit {
  readonly index: number;
  readonly removed: readonly string[];
  readonly inserted: readonly string[];
}

interface Observer {
  order(edit: SurfaceOrderEdit): void;
  objects(ids: readonly string[]): void;
  draft?(
    id: string,
    record: import('./model.js').SurfaceObjectRecord | null,
  ): void;
}
const observers = new WeakMap<SurfaceModel, Set<Observer>>();
const installed = new WeakSet<string[]>();
const refinements = new WeakSet<SurfaceOrderEdit>();
export function isSurfaceRefinementOrderEdit(edit: SurfaceOrderEdit): boolean {
  return refinements.has(edit);
}
const buffered = new WeakMap<SurfaceModel, Array<() => void>>();
function deliver(model: SurfaceModel, event: () => void): void {
  const pending = buffered.get(model);
  if (pending !== undefined) pending.push(event);
  else event();
}
/** Buffer observers until every candidate replacement and history refinement succeeds. */
export function atomicSurfaceTransaction(
  model: SurfaceModel,
  ids: readonly string[],
  apply: () => void,
): void {
  if (buffered.has(model)) throw new Error('Nested Surface transaction');
  const before = new Map(ids.map((id) => [id, model.objects[id]]));
  const order = [...model.order];
  const events: Array<() => void> = [];
  buffered.set(model, events);
  try {
    apply();
  } catch (error) {
    for (const [id, record] of before) {
      if (record === undefined) delete model.objects[id];
      else model.objects[id] = record;
    }
    Array.prototype.splice.call(model.order, 0, model.order.length, ...order);
    throw error;
  } finally {
    buffered.delete(model);
  }
  let failure: unknown;
  for (const event of events)
    try {
      event();
    } catch (error) {
      failure ??= error;
    }
  if (failure !== undefined) throw failure;
}

function notifyObservers(
  model: SurfaceModel,
  action: (observer: Observer) => void,
): void {
  let failure: unknown;
  for (const observer of observers.get(model) ?? [])
    try {
      action(observer);
    } catch (error) {
      failure ??= error;
    }
  if (failure !== undefined) throw failure;
}

/** Observe explicit committed mutations; records and sample arrays remain plain values. */
export function observeSurfaceTransactions(
  model: SurfaceModel,
  observer: Observer,
): { dispose(): void } {
  let listeners = observers.get(model);
  if (listeners === undefined) observers.set(model, (listeners = new Set()));
  listeners.add(observer);
  const order = model.order;
  if (!installed.has(order)) {
    installed.add(order);
    Object.defineProperties(order, {
      push: {
        configurable: true,
        value: (...ids: string[]) => {
          const index = order.length;
          const length = Array.prototype.push.apply(order, ids);
          if (ids.length > 0) emit({ index, removed: [], inserted: ids });
          return length;
        },
      },
      splice: {
        configurable: true,
        value: (start: number, ...args: [number?, ...string[]]) => {
          const index =
            start < 0
              ? Math.max(0, order.length + start)
              : Math.min(start, order.length);
          const count =
            args.length === 0
              ? order.length - index
              : Math.max(0, Math.min(args[0] ?? 0, order.length - index));
          const inserted = args.slice(1) as string[];
          const removed = Array.prototype.splice.call(
            order,
            index,
            count,
            ...inserted,
          ) as string[];
          if (removed.length > 0 || inserted.length > 0)
            emit({ index, removed, inserted });
          return removed;
        },
      },
    });
  }
  function emit(edit: SurfaceOrderEdit): void {
    if (buffered.has(model)) refinements.add(edit);
    deliver(model, () =>
      notifyObservers(model, (listener) => listener.order(edit)),
    );
  }
  return {
    dispose: () => {
      listeners.delete(observer);
    },
  };
}

export function publishSurfaceObjects(
  model: SurfaceModel,
  ids: readonly string[],
): void {
  deliver(model, () =>
    notifyObservers(model, (listener) => listener.objects(ids)),
  );
}

export function applySurfaceOrderEdits(
  order: string[],
  edits: readonly SurfaceOrderEdit[],
  inverse: boolean,
): void {
  if (inverse) {
    for (let i = edits.length - 1; i >= 0; i--) {
      const edit = edits[i]!;
      order.splice(edit.index, edit.inserted.length, ...edit.removed);
    }
  } else {
    for (const edit of edits)
      order.splice(edit.index, edit.removed.length, ...edit.inserted);
  }
}

export function hasSurfaceDraftObserver(model: SurfaceModel): boolean {
  return [...(observers.get(model) ?? [])].some(
    (observer) => observer.draft !== undefined,
  );
}
export function publishSurfaceDraft(
  model: SurfaceModel,
  id: string,
  record: import('./model.js').SurfaceObjectRecord | null,
): void {
  for (const observer of observers.get(model) ?? [])
    observer.draft?.(id, record);
}

/** Accepted asynchronous work is owned by the canonical surface, not a mounted view. */
const pendingWork = new WeakMap<SurfaceModel, Set<Promise<void>>>();
const workErrors = new WeakMap<SurfaceModel, unknown>();
export function ownSurfaceWork(model: SurfaceModel, work: Promise<void>): void {
  let pending = pendingWork.get(model);
  if (pending === undefined) pendingWork.set(model, (pending = new Set()));
  pending.add(work);
  void work.then(
    () => pending.delete(work),
    (error) => {
      workErrors.set(model, error);
      pending.delete(work);
    },
  );
}
export function clearSurfaceWorkError(model: SurfaceModel): void {
  workErrors.delete(model);
}
function documentSurfaces(model: unknown): SurfaceModel[] {
  if (typeof model !== 'object' || model === null) return [];
  const root = model as {
    objects?: unknown;
    pages?: Record<string, { kind: string; surface?: SurfaceModel }>;
  };
  if (root.objects !== undefined) return [model as SurfaceModel];
  return Object.values(root.pages ?? {}).flatMap((page) =>
    page.kind === 'page' && page.surface ? [page.surface] : [],
  );
}
export function hasSurfaceDocumentWork(model: unknown): boolean {
  return documentSurfaces(model).some(
    (surface) => (pendingWork.get(surface)?.size ?? 0) > 0,
  );
}
export async function drainSurfaceDocumentWork(model: unknown): Promise<void> {
  const surfaces = documentSurfaces(model);
  while (surfaces.some((surface) => (pendingWork.get(surface)?.size ?? 0) > 0))
    await Promise.all(
      surfaces.flatMap((surface) => [...(pendingWork.get(surface) ?? [])]),
    );
  for (const surface of surfaces)
    if (workErrors.has(surface)) throw workErrors.get(surface);
}

const workRetries = new WeakMap<SurfaceModel, () => void>();
export function registerSurfaceWorkRetry(
  model: SurfaceModel,
  retry: () => void,
): { dispose(): void } {
  workRetries.set(model, retry);
  return {
    dispose: () => {
      if (workRetries.get(model) === retry) workRetries.delete(model);
    },
  };
}
/** Explicit save retries preparation; background autosave only reports failures. */
export function retrySurfaceDocumentWork(model: unknown): void {
  for (const surface of documentSurfaces(model))
    if (workErrors.has(surface)) workRetries.get(surface)?.();
}
