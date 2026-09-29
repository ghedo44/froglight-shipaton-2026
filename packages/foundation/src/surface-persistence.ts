import { FroglightError, type ErrorCode } from './errors.js';
import { cloneInkRecord } from './surfaces/ink/fragments.js';
import type {
  DocumentRef,
  DocumentKindDescriptor,
  CommittedDocumentProjection,
} from './documents.js';
import type { SurfaceModel, SurfaceObjectRecord } from './surfaces/model.js';
import type { NotebookModel } from './notebooks/model.js';
import {
  observeSurfaceTransactions,
  type SurfaceOrderEdit,
} from './surfaces/transactions.js';
import { cloneTemplateValue } from './documents.js';

/** Read-only export; choosing it never resets the original journal or vault file. */
export interface DocumentRecoveryCandidate {
  readonly sequence: number;
  readonly origin: 'saved-file' | 'local-recovery';
  readonly filename: string;
  readonly data: Uint8Array;
}
export class DocumentRecoveryError extends FroglightError {
  constructor(
    code: ErrorCode,
    message: string,
    readonly recovery: DocumentRecoveryCandidate,
    options?: { cause?: unknown },
  ) {
    super(code, message, options);
    this.name = 'DocumentRecoveryError';
  }
}

export interface SurfaceDelta {
  readonly pageId: string | null;
  readonly order: readonly SurfaceOrderEdit[];
  readonly shell: unknown;
  readonly objects: Readonly<Record<string, SurfaceObjectRecord | null>>;
  readonly drafts?: Readonly<Record<string, SurfaceObjectRecord | null>>;
}
export interface SurfaceDocumentDelta {
  /** Model shell, with existing surfaces omitted. New pages include their initial surface. */
  readonly shell: unknown;
  readonly surfaces: readonly SurfaceDelta[];
}
export interface PersistenceSnapshot {
  readonly sequence: number;
  readonly data: Uint8Array;
  readonly checksum: string;
  readonly projection?: CommittedDocumentProjection;
}
export interface PersistenceOpenResult {
  readonly sequence: number;
  readonly publishedSequence: number;
  readonly baseChecksum: string;
  readonly conflict?: boolean;
  readonly recoveredData?: Uint8Array;
}
export interface DocumentPersistence {
  open(data: Uint8Array): Promise<PersistenceOpenResult>;
  reset(data: Uint8Array, sequence: number): Promise<PersistenceOpenResult>;
  commit(sequence: number, delta: SurfaceDocumentDelta): Promise<void>;
  snapshot(sequence: number): Promise<PersistenceSnapshot>;
  rebase(checksum: string): Promise<void>;
  published(sequence: number, checksum: string): Promise<void>;
  dispose(): void;
}
export type DocumentPersistenceFactory = (
  workspaceId: string,
  document: DocumentRef,
  kind: DocumentKindDescriptor,
) => DocumentPersistence | null;

export function supportsSurfacePersistence(kindId: string): boolean {
  return [
    'froglight.ink',
    'froglight.whiteboard',
    'froglight.notebook',
  ].includes(kindId);
}

/** Collect only changed objects. The model stays authoritative and editor records stay plain. */
export class SurfaceDeltaCollector {
  readonly #model: SurfaceModel | NotebookModel;
  readonly #notebook: boolean;
  readonly #surfaces = new Map<
    string | null,
    {
      model: SurfaceModel;
      ids: Set<string>;
      order: SurfaceOrderEdit[];
      drafts: Map<string, SurfaceObjectRecord | null>;
      sources: Map<string, SurfaceObjectRecord>;
      dispose(): void;
    }
  >();
  #knownPages = new Map<string, SurfaceModel | null>();
  readonly #onDraft: (() => void) | undefined;
  constructor(model: unknown, notebook: boolean, onDraft?: () => void) {
    this.#model = model as SurfaceModel | NotebookModel;
    this.#notebook = notebook;
    this.#onDraft = onDraft;
    this.#attach();
  }
  #attach(): void {
    const available = new Map<string | null, SurfaceModel>();
    if (this.#notebook) {
      for (const [id, page] of Object.entries(
        (this.#model as NotebookModel).pages,
      )) {
        if (page.kind === 'page') available.set(id, page.surface);
      }
    } else available.set(null, this.#model as SurfaceModel);
    for (const [id, state] of this.#surfaces) {
      if (available.get(id) !== state.model) {
        state.dispose();
        this.#surfaces.delete(id);
      }
    }
    for (const [pageId, model] of available) {
      if (this.#surfaces.has(pageId)) continue;
      const ids = new Set<string>();
      const order: SurfaceOrderEdit[] = [];
      const drafts = new Map<string, SurfaceObjectRecord | null>();
      const sources = new Map(
        Object.entries(model.objects).filter(
          ([, record]) =>
            record.type === 'froglight.ink.source' && Object.isFrozen(record),
        ),
      );
      const subscription = observeSurfaceTransactions(model, {
        order: (edit) => {
          order.push(edit);
          for (const id of [...edit.removed, ...edit.inserted]) ids.add(id);
        },
        objects: (changed) => {
          for (const id of changed) {
            const record = model.objects[id];
            if (
              record?.type === 'froglight.ink.source' &&
              Object.isFrozen(record) &&
              sources.get(id) === record
            )
              continue;
            ids.add(id);
          }
        },
        draft: (id, record) => {
          drafts.set(id, record);
          this.#onDraft?.();
        },
      });
      this.#surfaces.set(pageId, {
        model,
        ids,
        order,
        drafts,
        sources,
        dispose: subscription.dispose,
      });
    }
  }
  take(): SurfaceDocumentDelta {
    this.#attach();
    const surfaces: SurfaceDelta[] = [];
    for (const [pageId, state] of this.#surfaces) {
      const objects: Record<string, SurfaceObjectRecord | null> = Object.create(
        null,
      ) as Record<string, SurfaceObjectRecord | null>;
      for (const id of state.ids) {
        const record = state.model.objects[id];
        if (
          record?.type === 'froglight.ink.source' &&
          Object.isFrozen(record) &&
          state.sources.get(id) === record
        )
          continue;
        objects[id] = record === undefined ? null : cloneInkRecord(record);
        if (record?.type === 'froglight.ink.source' && Object.isFrozen(record))
          state.sources.set(id, record);
        else state.sources.delete(id);
      }
      const { objects: _objects, order: _order, ...shell } = state.model;
      surfaces.push({
        pageId,
        objects,
        shell: cloneTemplateValue(shell),
        drafts: cloneTemplateValue(Object.fromEntries(state.drafts)),
        order: state.order.splice(0),
      });
      state.ids.clear();
      state.drafts.clear();
    }
    let shell: unknown;
    if (this.#notebook) {
      const model = this.#model as NotebookModel;
      const pages = Object.fromEntries(
        Object.entries(model.pages).map(([id, page]) => {
          if (page.kind === 'opaque') return [id, page];
          const record = Object.fromEntries(
            Object.entries(page.record).map(([key, value]) => [
              key,
              key === 'surface' ? null : value,
            ]),
          );
          return [
            id,
            {
              ...page,
              record,
              surface:
                this.#knownPages.get(id) === page.surface ? null : page.surface,
            },
          ];
        }),
      );
      shell = cloneTemplateValue({ ...model, pages });
      this.#knownPages = new Map(
        Object.entries(model.pages).map(([id, page]) => [
          id,
          page.kind === 'page' ? page.surface : null,
        ]),
      );
    } else {
      const {
        objects: _objects,
        order: _order,
        ...rest
      } = this.#model as SurfaceModel;
      shell = cloneTemplateValue(rest);
    }
    return { shell, surfaces };
  }
  seed(): void {
    if (this.#notebook)
      this.#knownPages = new Map(
        Object.entries((this.#model as NotebookModel).pages).map(
          ([id, page]) => [id, page.kind === 'page' ? page.surface : null],
        ),
      );
  }
  dispose(): void {
    for (const state of this.#surfaces.values()) state.dispose();
    this.#surfaces.clear();
  }
}

export function applySurfaceDocumentDelta(
  model: unknown,
  delta: SurfaceDocumentDelta,
  notebook: boolean,
): unknown {
  let next: SurfaceModel | NotebookModel;
  if (notebook) {
    const previous = model as NotebookModel;
    next = {
      ...(delta.shell as NotebookModel),
      pages: { ...(delta.shell as NotebookModel).pages },
    };
    for (const [id, page] of Object.entries(next.pages)) {
      if (page.kind === 'page' && page.surface === null) {
        const prior = previous.pages[id];
        if (prior?.kind !== 'page')
          throw new Error('incremental page has no base');
        next.pages[id] = { ...page, surface: prior.surface };
      }
    }
  } else {
    const previous = model as SurfaceModel;
    next = {
      ...(delta.shell as SurfaceModel),
      objects: { ...previous.objects },
      order: [...previous.order],
    };
  }
  for (const change of delta.surfaces) {
    if (notebook && change.pageId !== null) {
      const page = (next as NotebookModel).pages[change.pageId];
      if (page?.kind === 'page') {
        const { objects: _objects, order: _order, ...shell } = page.surface;
        if (
          Object.keys(change.objects).length === 0 &&
          change.order.length === 0 &&
          Object.keys(change.drafts ?? {}).length === 0 &&
          JSON.stringify(shell) === JSON.stringify(change.shell)
        )
          continue;
      }
    }
    if (notebook && change.pageId !== null) {
      const page = (next as NotebookModel).pages[change.pageId];
      if (page?.kind === 'page')
        (next as NotebookModel).pages[change.pageId] = {
          ...page,
          surface: {
            ...page.surface,
            objects: { ...page.surface.objects },
            order: [...page.surface.order],
          },
        };
    }
    const surface =
      change.pageId === null
        ? (next as SurfaceModel)
        : (next as NotebookModel).pages[change.pageId]?.kind === 'page'
          ? (
              (next as NotebookModel).pages[
                change.pageId
              ] as import('./notebooks/model.js').NotebookPage
            ).surface
          : undefined;
    if (surface === undefined)
      throw new Error('incremental surface has no base');
    Object.assign(surface, change.shell);
    for (const [id, record] of Object.entries(change.drafts ?? {})) {
      if (record !== null) continue;
      delete surface.objects[id];
      const index = surface.order.indexOf(id);
      if (index >= 0) surface.order.splice(index, 1);
    }
    for (const [id, record] of Object.entries(change.objects)) {
      if (record === null) delete surface.objects[id];
      else
        Object.defineProperty(surface.objects, id, {
          value: record,
          configurable: true,
          enumerable: true,
          writable: true,
        });
    }
    for (const edit of change.order)
      surface.order.splice(edit.index, edit.removed.length, ...edit.inserted);
    for (const [id, record] of Object.entries(change.drafts ?? {})) {
      if (record === null) continue;
      if (surface.objects[id] === undefined) surface.order.push(id);
      Object.defineProperty(surface.objects, id, {
        value: record,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return next;
}

/** Object-sized checkpoint units; unchanged object records keep their identity. */
export function surfaceCheckpointUnits(
  model: unknown,
  notebook: boolean,
): Map<string, unknown> {
  const units = new Map<string, unknown>();
  const addSurface = (surface: SurfaceModel, location: string[]) => {
    const path = ['surface', ...location];
    const { objects, order, ...shell } = surface;
    units.set(JSON.stringify([...path, 'shell']), shell);
    units.set(JSON.stringify([...path, 'order']), [...order]);
    for (const [id, object] of Object.entries(objects))
      units.set(JSON.stringify([...path, 'object', id]), object);
  };
  if (notebook) {
    const { pages, ...shell } = model as NotebookModel;
    units.set('root', shell);
    for (const [id, page] of Object.entries(pages)) {
      if (page.kind === 'opaque') units.set(JSON.stringify(['page', id]), page);
      else {
        const record = Object.fromEntries(
          Object.entries(page.record).map(([key, value]) => [
            key,
            key === 'surface' ? null : value,
          ]),
        );
        units.set(JSON.stringify(['page', id]), {
          kind: page.kind,
          id,
          record,
        });
        addSurface(page.surface, [id]);
      }
    }
  } else addSurface(model as SurfaceModel, []);
  return units;
}
export function restoreSurfaceCheckpoint(
  units: Map<string, unknown>,
  notebook: boolean,
): unknown {
  const objectsBySurface = new Map<string, SurfaceModel['objects']>();
  const pages = new Map<
    string,
    import('./notebooks/model.js').NotebookPageEntry
  >();
  for (const [key, value] of units) {
    if (key === 'root') continue;
    const parts = JSON.parse(key) as string[];
    if (parts.length === 2 && parts[0] === 'page')
      pages.set(
        parts[1]!,
        value as import('./notebooks/model.js').NotebookPageEntry,
      );
    if (parts[0] !== 'surface' || parts.at(-2) !== 'object') continue;
    const location = JSON.stringify(parts.slice(0, -2));
    let objects = objectsBySurface.get(location);
    if (objects === undefined) {
      objects = Object.create(null) as SurfaceModel['objects'];
      objectsBySurface.set(location, objects);
    }
    objects[parts.at(-1)!] = value as SurfaceObjectRecord;
  }
  const restore = (location: string[]): SurfaceModel => {
    const path = ['surface', ...location];
    const surface = {
      ...(units.get(JSON.stringify([...path, 'shell'])) as SurfaceModel),
      order: units.get(JSON.stringify([...path, 'order'])) as string[],
      objects:
        objectsBySurface.get(JSON.stringify(path)) ??
        (Object.create(null) as SurfaceModel['objects']),
    };
    return surface;
  };
  if (!notebook) return restore([]);
  const model = {
    ...(units.get('root') as NotebookModel),
    pages: Object.create(null) as NotebookModel['pages'],
  };
  for (const [id, page] of pages) {
    model.pages[id] =
      page.kind === 'opaque' ? page : { ...page, surface: restore([id]) };
  }
  return model;
}

/** Coalesce the unsent tail: replaced records are released, while order edits retain their order. */
export function mergeSurfaceDocumentDeltas(
  previous: SurfaceDocumentDelta,
  next: SurfaceDocumentDelta,
): SurfaceDocumentDelta {
  const surfaces = new Map(
    previous.surfaces.map((change) => [change.pageId, change]),
  );
  for (const change of next.surfaces) {
    const prior = surfaces.get(change.pageId);
    const page =
      change.pageId === null
        ? undefined
        : (next.shell as Partial<NotebookModel>).pages?.[change.pageId];
    if (
      prior === undefined ||
      (page?.kind === 'page' && page.surface !== null)
    ) {
      surfaces.set(change.pageId, change);
      continue;
    }
    const order = [...prior.order];
    for (const edit of change.order) {
      const last = order.at(-1);
      if (
        last !== undefined &&
        last.removed.length === 0 &&
        edit.removed.length === 0 &&
        edit.index === last.index + last.inserted.length
      ) {
        order[order.length - 1] = {
          ...last,
          inserted: [...last.inserted, ...edit.inserted],
        };
      } else order.push(edit);
    }
    surfaces.set(change.pageId, {
      ...change,
      objects: { ...prior.objects, ...change.objects },
      drafts: { ...prior.drafts, ...change.drafts },
      order,
    });
  }
  // New pages in an unsent earlier shell must retain their initial surface.
  const shell = next.shell as Partial<NotebookModel>;
  const oldShell = previous.shell as Partial<NotebookModel>;
  if (shell.pages !== undefined && oldShell.pages !== undefined) {
    for (const [id, page] of Object.entries(shell.pages)) {
      const oldPage = oldShell.pages[id];
      if (
        page.kind === 'page' &&
        page.surface === null &&
        oldPage?.kind === 'page' &&
        oldPage.surface !== null
      )
        Object.assign(page, { surface: oldPage.surface });
    }
  }
  return { shell: next.shell, surfaces: [...surfaces.values()] };
}
