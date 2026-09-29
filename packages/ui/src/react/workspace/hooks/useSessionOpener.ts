import { DocumentRecoveryError } from '@froglight/foundation';
/**
 * React host/session reconciler for the workspace shell.
 *
 * A *host* coordinator, not a session owner and not a routing policy: it
 * waits until a pane's stable editor/reader host exists, then runs the
 * controller operation. Explicit document opens arrive as pending intents
 * through `requestOpen`; startup restore, tab switches, and pane reparents
 * derive from the controller snapshot. Sessions, dock state, history, and
 * execution ordering stay owned by the workbench controller — the mailbox
 * here never chains promises and never chooses panes, splits, previews, or
 * delete reconciliation.
 *
 * Depends only on the host, reading, and state ports — never the aggregate.
 */

import {
  useCallback,
  useLayoutEffect,
  useEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import type { PaneModeView, PaneView } from '../../../workbench.js';
import type {
  WorkbenchHostPort,
  WorkbenchReadingPort,
  WorkbenchStatePort,
} from '../../../workbench-ports.js';
import type { VaultChoice } from '../../../workbench.js';
import type { WorkspaceSettingsService } from '../../../workspace-settings.js';
import {
  DEFAULT_VIEW_KEY,
  type DefaultViewMode,
} from '../../../settings-view.js';
import { documentSettingKey } from '../../../document-preferences.js';
import { MAIN_PANE } from '../WorkspaceContext.js';
import {
  createPendingMailbox,
  hasPendingOpen as hasMailboxPending,
  appendPendingOpen,
  pruneClosedPanes,
  takePendingOpens,
} from '../model/openQueue.js';
import { preferredReadingMode } from '../model/readingMode.js';
import type { Notify } from './useToast.js';

export function useSessionOpener(input: {
  readonly host: WorkbenchHostPort;
  readonly reading: WorkbenchReadingPort;
  readonly state: WorkbenchStatePort;
  readonly settingsService: WorkspaceSettingsService | null;
  readonly paneStates: readonly PaneView[];
  readonly revision: number;
  readonly choice: VaultChoice;
  readonly notify: Notify;
  readonly onRecoveryError?: (error: DocumentRecoveryError) => void;
  /** Runs once the startup `initialize` settles. */
  readonly onInitialized: () => void;
}): {
  readonly editorHosts: { readonly current: Map<string, HTMLElement> };
  readonly readerHosts: { readonly current: Map<string, HTMLElement> };
  /**
   * Request a document open into `paneId`. Resolves after the controller
   * open settles (or immediately when the pane closes first). When
   * `address` is present it travels with the intent so the controller can
   * store address-aware history and reveal after the presentation is ready;
   * the router still performs the post-open reveal as a safety net. When
   * `opts.preserveFocus` is true the intent is a background open: the
   * controller must never modify global focus.
   */
  readonly requestOpen: (
    paneId: string,
    documentId: string,
    address?: string,
    opts?: { preserveFocus?: boolean },
  ) => Promise<void>;
  readonly hasPendingOpen: (pane: string) => boolean;
} {
  const {
    host,
    reading,
    state,
    settingsService,
    paneStates,
    revision,
    choice,
    notify,
    onInitialized,
  } = input;

  /** Stable per-pane editor host elements handed to the controller. */
  const editorHosts = useRef(new Map<string, HTMLElement>());
  /** Stable per-pane reading-view host elements handed to the controller. */
  const readerHosts = useRef(new Map<string, HTMLElement>());
  // Remember attempts, not just successes. A failure notification is not new
  // availability. Explicit opens bypass this cache; host/tab/mode/provider
  // changes permit another automatic attempt.
  const attachmentAttempts = useRef(new Map<string, readonly unknown[]>());
  const readerAttempts = useRef(new Map<string, readonly unknown[]>());
  const [mailbox] = useState(createPendingMailbox);
  const resolvers = useRef(
    new Map<
      string,
      { resolve: () => void; reject: (error: unknown) => void }[]
    >(),
  );
  const [pendingRevision, bumpPending] = useReducer(
    (count: number) => count + 1,
    0,
  );

  function reportRecovery(pane: PaneView): void {
    if (pane.recoveryWarnings.length === 0) return;
    const report = pane.recoveryWarnings
      .map((warning) =>
        warning.pageId === undefined
          ? warning.code
          : `${warning.code} (${warning.pageId})`,
      )
      .join(', ');
    notify(`Recovery report: ${report}`, 'error');
  }

  /** Presentation mode for a freshly opened document tab. */
  function preferredMode(paneName: string, documentId: string): PaneModeView {
    const perDocumentReading =
      settingsService?.get<boolean>(
        documentSettingKey(documentId, 'view'),
        false,
      ) ?? false;
    const defaultView =
      settingsService?.get<DefaultViewMode>(DEFAULT_VIEW_KEY, 'edit') ?? 'edit';
    return preferredReadingMode({
      perDocumentReading,
      defaultView,
      availableModes: reading.availableTabModes(paneName, documentId),
    });
  }

  /** Post-open presentation: recovery report plus reading-mode default. */
  function settleOpenedPane(paneName: string, documentId: string): void {
    const openedPane = state
      .paneStates()
      .find((candidate) => candidate.pane === paneName);
    if (openedPane !== undefined) reportRecovery(openedPane);
    const preferred = preferredMode(paneName, documentId);
    if (preferred !== 'edit') {
      reading.setTabMode(paneName, documentId, preferred);
    }
  }

  function settleDropped(dropped: readonly { pane: string }[]): void {
    const byPane = new Map<string, number>();
    for (const request of dropped) {
      byPane.set(request.pane, (byPane.get(request.pane) ?? 0) + 1);
    }
    for (const [pane, count] of byPane) {
      const queue = resolvers.current.get(pane);
      if (queue === undefined) continue;
      resolvers.current.delete(pane);
      // Dropped before a host existed: resolve as a no-op supersede rather
      // than hanging the dispatch that requested them.
      for (const settlement of queue.slice(0, count)) {
        settlement.resolve();
      }
    }
  }

  // Host-readiness drain: run pending explicit opens and snapshot-derived
  // restores as soon as their host exists. Each controller call is fired
  // without awaiting its siblings — per-pane serialization lives inside the
  // controller queue, never here.
  useEffect(() => {
    const livePanes = paneStates.map((pane) => pane.pane);
    const dropped = pruneClosedPanes(mailbox, livePanes);
    if (dropped.length > 0) {
      settleDropped(dropped);
      bumpPending();
    }

    for (const attempts of [
      attachmentAttempts.current,
      readerAttempts.current,
    ]) {
      for (const pane of attempts.keys()) {
        if (!livePanes.includes(pane)) attempts.delete(pane);
      }
    }
    const isNewAttempt = (
      attempts: Map<string, readonly unknown[]>,
      pane: string,
      key: readonly unknown[],
    ) => {
      const previous = attempts.get(pane);
      if (
        previous?.length === key.length &&
        previous.every((value, index) => value === key[index])
      )
        return false;
      attempts.set(pane, key);
      return true;
    };

    for (const pane of paneStates) {
      const generation = host.attachmentGeneration?.(pane.pane) ?? 0;
      const presentation = reading.readingPresentation(pane.pane);
      const key = [
        host,
        pane.activeTab,
        pane.documentId,
        pane.mode,
        generation,
        presentation.kind === 'separate-reader' ? presentation.provider : null,
      ];
      const separateReader =
        pane.mode !== 'edit' &&
        reading.readingPresentation(pane.pane).kind === 'separate-reader';
      if (separateReader) {
        const readerHost = readerHosts.current.get(pane.pane);
        if (
          readerHost !== undefined &&
          isNewAttempt(readerAttempts.current, pane.pane, [...key, readerHost])
        ) {
          // Reader providers synchronously commit their own React roots.
          // Do not invoke that commit inside this shell's effect phase.
          queueMicrotask(() => {
            if (
              readerHosts.current.get(pane.pane) === readerHost &&
              reading.tabMode(pane.pane) !== 'edit' &&
              host.isReaderAttached(pane.pane, readerHost) !== true
            ) {
              try {
                host.setReaderHost(pane.pane, readerHost);
              } catch (error) {
                if (error instanceof DocumentRecoveryError)
                  input.onRecoveryError?.(error);
                notify(`Open failed: ${String(error)}`, 'error');
              }
            }
          });
        }
      }
      const editorHost = editorHosts.current.get(pane.pane);
      if (editorHost === undefined) continue;

      // Explicit routing intents drain whenever the host exists — including
      // into an already-attached pane (document switch). The queued calls
      // are fired in order without awaiting between them, so per-pane
      // serialization stays inside the controller queue. Only restores wait
      // for a detached host.
      const queued = takePendingOpens(mailbox, pane.pane);
      if (queued.length > 0) {
        bumpPending();
        const queue = resolvers.current.get(pane.pane) ?? [];
        resolvers.current.delete(pane.pane);
        queued.forEach((request, index) => {
          const settlement = queue[index];
          const openOpts: {
            pane: string;
            address?: string;
            preserveFocus?: boolean;
          } = { pane: request.pane };
          if (request.address !== undefined) {
            openOpts.address = request.address;
          }
          if (request.preserveFocus === true) {
            openOpts.preserveFocus = true;
          }
          void host
            .openDocument(request.documentId, editorHost, openOpts)
            .then(() => {
              settleOpenedPane(request.pane, request.documentId);
              settlement?.resolve();
            })
            .catch((error: unknown) => {
              if (error instanceof DocumentRecoveryError)
                input.onRecoveryError?.(error);
              notify(`Open failed: ${String(error)}`, 'error');
              settlement?.reject(error);
            });
        });
        continue;
      }

      // Snapshot-derived restore: the active tab names a document with no
      // live session in this host (startup restore, tab switch, reparent).
      if (host.isPaneAttached(pane.pane, editorHost)) {
        attachmentAttempts.current.delete(pane.pane);
        continue;
      }
      if (pane.activeTab === null || pane.documentId === null) continue;
      const reattach = host.isPaneActive(pane.pane);
      if (
        !isNewAttempt(attachmentAttempts.current, pane.pane, [
          ...key,
          editorHost,
          readerHosts.current.get(pane.pane),
          reattach,
        ])
      )
        continue;
      if (reattach) {
        void host
          .reattachPane(
            pane.pane,
            editorHost,
            readerHosts.current.get(pane.pane),
          )
          .catch((error: unknown) => {
            if (error instanceof DocumentRecoveryError)
              input.onRecoveryError?.(error);
            notify(`Open failed: ${String(error)}`, 'error');
          });
      } else {
        const documentId = pane.documentId;
        void host
          .openDocument(documentId, editorHost, { pane: pane.pane })
          .then(() => {
            settleOpenedPane(pane.pane, documentId);
          })
          .catch((error: unknown) => {
            if (error instanceof DocumentRecoveryError)
              input.onRecoveryError?.(error);
            notify(`Open failed: ${String(error)}`, 'error');
          });
      }
    }
  }, [revision, pendingRevision, paneStates, host, reading, state]);

  const requestOpen = useCallback(
    (
      paneId: string,
      documentId: string,
      address?: string,
      opts?: { preserveFocus?: boolean },
    ): Promise<void> => {
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const queue = resolvers.current.get(paneId);
      if (queue === undefined)
        resolvers.current.set(paneId, [{ resolve, reject }]);
      else queue.push({ resolve, reject });
      appendPendingOpen(mailbox, {
        pane: paneId,
        documentId,
        ...(address !== undefined ? { address } : {}),
        ...(opts?.preserveFocus === true ? { preserveFocus: true } : {}),
      });
      bumpPending();
      return promise;
    },
    [mailbox],
  );

  const hasPendingOpen = useCallback(
    (pane: string): boolean => hasMailboxPending(mailbox, pane),
    [mailbox],
  );

  const initialized = useRef(false);
  useLayoutEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const editorHost = editorHosts.current.get(MAIN_PANE) ?? null;
    void (async () => {
      try {
        await host.initialize(editorHost);
        for (const pane of state.paneStates()) reportRecovery(pane);
      } catch (error) {
        if (error instanceof DocumentRecoveryError)
          input.onRecoveryError?.(error);
        notify(`Init failed: ${String(error)}`, 'error');
      }
      onInitialized();
    })();
  }, [host, state, choice]);

  return { editorHosts, readerHosts, requestOpen, hasPendingOpen };
}
