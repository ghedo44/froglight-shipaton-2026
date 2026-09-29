/**
 * Workbench-backed dirty-session tracker with fail-closed ownership.
 *
 * The sync engine defers remote materialization for paths with unsaved
 * editor state (`SyncDirtyTracker.isDirty`). Hosts have no session
 * registry of their own: the workspace owns every open `DocumentSession`
 * (dirty/save/reload/close), so this tracker answers per-path dirtiness
 * by resolving the path to its document and borrowing the open session.
 *
 * Pure and total per the contract: never throws, never touches the
 * network, never reports editor-library state — only the session's
 * boolean `dirty` flag.
 *
 * Fail-closed invariant: never overwrite a dirty open session. `isDirty`
 * returns false only when it can PROVE clean:
 *
 * ```text
 * getWorkspace() returns null → clean / false (no sessions to protect)
 * getWorkspace() THROWS → dirty / true
 *   (workspace state unknown is not permission to overwrite; a thrown
 *   lookup means cleanliness cannot be proven)
 * workspace exists AND required lookup unexpectedly fails
 *   → dirty / true (defer remote apply; failure to prove clean is not
 *     permission to overwrite canonical bytes beneath a potentially
 *     dirty editor session)
 * ```
 *
 * Normal missing documents, closed sessions, and clean open sessions
 * remain false; normal dirty open sessions remain true.
 */

import { WORKSPACE_RECORD_PATH } from '../workspace.js';
import type { WorkspacePath } from '../paths.js';
import type { WorkspaceService } from '../workspace.js';
import type {
  SyncAppliedNotification,
  SyncDirtyTracker,
  SyncWorkspaceReconciler,
} from './contract.js';

export interface WorkspaceDirtyTrackerOptions {
  /**
   * Live workspace lookup. Called on every `isDirty` probe so vault
   * replacement can never leave a stale workspace behind; return null
   * when no vault is open.
   */
  readonly getWorkspace: () => WorkspaceService | null;
}

/**
 * Session-backed `SyncDirtyTracker` over the shared workspace. Hosts
 * construct one per bootstrap closing over their app handle
 * (`() => app.getWorkspace()`) and inject it into `VaultSyncStore`.
 */
export class WorkspaceDirtyTracker implements SyncDirtyTracker {
  readonly #getWorkspace: () => WorkspaceService | null;

  constructor(options: WorkspaceDirtyTrackerOptions) {
    this.#getWorkspace = options.getWorkspace;
  }

  isDirty(path: WorkspacePath): boolean {
    let workspace: WorkspaceService | null;
    try {
      workspace = this.#getWorkspace();
    } catch {
      // A thrown host lookup means workspace state is UNKNOWN, not absent:
      // fail closed (dirty/defer) so remote bytes can never overwrite a
      // potentially dirty session behind the failing lookup. Only an
      // explicit null proves there are no sessions to protect.
      return true;
    }
    if (workspace === null) return false;
    // A workspace object exists: any unexpected lookup failure below means
    // session state cannot be determined — fail closed (dirty/defer) rather
    // than overwriting canonical bytes beneath a potentially dirty editor.
    try {
      const ref = workspace.findByResourcePath(path);
      if (ref === null) return false;
      try {
        const session = workspace.getOpenDocument(ref.documentId);
        return session?.dirty ?? false;
      } catch {
        return true;
      }
    } catch {
      return true;
    }
  }
}

export interface WorkspaceSyncReconcilerOptions {
  /**
   * Live workspace lookup. Called per reconcile so vault replacement can
   * never leave a stale workspace behind; return null when no vault is
   * open.
   */
  readonly getWorkspace: () => WorkspaceService | null;
}

/**
 * Host `SyncWorkspaceReconciler` over the shared workspace (fail-closed
 * hardening). After the engine materializes remote bytes (and before the
 * sync base advances), this seam makes application-visible state safe:
 *
 * - the workspace record is reloaded first, so remotely added/dropped
 *   documents (and moves) enter/leave the registry before any session
 *   work runs;
 * - clean open sessions over written paths reload from the downloaded
 *   bytes — a stale clean editor can never later overwrite them;
 * - clean open sessions over removed paths close (dirty sessions are
 *   never touched: deferral kept their bytes out of this notification,
 *   and the belt-and-braces dirty check below skips them anyway);
 * - derived search/index state rebuilds best-effort.
 *
 * Fail-closed policy: any failure required to prove session coherence
 * propagates (handleRemoteApplied rejects) so the service keeps the
 * per-replica pending retry and the base/checkpoint does NOT advance:
 * getWorkspace throw, reloadFromVault failure, findByResourcePath failure
 * for an affected path, getOpenDocument failure, clean reload failure,
 * clean close failure. Only rebuildable derived state (search index,
 * secondary caches, previews) stays best-effort.
 *
 * Sync never imports React/UI concepts and never depends on application
 * implementation details: this semantic callback is the only coupling.
 */
export class WorkspaceSyncReconciler implements SyncWorkspaceReconciler {
  readonly #getWorkspace: () => WorkspaceService | null;

  constructor(options: WorkspaceSyncReconcilerOptions) {
    this.#getWorkspace = options.getWorkspace;
  }

  async handleRemoteApplied(
    notification: SyncAppliedNotification,
  ): Promise<void> {
    // An unexpected workspace lookup failure is a coherence failure, not
    // a skip: propagate so the service retries via the per-replica pending
    // mechanism instead of advancing the base beneath unknown state.
    // A null workspace (no vault open) is the only legitimate no-op.
    const workspace = this.#getWorkspace();
    if (workspace === null) return;
    if (
      notification.written.includes(WORKSPACE_RECORD_PATH) ||
      notification.removed.includes(WORKSPACE_RECORD_PATH)
    ) {
      await workspace.reloadFromVault();
    }
    for (const raw of notification.written) {
      const path = raw as WorkspacePath;
      if (path === WORKSPACE_RECORD_PATH) continue;
      const ref = workspace.findByResourcePath(path);
      if (ref === null) continue;
      const session = workspace.getOpenDocument(ref.documentId);
      if (session === null || session.dirty) continue;
      await session.reload();
    }
    for (const raw of notification.removed) {
      const path = raw as WorkspacePath;
      if (path === WORKSPACE_RECORD_PATH) continue;
      const ref = workspace.findByResourcePath(path);
      if (ref === null) continue;
      const session = workspace.getOpenDocument(ref.documentId);
      if (session === null || session.dirty) continue;
      await workspace.closeDocument(ref.documentId);
    }
    try {
      await workspace.rebuildDerivedState();
    } catch {
      // Derived-state rebuild is best-effort: canonical bytes already
      // converged and the base advance must not hinge on an index.
      // Search indexes, secondary caches, and previews may rebuild later;
      // canonical workspace/session correctness above always propagates.
    }
  }
}
