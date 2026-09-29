import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { ReactElement } from 'react';

/**
 * Isolated React roots for provider-owned DOM branches.
 *
 * Permanent provider infrastructure: document readers and editor providers
 * own isolated React roots inside their opaque hosts, commit once
 * synchronously at creation, and unmount before engine teardown. It must
 * never be used to paper over a presentation contract — views, sections,
 * and panels register components directly.
 *
 * In-repo editor providers inline this same pattern instead of importing it
 * so provider packages never depend on the UI package; this module is the
 * sanctioned seam for trusted document readers and external trusted
 * provider plugins.
 *
 * Ownership (strict):
 *
 * - one live root per container; mounting while one is live throws —
 *   dispose the previous owner first;
 * - dispose is idempotent and never unmounts another owner's root: a stale
 *   disposer releases nothing when the container no longer maps to its root;
 * - the single synchronous commit happens inside this helper during
 *   creation — callers must not wrap it in another `flushSync`, and never
 *   commit during normal rendering or engine updates;
 * - callers unmount (dispose) before tearing down the engine that consumes
 *   the committed elements.
 */
const liveRoots = new WeakMap<HTMLElement, Root>();

export function mountIsolatedReactRoot(
  container: HTMLElement,
  node: ReactElement,
): { render(node: ReactElement): void; dispose(): void } {
  if (liveRoots.get(container) !== undefined) {
    throw new Error(
      'mountIsolatedReactRoot: container already hosts a live React root — dispose it first',
    );
  }
  container.replaceChildren();
  const root = createRoot(container);
  liveRoots.set(container, root);
  // The single synchronous commit for this root: callers and
  // their specs own the container and read it back immediately.
  flushSync(() => {
    root.render(node);
  });
  let disposed = false;
  return {
    render(next) {
      if (!disposed && liveRoots.get(container) === root) root.render(next);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // A stale disposer must never unmount a newer owner's root.
      if (liveRoots.get(container) !== root) return;
      liveRoots.delete(container);
      root.unmount();
    },
  };
}
