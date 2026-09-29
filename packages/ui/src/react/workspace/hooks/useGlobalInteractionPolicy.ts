/**
 * Browser/global interaction policy for the workspace shell.
 *
 * A single capturing `contextmenu` listener routes unhandled right-clicks
 * through the shell's menu policy (native text fields keep their edit
 * menus), mouse buttons 4/5 walk the focused pane's history, and the global
 * "open settings" command opens the settings modal.
 */

import { useEffect } from 'react';
import type { WorkbenchDocumentPort } from '../../../workbench-ports.js';
import {
  dispatchContextMenu,
  isEditableTarget,
} from '../../../menu.js';
import { workspaceEvents as events } from '../../../ui-events.js';

export function useGlobalInteractionPolicy(input: {
  readonly documents: WorkbenchDocumentPort;
  readonly bump: () => void;
  readonly openSettings: () => void;
}): void {
  const { documents, bump, openSettings } = input;

  useEffect(() => {
    const contextPolicy = (event: MouseEvent): void => {
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      dispatchContextMenu(event);
    };
    document.addEventListener('contextmenu', contextPolicy, true);

    const mouseNavHandler = (event: MouseEvent): void => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      const navigate =
        event.button === 3 ? documents.goBack() : documents.goForward();
      void navigate.then((moved) => {
        if (moved) bump();
      });
    };
    document.addEventListener('mouseup', mouseNavHandler);
    return () => {
      document.removeEventListener('contextmenu', contextPolicy, true);
      document.removeEventListener('mouseup', mouseNavHandler);
    };
  }, [documents, bump]);

  // The "Open settings" command and any other surface can open the modal.
  useEffect(() => {
    document.addEventListener(events.openSettings, openSettings);
    return () => document.removeEventListener(events.openSettings, openSettings);
  }, [openSettings]);
}
