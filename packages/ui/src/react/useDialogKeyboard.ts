import { useLayoutEffect, useRef, type RefObject } from 'react';
import { trapDialogFocus } from './dialog-focus.js';

export interface DialogKeyboardOptions {
  /** Return false to leave Escape available to an enclosing dialog. */
  onEscape?: () => boolean | void;
  /** Handle dialog-specific keys before the default Tab behavior. */
  onKeyDown?: (event: KeyboardEvent, dialog: HTMLElement) => void;
  active?: boolean;
  /** Ignore events owned by a nested dialog, alert dialog, or menu. */
  ignoreNested?: boolean;
}

/** Own document-level Escape and Tab handling for an in-app dialog. */
export function useDialogKeyboard<T extends HTMLElement>(
  dialogRef: RefObject<T | null>,
  options: DialogKeyboardOptions,
): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useLayoutEffect(() => {
    if (options.active === false) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      const dialog = dialogRef.current;
      if (dialog === null) return;

      const current = optionsRef.current;
      const owner =
        event.target instanceof Element
          ? event.target.closest(
              '[role="dialog"], [role="alertdialog"], [role="menu"]',
            )
          : null;
      if (current.ignoreNested !== false && owner !== null && owner !== dialog)
        return;

      current.onKeyDown?.(event, dialog);
      if (event.defaultPrevented) return;

      if (event.key === 'Escape' && current.onEscape !== undefined) {
        const handled = current.onEscape();
        if (handled !== false) {
          event.preventDefault();
          event.stopPropagation();
        }
      } else if (event.key === 'Tab') {
        trapDialogFocus(event, dialog);
      }
    };

    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [dialogRef, options.active]);
}
