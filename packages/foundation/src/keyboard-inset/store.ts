/**
 * Host-independent keyboard-inset state machine.
 *
 * Ports the event/state core of the reference virtual-keyboard guest code
 * (direct-eval ingestion, target reconciliation, swap-gap debounce,
 * persisted reserved height) without DOM, storage globals, or framework
 * signals: persistence and the hide/show transport are injected, and state
 * flows out through explicit listener sets.
 */

import {
  KEYBOARD_INSET_FALLBACK_HEIGHT,
  KEYBOARD_INSET_SETTLE_DEBOUNCE_MS,
  KEYBOARD_INSET_STORAGE_KEY,
  noopKeyboardInsetTransport,
  readKeyboardInsetMeasurement,
  reconcileKeyboardInsetTarget,
  type KeyboardInsetListener,
  type KeyboardInsetService,
  type KeyboardInsetSettledListener,
  type KeyboardInsetSnapshot,
  type KeyboardInsetTargetEvent,
  type KeyboardInsetTargetListener,
  type KeyboardInsetTransport,
  type KeyboardInsetWillHideListener,
} from './contract.js';

export interface KeyboardInsetStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Injectable one-shot timer. Foundation ships without DOM/Node libs, so
 * the debounce never touches the `setTimeout` global directly: hosts and
 * tests run wherever they already run.
 */
export interface KeyboardInsetTimer {
  schedule(task: () => void, delayMs: number): { cancel(): void };
}

type GlobalTimerScope = {
  setTimeout(task: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

const globalTimer: KeyboardInsetTimer = {
  schedule(task, delayMs) {
    const scope = globalThis as unknown as GlobalTimerScope;
    const handle = scope.setTimeout(task, delayMs);
    let done = false;
    return {
      cancel: () => {
        if (done) return;
        done = true;
        scope.clearTimeout(handle);
      },
    };
  },
};

export interface KeyboardInsetStoreOptions {
  readonly transport?: KeyboardInsetTransport;
  /** Injectable persistence; omit for memory-only (tests, headless). */
  readonly storage?: KeyboardInsetStorage | null;
  readonly settleDebounceMs?: number;
  readonly timer?: KeyboardInsetTimer;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function readPayload(payload: unknown): {
  height: number | null;
  durationMs: number | null;
} {
  if (typeof payload !== 'object' || payload === null) {
    return { height: null, durationMs: null };
  }
  const record = payload as Record<string, unknown>;
  const height = toFiniteNumber(record.height);
  const durationMs = toFiniteNumber(record.durationMs);
  return {
    height: height !== null && height >= 0 ? height : null,
    durationMs: durationMs !== null && durationMs >= 0 ? durationMs : null,
  };
}

export class KeyboardInsetStore implements KeyboardInsetService {
  private height = 0;
  private open = false;
  private settledHeight = 0;
  private readonly transport: KeyboardInsetTransport;
  private readonly storage: KeyboardInsetStorage | null;
  private readonly settleDebounceMs: number;
  private readonly timer: KeyboardInsetTimer;
  private settleTask: { cancel(): void } | undefined;

  private readonly snapshotListeners = new Set<KeyboardInsetListener>();
  private readonly targetListeners = new Set<KeyboardInsetTargetListener>();
  private readonly willHideListeners = new Set<KeyboardInsetWillHideListener>();
  private readonly settledListeners = new Set<KeyboardInsetSettledListener>();

  constructor(options: KeyboardInsetStoreOptions = {}) {
    this.transport = options.transport ?? noopKeyboardInsetTransport;
    this.storage = options.storage ?? null;
    this.settleDebounceMs =
      options.settleDebounceMs ?? KEYBOARD_INSET_SETTLE_DEBOUNCE_MS;
    this.timer = options.timer ?? globalTimer;
    if (this.storage !== null) {
      const stored = Number(this.storage.getItem(KEYBOARD_INSET_STORAGE_KEY));
      if (Number.isFinite(stored) && stored > 0) this.settledHeight = stored;
    }
  }

  snapshot(): KeyboardInsetSnapshot {
    return {
      height: this.height,
      isOpen: this.open,
      reservedHeight: this.settledHeight || KEYBOARD_INSET_FALLBACK_HEIGHT,
    };
  }

  subscribe(listener: KeyboardInsetListener): () => void {
    this.snapshotListeners.add(listener);
    return () => {
      this.snapshotListeners.delete(listener);
    };
  }

  onTargetChange(listener: KeyboardInsetTargetListener): () => void {
    this.targetListeners.add(listener);
    return () => {
      this.targetListeners.delete(listener);
    };
  }

  onWillHide(listener: KeyboardInsetWillHideListener): () => void {
    this.willHideListeners.add(listener);
    return () => {
      this.willHideListeners.delete(listener);
    };
  }

  onSettled(listener: KeyboardInsetSettledListener): () => void {
    this.settledListeners.add(listener);
    return () => {
      this.settledListeners.delete(listener);
    };
  }

  handleNativeEvent(event: string, payload: unknown): void {
    switch (event) {
      case 'target':
      case 'willShow': {
        // `willShow` is the legacy native name for a target update.
        // A target is always a positive occlusion: zero is not an open
        // keyboard, so zero-height targets are rejected and closes travel
        // the willHide/didHide lifecycle instead.
        const { height, durationMs } = readPayload(payload);
        if (height === null || height <= 0) return;
        this.cancelQueuedSettled();
        // Exact geometry is authoritative: trust it directly. Hint
        // geometry (Android animation-start approximations, older payloads
        // without a measurement) may reconcile against settled history.
        // No platform detection lives here — the payload declares itself.
        const measurement = readKeyboardInsetMeasurement(payload);
        const reconciled =
          measurement === 'exact'
            ? height
            : reconcileKeyboardInsetTarget(height, this.settledHeight);
        this.setState(reconciled, true);
        this.announceTarget(reconciled, durationMs ?? 0, measurement);
        break;
      }
      case 'willHide': {
        const { durationMs } = readPayload(payload);
        // Intent listeners must run while the previous open geometry is still
        // observable. The UI shell uses this callback to start the native-
        // duration hide FLIP; publishing the closed snapshot first would make
        // its snapshot backstop perform an immediate zero-duration correction
        // and consume the geometry before the animated callback can use it.
        for (const listener of this.willHideListeners) {
          listener({ durationMs: durationMs ?? 0 });
        }
        this.applyClosed();
        break;
      }
      case 'settled':
      case 'didShow': {
        // `didShow` is the legacy native name for a settled report. A zero
        // settled height normalizes to closed semantics; only positive
        // geometry feeds the reserved-height debounce.
        const { height } = readPayload(payload);
        if (height === null) return;
        if (height <= 0) {
          this.applyClosed();
          break;
        }
        this.setState(height, true);
        this.queueSettled(height);
        break;
      }
      case 'didHide': {
        // Authoritative final close even when willHide was missed: cancel
        // any queued positive settle so it cannot restore open state after
        // the debounce expires.
        this.applyClosed();
        break;
      }
      case 'change': {
        // Web `visualViewport` fallback: a settled report. Gap reports from
        // keyboard swaps land here carrying heights the keyboard never
        // takes, so the swap-gap debounce below must keep filtering those —
        // this never announces a target.
        const { height } = readPayload(payload);
        if (height === null) return;
        this.setState(height, height > 0);
        this.queueSettled(height);
        break;
      }
      default:
        break;
    }
  }

  hide(): void {
    if (!this.open) return;
    void this.transport.hide();
  }

  show(): void {
    void this.transport.show();
  }

  /** Test/headless teardown: drop timers and listeners, keep heights. */
  dispose(): void {
    this.cancelQueuedSettled();
    this.snapshotListeners.clear();
    this.targetListeners.clear();
    this.willHideListeners.clear();
    this.settledListeners.clear();
  }

  private announceTarget(
    height: number,
    durationMs: number,
    measurement: KeyboardInsetTargetEvent['measurement'],
  ): void {
    const event: KeyboardInsetTargetEvent = {
      height,
      durationMs,
      measurement,
    };
    for (const listener of this.targetListeners) listener(event);
  }

  private setState(nextHeight: number, nextOpen: boolean): void {
    this.height = nextHeight;
    this.open = nextOpen;
    const snapshot = this.snapshot();
    for (const listener of this.snapshotListeners) listener(snapshot);
  }

  /**
   * Final closed state: drop any queued positive settle, then close. Every
   * authoritative close funnels through here so a missed willHide cannot
   * leave a stale settle behind.
   */
  private applyClosed(): void {
    this.cancelQueuedSettled();
    this.setState(0, false);
  }

  /**
   * Adopt a settled height as the reserved height. Only settled heights
   * (`didShow`/`change`) qualify — the `willShow` target can overshoot
   * where the IME actually settles. The latest settled value wins, not a
   * running maximum: one over-reported settle would otherwise stick
   * forever.
   */
  private adoptHeight(candidate: number): void {
    if (candidate <= 0 || candidate === this.settledHeight) return;
    this.settledHeight = candidate;
    try {
      this.storage?.setItem(KEYBOARD_INSET_STORAGE_KEY, String(candidate));
    } catch {
      // Persistence is a hint; layout must never fail on a quota error.
    }
  }

  /**
   * Adopt and forward a settled report only if it survives the debounce
   * window. A reopen landing between the hide/show animations of a
   * keyboard swap dispatches gap insets carrying the animation hint —
   * acting immediately would glide to a height the keyboard never takes
   * and poison the settled height that `willShow` targets reconcile
   * against. An animation's own `didShow`/`didHide` supersedes it.
   */
  private queueSettled(height: number): void {
    this.cancelQueuedSettled();
    this.settleTask = this.timer.schedule(() => {
      this.settleTask = undefined;
      this.adoptHeight(height);
      for (const listener of this.settledListeners) listener(height);
    }, this.settleDebounceMs);
  }

  private cancelQueuedSettled(): void {
    this.settleTask?.cancel();
    this.settleTask = undefined;
  }
}
