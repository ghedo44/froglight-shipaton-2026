/**
 * Fiber diagnostics: activation timing. Diagnostics are runtime-owned derived
 * state, not canonical data.
 */

/** Timing recorded for a fiber's lifecycle. */
export interface FiberTiming {
  /** Monotonic ms at activation start (0 if never activated). */
  readonly activateStart: number;
  /** Monotonic ms at activation completion (0 if never completed). */
  readonly activateEnd: number;
  /** Wall-clock timestamp of activation start (0 if never activated). */
  readonly activatedAt: number;
  /** Monotonic ms at disposal start (0 if never disposed). */
  readonly disposeStart: number;
  /** Monotonic ms at disposal completion (0 if never disposed). */
  readonly disposeEnd: number;
}

/** Read-only diagnostics snapshot owned by a fiber. */
export interface FiberDiagnostics {
  readonly timing: FiberTiming;
}
