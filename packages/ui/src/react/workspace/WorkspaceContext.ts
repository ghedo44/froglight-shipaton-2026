/**
 * Narrow workspace context: stable dependencies shared across the shell.
 *
 * Only values that never change for the shell's lifetime live here —
 * controller, installed UI, vault choice, event target, window chrome, and
 * the close callback. Revision-driven snapshots, toast state, drag state,
 * and all other reactive concerns stay local to the hooks and components
 * that subscribe to them.
 */

import { createContext, useContext } from 'react';
import type {
  InstalledUi,
  VaultChoice,
  WorkbenchControllerView,
} from '../../workbench.js';
import type { WindowChrome } from '../../window-chrome.js';

export interface WorkspaceContextValue {
  readonly controller: WorkbenchControllerView;
  readonly ui: InstalledUi;
  readonly choice: VaultChoice;
  readonly eventTarget?: HTMLElement;
  readonly chrome: WindowChrome;
  readonly onClose: () => void;
}

const workspaceContext = createContext<WorkspaceContextValue | null>(null);

export const WorkspaceContextProvider = workspaceContext.Provider;

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(workspaceContext);
  if (value === null) throw new Error('WorkspaceView subtree mounted without context');
  return value;
}

/** The initial pane id the workspace boots into. */
export const MAIN_PANE = 'main';
