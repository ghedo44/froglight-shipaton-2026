/**
 * Native stylus host adapter.
 *
 * Thin `apps/native` bridge over the shared `froglight.stylus`
 * capability: the direct-eval hook installed here feeds native accessory
 * actions into the host-owned service, while `get_capabilities` is queried
 * as state after the forwarder installs so a load-time report that fired
 * before bootstrap is never lost. Community plugins never touch this
 * module — they observe accessory state through `stylusToken` only.
 */

import {
  STYLUS_NATIVE_EVENT_CHANNEL,
  createStylusHost,
  type StylusHost,
  type StylusService,
  type StylusInputContext,
  stylusToken,
} from '@froglight/foundation';
import { definePlugin } from '@froglight/runtime';

/**
 * Trusted-side invoke name for the stateful native capability query
 * Like the keyboard-inset hide/show commands, the raw
 * plugin command string lives in the native shell — never in the shared
 * foundation contract community plugins consume.
 */
export const STYLUS_GET_CAPABILITIES_COMMAND =
  'plugin:froglight-stylus|get_capabilities';

/**
 * Host object for the native shell: capability definition for
 * `extraPlugins` plus the service the event forwarder feeds.
 */
export function createNativeStylus(invoke?: InputContextInvoke): StylusHost {
  const host = createStylusHost();
  if (invoke === undefined) return host;
  const setContext = createNativeStylusInputContextAdapter(invoke);
  return {
    service: host.service,
    definition: definePlugin({
      id: host.definition.id,
      activate: (ctx) => {
        ctx.provide(stylusToken, host.service);
        ctx.effect(() => {
          const publish = (context: StylusInputContext): void => {
            void setContext(context).then((ok) => {
              if (!ok)
                console.warn('Native stylus input context update failed');
            });
          };
          const unsubscribe = host.service.onInputContextChange(publish);
          const releaseFocus = installStylusTextEntryFocus(host.service);
          publish(host.service.inputContext());
          return () => {
            releaseFocus();
            unsubscribe();
            publish('default');
          };
        });
      },
    }),
  };
}

export const STYLUS_SET_INPUT_CONTEXT_COMMAND =
  'plugin:froglight-stylus|set_input_context';

type InputContextInvoke = (
  command: string,
  payload: { context: StylusInputContext },
) => Promise<unknown> | unknown;

/** Serialize low-frequency transitions; failed calls remain retryable. */
export function createNativeStylusInputContextAdapter(
  invoke: InputContextInvoke,
) {
  // Seed native state on activation as well as transitions: a JS reload may
  // otherwise inherit the previous page's drawing policy.
  let applied: StylusInputContext | undefined;
  let pending = Promise.resolve(true);
  return (context: StylusInputContext): Promise<boolean> => {
    if (
      context !== 'default' &&
      context !== 'drawing' &&
      context !== 'text-entry'
    ) {
      return Promise.reject(new TypeError('Invalid stylus input context'));
    }
    pending = pending.then(async () => {
      if (context === applied) return true;
      try {
        await invoke(STYLUS_SET_INPUT_CONTEXT_COMMAND, { context });
        applied = context;
        return true;
      } catch {
        return false;
      }
    });
    return pending;
  };
}

/** Allow ordinary focused text controls even when another pane owns drawing. */
export function installStylusTextEntryFocus(
  service: StylusService,
  scope: Document | undefined = typeof document === 'undefined'
    ? undefined
    : document,
): () => void {
  if (scope === undefined) return () => undefined;
  let release: (() => void) | undefined;
  const isTextEntry = (target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return false;
    const control = target.closest('input, textarea, [contenteditable]');
    if (control instanceof HTMLInputElement) {
      return (
        !control.disabled &&
        !control.readOnly &&
        [
          'text',
          'search',
          'email',
          'url',
          'tel',
          'number',
          'password',
        ].includes(control.type)
      );
    }
    if (control instanceof HTMLTextAreaElement)
      return !control.disabled && !control.readOnly;
    return (
      control !== null && control.getAttribute('contenteditable') !== 'false'
    );
  };
  const update = (target: EventTarget | null): void => {
    if (isTextEntry(target))
      release ??= service.acquireInputContext('text-entry');
    else {
      release?.();
      release = undefined;
    }
  };
  const focusIn = (event: FocusEvent): void => update(event.target);
  const focusOut = (event: FocusEvent): void => update(event.relatedTarget);
  scope.addEventListener('focusin', focusIn);
  scope.addEventListener('focusout', focusOut);
  update(scope.activeElement);
  return () => {
    scope.removeEventListener('focusin', focusIn);
    scope.removeEventListener('focusout', focusOut);
    release?.();
    release = undefined;
  };
}

type EventHookTarget = Record<string, unknown>;

/**
 * Install the direct-eval entry point the iPadOS/Android hosts call into
 * (see the native plugin `emit`). Idempotent per target; returns an
 * uninstaller that removes exactly the hook it installed. No-op without a
 * DOM window (desktop/headless shells never receive native events until
 * their gap-driven backends land).
 */
export function installNativeStylusEventForwarder(
  service: StylusService,
  target?: EventHookTarget,
): () => void {
  const scope =
    target ??
    (typeof window === 'undefined'
      ? null
      : (window as unknown as EventHookTarget));
  if (scope === null) return () => undefined;
  const previous = scope[STYLUS_NATIVE_EVENT_CHANNEL];
  const hook = (event: unknown, payload: unknown) => {
    if (typeof event !== 'string') return;
    service.handleNativeEvent(event, payload);
  };
  scope[STYLUS_NATIVE_EVENT_CHANNEL] = hook;
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    if (scope[STYLUS_NATIVE_EVENT_CHANNEL] === hook) {
      if (previous === undefined) delete scope[STYLUS_NATIVE_EVENT_CHANNEL];
      else scope[STYLUS_NATIVE_EVENT_CHANNEL] = previous;
    }
  };
}

type CapabilityQueryFn = (command: string) => Promise<unknown> | unknown;

/**
 * Bootstrap ordering:
 *
 * ```text
 * create StylusService → install forwarder → activate plugin →
 * query get_capabilities() → seed service → receive accessory actions
 * ```
 *
 * Call after installing the forwarder and activating the native plugin.
 * Malformed/absent reports resolve without mutating the service so drawing
 * never breaks on a corrupt native payload.
 */
export async function seedStylusCapabilitiesFromNative(
  service: StylusService,
  query: CapabilityQueryFn,
): Promise<boolean> {
  let raw: unknown;
  try {
    raw = await query(STYLUS_GET_CAPABILITIES_COMMAND);
  } catch {
    return false;
  }
  // Native contract is identical on every platform: Swift/Kotlin return the
  // capability object directly, Rust deserializes it into
  // NativeStylusCapabilities and the Tauri command returns it unchanged.
  // No host-specific shape conversion here.
  const before = service.capabilities();
  service.handleNativeEvent('capabilities', raw);
  const after = service.capabilities();
  return (
    before.available !== after.available ||
    before.pressure !== after.pressure ||
    before.tilt !== after.tilt ||
    before.twist !== after.twist ||
    before.hover !== after.hover ||
    before.eraser !== after.eraser ||
    before.barrelButton !== after.barrelButton ||
    before.doubleTap !== after.doubleTap ||
    before.squeeze !== after.squeeze
  );
}
