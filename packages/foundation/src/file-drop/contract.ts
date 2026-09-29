/**
 * External file-drop capability contract (`froglight.file-drop`).
 *
 * External file ingress — not general drag mechanics. The browser/WebView
 * HTML5 path stays primary wherever it works; native hosts feed the same
 * UI through this token only where the WebView cannot reliably produce
 * `File` objects (initially Android `ClipData`/content URIs).
 *
 * Native handles are opaque temporary tokens: shared application code
 * never sees filesystem paths or `content://` URIs, and whole files are
 * never sent as base64 through JS evaluation. Reading is lazy via
 * `readBytes()` so tokens can expire and permissions stay host-owned.
 *
 * Host- and framework-free: no Tauri, DOM, React, or Android types leak
 * into the service surface. Community plugins never receive this token —
 * they observe the eventual vault resource through normal Froglight APIs.
 */

export interface ExternalDropFile {
  readonly name: string;
  readonly mimeType?: string;
  readonly size?: number;
  readBytes(): Promise<Uint8Array>;
  /**
   * Deterministic cleanup when an import is rejected or cancelled.
   * Native handles release their token/permission; browser files omit it.
   * Successful `readBytes()` already consumes the token server-side, so
   * callers only need this for drops that are never read.
   */
  release?(): Promise<void> | void;
}

export interface ExternalDropPosition {
  readonly x: number;
  readonly y: number;
}

export type ExternalDropEvent =
  | {
      readonly type: 'enter' | 'over';
      readonly position: ExternalDropPosition;
    }
  | {
      readonly type: 'leave';
    }
  | {
      readonly type: 'drop';
      readonly position: ExternalDropPosition;
      readonly files: readonly ExternalDropFile[];
    };

export type ExternalDropListener = (event: ExternalDropEvent) => void;

/**
 * Stable external file-drop service behind `externalFileDropToken`.
 * Framework- and host-free: native hosts feed events via
 * `handleNativeEvent` (direct-eval hook) or `emit`, the web host leaves
 * the token unbound and keeps its `DataTransfer` path.
 */
export interface ExternalFileDropService {
  listen(listener: ExternalDropListener): { dispose(): void };
  /**
   * Ingest one native event from the trusted direct-eval hook.
   * Malformed payloads are ignored. Community plugins observe only
   * `listen`; this entry point is for the native shell adapter.
   */
  handleNativeEvent(
    event: FileDropNativeEventName | string,
    payload: unknown,
  ): void;
}

/** Direct-eval hook name the native hosts call into. */
export const FILE_DROP_NATIVE_EVENT_CHANNEL = '__FROGLIGHT_FILE_DROP_EVENT__';

export type FileDropNativeEventName = 'enter' | 'over' | 'leave' | 'drop';

/** Wire payload for one native file handle (opaque token, never a URI). */
export interface NativeFileDropFilePayload {
  readonly token: string;
  readonly name: string;
  readonly mimeType?: string;
  readonly size?: number;
}

/** Wire payload for native position phases. */
export interface NativeFileDropPositionPayload {
  readonly x?: unknown;
  readonly y?: unknown;
  readonly files?: unknown;
}

/**
 * Host-provided byte resolver. Implemented with Tauri invoke on native
 * (`plugin:froglight-file-drop|read_drop_file`), faked in tests. The
 * shared contract never names the raw plugin command — like the
 * keyboard-inset hide/show commands, it lives in the native shell.
 */
export interface ExternalFileDropResolver {
  readBytes(token: string): Promise<Uint8Array>;
  release?(token: string): Promise<void> | void;
}
