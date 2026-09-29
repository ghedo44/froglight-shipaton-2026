import {
  FroglightError,
  DocumentRecoveryError,
  type DocumentRecoveryCandidate,
  supportsSurfacePersistence,
  ErrorCodes,
  type ErrorCode,
  type DocumentPersistenceFactory,
  type DocumentRef,
  type SurfaceDocumentDelta,
  type PersistenceSnapshot,
  type PersistenceOpenResult,
} from '@froglight/foundation';

/** Persistent host worker; a failed worker resumes from the durable local journal. */
export function createWorkerPersistence(): {
  factory: DocumentPersistenceFactory;
  dispose(): void;
} {
  let worker: Worker;
  let epoch = 0;
  let failed = false;
  let nextId = 0;
  let nextOwner = 0;
  let disposed = false;
  const pending = new Map<
    number,
    {
      owner: string;
      resolve(value: unknown): void;
      reject(error: unknown): void;
    }
  >();
  const rejectAll = (error: unknown) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  function start(): void {
    worker = new Worker(new URL('./persistence.worker.ts', import.meta.url), {
      type: 'module',
      name: 'froglight-persistence',
    });
    epoch++;
    failed = false;
    worker.onerror = () => {
      failed = true;
      worker.terminate();
      rejectAll(
        new FroglightError(
          'IO',
          'Persistence worker stopped; local changes are retained',
        ),
      );
    };
    worker.onmessage = (
      event: MessageEvent<{
        id: number;
        owner: string;
        result?: unknown;
        error?: {
          message: string;
          code: string;
          recovery?: DocumentRecoveryCandidate;
        };
      }>,
    ) => {
      const response = event.data;
      const request = pending.get(response.id);
      if (request === undefined || request.owner !== response.owner) return;
      pending.delete(response.id);
      if (response.error !== undefined) {
        const code = response.error.code;
        const known =
          [
            'INVALID_PATH',
            'NOT_FOUND',
            'ALREADY_EXISTS',
            'NOT_DIRECTORY',
            'IS_DIRECTORY',
            'PERMISSION_DENIED',
            'CONFLICT',
            'QUOTA_EXCEEDED',
            'UNSUPPORTED',
            'ABORTED',
            'IO',
          ].includes(code) ||
          Object.values(ErrorCodes).includes(
            code as (typeof ErrorCodes)[keyof typeof ErrorCodes],
          );
        request.reject(
          response.error.recovery !== undefined
            ? new DocumentRecoveryError(
                known ? (code as ErrorCode) : 'IO',
                response.error.message,
                response.error.recovery,
              )
            : new FroglightError(
                known ? (code as ErrorCode) : 'IO',
                response.error.message,
              ),
        );
      } else request.resolve(response.result);
    };
  }
  start();
  function call<T>(
    owner: string,
    key: string,
    ref: DocumentRef,
    operation: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    if (disposed)
      return Promise.reject(
        new FroglightError('ABORTED', 'Persistence owner disposed'),
      );
    if (failed) start();
    if (pending.size >= 64)
      return Promise.reject(
        new FroglightError(
          'IO',
          'Local persistence is congested; edits remain pending',
        ),
      );
    const id = ++nextId;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, {
        owner,
        resolve: (value) => resolve(value as T),
        reject,
      });
      try {
        worker.postMessage({ id, owner, key, ref, operation, ...args });
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  }
  return {
    factory: (workspaceId, ref) => {
      if (!supportsSurfacePersistence(ref.kindId)) return null;
      const owner = String(++nextOwner);
      const key = JSON.stringify([
        workspaceId,
        ref.documentId,
        ref.location.resourceId,
      ]);
      let seed: Uint8Array | null = null;
      let snapshot: PersistenceSnapshot | null = null;
      let openedEpoch = -1;
      let queue: Promise<unknown> = Promise.resolve();
      let closed = false;
      const execute = <T>(
        operation: string,
        args: Record<string, unknown> = {},
      ): Promise<T> => {
        const result = queue.then(async () => {
          if (closed)
            throw new FroglightError(
              'ABORTED',
              'Document persistence disposed',
            );
          if (failed) start();
          if (operation !== 'open' && openedEpoch !== epoch) {
            if (seed === null)
              throw new FroglightError(
                'IO',
                'Document persistence was not opened',
              );
            await call(owner, key, ref, 'open', { data: seed });
            openedEpoch = epoch;
          }
          return call<T>(owner, key, ref, operation, args);
        });
        queue = result.catch(() => undefined);
        return result;
      };
      return {
        open: async (data) => {
          closed = false;
          seed = data;
          const result = await execute<PersistenceOpenResult>('open', { data });
          openedEpoch = epoch;
          return result;
        },
        reset: async (data, sequence) => {
          const result = await execute<PersistenceOpenResult>('reset', {
            data,
            sequence,
          });
          seed = data;
          return result;
        },
        commit: (sequence: number, delta: SurfaceDocumentDelta) =>
          execute<void>('commit', { sequence, delta }),
        snapshot: async (sequence) => {
          const result = await execute<PersistenceSnapshot>('snapshot', {
            sequence,
          });
          snapshot = result;
          return result;
        },
        rebase: (checksum) => execute<void>('rebase', { checksum }),
        published: (sequence, checksum) => {
          // The file already committed. Retain those exact bytes even if the
          // acknowledgement or worker fails before its header is updated.
          if (snapshot?.sequence === sequence) seed = snapshot.data;
          return execute<void>('published', { sequence, checksum });
        },
        dispose: () => {
          queue = queue
            .then(() => call(owner, key, ref, 'dispose'))
            .catch(() => undefined);
          closed = true;
          seed = null;
          snapshot = null;
        },
      };
    },
    dispose: () => {
      disposed = true;
      worker.terminate();
      rejectAll(new FroglightError('ABORTED', 'Persistence owner disposed'));
    },
  };
}
