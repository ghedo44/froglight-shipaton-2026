export interface NotebookNavigationTiming {
  now(): number;
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(handle: number): void;
  readonly reducedMotion?: boolean;
}

const timingOverrides = new WeakMap<HTMLElement, NotebookNavigationTiming>();

/** Internal deterministic seam; intentionally absent from the package barrel. */
export function installNotebookNavigationTiming(
  host: HTMLElement,
  timing: NotebookNavigationTiming,
): { dispose(): void } {
  timingOverrides.set(host, timing);
  return {
    dispose() {
      timingOverrides.delete(host);
    },
  };
}

export function notebookNavigationTiming(
  host: HTMLElement,
): NotebookNavigationTiming {
  return (
    timingOverrides.get(host) ?? {
      now: () => performance.now(),
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (handle) => cancelAnimationFrame(handle),
      reducedMotion:
        typeof matchMedia === 'function' &&
        matchMedia('(prefers-reduced-motion: reduce)').matches,
    }
  );
}
