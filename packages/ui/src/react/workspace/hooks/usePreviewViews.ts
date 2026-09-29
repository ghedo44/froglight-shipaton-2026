/**
 * Raw-file preview view registrations.
 *
 * Preview views are registered on first open and owned by the shell:
 * everything is disposed on unmount, orphan registrations die when their
 * last tab closes, restored tabs re-register before first paint, and a
 * reader replacement (provider swap) re-registers against the new reader.
 * The *what* to dispose/ensure is computed by the pure
 * `model/previewLifecycle` planner; this hook owns the effectful
 * `ensure` / `reconcile` / `disposeAll` operations.
 */

import { createElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { InstalledUi } from '../../../workbench.js';
import type { PaneView } from '../../../workbench.js';
import { fileExplorerToken } from '../../../file-explorer.js';
import { fileNameOf, iconForPath, mimeForPath } from '../../../file-kinds.js';
import { PREVIEW_VIEW_ID_PREFIX as PREVIEW_VIEW_PREFIX } from '../../../view-registry.js';
import { workspaceEvents as events } from '../../../ui-events.js';
import { RawFilePreview } from '../../previews/RawFilePreview.jsx';
import type { RawFileReader } from '../../previews/shared.js';
import { planPreviewReconciliation } from '../model/previewLifecycle.js';
import type { Notify } from './useToast.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface PreviewRegistration {
  dispose(): void;
  reader: RawFileReader | null;
}

export function usePreviewViews(input: {
  readonly ui: InstalledUi;
  readonly paneStates: readonly PaneView[];
  readonly revision: number;
  readonly notify: Notify;
  readonly dispatchWorkspaceEvent: (name: string, detail: unknown) => void;
}): {
  /** Register (or reuse) the preview view for a vault path. */
  readonly ensurePreviewView: (path: string) => string;
  readonly resolveRawFileLink: (
    destination: string,
    sourcePath?: string,
  ) => Promise<{ path: string } | { ambiguous: true } | null>;
  /**
   * Reconcile registrations against live tabs: dispose orphans and
   * stale-reader entries, (re-)register restored tabs. Runs automatically
   * before paint on every revision; exposed for tests and shell lifecycle.
   */
  readonly reconcilePreviews: () => void;
  /** Dispose every registration; runs automatically on shell unmount. */
  readonly disposeAllPreviews: () => void;
} {
  const { ui, paneStates, revision, notify, dispatchWorkspaceEvent } =
    input;

  const explorerService = ui.services.try(fileExplorerToken) ?? null;
  const resolveRawFileLink = useCallback(
    (destination: string, sourcePath?: string) =>
      explorerService?.resolveRawFileLink(destination, sourcePath) ??
      Promise.resolve(null),
    [explorerService],
  );
  /** Prefers a disk-backed blob (streams big media); falls back to bytes. */
  const rawFileReader: RawFileReader | null = useMemo(() => {
    if (explorerService === null) return null;
    return (path: string): Promise<Blob> => {
      if (explorerService.readRawFileBlob !== undefined) {
        return explorerService.readRawFileBlob(path);
      }
      return explorerService
        .readRawFile(path)
        .then(
          (bytes) => new Blob([bytes as BlobPart], { type: mimeForPath(path) }),
        );
    };
  }, [explorerService]);

  /**
   * Live preview registrations, keyed by view id. Each entry remembers which
   * reader it was built against so a service replacement (or the explorer
   * appearing after a preview was registered) re-registers the view.
   */
  const previewRegistrations = useRef(
    new Map<string, PreviewRegistration>(),
  );

  const ensurePreviewView = useCallback(
    (path: string): string => {
      const viewId = `${PREVIEW_VIEW_PREFIX}${path}`;
      if (previewRegistrations.current.has(viewId)) return viewId;
      const reader = rawFileReader;
      const canEmbedPdf = ui.capabilities.iframePdf;
      const service = explorerService;
      const registration = ui.views.register({
        id: viewId,
        title: fileNameOf(path),
        icon: iconForPath(path),
        description: path,
        area: 'pane',
        component: () =>
          createElement(RawFilePreview, {
            path,
            reader,
            canEmbedPdf,
            onImportAsNotebook:
              service === null
                ? undefined
                : () => {
                    void service
                      .createNotebookFromPdf(path)
                      .then((documentId) => {
                        dispatchWorkspaceEvent(events.open, { documentId });
                      })
                      .catch((error: unknown) =>
                        notify(
                          `Import failed: ${errorMessage(error)}`,
                          'error',
                        ),
                      );
                  },
          }),
      });
      previewRegistrations.current.set(viewId, {
        dispose: registration.dispose,
        reader,
      });
      return viewId;
    },
    [ui, rawFileReader, explorerService, dispatchWorkspaceEvent, notify],
  );

  const disposeAllPreviews = useCallback((): void => {
    for (const registration of previewRegistrations.current.values()) {
      registration.dispose();
    }
    previewRegistrations.current.clear();
  }, []);

  // Shell shutdown owns the registrations too: dispose everything on unmount
  // so no view definition outlives the shell that created it.
  useEffect(() => disposeAllPreviews, [disposeAllPreviews]);

  const reconcilePreviews = useCallback((): void => {
    const referenced = new Set<string>();
    for (const pane of paneStates) {
      for (const tab of pane.tabs) {
        if (
          tab.kind === 'view' &&
          tab.viewId !== null &&
          tab.viewId.startsWith(PREVIEW_VIEW_PREFIX)
        ) {
          referenced.add(tab.viewId);
        }
      }
    }
    const plan = planPreviewReconciliation({
      referencedViewIds: [...referenced],
      registered: previewRegistrations.current,
      currentReader: rawFileReader,
      prefix: PREVIEW_VIEW_PREFIX,
    });
    for (const viewId of plan.disposeViewIds) {
      const registration = previewRegistrations.current.get(viewId);
      if (registration !== undefined) {
        previewRegistrations.current.delete(viewId);
        registration.dispose();
      }
    }
    for (const path of plan.ensurePaths) {
      ensurePreviewView(path);
    }
  }, [paneStates, rawFileReader, ensurePreviewView]);

  // Registration lifecycle: re-register for restored or unknown preview
  // tabs, re-register when the reader was replaced (provider swap), and
  // dispose registrations whose last tab is gone. Runs as a layout effect so
  // a restored tab's view exists before the first paint.
  useLayoutEffect(() => {
    reconcilePreviews();
  }, [revision, reconcilePreviews]);

  return {
    ensurePreviewView,
    resolveRawFileLink,
    reconcilePreviews,
    disposeAllPreviews,
  };
}
