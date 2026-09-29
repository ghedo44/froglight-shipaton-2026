import { useLayoutEffect, useRef, type RefObject } from 'react';

/** Return focus when a dialog stops being interactive, including its exit animation. */
export function useDialogFocusReturn<T extends HTMLElement>(
  dialogRef: RefObject<T | null>,
  active = true,
): void {
  const invokerRef = useRef<HTMLElement | null>(null);
  const activeRef = useRef(false);

  useLayoutEffect(() => {
    if (active) {
      if (!activeRef.current) {
        invokerRef.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        activeRef.current = true;
      }
      return;
    }

    if (!activeRef.current) return;
    activeRef.current = false;
    const dialog = dialogRef.current;
    if (
      document.activeElement === document.body ||
      dialog?.contains(document.activeElement)
    ) {
      invokerRef.current?.focus({ preventScroll: true });
    }
    invokerRef.current = null;
  }, [active, dialogRef]);

  useLayoutEffect(
    () => () => {
      if (!activeRef.current) return;
      const dialog = dialogRef.current;
      const focused = document.activeElement;
      if (
        focused === null ||
        focused === document.body ||
        dialog?.contains(focused)
      ) {
        invokerRef.current?.focus({ preventScroll: true });
      }
    },
    [dialogRef],
  );
}
