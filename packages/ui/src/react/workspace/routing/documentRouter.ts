/**
 * Workspace document router: routing policy and reconciliation for
 * document/raw-preview intents.
 *
 * React-free. Decides *what* pane/view/document operation should happen;
 * `WorkbenchController` remains the owner of dock/session/history state and
 * the sole promise-serialization authority for per-pane transitions.
 * Host readiness lives outside (a pending-intent mailbox); this module
 * never touches DOM nodes or React state.
 */

import type { PaneView } from '../../../workbench-view.js';
import { PREVIEW_VIEW_ID_PREFIX } from '../../../view-registry.js';

export type WorkspaceDocumentIntent =
  | {
      readonly type: 'open-document';
      readonly documentId: string;
      readonly address?: string;
      readonly disposition: 'foreground' | 'background';
      readonly pane?: string;
    }
  | {
      readonly type: 'open-link';
      readonly destination: string;
      readonly pane?: string;
    }
  | {
      readonly type: 'open-preview';
      readonly path: string;
      readonly disposition: 'foreground' | 'background';
      readonly pane?: string;
    }
  | {
      readonly type: 'open-view';
      readonly viewId: string;
      readonly disposition: 'foreground' | 'background';
      readonly pane?: string;
    }
  | {
      readonly type: 'preview-moved';
      readonly from: string;
      readonly to: string;
    }
  | { readonly type: 'preview-deleted'; readonly path: string }
  | {
      readonly type: 'documents-deleted';
      readonly documentIds?: readonly string[];
      readonly folder?: string;
    };

/**
 * Structural workbench port the router drives. Composed at the shell
 * boundary from narrow workbench ports plus the host-readiness mailbox
 * (`hasPendingOpen`) — never by `packages/application` (which must not
 * import `packages/ui`).
 */
export interface DocumentRouterWorkbench {
  readonly focusedPane: string;
  leafIds(): string[];
  paneStates(): readonly PaneView[];
  splitPane(
    pane: string,
    direction: 'right' | 'down' | 'left' | 'up',
    opts?: { preserveFocus?: boolean },
  ): string;
  focusPane(pane: string): void;
  /**
   *  live-owner probe (controller-owned, required core member).
   * Returns the pane currently owning a live session for `documentId`,
   * or `null` when the document is not live anywhere.
   */
  liveOwnerOf(documentId: string): string | null;
  /**
   *  race-net discard for a redirected fresh split (required core
   * member). Removes exactly the empty leaf left by a redirect.
   */
  discardRedirectedSplit(created: string, documentId: string): void;
  openDocument(
    pane: string,
    documentId: string,
    address?: string,
    opts?: { preserveFocus?: boolean },
  ): Promise<void>;
  openLink(destination: string, pane?: string): Promise<unknown>;
  openView(
    viewId: string,
    opts?: { pane?: string; preserveFocus?: boolean },
  ): Promise<string>;
  closeTab(pane: string, tabId: string): Promise<void>;
  activateTab(pane: string, tabId: string): Promise<void>;
  pruneMissingDocuments(): Promise<void>;
  revealAddress(
    pane: string,
    address: string,
    opts?: { preserveFocus?: boolean },
  ): boolean;
  /** True while the host-readiness mailbox holds a pending open for `pane`. */
  hasPendingOpen(pane: string): boolean;
}

export interface DocumentRouterPreviews {
  ensurePreviewView(path: string): string;
  resolveRawFileLink?(
    destination: string,
    sourcePath?: string,
  ): Promise<{ path: string } | { ambiguous: true } | null>;
}

export interface DocumentRouterEffects {
  notify(message: string, kind: 'error'): void;
  closeDrawer(): void;
  bump(): void;
  publishActiveDocument(detail: {
    readonly documentId: string | null;
    readonly previewPath: string | null;
    readonly reveal?: boolean;
  }): void;
  readonly isCompact: () => boolean;
}

export interface WorkspaceDocumentRouter {
  dispatch(intent: WorkspaceDocumentIntent): Promise<void>;
}

export function createWorkspaceDocumentRouter(deps: {
  readonly workbench: DocumentRouterWorkbench;
  readonly previews: DocumentRouterPreviews;
  readonly effects: DocumentRouterEffects;
}): WorkspaceDocumentRouter {
  const { workbench, previews, effects } = deps;

  /**
   * The only background-open policy in the codebase: an idle existing leaf
   * first; when none exists, the focused pane on compact/mobile layouts and
   * a fresh split right on multi-pane layouts. Explicit `pane` targeting
   * bypasses the policy.
   *
   * when `documentId` names a live-active document (single
   * owner), return its owner before any split so a duplicate never
   * materializes a fresh leaf it will not use. Inactive documents (no live
   * owner) fall through to the idle/split policy and may create the second
   * tab entry.
   */
  function resolveTargetPane(
    disposition: 'foreground' | 'background',
    explicitPane?: string,
    documentId?: string,
  ): string {
    if (explicitPane !== undefined) return explicitPane;
    if (documentId !== undefined) {
      const live = workbench.liveOwnerOf(documentId);
      if (live !== null) return live;
    }
    if (disposition === 'foreground') return workbench.focusedPane;
    const leaves = workbench.leafIds();
    const states = workbench.paneStates();
    const idle = leaves.find((leaf) => {
      const state = states.find((pane) => pane.pane === leaf);
      const activeTab = state?.activeTab ?? null;
      return activeTab === null && !workbench.hasPendingOpen(leaf);
    });
    if (idle !== undefined) return idle;
    if (effects.isCompact()) return workbench.focusedPane;
    // Only background opens reach this split (foreground returns the focused
    // pane above). The new pane is created unfocused and the subsequent open
    // preserves focus as well, so a desktop background open never moves
    // global focus — not even transiently.
    return workbench.splitPane(workbench.focusedPane, 'right', {
      preserveFocus: true,
    });
  }

  /**
   * Shared open-into-pane flow: resolve the target, run the controller
   * operation, then close the drawer and publish the new presentation when
   * it is globally active. Returns the target pane, or null when the open
   * failed (already toasted).
   *
   * Background semantic: opening into another pane never modifies global
   * focus — not transiently, and never via a stale post-operation restore.
   * The preserve-focus intent travels with the operation itself (split with
   * `{ preserveFocus: true }`, document/view opens with the same flag
   * through the host-readiness mailbox), so a concurrent user focus change
   * while the async open is pending can never be overwritten. Foreground
   * opens focus their target normally through the controller. No second
   * async queue is introduced: controller operations remain serialized
   * through `WorkbenchController.#paneOpenOperations`.
   *
   * Active-document publication is presentation state: foreground opens
   * publish the newly focused document/view, and background opens into the
   * already-focused pane publish it as well (compact reuse). Background
   * opens into another pane publish nothing — the focused-pane-derived
   * publication already represents the active presentation.
   */
  async function runRoutedOpen(
    open: (target: string, preserveFocus: boolean) => Promise<void>,
    published: {
      readonly documentId: string | null;
      readonly previewPath: string | null;
    },
    disposition: 'foreground' | 'background',
    explicitPane?: string,
    documentId?: string,
  ): Promise<string | null> {
    const target = resolveTargetPane(disposition, explicitPane, documentId);
    const preserveFocus = disposition === 'background';
    try {
      await open(target, preserveFocus);
    } catch (error) {
      effects.notify(`Open failed: ${String(error)}`, 'error');
      return null;
    }
    effects.closeDrawer();
    if (!preserveFocus || target === workbench.focusedPane) {
      effects.publishActiveDocument({ ...published, reveal: true });
    }
    return target;
  }

  async function openDocument(
    documentId: string,
    address: string | undefined,
    disposition: 'foreground' | 'background',
    explicitPane?: string,
  ): Promise<void> {
    // race net: only a router-created split may be discarded. An
    // explicit pane (e.g. splitWithTab's fresh leaf, handled by its caller,
    // or a pre-existing switcher target) must never be removed here.
    const leavesBefore =
      explicitPane === undefined ? new Set(workbench.leafIds()) : null;
    const target = await runRoutedOpen(
      (pane, preserveFocus) =>
        workbench.openDocument(pane, documentId, address, { preserveFocus }),
      { documentId, previewPath: null },
      disposition,
      explicitPane,
      documentId,
    );
    if (target !== null && leavesBefore !== null && !leavesBefore.has(target)) {
      workbench.discardRedirectedSplit(target, documentId);
    }
    if (target !== null && address !== undefined) {
      // `#openSession` already revealed after the presentation was ready and
      // stored address-aware history. Reveal again as a safety net for
      // providers whose first reveal races mount — preserving focus for
      // background opens so the reveal never steals focus. Reveal where the
      // document actually ended up after a redirect, never the
      // requested pane (mirrors `#owningPaneFor`).
      const revealPane = workbench.liveOwnerOf(documentId) ?? target;
      workbench.revealAddress(revealPane, address, {
        preserveFocus: disposition === 'background',
      });
    }
  }

  async function openPreview(
    path: string,
    disposition: 'foreground' | 'background',
    explicitPane?: string,
  ): Promise<void> {
    const viewId = previews.ensurePreviewView(path);
    await runRoutedOpen(
      (pane, preserveFocus) =>
        workbench.openView(viewId, { pane, preserveFocus }).then(() => undefined),
      { documentId: null, previewPath: path },
      disposition,
      explicitPane,
    );
  }

  async function openView(
    viewId: string,
    disposition: 'foreground' | 'background',
    explicitPane?: string,
  ): Promise<void> {
    const previewPath = viewId.startsWith(PREVIEW_VIEW_ID_PREFIX)
      ? viewId.slice(PREVIEW_VIEW_ID_PREFIX.length)
      : null;
    await runRoutedOpen(
      (pane, preserveFocus) =>
        workbench.openView(viewId, { pane, preserveFocus }).then(() => undefined),
      { documentId: null, previewPath },
      disposition,
      explicitPane,
    );
  }

  async function previewMoved(from: string, to: string): Promise<void> {
    const fromViewId = `${PREVIEW_VIEW_ID_PREFIX}${from}`;
    const toViewId = previews.ensurePreviewView(to);
    // Preview renames/moves preserve global focus by construction: every
    // view open carries `preserveFocus`, and tab activation only changes a
    // pane's active tab — never global focus. No post-operation restore.
    for (const pane of workbench.paneStates()) {
      const affected = pane.tabs.filter(
        (tab) => tab.kind === 'view' && tab.viewId === fromViewId,
      );
      for (const tab of affected) {
        // Preserve the pane's active tab: a background preview that follows
        // a rename must not steal focus in its pane.
        const wasActive = pane.activeTab === tab.id;
        const previousActive = pane.activeTab;
        try {
          await workbench.closeTab(pane.pane, tab.id);
          await workbench.openView(toViewId, {
            pane: pane.pane,
            preserveFocus: true,
          });
          if (!wasActive && previousActive !== null) {
            await workbench.activateTab(pane.pane, previousActive);
          }
        } catch (error) {
          effects.notify(`Move failed: ${String(error)}`, 'error');
        }
      }
    }
  }

  async function previewDeleted(path: string): Promise<void> {
    const viewId = `${PREVIEW_VIEW_ID_PREFIX}${path}`;
    for (const pane of workbench.paneStates()) {
      for (const tab of pane.tabs) {
        if (tab.kind === 'view' && tab.viewId === viewId) {
          try {
            await workbench.closeTab(pane.pane, tab.id);
          } catch (error) {
            effects.notify(`Close failed: ${String(error)}`, 'error');
          }
        }
      }
    }
  }

  async function documentsDeleted(): Promise<void> {
    try {
      await workbench.pruneMissingDocuments();
      effects.bump();
    } catch (error) {
      effects.notify(`Delete cleanup failed: ${String(error)}`, 'error');
    }
  }

  return {
    async dispatch(intent: WorkspaceDocumentIntent): Promise<void> {
      switch (intent.type) {
        case 'open-document':
          await openDocument(
            intent.documentId,
            intent.address,
            intent.disposition,
            intent.pane,
          );
          return;
        case 'open-link': {
          const target = intent.pane ?? workbench.focusedPane;
          try {
            const sourcePath = workbench
              .paneStates()
              .find((pane) => pane.pane === target)?.path ?? undefined;
            const raw = await previews.resolveRawFileLink?.(
              intent.destination,
              sourcePath,
            );
            if (raw !== undefined && raw !== null) {
              if ('ambiguous' in raw) {
                effects.notify(`Link is ambiguous: ${intent.destination}`, 'error');
              } else {
                await openPreview(raw.path, 'foreground', target);
              }
              return;
            }
            await workbench.openLink(intent.destination, target);
            effects.bump();
          } catch (error) {
            effects.notify(`Link failed: ${String(error)}`, 'error');
          }
          return;
        }
        case 'open-preview':
          await openPreview(intent.path, intent.disposition, intent.pane);
          return;
        case 'open-view':
          await openView(intent.viewId, intent.disposition, intent.pane);
          return;
        case 'preview-moved':
          await previewMoved(intent.from, intent.to);
          return;
        case 'preview-deleted':
          await previewDeleted(intent.path);
          return;
        case 'documents-deleted':
          await documentsDeleted();
          return;
      }
    },
  };
}
