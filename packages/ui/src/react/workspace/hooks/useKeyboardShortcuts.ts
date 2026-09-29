/**
 * Workspace keyboard shortcuts (document-level so they keep working when
 * focus leaves the shell).
 *
 * - `Mod S` saves the focused pane;
 * - `Mod E` toggles the focused tab between edit and reading;
 * - `Mod B` toggles the sidebar;
 * - `Mod P` opens the quick switcher, `Mod Shift F` the scoped search;
 * - `Mod \` splits right, `Mod Shift \` splits down.
 */

import { useEffect } from 'react';
import { closeOpenMenu } from '../../../menu.js';

export interface WorkspaceShortcuts {
  readonly save: () => void;
  readonly toggleReadingMode: () => void;
  readonly toggleSidebar: () => void;
  readonly openQuickSwitcher: () => void;
  readonly openSearch: () => void;
  readonly split: (direction: 'right' | 'down') => void;
}

export function useKeyboardShortcuts(input: {
  readonly mobile: boolean;
  readonly shortcuts: WorkspaceShortcuts;
}): void {
  const { mobile, shortcuts } = input;
  const {
    save,
    toggleReadingMode,
    toggleSidebar,
    openQuickSwitcher,
    openSearch,
    split,
  } = shortcuts;

  useEffect(() => {
    const keyHandler = (event: KeyboardEvent): void => {
      // The focused provider owns shortcuts it has already handled.
      if (event.defaultPrevented) return;
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      if (event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        openSearch();
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 's') {
        event.preventDefault();
        save();
      } else if (key === 'e') {
        event.preventDefault();
        toggleReadingMode();
      } else if (key === 'b') {
        event.preventDefault();
        toggleSidebar();
      } else if (key === 'p') {
        event.preventDefault();
        openQuickSwitcher();
      } else if (key === '\\') {
        event.preventDefault();
        split(event.shiftKey ? 'down' : 'right');
      }
    };
    // Document-level so shortcuts keep working when focus leaves the shell.
    document.addEventListener('keydown', keyHandler);
    return () => {
      document.removeEventListener('keydown', keyHandler);
    };
  }, [
    mobile,
    save,
    toggleReadingMode,
    toggleSidebar,
    openQuickSwitcher,
    openSearch,
    split,
  ]);
  // A snapshot can replace shortcut callbacks while a menu is open (for
  // example when PDF navigation or autosave settles). Only leaving the
  // workspace should dismiss that menu, not refreshing the key listener.
  useEffect(() => () => closeOpenMenu(), []);
}
