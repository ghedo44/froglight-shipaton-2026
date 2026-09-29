import { inkSourceRetainedBytes } from '@froglight/foundation';
/**
 * Gesture-level provider-local history.
 *
 * Patch/command history: each entry contains ONLY what the gesture
 * changed (object before/after records with absent markers, order
 * positional edits, frame before/after). A normal new pen stroke undoes by
 * removing the newly-created stroke/logical chunks and redoes by
 * restoring them at their paint positions — pre-existing strokes are
 * never copied. Full-document JSON snapshots are never taken.
 */

import type { SurfaceModel, SurfaceObjectRecord } from '@froglight/foundation';
import {
  FroglightError,
  isSurfaceRefinementOrderEdit,
  cloneInkRecord,
  bindInkSource,
  type ErasureRefinement,
  invalidateCompiledForIds,
  observeSurfaceTransactions,
  applySurfaceOrderEdits,
  publishSurfaceObjects,
  type SurfaceOrderEdit,
  captureGeometryOwnershipForIds,
} from '@froglight/foundation';

/** Small internal history seam consumed by the surface orchestrator. */
export interface SurfaceGestureHistoryPort {
  beginGesture(): void;
  commitGesture(): void;
  cancelGesture(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  undo(): boolean;
  redo(): boolean;
}

export interface SurfaceHistoryCounters {
  /** Full-model JSON serializations (must stay 0 — patches only). */
  fullModelSerializations: number;
  /** Deep clones of UNCHANGED records (must stay 0). */
  unchangedRecordsCopied: number;
  /** Deep clones of changed records (new stroke ≈ its chunk count). */
  changedRecordsCaptured: number;
  /** Current undo depth. */
  entries: number;
  /** Entries evicted by the memory policy. */
  evicted: number;
  retainedBytes: number;
}

/** Explicit memory policy: bounded undo depth (oldest evicted first). */
export const SURFACE_HISTORY_MAX_ENTRIES = 100;
export const SURFACE_HISTORY_MAX_BYTES = 64 * 1024 * 1024;
function retainedBytes(entries: readonly HistoryEntry[]): number {
  const seen = new Set<object>();
  const size = (value: unknown): number => {
    if (typeof value === 'string') return value.length * 2;
    if (typeof value === 'number') return 8;
    if (value === null || typeof value !== 'object' || seen.has(value))
      return 0;
    seen.add(value);
    const record = value as SurfaceObjectRecord;
    if (record.type === 'froglight.ink.source')
      return inkSourceRetainedBytes(record);
    if (record.type === 'froglight.ink.stroke') {
      const { points, region, visible, type: _type, ...shell } = record;
      const vertices =
        region === undefined
          ? 0
          : (region as import('@froglight/foundation').InkErasure).reduce(
              (n, poly) => n + poly.reduce((n, ring) => n + ring.length, 0),
              0,
            );
      return (
        size(shell) +
        size(visible) +
        (Array.isArray(points) ? points.length * 128 : 0) +
        vertices * 8
      );
    }
    if (value instanceof Map)
      return [...value.values()].reduce((n, v) => n + size(v), 0);
    return Object.values(value).reduce<number>((n, v) => n + size(v), 32);
  };
  return entries.reduce((n, entry) => n + size(entry), 0);
}

interface ObjectPatch {
  before: SurfaceObjectRecord | undefined;
  after: SurfaceObjectRecord | undefined;
}

interface PatchHistoryEntry {
  readonly kind: 'patch';
  objects: Map<string, ObjectPatch>;
  orderEdits: SurfaceOrderEdit[];
  frameBefore: SurfaceModel['frame'] | null;
  frameAfter: SurfaceModel['frame'] | null;
  frameChanged: boolean;
  orderChanged: boolean;
  refinedBefore?: Map<string, readonly string[]>;
}

interface TranslateHistoryEntry {
  readonly kind: 'translate';
  ids: string[];
  dx: number;
  dy: number;
}

interface TranslatePatchHistoryEntry {
  readonly kind: 'translate-patch';
  translate: { ids: string[]; dx: number; dy: number };
  objects: Map<string, ObjectPatch>;
  orderEdits: SurfaceOrderEdit[];
  frameBefore: SurfaceModel['frame'] | null;
  frameAfter: SurfaceModel['frame'] | null;
  frameChanged: boolean;
  orderChanged: boolean;
  refinedBefore?: Map<string, readonly string[]>;
}

type HistoryEntry =
  | PatchHistoryEntry
  | TranslateHistoryEntry
  | TranslatePatchHistoryEntry;

/**
 * Discriminated last-change descriptor for notification routing.
 * `translate-patch` carries BOTH sides: primaries moved by rigid
 * translation (zero-clone, `notifyTranslated` only) and follower
 * patches (ordinary mutation publication). Callers MUST branch on
 * this instead of the legacy wrappers to avoid losing one side.
 */
export type SurfaceHistoryLastChange =
  | { kind: 'none' }
  | { kind: 'patch'; ids: readonly string[] }
  | {
      kind: 'translate';
      ids: readonly string[];
      dx: number;
      dy: number;
    }
  | {
      kind: 'translate-patch';
      translate: { ids: readonly string[]; dx: number; dy: number };
      patchIds: readonly string[];
    };

function cloneRecord(record: SurfaceObjectRecord): SurfaceObjectRecord {
  return cloneInkRecord(record);
}
function recordsEqual(a: SurfaceObjectRecord, b: SurfaceObjectRecord): boolean {
  if (a.sourceId !== undefined || b.sourceId !== undefined) {
    if (
      a.region !== b.region ||
      a.visible !== b.visible ||
      a.regionTransform !== b.regionTransform
    )
      return false;
    const { region: ar, visible: av, regionTransform: at, ...as } = a;
    const { region: br, visible: bv, regionTransform: bt, ...bs } = b;
    return (
      ar === br &&
      av === bv &&
      at === bt &&
      JSON.stringify(as) === JSON.stringify(bs)
    );
  }
  if (Object.isFrozen(a) && a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

function applyTranslateToModel(
  model: SurfaceModel,
  ids: readonly string[],
  dx: number,
  dy: number,
  registry?: {
    get(type: string): {
      translate?: (record: SurfaceObjectRecord, dx: number, dy: number) => void;
    } | null;
  },
): void {
  for (const id of ids) {
    const record = model.objects[id];
    if (record === undefined) continue;
    const translate = registry?.get(record.type)?.translate;
    if (translate !== undefined && translate !== null) {
      try {
        translate(record, dx, dy);
        continue;
      } catch {
        // Fall through to envelope fallback.
      }
    }
    // Envelope fallback for x/y types (matches controller semantics).
    const x = typeof record.x === 'number' ? record.x : null;
    const y = typeof record.y === 'number' ? record.y : null;
    if (x !== null && y !== null) {
      (record as Record<string, unknown>).x = x + dx;
      (record as Record<string, unknown>).y = y + dy;
    } else if (
      record.type === 'froglight.ink.stroke' &&
      Array.isArray(record.points)
    ) {
      // Direct Ink fallback when no registry is available (no clone).
      for (const raw of record.points as unknown[]) {
        if (typeof raw !== 'object' || raw === null) continue;
        const s = raw as Record<string, unknown>;
        if (typeof s.x === 'number') s.x += dx;
        if (typeof s.y === 'number') s.y += dy;
      }
    }
  }
}

function cloneFrame(frame: SurfaceModel['frame']): SurfaceModel['frame'] {
  if (typeof structuredClone === 'function') {
    return structuredClone(frame) as SurfaceModel['frame'];
  }
  return JSON.parse(JSON.stringify(frame)) as SurfaceModel['frame'];
}

function framesEqual(a: unknown, b: unknown): boolean {
  // Frames are tiny (bounded dims + unknownFields); a targeted JSON
  // comparison here never touches stroke samples and never counts as a
  // full-model serialization.
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Provider-local gesture history over one mutable SurfaceModel. */
export class SurfaceGestureHistory {
  readonly #undo: HistoryEntry[] = [];
  readonly #redo: HistoryEntry[] = [];
  readonly #model: SurfaceModel;
  readonly #registry?: {
    get(type: string): {
      translate?: (record: SurfaceObjectRecord, dx: number, dy: number) => void;
    } | null;
  };
  readonly #observation: { dispose(): void };
  #active: {
    orderEdits: SurfaceOrderEdit[];
    frameBefore: SurfaceModel['frame'];
    before: Map<string, SurfaceObjectRecord | undefined>;
    translate: { ids: string[]; dx: number; dy: number } | null;
  } | null = null;
  readonly #counters: SurfaceHistoryCounters = {
    fullModelSerializations: 0,
    unchangedRecordsCopied: 0,
    changedRecordsCaptured: 0,
    entries: 0,
    evicted: 0,
    retainedBytes: 0,
  };
  readonly #maxEntries: number;
  #lastChangeIds: string[] = [];
  #lastChangeTranslate: { ids: string[]; dx: number; dy: number } | null = null;
  #lastChangeKind: 'none' | 'patch' | 'translate' | 'translate-patch' = 'none';

  constructor(
    model: SurfaceModel,
    maxEntriesOrRegistry:
      | number
      | {
          get(type: string): {
            translate?: (
              record: SurfaceObjectRecord,
              dx: number,
              dy: number,
            ) => void;
          } | null;
        } = SURFACE_HISTORY_MAX_ENTRIES,
    registry?: {
      get(type: string): {
        translate?: (
          record: SurfaceObjectRecord,
          dx: number,
          dy: number,
        ) => void;
      } | null;
    },
  ) {
    this.#model = model;
    this.#observation = observeSurfaceTransactions(model, {
      order: (edit) => {
        if (isSurfaceRefinementOrderEdit(edit)) return;
        if (this.#active === null) return;
        this.#active.orderEdits.push(edit);
        for (const id of edit.inserted) {
          if (!this.#active.before.has(id) && !edit.removed.includes(id)) {
            this.#active.before.set(id, undefined);
          }
        }
      },
      objects: () => undefined,
    });
    if (typeof maxEntriesOrRegistry === 'number') {
      this.#maxEntries = maxEntriesOrRegistry;
      if (registry !== undefined) this.#registry = registry;
    } else {
      this.#maxEntries = SURFACE_HISTORY_MAX_ENTRIES;
      this.#registry = maxEntriesOrRegistry;
    }
  }

  /** Structural counters (large-document regression gate). */
  historyStats(): SurfaceHistoryCounters {
    return {
      ...this.#counters,
      entries: this.#undo.length,
      retainedBytes: retainedBytes([...this.#undo, ...this.#redo]),
    };
  }

  /**
   * Ids affected by the last commit/undo/redo/cancel (for incremental
   * scene invalidation). Empty when the last gesture was a no-op.
   *
   * For `translate-patch` this returns ONLY the patch/follower ids, NOT
   * the union with translated primaries. Rationale: primaries must never
   * take the geometry-recompile/publication path (`notifyExternalMutation`
   * / `publishContentMutation`); they route exclusively through
   * `notifyTranslated`. Callers needing BOTH sides must use `lastChange()`.
   */
  lastChangeIds(): readonly string[] {
    return [...this.#lastChangeIds];
  }

  /**
   * Rigid-translation delta for the last change (item 1): non-null for
   * pure translates AND for `translate-patch` composites (returns the
   * translate side). Callers routing composites must use `lastChange()`
   * for the split — this wrapper alone cannot express the follower side.
   * Null for pure patches, no-ops, and cancels.
   */
  lastChangeTranslate(): {
    ids: readonly string[];
    dx: number;
    dy: number;
  } | null {
    return this.#lastChangeTranslate === null
      ? null
      : {
          ids: [...this.#lastChangeTranslate.ids],
          dx: this.#lastChangeTranslate.dx,
          dy: this.#lastChangeTranslate.dy,
        };
  }

  /**
   * Discriminated last-change descriptor for split notification routing.
   * `surface.ts` MUST branch on this (not the wrappers) so composites
   * publish BOTH the translated path (primaries) and the ordinary
   * mutation path (followers).
   */
  lastChange(): SurfaceHistoryLastChange {
    switch (this.#lastChangeKind) {
      case 'translate': {
        const t = this.#lastChangeTranslate;
        if (t === null) return { kind: 'none' };
        return {
          kind: 'translate',
          ids: [...t.ids],
          dx: t.dx,
          dy: t.dy,
        };
      }
      case 'translate-patch': {
        const t = this.#lastChangeTranslate;
        if (t === null) return { kind: 'none' };
        return {
          kind: 'translate-patch',
          translate: {
            ids: [...t.ids],
            dx: t.dx,
            dy: t.dy,
          },
          patchIds: [...this.#lastChangeIds],
        };
      }
      case 'patch': {
        return { kind: 'patch', ids: [...this.#lastChangeIds] };
      }
      case 'none':
      default:
        return { kind: 'none' };
    }
  }

  #setLastChange(
    kind: 'none' | 'patch' | 'translate' | 'translate-patch',
    ids: readonly string[],
    translate: { ids: string[]; dx: number; dy: number } | null,
  ): void {
    publishSurfaceObjects(this.#model, [...ids, ...(translate?.ids ?? [])]);
    this.#lastChangeKind = kind;
    this.#lastChangeIds = [...ids];
    this.#lastChangeTranslate =
      translate === null
        ? null
        : { ids: [...translate.ids], dx: translate.dx, dy: translate.dy };
  }

  /**
   * Mutation-recorder seam: record an object's BEFORE state before its
   * first change in the active gesture. New ids record an absent marker
   * (no clone); existing ids deep-clone once (changed-only cost).
   * Mutation code (tools/controller/surface) must call this BEFORE
   * mutating — the transaction then knows exactly what changed without
   * scanning or serializing unchanged strokes.
   */
  recordBefore(id: string): void {
    if (this.#active === null) return;
    if (this.#active.before.has(id)) return;
    const current = this.#model.objects[id];
    if (
      current?.type === 'froglight.ink.stroke' &&
      typeof current.sourceId === 'string' &&
      !this.#active.before.has(current.sourceId)
    )
      this.recordBefore(current.sourceId);
    if (current === undefined) {
      this.#active.before.set(id, undefined);
    } else {
      this.#active.before.set(id, cloneRecord(current));
      this.#counters.changedRecordsCaptured += 1;
    }
  }

  /** Record several ids (convenience for multi-object verbs). */
  recordBeforeMany(ids: readonly string[]): void {
    for (const id of ids) this.recordBefore(id);
  }

  /**
   * Invoked by the controller at every gesture start, pre-mutation.
   * Captures only the cheap order/frame shells (id lists + tiny frame);
   * object samples are captured lazily via `recordBefore` on first
   * mutation, so pre-existing strokes are never copied.
   */
  beginGesture(): void {
    if (this.#active !== null) return;
    this.#active = {
      orderEdits: [],
      frameBefore: cloneFrame(this.#model.frame),
      before: new Map(),
      translate: null,
    };
  }

  /**
   * Command-history seam for pure translations (Slice 3): records
   * {ids,dx,dy} without cloning sample arrays. One drag remains one undo
   * step; undo applies -dx/-dy, redo +dx/+dy, both without clones.
   */
  recordTranslate(ids: readonly string[], dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    if (this.#active === null) {
      this.beginGesture();
      if (this.#active === null) return;
    }
    // Coalesce multiple translate records in one gesture (should not
    // happen for drag commits, but keeps verbs safe).
    const prev = this.#active.translate;
    if (prev !== null) {
      prev.dx += dx;
      prev.dy += dy;
      for (const id of ids) {
        if (!prev.ids.includes(id)) prev.ids.push(id);
      }
    } else {
      this.#active.translate = { ids: [...ids], dx, dy };
    }
  }

  /**
   * Successful gesture completion: build the patch from recorded befores
   * plus current afters. No-op gestures (no recorded objects, order and
   * frame unchanged) leave no undo entry. Never serializes the model.
   */
  commitGesture(): void {
    const active = this.#active;
    if (active === null) return;
    const orderChanged = active.orderEdits.length > 0;
    const frameChanged = !framesEqual(active.frameBefore, this.#model.frame);
    // Pure-translation fast path (Slice 3): one command entry, zero clones.
    if (
      active.translate !== null &&
      active.before.size === 0 &&
      !orderChanged &&
      !frameChanged
    ) {
      const { ids, dx, dy } = active.translate;
      if (dx !== 0 || dy !== 0) {
        const entry: TranslateHistoryEntry = {
          kind: 'translate',
          ids: [...ids],
          dx,
          dy,
        };
        if (retainedBytes([entry]) > SURFACE_HISTORY_MAX_BYTES)
          throw new FroglightError(
            'FORMAT_LIMIT_EXCEEDED',
            'This gesture exceeds the undo memory budget',
          );
        this.#active = null;
        this.#undo.push(entry);
        this.#redo.length = 0;
        this.#counters.entries = this.#undo.length;
        while (
          this.#undo.length > this.#maxEntries ||
          retainedBytes([...this.#undo, ...this.#redo]) >
            SURFACE_HISTORY_MAX_BYTES
        ) {
          this.#undo.shift();
          this.#counters.evicted += 1;
        }
        this.#counters.entries = this.#undo.length;
        this.#setLastChange('translate', ids, { ids: [...ids], dx, dy });
        return;
      }
      this.#active = null;
      this.#setLastChange('none', [], null);
      return;
    }
    // Collect afters for every recorded id (created/modified/deleted).
    const objects = new Map<string, ObjectPatch>();
    for (const [id, before] of active.before) {
      const afterRaw = this.#model.objects[id];
      const after = afterRaw === undefined ? undefined : cloneRecord(afterRaw);
      if (after !== undefined) this.#counters.changedRecordsCaptured += 1;
      // Skip no-op records (should not happen when callers record
      // correctly, but guards against redundant recordBefore calls).
      // A new object has no before image to compare. Serializing its entire
      // record here only walks the samples once before storing the same
      // record in the history patch.
      const unchanged =
        before === undefined
          ? after === undefined
          : after !== undefined && recordsEqual(before, after);
      const pendingGroup =
        before?.type === 'froglight.group' &&
        Array.isArray(before.children) &&
        before.children.some(
          (id) => this.#model.objects[id as string]?.region !== undefined,
        );
      if (unchanged && !orderChanged && !frameChanged && !pendingGroup)
        continue;
      objects.set(id, { before, after });
    }
    if (objects.size === 0 && !orderChanged && !frameChanged) {
      // Translate-only with zero delta, or a no-op patch: no undo entry.
      // (A non-zero translate with order/frame changes falls through to
      // the composite branch below.)
      if (active.translate === null) {
        this.#active = null;
        this.#setLastChange('none', [], null);
        return;
      }
    }
    // Mixed translate+patch (move with bound-connector followers): one
    // composite entry preserving BOTH sides. Primaries stay a zero-clone
    // command; followers stay before/after patches. Never converts to a
    // pure patch (would lose the translation) or a pure translate (would
    // lose followers).
    if (
      active.translate !== null &&
      (objects.size > 0 || orderChanged || frameChanged)
    ) {
      const { ids, dx, dy } = active.translate;
      if (dx !== 0 || dy !== 0) {
        const entry: TranslatePatchHistoryEntry = {
          kind: 'translate-patch',
          translate: { ids: [...ids], dx, dy },
          objects,
          orderEdits: active.orderEdits,
          frameBefore: frameChanged ? active.frameBefore : null,
          frameAfter: frameChanged ? cloneFrame(this.#model.frame) : null,
          frameChanged,
          orderChanged,
        };
        if (retainedBytes([entry]) > SURFACE_HISTORY_MAX_BYTES)
          throw new FroglightError(
            'FORMAT_LIMIT_EXCEEDED',
            'This gesture exceeds the undo memory budget',
          );
        this.#active = null;
        this.#undo.push(entry);
        this.#redo.length = 0;
        this.#counters.entries = this.#undo.length;
        while (
          this.#undo.length > this.#maxEntries ||
          retainedBytes([...this.#undo, ...this.#redo]) >
            SURFACE_HISTORY_MAX_BYTES
        ) {
          this.#undo.shift();
          this.#counters.evicted += 1;
        }
        this.#counters.entries = this.#undo.length;
        this.#setLastChange('translate-patch', [...objects.keys()], {
          ids: [...ids],
          dx,
          dy,
        });
        return;
      }
      // Zero-delta translate with patch content: fall through to pure patch.
    }
    if (objects.size === 0 && !orderChanged && !frameChanged) {
      this.#active = null;
      this.#setLastChange('none', [], null);
      return;
    }
    const entry: PatchHistoryEntry = {
      kind: 'patch',
      objects,
      orderEdits: active.orderEdits,
      frameBefore: frameChanged ? active.frameBefore : null,
      frameAfter: frameChanged ? cloneFrame(this.#model.frame) : null,
      frameChanged,
      orderChanged,
    };
    if (retainedBytes([entry]) > SURFACE_HISTORY_MAX_BYTES)
      throw new FroglightError(
        'FORMAT_LIMIT_EXCEEDED',
        'This gesture exceeds the undo memory budget',
      );
    this.#active = null;
    this.#undo.push(entry);
    this.#redo.length = 0;
    this.#counters.entries = this.#undo.length;
    while (
      this.#undo.length > this.#maxEntries ||
      retainedBytes([...this.#undo, ...this.#redo]) > SURFACE_HISTORY_MAX_BYTES
    ) {
      this.#undo.shift();
      this.#counters.evicted += 1;
    }
    this.#counters.entries = this.#undo.length;
    this.#setLastChange('patch', [...objects.keys()], null);
  }

  /** Aborted gesture: restore recorded befores + order/frame, no history. */
  cancelGesture(): void {
    const active = this.#active;
    if (active === null) {
      this.#setLastChange('none', [], null);
      return;
    }
    this.#active = null;
    // Pending translate without commit: the model was not yet mutated
    // through the command path (ephemeral cancel discards delta before
    // mutation), so just drop it. If a caller mutated after recordTranslate
    // then cancels, reverse it to keep the seam truthful.
    if (active.translate !== null && active.before.size === 0) {
      // Detect whether the translate was already applied by checking if
      // any id moved? We cannot know cheaply; the controller's ephemeral
      // cancel never mutates, so dropping is correct. For direct callers
      // that mutated, they should use commit, not cancel.
      this.#setLastChange('none', [], null);
      // Still restore order/frame shells below (no-ops when unchanged).
    }
    for (const [id, before] of active.before) {
      if (before === undefined) {
        delete this.#model.objects[id];
      } else {
        this.#model.objects[id] = cloneRecord(before);
        this.#counters.changedRecordsCaptured += 1;
      }
    }
    applySurfaceOrderEdits(this.#model.order, active.orderEdits, true);
    if (!framesEqual(active.frameBefore, this.#model.frame)) {
      this.#model.frame = cloneFrame(active.frameBefore);
    }
    // A cancelled mixed gesture (translate + befores) restores follower
    // befores and drops the pending translate (ephemeral path never
    // mutated primaries). Report the restored follower set as a patch so
    // routing invalidates exactly what changed; the dropped translate
    // needs no notification.
    if (active.before.size > 0) {
      this.#setLastChange('patch', [...active.before.keys()], null);
    } else {
      this.#setLastChange('none', [], null);
    }
  }

  /** Refinements alter identities only; their fill belongs to the accepted gesture. */
  refineErasure(refinement: ErasureRefinement, publish: () => void): void {
    const entries = [...this.#undo, ...[...this.#redo].reverse()];
    const entry = entries.find(
      (entry) =>
        entry.kind !== 'translate' &&
        refinement.before.some(
          (record) =>
            record.region !== undefined &&
            entry.objects.get(record.id)?.after?.region === record.region,
        ),
    );
    if (entry === undefined || entry.kind === 'translate') {
      publish();
      return;
    }
    const active = this.#active;
    const rollback = entries
      .filter(
        (entry): entry is PatchHistoryEntry | TranslatePatchHistoryEntry =>
          entry.kind !== 'translate',
      )
      .map((entry) => ({
        entry,
        objects: new Map(
          [...entry.objects].map(([id, patch]) => [id, { ...patch }]),
        ),
        orderEdits: [...entry.orderEdits],
        orderChanged: entry.orderChanged,
        refinedBefore:
          entry.refinedBefore === undefined
            ? undefined
            : new Map(entry.refinedBefore),
      }));
    const activeRollback =
      active === null
        ? null
        : {
            before: new Map(active.before),
            orderEdits: [...active.orderEdits],
          };
    this.#active = null;
    try {
      publish();
      for (const before of refinement.before) {
        const replacements = refinement.after.filter(
          (after) =>
            after.sourceId === before.sourceId &&
            (after.id === before.id ||
              refinement.order.some(
                (edit) =>
                  edit.removed.includes(before.id) &&
                  edit.inserted.includes(after.id),
              )),
        );
        if (before.sourceId === undefined) continue;
        const originalAfter = entry.objects.get(before.id)?.after;
        if (
          originalAfter === undefined ||
          originalAfter.region !== before.region
        )
          continue;
        for (const after of replacements) {
          const patch = entry.objects.get(after.id) ?? {
            before: undefined,
            after: undefined,
          };
          const image: SurfaceObjectRecord = {
            ...originalAfter,
            id: after.id,
            visible: after.visible,
          };
          delete image.region;
          // cloneInkRecord binds via a prepared record carrying the same source.
          patch.after = cloneRecord({ ...after, ...image });
          entry.objects.set(after.id, patch);
        }
        for (const later of entries.slice(entries.indexOf(entry) + 1)) {
          if (later.kind === 'translate') continue;
          const patch = later.objects.get(before.id);
          if (patch === undefined) continue;
          const befores = patch.before?.region === before.region;
          const afters = patch.after?.region === before.region;
          if (!befores && !afters) continue;
          if (befores) {
            later.refinedBefore ??= new Map();
            later.refinedBefore.set(
              before.id,
              replacements.map((record) => record.id),
            );
          }
          for (const after of replacements) {
            const next = later.objects.get(after.id) ?? {
              before: undefined,
              after: undefined,
            };
            const image = (old: SurfaceObjectRecord): SurfaceObjectRecord => {
              const record: SurfaceObjectRecord = {
                ...after,
                ...old,
                id: after.id,
                visible: after.visible,
              };
              delete record.region;
              return cloneRecord(record);
            };
            if (befores) next.before = image(patch.before!);
            if (afters) next.after = image(patch.after!);
            later.objects.set(after.id, next);
          }
          later.orderEdits = later.orderEdits.map((edit) => ({
            ...edit,
            removed: edit.removed.flatMap((id) =>
              id === before.id ? replacements.map((r) => r.id) : [id],
            ),
            inserted: afters
              ? edit.inserted.flatMap((id) =>
                  id === before.id ? replacements.map((r) => r.id) : [id],
                )
              : edit.inserted,
          }));
        }
      }
      const expandGroup = (
        record: SurfaceObjectRecord | undefined,
      ): SurfaceObjectRecord | undefined => {
        if (
          record?.type !== 'froglight.group' ||
          !Array.isArray(record.children)
        )
          return record;
        return cloneRecord({
          ...record,
          children: record.children.flatMap(
            (child) =>
              refinement.order.find((edit) => edit.removed.includes(child))
                ?.inserted ?? [child],
          ),
        });
      };
      for (const [index, later] of entries
        .slice(entries.indexOf(entry))
        .entries()) {
        if (later.kind === 'translate') continue;
        for (const patch of later.objects.values()) {
          if (index > 0) patch.before = expandGroup(patch.before);
          patch.after = expandGroup(patch.after);
        }
      }
      if (active !== null)
        for (const [id, before] of active.before)
          active.before.set(id, expandGroup(before));
      for (const edit of refinement.order) {
        const removed = edit.removed.flatMap(
          (id) => entry.refinedBefore?.get(id) ?? [id],
        );
        const delta = edit.inserted.length - removed.length;
        for (const later of entries.slice(entries.indexOf(entry) + 1)) {
          if (later.kind === 'translate') continue;
          later.orderEdits = later.orderEdits.map((next) => ({
            ...next,
            index: next.index > edit.index ? next.index + delta : next.index,
          }));
        }
        if (active !== null)
          active.orderEdits = active.orderEdits.map((next) => ({
            ...next,
            index: next.index > edit.index ? next.index + delta : next.index,
          }));
      }
      entry.orderEdits.push(
        ...refinement.order.map((edit) => ({
          ...edit,
          removed: edit.removed.flatMap(
            (id) => entry.refinedBefore?.get(id) ?? [id],
          ),
        })),
      );
      entry.orderChanged ||= refinement.order.length > 0;
      if (
        retainedBytes([entry]) > SURFACE_HISTORY_MAX_BYTES ||
        retainedBytes([...this.#undo, ...this.#redo]) >
          SURFACE_HISTORY_MAX_BYTES
      )
        throw new FroglightError(
          'FORMAT_LIMIT_EXCEEDED',
          'Precision eraser refinement exceeds the undo memory budget',
        );
    } catch (error) {
      if (active !== null && activeRollback !== null) {
        active.before = activeRollback.before;
        active.orderEdits = activeRollback.orderEdits;
      }
      for (const previous of rollback) {
        previous.entry.objects = previous.objects;
        previous.entry.orderEdits = previous.orderEdits;
        previous.entry.orderChanged = previous.orderChanged;
        if (previous.refinedBefore === undefined)
          delete previous.entry.refinedBefore;
        else previous.entry.refinedBefore = previous.refinedBefore;
      }
      throw error;
    } finally {
      this.#active = active;
    }
  }

  dispose(): void {
    this.#observation.dispose();
    this.#undo.length = 0;
    this.#redo.length = 0;
    this.#active = null;
  }

  canUndo(): boolean {
    return this.#undo.length > 0;
  }

  canRedo(): boolean {
    return this.#redo.length > 0;
  }

  undo(): boolean {
    if (this.#active !== null) return false;
    const entry = this.#undo.pop();
    if (entry === undefined) {
      this.#setLastChange('none', [], null);
      return false;
    }
    if (entry.kind === 'translate') {
      // Command undo: canonical translation ONLY.
      //
      // Translation ownership matrix (one owner per layer, never two):
      // | Original drag/commit | Controller (#applyTranslation /
      // |   #commitMoveDrag: canonical + #indexTranslated during run) |
      // | History undo/redo    | History (applyTranslateToModel below)   |
      // | Derived/index/epoch  | Controller notification               |
      // |   (notifyTranslated -> accumulateDerivedTranslation, exactly   |
      // |   once per translation, via surface notifyHistoryChange)      |
      // | Composite follower   | History (#apply restore) +              |
      // |   patch              | notifyExternalMutation/publishContent-  |
      // |                      | Mutation (followers only, never primaries)|
      //
      // History MUST NOT call accumulateDerivedTranslation here: the surface
      // notify path routes the same delta through controller.notifyTranslated
      // (which accumulates exactly once). A second accumulation here displaces
      // retained geometry (undo lands at -delta instead of 0) and advances
      // position epochs twice per operation. Zero clones, no B-spline
      // recompile (geometry generation untouched — item 1).
      applyTranslateToModel(
        this.#model,
        entry.ids,
        -entry.dx,
        -entry.dy,
        this.#registry,
      );
      this.#redo.push({
        kind: 'translate',
        ids: [...entry.ids],
        dx: entry.dx,
        dy: entry.dy,
      });
      this.#counters.entries = this.#undo.length;
      this.#setLastChange('translate', entry.ids, {
        ids: [...entry.ids],
        dx: -entry.dx,
        dy: -entry.dy,
      });
      return true;
    }
    if (entry.kind === 'translate-patch') {
      // Composite undo: primaries translate back (zero clones, position
      // epoch advances, geometry generation unchanged), followers restore
      // before patches + order/frame. Invalidate ONLY follower ids.
      const redoObjects = new Map<string, ObjectPatch>();
      for (const [id, patch] of entry.objects) {
        const currentRaw = this.#model.objects[id];
        const current =
          currentRaw === undefined ? undefined : cloneRecord(currentRaw);
        if (current !== undefined) this.#counters.changedRecordsCaptured += 1;
        redoObjects.set(id, { before: current, after: patch.after });
      }
      this.#redo.push({
        kind: 'translate-patch',
        translate: {
          ids: [...entry.translate.ids],
          dx: entry.translate.dx,
          dy: entry.translate.dy,
        },
        objects: redoObjects,
        orderEdits: entry.orderEdits,
        refinedBefore: entry.refinedBefore,
        frameBefore: cloneFrame(this.#model.frame),
        frameAfter:
          entry.frameAfter !== null ? cloneFrame(entry.frameAfter) : null,
        frameChanged: entry.frameChanged,
        orderChanged: entry.orderChanged,
      });
      const { ids, dx, dy } = entry.translate;
      // Canonical primaries only — derived/index/epoch for the same delta
      // is owned by the surface notify path (controller.notifyTranslated,
      // exactly once). See the ownership matrix on the 'translate' branch.
      applyTranslateToModel(this.#model, ids, -dx, -dy, this.#registry);
      this.#invalidatePatchIds([...entry.objects.keys()]);
      this.#apply(entry, 'before');
      this.#counters.entries = this.#undo.length;
      this.#setLastChange('translate-patch', [...entry.objects.keys()], {
        ids: [...ids],
        dx: -dx,
        dy: -dy,
      });
      return true;
    }
    // Capture redo patch (current afters) without full serialization.
    const redoObjects = new Map<string, ObjectPatch>();
    for (const [id, patch] of entry.objects) {
      const currentRaw = this.#model.objects[id];
      const current =
        currentRaw === undefined ? undefined : cloneRecord(currentRaw);
      if (current !== undefined) this.#counters.changedRecordsCaptured += 1;
      redoObjects.set(id, { before: current, after: patch.after });
    }
    this.#redo.push({
      kind: 'patch',
      objects: redoObjects,
      orderEdits: entry.orderEdits,
      refinedBefore: entry.refinedBefore,
      frameBefore: cloneFrame(this.#model.frame),
      frameAfter:
        entry.frameAfter !== null ? cloneFrame(entry.frameAfter) : null,
      frameChanged: entry.frameChanged,
      orderChanged: entry.orderChanged,
    });
    this.#apply(entry, 'before');
    this.#counters.entries = this.#undo.length;
    this.#setLastChange('patch', [...entry.objects.keys()], null);
    return true;
  }

  redo(): boolean {
    if (this.#active !== null) return false;
    const entry = this.#redo.pop();
    if (entry === undefined) {
      this.#setLastChange('none', [], null);
      return false;
    }
    if (entry.kind === 'translate') {
      // Command redo: canonical translation ONLY (same single-owner split as
      // undo — derived/index/epoch via controller.notifyTranslated once).
      applyTranslateToModel(
        this.#model,
        entry.ids,
        entry.dx,
        entry.dy,
        this.#registry,
      );
      this.#undo.push({
        kind: 'translate',
        ids: [...entry.ids],
        dx: entry.dx,
        dy: entry.dy,
      });
      while (
        this.#undo.length > this.#maxEntries ||
        retainedBytes([...this.#undo, ...this.#redo]) >
          SURFACE_HISTORY_MAX_BYTES
      ) {
        this.#undo.shift();
        this.#counters.evicted += 1;
      }
      this.#counters.entries = this.#undo.length;
      this.#setLastChange('translate', entry.ids, {
        ids: [...entry.ids],
        dx: entry.dx,
        dy: entry.dy,
      });
      return true;
    }
    if (entry.kind === 'translate-patch') {
      // Composite redo: mirror of undo with +dx/+dy + after patches.
      const undoObjects = new Map<string, ObjectPatch>();
      for (const [id, patch] of entry.objects) {
        const currentRaw = this.#model.objects[id];
        const current =
          currentRaw === undefined ? undefined : cloneRecord(currentRaw);
        if (current !== undefined) this.#counters.changedRecordsCaptured += 1;
        undoObjects.set(id, { before: current, after: patch.after });
      }
      this.#undo.push({
        kind: 'translate-patch',
        translate: {
          ids: [...entry.translate.ids],
          dx: entry.translate.dx,
          dy: entry.translate.dy,
        },
        objects: undoObjects,
        orderEdits: entry.orderEdits,
        refinedBefore: entry.refinedBefore,
        frameBefore: cloneFrame(this.#model.frame),
        frameAfter:
          entry.frameAfter !== null ? cloneFrame(entry.frameAfter) : null,
        frameChanged: entry.frameChanged,
        orderChanged: entry.orderChanged,
      });
      while (
        this.#undo.length > this.#maxEntries ||
        retainedBytes([...this.#undo, ...this.#redo]) >
          SURFACE_HISTORY_MAX_BYTES
      ) {
        this.#undo.shift();
        this.#counters.evicted += 1;
      }
      const { ids, dx, dy } = entry.translate;
      // Canonical primaries only — same single-owner split as composite undo.
      applyTranslateToModel(this.#model, ids, dx, dy, this.#registry);
      this.#invalidatePatchIds([...entry.objects.keys()]);
      this.#apply(entry, 'after');
      this.#counters.entries = this.#undo.length;
      this.#setLastChange('translate-patch', [...entry.objects.keys()], {
        ids: [...ids],
        dx,
        dy,
      });
      return true;
    }
    const undoObjects = new Map<string, ObjectPatch>();
    for (const [id, patch] of entry.objects) {
      const currentRaw = this.#model.objects[id];
      const current =
        currentRaw === undefined ? undefined : cloneRecord(currentRaw);
      if (current !== undefined) this.#counters.changedRecordsCaptured += 1;
      undoObjects.set(id, { before: current, after: patch.after });
    }
    this.#undo.push({
      kind: 'patch',
      objects: undoObjects,
      orderEdits: entry.orderEdits,
      refinedBefore: entry.refinedBefore,
      frameBefore: cloneFrame(this.#model.frame),
      frameAfter:
        entry.frameAfter !== null ? cloneFrame(entry.frameAfter) : null,
      frameChanged: entry.frameChanged,
      orderChanged: entry.orderChanged,
    });
    while (
      this.#undo.length > this.#maxEntries ||
      retainedBytes([...this.#undo, ...this.#redo]) > SURFACE_HISTORY_MAX_BYTES
    ) {
      this.#undo.shift();
      this.#counters.evicted += 1;
    }
    this.#counters.entries = this.#undo.length;
    this.#apply(entry, 'after');
    this.#setLastChange('patch', [...entry.objects.keys()], null);
    return true;
  }

  #invalidatePatchIds(ids: readonly string[]): void {
    // Follower-only invalidation for composite undo/redo: captures logical
    // ownership then drops compiled geometry for patch ids. Primaries are
    // NEVER passed here (zero-recompile guarantee).
    if (ids.length === 0) return;
    try {
      captureGeometryOwnershipForIds(this.#model, ids);
    } catch {
      // Ownership capture never breaks undo/redo.
    }
    try {
      invalidateCompiledForIds(this.#model, ids);
    } catch {
      // Invalidation never breaks undo/redo.
    }
  }

  #apply(
    entry: PatchHistoryEntry | TranslatePatchHistoryEntry,
    side: 'before' | 'after',
  ): void {
    // Objects first, then order/frame so paint positions restore exactly.
    captureGeometryOwnershipForIds(this.#model, [...entry.objects.keys()]);
    for (const [id, patch] of entry.objects) {
      const record = side === 'before' ? patch.before : patch.after;
      if (record === undefined) {
        delete this.#model.objects[id];
      } else {
        this.#model.objects[id] = cloneRecord(record);
      }
    }
    for (const id of entry.objects.keys()) {
      const record = this.#model.objects[id];
      if (
        typeof record?.sourceId === 'string' &&
        this.#model.objects[record.sourceId] !== undefined
      )
        bindInkSource(record, this.#model.objects[record.sourceId]!);
    }
    applySurfaceOrderEdits(
      this.#model.order,
      entry.orderEdits,
      side === 'before',
    );
    if (entry.frameChanged) {
      const frame = side === 'before' ? entry.frameBefore : entry.frameAfter;
      if (frame !== null) this.#model.frame = cloneFrame(frame);
    }
  }
}
