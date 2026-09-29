import { DialogHeader, DialogBody } from './DialogParts.jsx';
import { Dialog, type DialogHandle } from './primitives/Dialog.jsx';
/**
 * React-backed hosts for the imperative overlay APIs.
 *
 * `showContextMenu`, `uiPrompt`, and `uiConfirm` are called from both React
 * components and plugin-contributed imperative views, so they render through
 * a private module-level React root attached to `document.body` and commit
 * synchronously (`flushSync`) with layout-effect wiring — callers observe the
 * panel in the DOM, fully wired, the moment the call returns. This preserves
 * the exact contract of the previous hand-rolled DOM implementations.
 */

import { createElement, useId, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import {
  clampMenuPosition,
  type MenuEntry,
  type MenuHandle,
  type MenuPointAnchor,
} from '../menu.js';
import { currentKeyboardInsetTarget } from '../platform/keyboard-inset.js';
import { currentVisualViewportPan } from '../platform/keyboard/ios-viewport-pan-guard.js';
import { useAboveKeyboard } from './useAboveKeyboard.js';
import { Button } from './Button.jsx';
import { Icon } from './Icon.jsx';
import styles from './Overlays.module.css';
import {
  NewNoteModal,
  type NewNoteChoice,
  type NewNoteOptions,
} from './NewNoteModal.jsx';

export type { NewNoteChoice };

function isSeparator(entry: MenuEntry): entry is 'separator' {
  return entry === 'separator';
}

/** jsdom-safe nearest-block scrolling (shared with other overlays). */
export function reveal(element: Element | undefined | null): void {
  element?.scrollIntoView?.({ block: 'nearest' });
}

let overlayRoot: Root | null = null;

/** One lazy body-level root hosting every transient overlay. */
function acquireOverlayRoot(): Root {
  if (overlayRoot !== null) return overlayRoot;
  const host = document.createElement('div');
  host.className = 'froglight-overlay-host';
  document.body.appendChild(host);
  overlayRoot = createRoot(host);
  return overlayRoot;
}

function clearOverlay(): void {
  if (overlayRoot === null) return;
  flushSync(() => {
    overlayRoot!.render(createElement('span', { style: { display: 'none' } }));
  });
}

/**
 * Tear down the module-level overlay root entirely. Called by the app mount's
 * dispose so a disposed shell leaves zero residual DOM behind.
 */
export function disposeOverlayHost(): void {
  if (overlayRoot === null) return;
  overlayRoot.unmount();
  overlayRoot = null;
  document.querySelector('.froglight-overlay-host')?.remove();
}

// ------------------------------------------------------------------ menus

interface ActiveMenu {
  readonly entries: readonly MenuEntry[];
  readonly openedAt: number;
  readonly x: number;
  readonly y: number;
  readonly invoker: HTMLElement | null;
  readonly onClose: () => void;
  readonly onWithdraw: () => void;
}

let openMenuCloser: (() => void) | null = null;
const menuInvokerSelector =
  'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

function focusableMenuInvoker(
  candidate: HTMLElement | null,
): HTMLElement | null {
  if (candidate !== null && candidate.isConnected) {
    if (candidate.matches(menuInvokerSelector)) return candidate;
    const descendant =
      candidate.querySelector<HTMLElement>(menuInvokerSelector);
    if (descendant !== null) return descendant;
  }
  return document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
}

function menuInvokerIsAvailable(invoker: HTMLElement): boolean {
  if (!invoker.isConnected) return false;
  for (
    let element: HTMLElement | null = invoker;
    element !== null;
    element = element.parentElement
  ) {
    if (element.hidden || element.inert) return false;
    const style = window.getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      style.pointerEvents === 'none' ||
      style.opacity === '0'
    ) {
      return false;
    }
  }
  return true;
}

/** Close whichever menu is currently open (single source of truth). */
export function closeActiveMenu(): void {
  openMenuCloser?.();
}

/**
 * Show a menu at viewport coordinates (`x`, `y`) or anchored to an element.
 * Only one menu is open at a time; opening a new one closes the previous.
 */
export function showContextMenuReact(
  entries: readonly MenuEntry[],
  anchor: MenuPointAnchor | HTMLElement,
): MenuHandle {
  openMenuCloser?.();
  if (entries.length === 0) return { close: () => undefined, closed: true };

  const invoker = focusableMenuInvoker(
    anchor instanceof HTMLElement && anchor.isConnected
      ? anchor
      : ((!(anchor instanceof HTMLElement) ? anchor.invoker : null) ??
          (document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null)),
  );
  // Hover-only row controls must stay visible while the pointer enters the portal.
  invoker?.setAttribute('data-fl-menu-open', '');
  let closed = false;

  const close = (refocus = true): void => {
    if (closed) return;
    closed = true;
    if (openMenuCloser === closer) openMenuCloser = null;
    clearOverlay();
    if (refocus && invoker instanceof HTMLElement && invoker.isConnected) {
      invoker.focus({ preventScroll: true });
    }
    invoker?.removeAttribute('data-fl-menu-open');
  };
  const closer = (): void => close(true);

  const active: ActiveMenu = {
    entries,
    openedAt: performance.now(),
    x: anchor instanceof HTMLElement ? Number.NaN : anchor.x,
    y: anchor instanceof HTMLElement ? Number.NaN : anchor.y,
    invoker,
    onClose: closer,
    onWithdraw: () => close(false),
  };

  const root = acquireOverlayRoot();
  flushSync(() => {
    root.render(createElement(MenuOverlay, { active }));
  });
  openMenuCloser = closer;

  return {
    close: closer,
    get closed() {
      return closed;
    },
  };
}

function MenuOverlay(props: { active: ActiveMenu }): React.ReactElement {
  const { active } = props;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const selectionRef = useRef(-1);
  const typeahead = useRef<{
    term: string;
    timer: ReturnType<typeof setTimeout> | null;
  }>({
    term: '',
    timer: null,
  });
  const [selection, setSelection] = useState(-1);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);

  const applySelection = (index: number, revealSelection = true): void => {
    selectionRef.current = index;
    setSelection(index);
    const item = panelRef.current?.querySelectorAll<HTMLElement>(
      `.${styles['fl-menu-item']}`,
    )[index];
    item?.focus({ preventScroll: true });
    if (revealSelection) item?.scrollIntoView?.({ block: 'nearest' });
  };

  // Measure once mounted, then clamp into the viewport so menus never spawn
  // off-screen.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    let originX = active.x;
    let originY = active.y;
    if (active.invoker !== null) {
      const rect = active.invoker.getBoundingClientRect();
      originX = Number.isNaN(active.x) ? rect.left : active.x;
      originY = Number.isNaN(active.y) ? rect.bottom + 4 : active.y;
    }
    // Layout dimensions ignore the entrance scale. A transformed bounding box
    // is smaller for the first frame and would clamp the final menu too late.
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    setPosition(
      clampMenuPosition(
        originX,
        originY,
        width,
        height,
        window.innerWidth,
        window.innerHeight,
        // The overlay keyboard never shrinks the layout viewport: exclude
        // the effective reservation (keyboard inset plus positive
        // visual-viewport pan) so the painted menu — self-translated after
        // layout — still ends above the keyboard. The pan is
        // counted here, never added again in CSS.
        currentKeyboardInsetTarget() + Math.max(0, currentVisualViewportPan()),
      ),
    );
  }, [active]);

  // The initial measuring render is visibility:hidden. Focus only after the
  // positioned render is visible; Chromium rejects focus on hidden controls.
  useLayoutEffect(() => {
    if (position === null) return;
    const panel = panelRef.current;
    if (panel === null) return;
    const items = [
      ...panel.querySelectorAll<HTMLButtonElement>(
        `.${styles['fl-menu-item']}:not(:disabled)`,
      ),
    ];
    const first = items[0];
    if (first !== undefined) {
      const allItems = [
        ...panel.querySelectorAll<HTMLButtonElement>(
          `.${styles['fl-menu-item']}`,
        ),
      ];
      // The panel has just been positioned around its invoker, so the first
      // item is visible. Avoid generating a deferred scroll event
      // that could be mistaken for an external coordinate-space change.
      applySelection(allItems.indexOf(first), false);
    } else {
      panel.focus({ preventScroll: true });
    }
  }, [active, position]);

  useLayoutEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        active.onClose();
        return;
      }
      const allItems = [
        ...(panelRef.current?.querySelectorAll<HTMLButtonElement>(
          `.${styles['fl-menu-item']}`,
        ) ?? []),
      ];
      const enabledIndexes = allItems.flatMap((item, index) =>
        item.disabled ? [] : [index],
      );
      if (event.key === 'Tab') {
        active.onClose();
        return;
      }
      if (enabledIndexes.length === 0) return;
      const selected = selectionRef.current;
      const moveBy = (delta: -1 | 1): void => {
        const at = enabledIndexes.indexOf(selected);
        const next =
          enabledIndexes[
            (at + delta + enabledIndexes.length) % enabledIndexes.length
          ];
        if (next !== undefined) applySelection(next);
      };
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveBy(1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveBy(-1);
      } else if (event.key === 'Home') {
        event.preventDefault();
        applySelection(enabledIndexes[0]!);
      } else if (event.key === 'End') {
        event.preventDefault();
        applySelection(enabledIndexes[enabledIndexes.length - 1]!);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        const target = allItems[selected];
        if (target !== undefined && !target.disabled) target.click();
      } else if (
        event.key.length === 1 &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        const memo = typeahead.current;
        if (memo.timer !== null) clearTimeout(memo.timer);
        memo.term += event.key.toLowerCase();
        memo.timer = setTimeout(() => {
          memo.term = '';
        }, 500);
        const from = memo.term.length > 1 ? selected + 1 : 0;
        const rotated = [...allItems.slice(from), ...allItems.slice(0, from)];
        const offset = rotated.findIndex(
          (item) =>
            !item.disabled &&
            (
              item.querySelector<HTMLElement>(
                `.${styles['fl-menu-item-label']}`,
              )?.textContent ?? ''
            )
              .trim()
              .toLowerCase()
              .startsWith(memo.term),
        );
        if (offset >= 0) applySelection((from + offset) % allItems.length);
      }
    };

    const onPointerDown = (event: PointerEvent): void => {
      const panel = panelRef.current;
      if (panel !== null && panel.contains(event.target as Node)) return;
      active.onClose();
    };
    const dismiss = (): void => active.onClose();
    const onScroll = (event: Event): void => {
      // A scroll queued while the invoker was brought into view can arrive
      // after the menu opens. It belongs to the click, not a new dismissal.
      if (event.timeStamp < active.openedAt) return;
      const panel = panelRef.current;
      if (
        panel !== null &&
        event.target instanceof Node &&
        panel.contains(event.target)
      ) {
        return;
      }
      if (
        active.invoker !== null &&
        event.target instanceof Element &&
        !event.target.contains(active.invoker)
      ) {
        return;
      }
      active.onClose();
    };

    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    window.addEventListener('scroll', onScroll, true);
    const invoker = active.invoker;
    const anchorObserver =
      invoker === null
        ? null
        : new MutationObserver(() => {
            if (!menuInvokerIsAvailable(invoker)) active.onWithdraw();
          });
    anchorObserver?.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'hidden', 'inert', 'style'],
      childList: true,
      subtree: true,
    });
    return () => {
      if (typeahead.current.timer !== null) {
        clearTimeout(typeahead.current.timer);
        typeahead.current.timer = null;
      }
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('scroll', onScroll, true);
      anchorObserver?.disconnect();
    };
  }, [active]);

  let runningIndex = -1;
  const hasCheckedItems = active.entries.some(
    (entry) => !isSeparator(entry) && entry.checked !== undefined,
  );
  return (
    <div
      ref={panelRef}
      className={styles['fl-menu']}
      role="menu"
      tabIndex={-1}
      data-fl-viewport-overlay=""
      style={
        position === null
          ? { visibility: 'hidden' }
          : { left: position.left, top: position.top }
      }
    >
      {active.entries.map((entry, entryAt) => {
        if (isSeparator(entry)) {
          return (
            <div
              key={`sep-${entryAt}`}
              className={styles['fl-menu-separator']}
              role="separator"
            />
          );
        }
        runningIndex += 1;
        const itemIndex = runningIndex;
        return (
          <button
            key={`${entry.label ?? 'item'}-${entryAt}`}
            type="button"
            className={`${styles['fl-menu-item']}${itemIndex === selection ? ` ${styles.selected}` : ''}`}
            role={entry.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={
              entry.checked !== undefined ? entry.checked : undefined
            }
            tabIndex={itemIndex === selection ? 0 : -1}
            data-danger={entry.danger === true ? 'true' : 'false'}
            disabled={entry.disabled === true}
            aria-disabled={entry.disabled === true ? 'true' : undefined}
            onClick={() => {
              if (entry.disabled === true) return;
              active.onClose();
              entry.run?.();
            }}
            onMouseEnter={() => {
              selectionRef.current = itemIndex;
              setSelection(itemIndex);
            }}
          >
            <span className={styles['fl-menu-item-icon']}>
              {entry.icon !== undefined ? (
                <Icon name={entry.icon} size={15} />
              ) : null}
            </span>
            {hasCheckedItems ? (
              <span className={styles['fl-menu-item-check']}>
                {entry.checked === true ? (
                  <Icon name="check" size={12} />
                ) : null}
              </span>
            ) : null}
            <span className={styles['fl-menu-item-label']}>
              {entry.label ?? ''}
            </span>
            {entry.shortcut !== undefined ? (
              <kbd className={styles['fl-menu-item-shortcut']}>
                {entry.shortcut}
              </kbd>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ dialogs

export interface ReactPromptOptions {
  readonly placeholder?: string;
  readonly initialValue?: string;
  readonly confirmLabel?: string;
  readonly description?: string;
  readonly inputType?: 'text' | 'password';
}

export function uiPromptReact(
  title: string,
  options: ReactPromptOptions = {},
): Promise<string | null> {
  const invoker = document.activeElement;
  return new Promise((resolve) => {
    const finish = (value: string | null): void => {
      clearOverlay();
      if (invoker instanceof HTMLElement && invoker.isConnected) {
        invoker.focus({ preventScroll: true });
      }
      resolve(value);
    };
    const root = acquireOverlayRoot();
    flushSync(() => {
      root.render(
        createElement(PromptDialog, { title, options, onFinish: finish }),
      );
    });
  });
}

function PromptDialog(props: {
  title: string;
  options: ReactPromptOptions;
  onFinish(value: string | null): void;
}): React.ReactElement {
  const { title, options, onFinish } = props;
  const titleId = useId();
  const descriptionId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const valueRef = useRef(options.initialValue ?? '');
  const finishedRef = useRef(false);
  const closeRef = useRef<DialogHandle | null>(null);
  // The dialog card glides with the keyboard animation; usable-viewport
  // geometry (backdrop ending at the keyboard top) lives in the stylesheet.
  const dialogRef = useAboveKeyboard<HTMLDivElement>();
  const onDialogKeyDown = (event: KeyboardEvent): void => {
      if (
        event.key === 'Enter' &&
        event.target === inputRef.current &&
        !event.isComposing
      ) {
        event.preventDefault();
        event.stopPropagation();
        settle(valueRef.current.trim() === '' ? null : valueRef.current);
      }
  };

  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const settle = (value: string | null): void => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    closeRef.current?.close(() => onFinish(value));
  };
  const submit = (): void =>
    settle(valueRef.current.trim() === '' ? null : valueRef.current);

  return (
    <Dialog open onKeyDown={onDialogKeyDown} closeRef={closeRef}
      className={styles['froglight-modal-backdrop']}
      onClose={() => {
        finishedRef.current = true;
        onFinish(null);
      }}
    >
      <Dialog.Content unstyled
        ref={dialogRef}
        className={styles['froglight-modal']}
        aria-labelledby={titleId}
        aria-describedby={
          options.description !== undefined ? descriptionId : undefined
        }
      >
        <DialogHeader>
          <h2 id={titleId}>{title}</h2>
        </DialogHeader>
        <DialogBody>
          {options.description !== undefined ? (
            <p
              id={descriptionId}
              className={styles['froglight-modal-description']}
            >
              {options.description}
            </p>
          ) : null}
          <input
            ref={inputRef}
            aria-label={title}
            type={options.inputType ?? 'text'}
            autoComplete={
              options.inputType === 'password' ? 'current-password' : 'off'
            }
            spellCheck={false}
            placeholder={options.placeholder}
            defaultValue={options.initialValue ?? ''}
            onInput={(event) => {
              valueRef.current = event.currentTarget.value;
            }}
          />
          <div className={styles['froglight-modal-actions']}>
            <Button
              type="button"
              variant="secondary"
              onClick={() => settle(null)}
            >
              Cancel
            </Button>
            <Button type="button" variant="primary" onClick={submit}>
              {options.confirmLabel ?? 'OK'}
            </Button>
          </div>
        </DialogBody>
      </Dialog.Content>
    </Dialog>
  );
}

export function uiConfirmReact(
  title: string,
  description?: string,
  confirmLabel = 'Delete',
): Promise<boolean> {
  const invoker = document.activeElement;
  return new Promise((resolve) => {
    const finish = (value: boolean): void => {
      clearOverlay();
      if (invoker instanceof HTMLElement && invoker.isConnected) {
        invoker.focus({ preventScroll: true });
      }
      resolve(value);
    };
    const root = acquireOverlayRoot();
    flushSync(() => {
      root.render(
        createElement(ConfirmDialog, {
          title,
          description,
          confirmLabel,
          onFinish: finish,
        }),
      );
    });
  });
}

/**
 * New-note picker: resolves with the chosen name + kind, or null on
 * dismissal. Same imperative contract as `uiPrompt` so non-React callers
 * (the file explorer) and React callers share one overlay host.
 */
export function uiPromptNewNoteReact(
  options: NewNoteOptions,
): Promise<NewNoteChoice | null> {
  const invoker = document.activeElement;
  return new Promise((resolve) => {
    const finish = (choice: NewNoteChoice | null): void => {
      clearOverlay();
      if (invoker instanceof HTMLElement && invoker.isConnected) {
        invoker.focus({ preventScroll: true });
      }
      resolve(choice);
    };
    const root = acquireOverlayRoot();
    flushSync(() => {
      root.render(createElement(NewNoteModal, { onFinish: finish, options }));
    });
  });
}

function ConfirmDialog(props: {
  title: string;
  description?: string;
  confirmLabel: string;
  onFinish(value: boolean): void;
}): React.ReactElement {
  const { title, description, onFinish } = props;
  const titleId = useId();
  const descriptionId = useId();
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const finishedRef = useRef(false);
  const closeRef = useRef<DialogHandle | null>(null);
  const dialogRef = useAboveKeyboard<HTMLDivElement>();

  useLayoutEffect(() => {
    confirmRef.current?.focus();
  }, []);

  const settle = (value: boolean): void => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    closeRef.current?.close(() => onFinish(value));
  };

  return (
    <Dialog open closeRef={closeRef}
      className={styles['froglight-modal-backdrop']}
      onClose={() => {
        finishedRef.current = true;
        onFinish(false);
      }}
    >
      <Dialog.Content unstyled
        ref={dialogRef}
        className={`${styles['froglight-modal']} ${styles['froglight-modal-small']}`}
        role="alertdialog"
        aria-labelledby={titleId}
        aria-describedby={description === undefined ? undefined : descriptionId}
      >
        <DialogHeader>
          <h2 id={titleId}>{title}</h2>
        </DialogHeader>
        <DialogBody>
          {description !== undefined ? (
            <p
              id={descriptionId}
              className={styles['froglight-modal-description']}
            >
              {description}
            </p>
          ) : null}
          <div className={styles['froglight-modal-actions']}>
            <Button
              type="button"
              variant="secondary"
              onClick={() => settle(false)}
            >
              Cancel
            </Button>
            <Button
              ref={confirmRef}
              type="button"
              variant="danger"
              onClick={() => settle(true)}
            >
              {props.confirmLabel}
            </Button>
          </div>
        </DialogBody>
      </Dialog.Content>
    </Dialog>
  );
}
