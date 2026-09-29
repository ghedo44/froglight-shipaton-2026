/**
 * React access to the host keyboard-inset capability.
 *
 * Layout-only consumers should normally use the shared CSS environment
 * variables. Components that need semantic keyboard state can call
 * `useKeyboardInset()`; components that only need transition motion use
 * `useAboveKeyboard()` instead. No consumer needs Tauri, platform sniffing,
 * or VisualViewport logic.
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import type {
  KeyboardInsetService,
  KeyboardInsetSnapshot,
} from '@froglight/foundation';

const CLOSED_KEYBOARD: KeyboardInsetSnapshot = Object.freeze({
  height: 0,
  isOpen: false,
  reservedHeight: 0,
});

const KeyboardInsetContext = createContext<KeyboardInsetService | null>(null);

export interface KeyboardInsetProviderProps {
  readonly service: KeyboardInsetService | null;
  readonly children?: ReactNode;
}

/** Shell-owned provider. Application components consume the hook, not this. */
export function KeyboardInsetProvider(
  props: KeyboardInsetProviderProps,
): React.ReactElement {
  return (
    <KeyboardInsetContext.Provider value={props.service}>
      {props.children}
    </KeyboardInsetContext.Provider>
  );
}

/**
 * Live semantic keyboard state for trusted React UI.
 *
 * Foundation publishes live height/open snapshots and settled-height events
 * separately. Subscribe to both so `reservedHeight` is live too, while the
 * framework-free store can keep returning plain value snapshots.
 */
export function useKeyboardInset(): KeyboardInsetSnapshot {
  const service = useContext(KeyboardInsetContext);
  const [snapshot, setSnapshot] = useState<KeyboardInsetSnapshot>(() =>
    service?.snapshot() ?? CLOSED_KEYBOARD,
  );

  useEffect(() => {
    if (service === null) {
      setSnapshot(CLOSED_KEYBOARD);
      return;
    }

    const refresh = (): void => setSnapshot(service.snapshot());
    const offSnapshot = service.subscribe(setSnapshot);
    const offSettled = service.onSettled(refresh);
    // Subscribe first, then refresh to close the render/effect race.
    refresh();
    return () => {
      offSettled();
      offSnapshot();
    };
  }, [service]);

  return snapshot;
}
