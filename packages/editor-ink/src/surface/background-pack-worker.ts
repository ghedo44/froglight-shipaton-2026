/**
 * Shared DOM Worker adapter + production background-pack wiring.
 *
 * Both the cold-compile scheduler (per-renderer, disposed with the
 * renderer) and the low-priority background packing lane (package-level
 * production facility, never per-Surface) use the SAME narrow Worker
 * adapter and the SAME literal Vite-compatible module Worker entry:
 *
 *   new Worker(new URL('./ink-compile.worker.ts', import.meta.url), { type: 'module' })
 *
 * The literal form must stay inline so Vite bundles the worker entry; only
 * the availability guard wraps it. The Worker runs the SAME
 * `compileInkStroke` implementation (no compiler/geometry fork): cold
 * compilation and background packing differ only in scheduling/staleness,
 * never in geometry math.
 *
 * Production facility: `ensureProductionBackgroundPackWorkerInstalled()`
 * installs `setBackgroundPackWorkerFactory(...)` exactly once per package
 * lifetime. It is idempotent — repeated calls (e.g. from successive mounts)
 * never replace the factory, because the Foundation setter terminates the
 * current background Worker when replaced and per-surface registration
 * would cause cross-surface interference. Teardown/destroy never
 * uninstalls it. Worker-unavailable/jsdom/headless environments degrade
 * safely to SKIP (factory returns null → disposable cache miss, never a
 * freeze). Tests inject fakes via the Foundation setter directly; this
 * module never blocks deterministic injection (it only installs when no
 * production install has happened yet in this package lifetime).
 */

import {
  setBackgroundPackWorkerFactory,
  type BackgroundPackWorker,
  type ColdCompileWorker,
  type PackedInkCompileRequest,
  type PackedInkCompileResponse,
} from '@froglight/foundation';

/**
 * DOM `Worker` adapter for the narrow packed-compile protocol. Satisfies
 * both `ColdCompileWorker` and `BackgroundPackWorker` (structurally the
 * same Pick: postMessage/onmessage/onerror/terminate). Forwards the
 * scheduler's protocol onto the real worker port; constructed lazily on
 * first need so documents that never need it pay nothing.
 */
export class DomInkCompileWorker
  implements ColdCompileWorker, BackgroundPackWorker
{
  readonly #worker: Worker;
  #messageHandler:
    | ((event: { data: PackedInkCompileResponse }) => void)
    | null = null;
  #errorHandler: ((event: unknown) => void) | null = null;

  constructor(worker: Worker) {
    this.#worker = worker;
  }

  postMessage(
    message: PackedInkCompileRequest,
    transfer?: readonly ArrayBuffer[],
  ): void {
    // Ownership of the packed buffers transfers to the worker thread —
    // no structured-clone of thousands of sample objects.
    this.#worker.postMessage(
      message,
      transfer === undefined ? [] : [...transfer],
    );
  }

  get onmessage():
    | ((event: { data: PackedInkCompileResponse }) => void)
    | null {
    return this.#messageHandler;
  }

  set onmessage(
    handler: ((event: { data: PackedInkCompileResponse }) => void) | null,
  ) {
    this.#messageHandler = handler;
    this.#worker.onmessage =
      handler === null
        ? null
        : (event: MessageEvent) =>
            handler({ data: event.data as PackedInkCompileResponse });
  }

  get onerror(): ((event: unknown) => void) | null {
    return this.#errorHandler;
  }

  set onerror(handler: ((event: unknown) => void) | null) {
    this.#errorHandler = handler;
    this.#worker.onerror =
      handler === null ? null : (event: Event | string) => handler(event);
  }

  terminate(): void {
    this.#worker.terminate();
  }
}

/**
 * Construct the shared Ink compile Worker, or null when workers are
 * unavailable (jsdom/tests/unsupported hosts fall back safely — cold
 * compilation uses its cooperative main-thread path, background packing
 * SKIPs as a disposable cache miss; file opening/editing never breaks).
 *
 * The `new Worker(new URL(...))` form must stay literal so Vite bundles
 * the worker entry; only the availability guard wraps it.
 */
export function createInkCompileWorker(): ColdCompileWorker | null {
  try {
    if (typeof Worker !== 'function') return null;
    const worker = new Worker(
      new URL('./ink-compile.worker.ts', import.meta.url),
      { type: 'module' },
    );
    return new DomInkCompileWorker(worker);
  } catch {
    return null;
  }
}

/** Alias kept for the cold-compile call site (same shared worker). */
export const createColdCompileWorker = createInkCompileWorker;

/**
 * Background-pack factory used by the production facility (same shared
 * worker entry; the background lane drives the same protocol).
 */
export function createBackgroundPackWorker(): BackgroundPackWorker | null {
  return createInkCompileWorker();
}

let productionBackgroundPackInstalled = false;

/**
 * Install the production background-pack Worker factory exactly once per
 * package lifetime (editor/package-level facility, not per-Surface).
 * Idempotent: repeated calls never replace the factory (which would
 * terminate the live background Worker and cause cross-surface
 * interference). Never uninstalls on Surface destroy.
 */
export function ensureProductionBackgroundPackWorkerInstalled(): void {
  if (productionBackgroundPackInstalled) return;
  productionBackgroundPackInstalled = true;
  try {
    setBackgroundPackWorkerFactory(() => createBackgroundPackWorker());
  } catch {
    // Production wiring never breaks mounting/editing.
    productionBackgroundPackInstalled = false;
  }
}
