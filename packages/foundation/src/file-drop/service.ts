/**
 * In-memory external file-drop service (`froglight.file-drop`).
 *
 * Host bootstrap state owns one instance; activation provides the token
 * binding (withdrawn on dispose) while the service keeps its resolver
 * across reactivations. Malformed native payloads are ignored; a corrupt
 * drop report must never break the file explorer. Listener failures never
 * break dispatch.
 */

import {
  type ExternalDropEvent,
  type ExternalDropFile,
  type ExternalDropListener,
  type ExternalFileDropResolver,
  type ExternalFileDropService,
  type FileDropNativeEventName,
  type NativeFileDropFilePayload,
} from './contract.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asPosition(payload: unknown): { x: number; y: number } | null {
  if (!isPlainObject(payload)) return null;
  const x = asFiniteNumber(payload.x);
  const y = asFiniteNumber(payload.y);
  if (x === null || y === null) return null;
  return { x, y };
}

function asNativeFile(
  value: unknown,
): NativeFileDropFilePayload | null {
  if (!isPlainObject(value)) return null;
  const token = value.token;
  const name = value.name;
  if (typeof token !== 'string' || token === '') return null;
  if (typeof name !== 'string' || name === '') return null;
  const mimeType = value.mimeType;
  const size = value.size;
  return {
    token,
    name,
    ...(typeof mimeType === 'string' && mimeType !== ''
      ? { mimeType }
      : {}),
    ...(typeof size === 'number' && Number.isFinite(size) && size >= 0
      ? { size }
      : {}),
  };
}

export interface InMemoryFileDropOptions {
  readonly resolver?: ExternalFileDropResolver | null;
}

export class InMemoryExternalFileDropService
  implements ExternalFileDropService
{
  #listeners = new Set<ExternalDropListener>();
  #resolver: ExternalFileDropResolver | null;

  constructor(options: InMemoryFileDropOptions = {}) {
    this.#resolver = options.resolver ?? null;
  }

  /** Replace the byte resolver (native invoke binding arrives at bootstrap). */
  setResolver(resolver: ExternalFileDropResolver | null): void {
    this.#resolver = resolver;
  }

  listen(listener: ExternalDropListener): { dispose(): void } {
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  /** Direct emit for tests and adapters that already built typed events. */
  emit(event: ExternalDropEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // Listener failures must not break drop dispatch.
      }
    }
  }

  /**
   * Ingest one native event from the direct-eval hook. Malformed payloads
   * are ignored. Drop files become lazy `ExternalDropFile` handles whose
   * `readBytes()` resolves through the injected resolver.
   */
  handleNativeEvent(event: FileDropNativeEventName | string, payload: unknown): void {
    if (event === 'enter' || event === 'over') {
      const position = asPosition(payload);
      if (position === null) return;
      this.emit({ type: event, position });
      return;
    }
    if (event === 'leave') {
      this.emit({ type: 'leave' });
      return;
    }
    if (event === 'drop') {
      if (!isPlainObject(payload)) return;
      const position = asPosition(payload);
      if (position === null) return;
      const rawFiles = payload.files;
      if (!Array.isArray(rawFiles) || rawFiles.length === 0) return;
      const files: ExternalDropFile[] = [];
      for (const raw of rawFiles) {
        const parsed = asNativeFile(raw);
        if (parsed === null) continue;
        files.push(this.toDropFile(parsed));
      }
      if (files.length === 0) return;
      this.emit({ type: 'drop', position, files });
    }
  }

  private toDropFile(native: NativeFileDropFilePayload): ExternalDropFile {
    return {
      name: native.name,
      ...(native.mimeType !== undefined ? { mimeType: native.mimeType } : {}),
      ...(native.size !== undefined ? { size: native.size } : {}),
      readBytes: async () => {
        // Resolve the transport lazily: the native invoke binding may
        // arrive after the drop event was emitted.
        const resolver = this.#resolver;
        if (resolver === null) {
          throw new Error('no file-drop resolver (native host not bound)');
        }
        const bytes = await resolver.readBytes(native.token);
        return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      },
      release: () => {
        try {
          void this.#resolver?.release?.(native.token);
        } catch {
          // Release is best-effort; a failed cancel must not break the UI.
        }
      },
    };
  }
}
