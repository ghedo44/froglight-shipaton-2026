/**
 * Native file-drop host adapter (`froglight.file-drop`).
 *
 * Thin `apps/native` bridge over the shared capability: the resolver runs
 * the trusted `froglight-file-drop` plugin commands through Tauri invoke,
 * and the direct-eval hook installed here feeds native drop events into
 * the host-owned service. Community plugins never touch this module — they
 * observe the eventual vault resource through normal Froglight APIs, never
 * temporary native tokens or URIs.
 */

import {
  FILE_DROP_NATIVE_EVENT_CHANNEL,
  createFileDropHost,
  type ExternalFileDropService,
  type FileDropHost,
} from '@froglight/foundation';

/**
 * Trusted-side invoke names for the stateful native file-drop commands.
 * Like the keyboard-inset hide/show commands, the raw plugin command
 * strings live in the native shell — never in the shared foundation
 * contract community plugins consume.
 */
export const FILE_DROP_READ_COMMAND =
  'plugin:froglight-file-drop|read_drop_file';
export const FILE_DROP_RELEASE_COMMAND =
  'plugin:froglight-file-drop|release_drop_file';

type InvokeFn = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

function toBytes(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (Array.isArray(raw)) return new Uint8Array(raw as number[]);
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  throw new Error('malformed file-drop bytes from native host');
}

/**
 * Host object for the native shell: capability definition for
 * `extraPlugins` plus the service the event forwarder feeds. Pass a fake
 * `call` in tests/headless shells.
 */
export function createNativeFileDrop(
  call?: InvokeFn,
): FileDropHost {
  const invoke = call ?? defaultInvoke;
  return createFileDropHost({
    resolver: {
      readBytes: async (token: string) => {
        const raw = await invoke(FILE_DROP_READ_COMMAND, { token });
        return toBytes(raw);
      },
      release: (token: string) => {
        void invoke(FILE_DROP_RELEASE_COMMAND, { token }).catch(() => undefined);
      },
    },
  });
}

async function defaultInvoke(
  command: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(command, args);
}

type EventHookTarget = Record<string, unknown>;

/**
 * Install the direct-eval entry point the Android host calls into (see the
 * native plugin `emit`). Idempotent per target; returns an uninstaller
 * that removes exactly the hook it installed. No-op without a DOM window
 * (desktop/headless shells never receive native drop events until a
 * gap-driven backend lands — the HTML5 path stays primary there).
 */
export function installNativeFileDropEventForwarder(
  service: ExternalFileDropService,
  target?: EventHookTarget,
): () => void {
  const scope =
    target ??
    (typeof window === 'undefined'
      ? null
      : (window as unknown as EventHookTarget));
  if (scope === null) return () => undefined;
  const previous = scope[FILE_DROP_NATIVE_EVENT_CHANNEL];
  const hook = (event: unknown, payload: unknown) => {
    if (typeof event !== 'string') return;
    service.handleNativeEvent(event, payload);
  };
  scope[FILE_DROP_NATIVE_EVENT_CHANNEL] = hook;
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    if (scope[FILE_DROP_NATIVE_EVENT_CHANNEL] === hook) {
      if (previous === undefined) delete scope[FILE_DROP_NATIVE_EVENT_CHANNEL];
      else scope[FILE_DROP_NATIVE_EVENT_CHANNEL] = previous;
    }
  };
}
