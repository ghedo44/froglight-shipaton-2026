/**
 * Transient status feedback for the workspace shell.
 *
 * Replaces the old persistent status bar: `showToast` is stable across
 * renders (timers live in refs), so event handlers and effects can depend
 * on it without resubscribing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const TOAST_MS = 2600;
const TOAST_EXIT_MS = 200;

export interface Toast {
  readonly text: string;
  readonly kind: 'ok' | 'error';
  readonly at: number;
  readonly leaving: boolean;
}

export type Notify = (text: string, kind?: 'ok' | 'error') => void;

export function useToast(): { readonly toast: Toast | null; readonly notify: Notify } {
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastLeaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback<Notify>((text, kind = 'ok') => {
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    if (toastLeaveTimer.current !== null) clearTimeout(toastLeaveTimer.current);
    setToast({ text, kind, at: Date.now(), leaving: false });
    toastLeaveTimer.current = setTimeout(() => {
      setToast((current) =>
        current === null ? null : { ...current, leaving: true },
      );
    }, TOAST_MS - TOAST_EXIT_MS);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current !== null) clearTimeout(toastTimer.current);
      if (toastLeaveTimer.current !== null)
        clearTimeout(toastLeaveTimer.current);
    },
    [],
  );

  return { toast, notify };
}
