/**
 * Tab-strip context-menu entries.
 *
 * Decides which entries a tab offers — desktop-only one-gesture splits, the
 * non-drag "move to next pane" fallback when another pane exists, and
 * close/close-others/close-all — while the shell wires the callbacks to the
 * workbench controller.
 */

import type { MenuEntry } from '../../../menu.js';
import type { DockTabView } from '../../../workbench-view.js';

export interface TabMenuContext {
  readonly pane: string;
  /** False on phones, where splits do not exist. */
  readonly desktopLayout: boolean;
  /** Current leaf panes in visual order (read fresh when the menu runs). */
  readonly leafIds: () => readonly string[];
  /** Sibling tabs in the same pane, excluding the target tab. */
  readonly otherTabs: () => readonly DockTabView[];
  /** A live document has one session owner, so a new pane starts empty. */
  readonly canSplitWithTab: boolean;
  readonly splitWithTab: (direction: 'right' | 'down') => void;
  readonly moveTabToPane: (pane: string) => void;
  readonly closeTab: () => void;
  readonly closeOtherTabs: () => void;
  readonly closeAllTabs: () => void;
}

export function buildTabMenuEntries(
  context: TabMenuContext,
): readonly MenuEntry[] {
  const {
    pane,
    desktopLayout,
    leafIds,
    otherTabs,
    canSplitWithTab,
    splitWithTab,
    moveTabToPane,
    closeTab,
    closeOtherTabs,
    closeAllTabs,
  } = context;
  const entries: MenuEntry[] = [];
  if (desktopLayout) {
    entries.push(
      {
        label: canSplitWithTab ? 'Split right with this tab' : 'Split right',
        icon: 'split-right',
        run: () => splitWithTab('right'),
      },
      {
        label: canSplitWithTab ? 'Split down with this tab' : 'Split down',
        icon: 'split-down',
        run: () => splitWithTab('down'),
      },
    );
  }
  if (leafIds().length > 1) {
    entries.push({
      label: 'Move to next pane',
      icon: 'columns',
      run: () => {
        const leaves = leafIds();
        const index = leaves.indexOf(pane);
        const next = leaves[index + 1] ?? leaves[index - 1];
        if (next === undefined) return;
        moveTabToPane(next);
      },
    });
  }
  entries.push({
    label: 'Close tab',
    run: () => closeTab(),
  });
  if (otherTabs().length > 0) {
    entries.push({
      label: 'Close other tabs',
      run: () => closeOtherTabs(),
    });
  }
  entries.push({
    label: 'Close all',
    run: () => closeAllTabs(),
  });
  return entries;
}
