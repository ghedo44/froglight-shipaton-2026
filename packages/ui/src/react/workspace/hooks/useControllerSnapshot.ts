/**
 * Controller-driven snapshot for the workspace shell.
 *
 * Every controller or view-registry invalidation bumps the revision; panes,
 * documents, and dock state derive from it. The snapshot is created once at
 * the composition root and passed down as props — it deliberately does not
 * live in `WorkspaceContext`, so only subscribers re-render on invalidation.
 */

import { useEffect, useReducer } from 'react';
import type {
  PaneView,
  WorkbenchDocumentView,
} from '../../../workbench.js';
import type {
  WorkbenchDockPort,
  WorkbenchStatePort,
} from '../../../workbench-ports.js';
import type { InstalledUi } from '../../../workbench.js';
import type { DockNodeView } from '../../../dock-tree.js';

/** Empty presentation state for a pane id the controller no longer reports. */
export function emptyPaneState(paneId: string): PaneView {
  return {
    pane: paneId,
    tabs: [],
    activeTab: null,
    mode: 'edit',
    documentId: null,
    viewId: null,
    title: null,
    path: null,
    dirty: false,
    recoveryWarnings: [],
    canGoBack: false,
    canGoForward: false,
  };
}

export interface WorkspaceSnapshot {
  readonly revision: number;
  readonly bump: () => void;
  readonly documents: readonly WorkbenchDocumentView[];
  readonly documentById: ReadonlyMap<string, WorkbenchDocumentView>;
  readonly dock: {
    readonly root: DockNodeView | null;
    readonly focusedPane: string | null;
    readonly maximizedPane: string | null;
  };
  readonly paneStates: readonly PaneView[];
  readonly paneStateOf: (paneId: string) => PaneView;
}

export function useControllerSnapshot(
  state: WorkbenchStatePort,
  dock: WorkbenchDockPort,
  ui: InstalledUi,
): WorkspaceSnapshot {
  // Controller-driven re-renders: every notify bumps the revision.
  const [revision, bump] = useReducer((count: number) => count + 1, 0);
  useEffect(() => state.onDidChange(bump).dispose, [state]);
  // View registrations (e.g. previews) also change what the shell renders.
  useEffect(() => ui.views.onDidChange(bump).dispose, [ui.views]);

  let documents: readonly WorkbenchDocumentView[];
  try {
    documents = state.listDocuments();
  } catch {
    documents = [];
  }
  const documentById = new Map(
    documents.map((document) => [document.documentId, document]),
  );
  const dockState = dock.dockState();
  const paneStates = state.paneStates();
  const paneStateOf = (paneId: string): PaneView => {
    const found = paneStates.find((candidate) => candidate.pane === paneId);
    return found ?? emptyPaneState(paneId);
  };

  return { revision, bump, documents, documentById, dock: dockState, paneStates, paneStateOf };
}
