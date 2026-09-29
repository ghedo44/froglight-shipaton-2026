/**
 * Focused-document publication for sidebar views.
 *
 * Presentation output, not a routing input: publishes the focused pane's
 * active document (or raw-file preview path) so the explorer can highlight
 * it without coupling to the controller. Routing policy lives in the
 * document router; this hook only reports.
 */

import { useEffect } from 'react';
import type { WorkbenchStatePort } from '../../../workbench-ports.js';
import { workspaceEvents as events } from '../../../ui-events.js';
import { PREVIEW_VIEW_ID_PREFIX } from '../../../view-registry.js';
import { emptyPaneState } from './useControllerSnapshot.js';

export function useActiveDocumentPublication(input: {
  readonly state: WorkbenchStatePort;
  readonly eventTarget: HTMLElement | undefined;
  readonly getRoot: () => HTMLElement | null;
  readonly revision: number;
  readonly focusedPane: string;
  readonly dispatchWorkspaceEvent: (name: string, detail: unknown) => void;
}): void {
  const {
    state,
    eventTarget,
    getRoot,
    revision,
    focusedPane,
    dispatchWorkspaceEvent,
  } = input;

  useEffect(() => {
    const root = eventTarget ?? getRoot();
    if (root === null) return;
    const focused =
      state.paneStates().find((pane) => pane.pane === focusedPane) ??
      emptyPaneState(focusedPane);
    const previewPath =
      focused.viewId !== null &&
      focused.viewId.startsWith(PREVIEW_VIEW_ID_PREFIX)
        ? focused.viewId.slice(PREVIEW_VIEW_ID_PREFIX.length)
        : null;
    dispatchWorkspaceEvent(events.activeDocument, {
      documentId: focused.documentId,
      previewPath,
    });
  }, [
    revision,
    focusedPane,
    state,
    eventTarget,
    getRoot,
    dispatchWorkspaceEvent,
  ]);
}
