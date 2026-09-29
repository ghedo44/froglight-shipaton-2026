/**
 * Pure reconciliation plan for raw-file preview view registrations.
 *
 * Preview views are registered on first open and must survive as long as any
 * tab references them: dispose registrations whose last tab is gone, dispose
 * and re-register when the underlying reader was replaced (provider swap),
 * and (re-)ensure registrations for restored or unknown preview tabs. The
 * hook in `usePreviewViews` executes the plan; this module computes it so the
 * orphan / restore / replacement / shared-tab cases are unit-testable.
 */

export interface PreviewRegistrationState {
  /** The reader the registration was built against. */
  readonly reader: unknown;
}

export interface PreviewReconciliationPlan {
  /** Registered view ids to dispose (orphans and stale-reader entries). */
  readonly disposeViewIds: string[];
  /** Vault paths to (re-)register, without the view-id prefix. */
  readonly ensurePaths: string[];
}

export function planPreviewReconciliation(input: {
  /** View ids referenced by live tabs (may contain non-preview views). */
  readonly referencedViewIds: readonly string[];
  /** Current registrations by view id. */
  readonly registered: ReadonlyMap<string, PreviewRegistrationState>;
  /** The current raw-file reader; registrations built against another reader are stale. */
  readonly currentReader: unknown;
  /** View-id prefix identifying raw-file previews. */
  readonly prefix: string;
}): PreviewReconciliationPlan {
  const { referencedViewIds, registered, currentReader, prefix } = input;
  const referenced = new Set(
    referencedViewIds.filter((viewId) => viewId.startsWith(prefix)),
  );
  const disposeViewIds: string[] = [];
  for (const [viewId, registration] of registered) {
    if (!referenced.has(viewId) || registration.reader !== currentReader) {
      disposeViewIds.push(viewId);
    }
  }
  const disposed = new Set(disposeViewIds);
  const ensurePaths: string[] = [];
  for (const viewId of referenced) {
    if (!registered.has(viewId) || disposed.has(viewId)) {
      ensurePaths.push(viewId.slice(prefix.length));
    }
  }
  return { disposeViewIds, ensurePaths };
}
