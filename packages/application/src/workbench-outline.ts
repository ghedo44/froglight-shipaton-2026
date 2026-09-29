/**
 * Production outline seam for the workbench controller.
 *
 * The shell (`WorkspaceView`) reads outline data through the UI-owned
 * structural port `WorkbenchOutlineProviderLike` (`outlineRegistry` plus
 * `getOutlineModel`); this module is the application-side filler that keeps
 * the dependency direction intact (`@froglight/ui` never imports
 * `@froglight/application` — the port is satisfied structurally, never by a
 * shared type import).
 *
 * The registry instance is owned by the `WorkbenchController`: it is created
 * with the controller, carries the same first-party extractors as the
 * runtime `outlineExtractorsPlugin` bundle (markdown, block page, notebook,
 * LaTeX, PDF stub), and its registrations are disposed with the controller
 * (activate → one registration per kind, dispose → zero). The canonical
 * effect-owned bundle remains `outlineExtractorsPlugin`; this mirror exists
 * only because the controller has no service-locator access to the runtime
 * registry, and consumers must still resolve extractors via
 * `outlineRegistryToken` / `OutlineRegistry.get` — never via this module's
 * shape.
 *
 * Headless and engine-free: plain data only, no CodeMirror/Tiptap/DOM types
 * cross this seam. Outline rows are derived memo data, never persisted.
 */

import {
  firstPartyOutlineExtractors,
  InMemoryOutlineRegistry,
} from './outline/registry.js';

/**
 * Build the controller-owned outline registry with the first-party extractors
 * used by the runtime plugin bundle.
 */
export function createWorkbenchOutlineRegistry(): {
  readonly registry: InMemoryOutlineRegistry;
  dispose(): void;
} {
  const registry = new InMemoryOutlineRegistry();
  const disposers = firstPartyOutlineExtractors.map((extractor) =>
    registry.register(extractor),
  );
  return {
    registry,
    dispose: () => {
      for (const disposer of disposers) {
        try {
          disposer.dispose();
        } catch {
          // Disposal is best-effort cache/registration hygiene; a failing
          // disposer must never break controller teardown.
        }
      }
    },
  };
}
