import {
  SurfaceDurabilityValidator,
  DocumentRecoveryError,
  inkPageKind,
  notebookKind,
  whiteboardKind,
  checksumOf,
  FroglightError,
  applySurfaceDocumentDelta,
  surfaceCheckpointUnits,
  restoreSurfaceCheckpoint,
  utf8Encode,
  type DocumentKindDescriptor,
  type DocumentRef,
  type SurfaceDocumentDelta,
} from '@froglight/foundation';

const scope = globalThis as unknown as {
  indexedDB: IDBFactory;
  postMessage(value: unknown, transfer?: ArrayBuffer[]): void;
  onmessage: ((event: { data: Request }) => void) | null;
};
interface Head {
  format: 'froglight.local-journal';
  version: 1;
  baseChecksum: string;
  publishedSeq: number;
  durableSeq: number;
  checkpointSeq: number;
  units: Record<string, string>;
  journal: number[];
  lastTransactionChecksum?: string;
  publishing?: { sequence: number; checksum: string };
}
let database: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const request = scope.indexedDB.open('froglight-persistence', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('records');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}
async function read<T>(key: string): Promise<T | undefined> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database
      .transaction('records')
      .objectStore('records')
      .get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}
async function write(
  values: Map<string, unknown>,
  remove: string[] = [],
  expected?: { key: string; sequence: number; checksum: string },
): Promise<void> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('records', 'readwrite', {
      durability: 'strict',
    });
    const store = transaction.objectStore('records');
    const commit = () => {
      for (const [key, value] of values) store.put(value, key);
      for (const key of remove) store.delete(key);
    };
    if (expected === undefined) commit();
    else {
      const request = store.get(expected.key);
      request.onsuccess = () => {
        const head = request.result as Head | undefined;
        if (
          head?.durableSeq !== expected.sequence ||
          head?.baseChecksum !== expected.checksum
        ) {
          reject(
            new FroglightError(
              'CONFLICT',
              'Another window changed the local journal; local edits remain pending',
            ),
          );
          transaction.abort();
        } else commit();
      };
    }
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(
        transaction.error ?? new Error('local journal transaction aborted'),
      );
    transaction.onerror = () => reject(transaction.error);
  });
}
interface DocumentState {
  key: string;
  ref: DocumentRef;
  kind: DocumentKindDescriptor;
  model: unknown;
  head: Head;
  references: Map<string, unknown>;
}
const documents = new Map<string, DocumentState>();
const validators = new WeakMap<DocumentState, SurfaceDurabilityValidator>();
const leases = new Map<string, () => void>();
async function acquire(owner: string, key: string): Promise<void> {
  if (
    leases.has(owner) ||
    typeof navigator === 'undefined' ||
    navigator.locks === undefined
  )
    return;
  await new Promise<void>((resolve, reject) => {
    void navigator.locks
      .request(
        `froglight-persistence:${key}`,
        { ifAvailable: true },
        async (lock) => {
          if (lock === null) {
            reject(
              new FroglightError(
                'CONFLICT',
                'This document is open in another window',
              ),
            );
            return;
          }
          await new Promise<void>((release) => {
            leases.set(owner, release);
            resolve();
          });
        },
      )
      .catch(reject);
  });
}
function kindFor(id: string): DocumentKindDescriptor {
  const kind = [inkPageKind, notebookKind, whiteboardKind].find(
    (kind) => kind.id === id,
  );
  if (kind === undefined) throw new Error('unsupported persistence kind');
  return kind as DocumentKindDescriptor;
}
async function checkpoint(state: DocumentState): Promise<void> {
  const units = surfaceCheckpointUnits(
    state.model,
    state.ref.kindId === 'froglight.notebook',
  );
  const values = new Map<string, unknown>();
  const keys: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  const remove: string[] = [];
  for (const [unit, value] of units) {
    if (
      state.references.get(unit) === value &&
      state.head.units[unit] !== undefined
    )
      keys[unit] = state.head.units[unit]!;
    else {
      const key = `${state.key}/unit/${state.head.durableSeq}/${unit}`;
      keys[unit] = key;
      values.set(key, JSON.stringify(value));
    }
  }
  const retained = new Set(Object.values(keys));
  for (const key of Object.values(state.head.units))
    if (!retained.has(key)) remove.push(key);
  for (const seq of state.head.journal)
    remove.push(`${state.key}/journal/${seq}`);
  const head = {
    ...state.head,
    units: keys,
    checkpointSeq: state.head.durableSeq,
    journal: [],
  };
  values.set(`${state.key}/head`, head);
  await write(values, remove);
  state.head = head;
  state.references = units;
}
interface Request {
  id: number;
  owner: string;
  key: string;
  ref: DocumentRef;
  operation: string;
  data?: Uint8Array;
  sequence?: number;
  delta?: SurfaceDocumentDelta;
  checksum?: string;
}
async function handle(request: Request): Promise<unknown> {
  if (request.operation === 'open') {
    await acquire(request.owner, request.key);
    const kind = kindFor(request.ref.kindId);
    let lastValid: unknown;
    let lastValidSequence = 0;
    let recoveryOrigin: 'saved-file' | 'local-recovery' = 'saved-file';
    try {
      lastValid = kind.decode(request.data!, request.ref).model;
    } catch {
      /* Original bytes are retained even if no valid export exists. */
    }
    try {
      const checksum = checksumOf(request.data!);
      let head = await read<Head>(`${request.key}/head`);
      let model: unknown;
      let conflict = false;
      if (head === undefined) {
        model = kind.decode(request.data!, request.ref).model;
        head = {
          format: 'froglight.local-journal',
          version: 1,
          baseChecksum: checksum,
          publishedSeq: 0,
          durableSeq: 0,
          checkpointSeq: 0,
          units: {},
          journal: [],
        };
      } else {
        const storedHead = head;
        if (
          head.format !== 'froglight.local-journal' ||
          head.version !== 1 ||
          ![head.durableSeq, head.publishedSeq, head.checkpointSeq].every(
            (value) => Number.isSafeInteger(value) && value >= 0,
          ) ||
          head.durableSeq < head.publishedSeq ||
          head.checkpointSeq > head.durableSeq ||
          (head.publishing !== undefined &&
            (!Number.isSafeInteger(head.publishing.sequence) ||
              head.publishing.sequence < head.publishedSeq ||
              head.publishing.sequence > head.durableSeq ||
              !/^[0-9a-f]{8}$/.test(head.publishing.checksum))) ||
          !/^[0-9a-f]{8}$/.test(head.baseChecksum) ||
          !Array.isArray(head.journal) ||
          head.journal.some(
            (seq, i) =>
              !Number.isSafeInteger(seq) ||
              seq <= (storedHead.journal[i - 1] ?? storedHead.checkpointSeq) ||
              seq > storedHead.durableSeq,
          ) ||
          (head.journal.at(-1) ?? head.checkpointSeq) !== head.durableSeq ||
          typeof head.units !== 'object' ||
          head.units === null ||
          Object.values(head.units).some(
            (key) =>
              typeof key !== 'string' ||
              !key.startsWith(`${request.key}/unit/`),
          )
        ) {
          throw new FroglightError(
            'RECORD_CORRUPT',
            'Corrupt local journal header',
          );
        }
        if (head.publishing?.checksum === checksum) {
          head = {
            ...head,
            baseChecksum: checksum,
            publishedSeq: head.publishing.sequence,
            publishing: undefined,
          };
        }
        if (
          head.baseChecksum !== checksum &&
          (head.durableSeq > head.publishedSeq || head.publishing !== undefined)
        ) {
          conflict = true;
        }
        if (head.baseChecksum !== checksum && !conflict) {
          model = kind.decode(request.data!, request.ref).model;
          // No pending edits: adopt external bytes and replace the local checkpoint.
          head = {
            ...head,
            baseChecksum: checksum,
            publishing: undefined,
            checkpointSeq: head.durableSeq,
          };
        } else {
          const units = new Map<string, unknown>();
          for (const [name, key] of Object.entries(head.units)) {
            const data = await read<string>(key);
            if (data === undefined)
              throw new FroglightError(
                'RECORD_CORRUPT',
                'Missing local checkpoint unit',
              );
            try {
              units.set(name, JSON.parse(data) as unknown);
            } catch {
              throw new FroglightError(
                'RECORD_CORRUPT',
                'Invalid local checkpoint unit',
              );
            }
          }
          model = restoreSurfaceCheckpoint(
            units,
            request.ref.kindId === 'froglight.notebook',
          );
          kind.decode(kind.encode(model, request.ref), request.ref);
          lastValid = model;
          lastValidSequence = head.checkpointSeq;
          recoveryOrigin = 'local-recovery';
          const validator = new SurfaceDurabilityValidator();
          for (const seq of head.journal) {
            const delta = await read<SurfaceDocumentDelta>(
              `${request.key}/journal/${seq}`,
            );
            if (delta === undefined)
              throw new FroglightError(
                'RECORD_CORRUPT',
                'Missing local journal transaction',
              );
            try {
              const candidate = applySurfaceDocumentDelta(
                model,
                delta,
                request.ref.kindId === 'froglight.notebook',
              );
              validator.validate(
                candidate,
                delta,
                request.ref.kindId === 'froglight.notebook',
                request.ref.kindId,
              );
              model = candidate;
              lastValid = model;
              lastValidSequence = seq;
            } catch {
              throw new FroglightError(
                'RECORD_CORRUPT',
                'Invalid local journal transaction',
              );
            }
          }
          // Validate recovered content through its canonical codec.
          kind.decode(kind.encode(model, request.ref), request.ref);
        }
      }
      const state = {
        key: request.key,
        ref: request.ref,
        kind,
        model,
        head,
        references: new Map<string, unknown>(),
      };
      await checkpoint(state);
      documents.set(request.owner, state);
      return {
        sequence: head.durableSeq,
        publishedSequence: head.publishedSeq,
        baseChecksum: head.baseChecksum,
        conflict,
        recoveredData:
          conflict || head.durableSeq > head.publishedSeq
            ? kind.encode(model, request.ref)
            : undefined,
      };
    } catch (error) {
      if (lastValid !== undefined) {
        const data = kind.encode(lastValid, request.ref);
        kind.decode(data, request.ref);
        throw new DocumentRecoveryError(
          error instanceof FroglightError ? error.code : 'RECORD_CORRUPT',
          'Local recovery could not be completed. Original files and recovery data are preserved.',
          {
            sequence: lastValidSequence,
            origin: recoveryOrigin,
            filename: `Recovered${kind.creation?.extension ?? '.json'}`,
            data,
          },
          { cause: error },
        );
      }
      throw error;
    }
  }
  const state = documents.get(request.owner);
  if (
    state === undefined ||
    state.key !== request.key ||
    state.ref.documentId !== request.ref.documentId
  )
    throw new Error('stale persistence owner');
  if (request.operation === 'reset') {
    if (request.sequence! < state.head.durableSeq)
      throw new Error('stale local reset');
    const model = state.kind.decode(request.data!, state.ref).model;
    const checksum = checksumOf(request.data!);
    const reset = {
      ...state,
      model,
      head: {
        ...state.head,
        baseChecksum: checksum,
        durableSeq: request.sequence!,
        publishedSeq: request.sequence!,
        publishing: undefined,
        lastTransactionChecksum: undefined,
      },
      references: new Map<string, unknown>(),
    };
    await checkpoint(reset);
    Object.assign(state, reset);
    return {
      sequence: state.head.durableSeq,
      publishedSequence: state.head.publishedSeq,
      baseChecksum: checksum,
    };
  }
  if (request.operation === 'commit') {
    const transactionChecksum = checksumOf(
      utf8Encode(JSON.stringify(request.delta)),
    );
    if (
      request.sequence === state.head.durableSeq &&
      transactionChecksum === state.head.lastTransactionChecksum
    )
      return null;
    if (request.sequence! <= state.head.durableSeq)
      throw new Error('out-of-order local transaction');
    const candidate = applySurfaceDocumentDelta(
      state.model,
      request.delta!,
      request.ref.kindId === 'froglight.notebook',
    );
    // Admission happens before journal/head publication and never mutates the mirror.
    // The normal encoder and decoder are the same gate used by cold recovery.
    const validator = validators.get(state) ?? new SurfaceDurabilityValidator();
    validator.validate(
      candidate,
      request.delta!,
      request.ref.kindId === 'froglight.notebook',
      request.ref.kindId,
    );
    validators.set(state, validator);
    const head = {
      ...state.head,
      durableSeq: request.sequence!,
      lastTransactionChecksum: transactionChecksum,
      journal: [...state.head.journal, request.sequence!],
    };
    await write(
      new Map<string, unknown>([
        [`${state.key}/journal/${request.sequence}`, request.delta],
        [`${state.key}/head`, head],
      ]),
      [],
      {
        key: `${state.key}/head`,
        sequence: state.head.durableSeq,
        checksum: state.head.baseChecksum,
      },
    );
    state.model = candidate;
    state.head = head;
    // A failed compaction cannot retroactively reject an already durable commit.
    // The intact journal remains the recovery path and the next commit retries.
    if (head.journal.length >= 128) {
      try {
        await checkpoint(state);
      } catch {
        /* Journal and head already committed atomically. */
      }
    }
    return null;
  }
  if (request.operation === 'snapshot') {
    if (request.sequence! > state.head.durableSeq)
      throw new Error('snapshot sequence mismatch');
    const sequence = state.head.durableSeq;
    const data = state.kind.encode(state.model, state.ref);
    state.kind.decode(data, state.ref);
    const checksum = checksumOf(data);
    const head = { ...state.head, publishing: { sequence, checksum } };
    await write(new Map([[`${state.key}/head`, head]]));
    state.head = head;
    return {
      sequence,
      data,
      checksum,
      projection: state.kind.projectCommitted?.(state.model, state.ref),
    };
  }
  if (request.operation === 'rebase') {
    const head = {
      ...state.head,
      baseChecksum: request.checksum!,
      publishing: undefined,
    };
    await write(new Map([[`${state.key}/head`, head]]));
    state.head = head;
    return null;
  }
  if (request.operation === 'published') {
    if (
      request.sequence! < state.head.publishedSeq ||
      request.sequence! > state.head.durableSeq
    )
      throw new Error('invalid publication sequence');
    const head = {
      ...state.head,
      publishedSeq: request.sequence!,
      baseChecksum: request.checksum!,
      publishing: undefined,
    };
    await write(new Map([[`${state.key}/head`, head]]));
    state.head = head;
    return null;
  }
  if (request.operation === 'dispose') {
    documents.delete(request.owner);
    leases.get(request.owner)?.();
    leases.delete(request.owner);
    return null;
  }
  throw new Error('unknown persistence operation');
}
// Sequential ownership queues: snapshot N finishes before applying N+1, without
// an edit-dependent cancellation loop. Storage and encoding run off the UI thread.
let queue = Promise.resolve();
scope.onmessage = (event: { data: Request }) => {
  const request = event.data;
  queue = queue.then(async () => {
    const started = performance.now();
    try {
      const result = await handle(request);
      const data =
        (result as { data?: Uint8Array; recoveredData?: Uint8Array } | null)
          ?.data ??
        (result as { recoveredData?: Uint8Array } | null)?.recoveredData;
      scope.postMessage(
        {
          id: request.id,
          owner: request.owner,
          result,
          duration: performance.now() - started,
        },
        data === undefined ? [] : [data.buffer as ArrayBuffer],
      );
    } catch (error) {
      if (request.operation === 'open') {
        leases.get(request.owner)?.();
        leases.delete(request.owner);
      }
      scope.postMessage(
        {
          id: request.id,
          owner: request.owner,
          error: {
            message: error instanceof Error ? error.message : String(error),
            recovery:
              error instanceof DocumentRecoveryError
                ? error.recovery
                : undefined,
            code:
              error instanceof FroglightError
                ? error.code
                : error instanceof DOMException &&
                    error.name === 'QuotaExceededError'
                  ? 'QUOTA_EXCEEDED'
                  : 'IO',
          },
        },
        error instanceof DocumentRecoveryError
          ? [error.recovery.data.buffer as ArrayBuffer]
          : [],
      );
    }
  });
};
