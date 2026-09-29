/**
 * React hook registering a node above the overlay keyboard.
 *
 * Across keyboard transitions the node glides on the compositor instead of
 * reflowing per frame. Returns a ref callback to spread onto the element;
 * unregisters on unmount. No-op without an attached keyboard shell.
 */

import { useCallback, useEffect, useRef } from 'react';
import { registerAboveKeyboard } from '../platform/keyboard-inset.js';

export function useAboveKeyboard<T extends HTMLElement>(): (
  node: T | null,
) => void {
  const unregister = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      unregister.current?.();
      unregister.current = null;
    },
    [],
  );
  return useCallback((node: T | null) => {
    unregister.current?.();
    unregister.current = null;
    if (node !== null) unregister.current = registerAboveKeyboard(node);
  }, []);
}
