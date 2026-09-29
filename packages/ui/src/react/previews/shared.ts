/**
 * Shared plumbing for raw-file preview components: the lazy file reader
 * contract, the fetch-on-mount hook, object-URL lifecycle, and byte
 * formatting. Components stay presentation-only; the shell supplies the
 * reader (backed by the file explorer service) when it is available.
 */

import { useEffect, useState } from 'react';
import { isVaultErrorCode } from '@froglight/foundation';

/** Reads a raw vault file's content as a blob, preferring disk-backed files. */
export type RawFileReader = (path: string) => Promise<Blob>;

export type RawFileStatus =
  | 'loading'
  | 'ready'
  | 'error'
  | 'missing'
  | 'unavailable';

export interface RawFileLoad {
  readonly status: RawFileStatus;
  readonly blob: Blob | null;
  readonly message: string | null;
}

/**
 * Fetch the file's blob once per activation. Inactive preview tabs unmount,
 * so re-activating a tab re-fetches and never shows stale content. The
 * reader is resolved once per call even if the identity changes; `retry`
 * re-runs the fetch after a failure.
 */
export function useRawFileBlob(
  reader: RawFileReader | null,
  path: string,
): RawFileLoad & { retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<RawFileLoad>({
    status: reader === null ? 'unavailable' : 'loading',
    blob: null,
    message: null,
  });

  useEffect(() => {
    if (reader === null) {
      setLoad({ status: 'unavailable', blob: null, message: null });
      return;
    }
    let live = true;
    setLoad({ status: 'loading', blob: null, message: null });
    reader(path).then(
      (blob) => {
        if (live) setLoad({ status: 'ready', blob, message: null });
      },
      (error: unknown) => {
        if (!live) return;
        if (isVaultErrorCode(error, 'NOT_FOUND')) {
          setLoad({ status: 'missing', blob: null, message: null });
          return;
        }
        setLoad({
          status: 'error',
          blob: null,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return () => {
      live = false;
    };
  }, [reader, path, attempt]);

  return { ...load, retry: () => setAttempt((count) => count + 1) };
}

/** Object URL for a blob, created lazily and revoked on change/unmount. */
export function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (blob === null) {
      setUrl(null);
      return;
    }
    const created = URL.createObjectURL(blob);
    setUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [blob]);
  return url;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
