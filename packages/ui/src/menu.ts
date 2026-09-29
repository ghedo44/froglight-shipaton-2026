/**
 * Froglight context menus.
 *
 * One component backs every menu in the app: row "…" buttons, right-click
 * context menus, and tab menus. Panels position at the invoking point,
 * clamp inside the viewport, support full keyboard navigation, and restore
 * focus to their invoker on close.
 */

import { closeActiveMenu, showContextMenuReact } from './react/overlays.jsx';

export interface MenuItem {
  readonly label?: string;
  readonly icon?: string;
  /** Monospace hint rendered on the trailing edge (e.g. `Mod S`). */
  readonly shortcut?: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly checked?: boolean;
  run?(): void;
}

export type MenuEntry = MenuItem | 'separator';

export interface MenuHandle {
  close(): void;
  readonly closed: boolean;
}

export interface MenuPointAnchor {
  readonly x: number;
  readonly y: number;
  /** Useful focus/ownership target when the menu opened from a pointer. */
  readonly invoker?: HTMLElement | null;
}

/** Clamp a menu rectangle into the viewport with a small margin. */
export function clampMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth = window.innerWidth,
  viewportHeight = window.innerHeight,
  /** Reserved bottom inset (overlay keyboard) excluded from the viewport. */
  bottomInset = 0,
): { left: number; top: number } {
  const margin = 8;
  const usableHeight = Math.max(margin * 2, viewportHeight - bottomInset);
  const left = Math.min(
    Math.max(x, margin),
    Math.max(margin, viewportWidth - width - margin),
  );
  const top = Math.min(
    Math.max(y, margin),
    Math.max(margin, usableHeight - height - margin),
  );
  return { left, top };
}

/** Close any currently open menu without touching focus. */
export function closeOpenMenu(): void {
  closeActiveMenu();
}

/**
 * Show a menu at viewport coordinates (`x`, `y`) or anchored to an element.
 * Only one menu is open at a time; opening a new one closes the previous.
 *
 * Rendering is delegated to the shared React overlay host; the contract is
 * unchanged: the panel exists in the DOM — positioned and keyboard-wired —
 * by the time this call returns.
 */
export function showContextMenu(
  entries: readonly MenuEntry[],
  anchor: MenuPointAnchor | HTMLElement,
): MenuHandle {
  return showContextMenuReact(entries, anchor);
}

/**
 * Element-scoped context-menu providers. Components attach providers to the
 * elements they own (tree rows, tabs…); the shell's single global listener
 * resolves the innermost provider on right-click.
 */
const contextProviders = new WeakMap<HTMLElement, (event: MouseEvent) => readonly MenuEntry[] | null>();

/** Attach a context-menu provider to an element. Disposing detaches it. */
export function registerContextMenu(
  target: HTMLElement,
  provider: (event: MouseEvent) => readonly MenuEntry[] | null,
): { dispose(): void } {
  contextProviders.set(target, provider);
  return {
    dispose() {
      if (contextProviders.get(target) === provider) contextProviders.delete(target);
    },
  };
}

/**
 * Resolve and open the context menu for a `contextmenu` event.
 * Returns true when a provider handled the event.
 */
export function dispatchContextMenu(event: MouseEvent): boolean {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  for (const node of path) {
    if (!(node instanceof HTMLElement)) continue;
    const provider = contextProviders.get(node);
    if (provider === undefined) continue;
    const entries = provider(event);
    if (entries === null || entries.length === 0) return true;
    showContextMenu(entries, {
      x: event.clientX,
      y: event.clientY,
      invoker:
        event.target instanceof Element
          ? (event.target.closest<HTMLElement>('button, [href], [tabindex]') ??
            node)
          : node,
    });
    return true;
  }
  return false;
}

/** Native text fields retain their edit menu; rich editors use app controls. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const editable = target.closest('input, textarea');
  return editable !== null;
}
