/**
 * CrashLoop tracker and Safe Mode decision per spec.
 *
 * Thresholds: 3 failures within 10 min or 2 consecutive boot failures
 * marks slot inactive and contributes to safe-mode.
 */

export interface FailureEvent {
  readonly slotId: string;
  readonly atMillis: number;
  readonly phase: 'activation' | 'runtime' | 'boot';
  readonly message: string;
}

export interface CrashLoopState {
  readonly failures: readonly FailureEvent[];
  readonly crashLoopSlots: ReadonlySet<string>;
  readonly consecutiveBootFailures: number;
}

export class CrashLoopTracker {
  #failures: FailureEvent[] = [];
  #crashLoopSlots = new Set<string>();
  #consecutiveBootFailures = 0;

  readonly windowMs: number;
  readonly maxFailures: number;
  readonly maxBootFailures: number;

  constructor(opts: { windowMs?: number; maxFailures?: number; maxBootFailures?: number } = {}) {
    this.windowMs = opts.windowMs ?? 10 * 60 * 1000;
    this.maxFailures = opts.maxFailures ?? 3;
    this.maxBootFailures = opts.maxBootFailures ?? 2;
  }

  record(event: FailureEvent): void {
    this.#failures.push(event);
    // Prune outside window for this slot.
    const cutoff = event.atMillis - this.windowMs;
    const recentForSlot = this.#failures.filter((f) => f.slotId === event.slotId && f.atMillis >= cutoff);
    if (recentForSlot.length >= this.maxFailures) {
      this.#crashLoopSlots.add(event.slotId);
    }
    if (event.phase === 'boot') {
      this.#consecutiveBootFailures++;
    }
  }

  recordBootSuccess(): void {
    this.#consecutiveBootFailures = 0;
  }

  isCrashLoop(slotId: string): boolean {
    return this.#crashLoopSlots.has(slotId);
  }

  shouldEnterSafeMode(): boolean {
    return this.#crashLoopSlots.size > 0 || this.#consecutiveBootFailures >= this.maxBootFailures;
  }

  getState(): CrashLoopState {
    return {
      failures: [...this.#failures],
      crashLoopSlots: new Set(this.#crashLoopSlots),
      consecutiveBootFailures: this.#consecutiveBootFailures,
    };
  }

  clear(slotId: string): void {
    this.#crashLoopSlots.delete(slotId);
    this.#failures = this.#failures.filter((f) => f.slotId !== slotId);
  }
}

export const MINIMAL_SAFE_MODE_PLUGINS = [
  'froglight.workspace',
  'froglight.vault',
  'froglight.markdown',
  'froglight.settings',
  'froglight.diagnostics',
] as const;

export function shouldMountInSafeMode(pluginId: string, isCrashLoop: boolean): boolean {
  if (!isCrashLoop) return true;
  const minimalIds = new Set<string>(MINIMAL_SAFE_MODE_PLUGINS as unknown as string[]);
  return minimalIds.has(pluginId);
}

/**
 * Filter a list of plugin ids for safe-mode boot.
 * In safe mode, only minimal plugins are mounted; third-party slots remain
 * inactive until explicitly re-enabled.
 */
export function filterForSafeMode(pluginIds: readonly string[], tracker: CrashLoopTracker): readonly string[] {
  if (!tracker.shouldEnterSafeMode()) return pluginIds;
  const minimal = new Set<string>(MINIMAL_SAFE_MODE_PLUGINS as unknown as string[]);
  return pluginIds.filter((id) => minimal.has(id));
}
