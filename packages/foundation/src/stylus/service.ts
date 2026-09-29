/**
 * In-memory stylus service.
 *
 * Host bootstrap state owns one instance; activation provides the token
 * binding (withdrawn on dispose) while the service keeps observed
 * capabilities across reactivations. Malformed native payloads are
 * ignored; valid accessory actions fan out to subscribers.
 */

import {
  DEFAULT_STYLUS_CAPABILITIES,
  DEFAULT_STYLUS_DEVICE_CAPABILITIES,
  observedPenFlags,
  type StylusAction,
  type StylusActionListener,
  type StylusCapabilities,
  type StylusCapabilitiesListener,
  type StylusDeviceCapabilities,
  type StylusDeviceCapabilitiesListener,
  type StylusNativeEventName,
  type StylusObservedPenSample,
  type StylusPreferredAction,
  type StylusService,
  type StylusInputContext,
  type StylusViewportAnchor,
} from './contract.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asCapabilities(payload: unknown): StylusCapabilities | null {
  if (!isPlainObject(payload)) return null;
  const read = (key: keyof StylusCapabilities): boolean | null => {
    const value = payload[key as string];
    return typeof value === 'boolean' ? value : null;
  };
  const available = read('available');
  const pressure = read('pressure');
  const tilt = read('tilt');
  const twist = read('twist');
  const hover = read('hover');
  const eraser = read('eraser');
  const barrelButton = read('barrelButton');
  const doubleTap = read('doubleTap');
  const squeeze = read('squeeze');
  if (
    available === null ||
    pressure === null ||
    tilt === null ||
    twist === null ||
    hover === null ||
    eraser === null ||
    barrelButton === null ||
    doubleTap === null ||
    squeeze === null
  ) {
    return null;
  }
  return {
    available,
    pressure,
    tilt,
    twist,
    hover,
    eraser,
    barrelButton,
    doubleTap,
    squeeze,
  };
}

const KNOWN_PREFERRED_ACTIONS: ReadonlySet<string> = new Set([
  'ignore',
  'switchEraser',
  'switchPrevious',
  'showColorPalette',
  'showInkAttributes',
  'showContextualPalette',
  'runSystemShortcut',
  'unknown',
]);

function asPreferredAction(value: unknown): StylusPreferredAction | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return 'unknown';
  if (KNOWN_PREFERRED_ACTIONS.has(value)) {
    return value as StylusPreferredAction;
  }
  // Unknown future values must not break event delivery.
  return 'unknown';
}

function asAnchor(value: unknown): StylusViewportAnchor | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) return undefined;
  const x = (value as Record<string, unknown>).x;
  const y = (value as Record<string, unknown>).y;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  ) {
    // Malformed positioning discards only the anchor, never the event.
    return undefined;
  }
  return { x, y };
}

function asAction(payload: unknown): StylusAction | null {
  if (!isPlainObject(payload)) return null;
  const type = payload.type;
  if (type === 'doubleTap') {
    const action: {
      type: 'doubleTap';
      preferredAction?: StylusPreferredAction;
      anchor?: StylusViewportAnchor;
    } = { type: 'doubleTap' };
    const preferredAction = asPreferredAction(payload.preferredAction);
    if (preferredAction !== undefined) action.preferredAction = preferredAction;
    const anchor = asAnchor(payload.anchor);
    if (anchor !== undefined) action.anchor = anchor;
    return action;
  }
  if (type === 'squeeze') {
    const phase = payload.phase;
    if (
      phase !== undefined &&
      phase !== 'began' &&
      phase !== 'changed' &&
      phase !== 'ended' &&
      phase !== 'cancelled'
    ) {
      return null;
    }
    const preferredAction = asPreferredAction(payload.preferredAction);
    const anchor = asAnchor(payload.anchor);
    if (phase === undefined && preferredAction === undefined && anchor === undefined) {
      return { type: 'squeeze' };
    }
    return {
      type: 'squeeze' as const,
      ...(phase !== undefined ? { phase } : {}),
      ...(preferredAction !== undefined ? { preferredAction } : {}),
      ...(anchor !== undefined ? { anchor } : {}),
    };
  }
  if (type === 'primaryButton' || type === 'secondaryButton') {
    return typeof payload.pressed === 'boolean'
      ? { type, pressed: payload.pressed }
      : null;
  }
  if (type === 'eraser' || type === 'proximity') {
    return typeof payload.active === 'boolean'
      ? { type, active: payload.active }
      : null;
  }
  return null;
}

export class InMemoryStylusService implements StylusService {
  #inputOwners = new Map<symbol, Exclude<StylusInputContext, 'default'>>();
  #inputContext: StylusInputContext = 'default';
  #inputListeners = new Set<(context: StylusInputContext) => void>();

  inputContext(): StylusInputContext {
    return this.#inputContext;
  }

  onInputContextChange(
    listener: (context: StylusInputContext) => void,
  ): () => void {
    this.#inputListeners.add(listener);
    return () => {
      this.#inputListeners.delete(listener);
    };
  }

  acquireInputContext(
    context: Exclude<StylusInputContext, 'default'>,
  ): () => void {
    if (context !== 'drawing' && context !== 'text-entry') {
      throw new TypeError('Invalid stylus input ownership context');
    }
    const owner = Symbol();
    this.#inputOwners.set(owner, context);
    this.#publishInputContext();
    return () => {
      if (!this.#inputOwners.delete(owner)) return;
      this.#publishInputContext();
    };
  }

  #publishInputContext(): void {
    const contexts = [...this.#inputOwners.values()];
    const next = contexts.includes('text-entry')
      ? 'text-entry'
      : contexts.length > 0
        ? 'drawing'
        : 'default';
    if (next === this.#inputContext) return;
    this.#inputContext = next;
    for (const listener of [...this.#inputListeners]) {
      try {
        listener(next);
      } catch {
        // A host failure must not prevent owner cleanup or local editing.
      }
    }
  }

  #capabilities: StylusCapabilities;
  #capabilityListeners = new Set<StylusCapabilitiesListener>();
  #actionListeners = new Set<StylusActionListener>();
  #device: StylusDeviceCapabilities = {
    ...DEFAULT_STYLUS_DEVICE_CAPABILITIES,
  };
  #deviceListeners = new Set<StylusDeviceCapabilitiesListener>();

  constructor(initial: StylusCapabilities = DEFAULT_STYLUS_CAPABILITIES) {
    this.#capabilities = { ...initial };
  }

  capabilities(): StylusCapabilities {
    return { ...this.#capabilities };
  }

  onCapabilitiesChange(listener: StylusCapabilitiesListener): () => void {
    this.#capabilityListeners.add(listener);
    return () => {
      this.#capabilityListeners.delete(listener);
    };
  }

  onAction(listener: StylusActionListener): () => void {
    this.#actionListeners.add(listener);
    return () => {
      this.#actionListeners.delete(listener);
    };
  }

  deviceCapabilities(): StylusDeviceCapabilities {
    return { ...this.#device };
  }

  onDeviceChange(listener: StylusDeviceCapabilitiesListener): () => void {
    this.#deviceListeners.add(listener);
    return () => {
      this.#deviceListeners.delete(listener);
    };
  }

  noteObservedPen(sample: StylusObservedPenSample): void {
    const flags = observedPenFlags(sample);
    if (!flags.connected) return;
    this.#setDevice({
      connected: flags.connected,
      pressure: flags.pressure,
      tilt: flags.tilt,
      twist: flags.twist,
      hover: flags.hover,
      eraser: flags.eraser,
      barrelButton: flags.barrelButton,
    });
  }

  #setDevice(promotions: {
    readonly connected?: boolean;
    readonly pressure?: boolean;
    readonly tilt?: boolean;
    readonly twist?: boolean;
    readonly hover?: boolean;
    readonly eraser?: boolean;
    readonly barrelButton?: boolean;
    readonly doubleTap?: boolean;
    readonly squeeze?: boolean;
  }): void {
    const next: StylusDeviceCapabilities = { ...this.#device };
    let changed = false;
    for (const [key, observed] of Object.entries(promotions)) {
      const flag = key as keyof StylusDeviceCapabilities;
      if (observed === true && next[flag] !== true) {
        (next as unknown as Record<string, unknown>)[flag] = true;
        changed = true;
      }
    }
    if (!changed) return;
    this.#device = next;
    for (const listener of [...this.#deviceListeners]) {
      try {
        listener({ ...next });
      } catch {
        // Listener failures must not break accessory dispatch.
      }
    }
  }

  #promoteDevice(key: keyof StylusDeviceCapabilities): void {
    this.#setDevice({ [key]: true } as {
      readonly [K in keyof StylusDeviceCapabilities]?: boolean;
    });
  }

  handleNativeEvent(event: StylusNativeEventName, payload: unknown): void {
    if (event === 'capabilities') {
      const capabilities = asCapabilities(payload);
      if (capabilities === null) return;
      this.#capabilities = capabilities;
      for (const listener of [...this.#capabilityListeners]) {
        try {
          listener({ ...capabilities });
        } catch {
          // Listener failures must not break accessory dispatch.
        }
      }
      return;
    }
    if (event === 'action') {
      const action = asAction(payload);
      if (action === null) return;
      // Any valid native accessory action proves a stylus exists.
      this.#promoteDevice('connected');
      // Accessory actions are observed-hardware evidence.
      if (action.type === 'doubleTap') this.#promoteDevice('doubleTap');
      else if (action.type === 'squeeze') this.#promoteDevice('squeeze');
      else if (action.type === 'eraser' && action.active)
        this.#promoteDevice('eraser');
      else if (
        (action.type === 'primaryButton' ||
          action.type === 'secondaryButton') &&
        action.pressed
      )
        this.#promoteDevice('barrelButton');
      else if (action.type === 'proximity' && action.active)
        this.#promoteDevice('hover');
      for (const listener of [...this.#actionListeners]) {
        try {
          listener(action);
        } catch {
          // Listener failures must not break accessory dispatch.
        }
      }
    }
  }
}
