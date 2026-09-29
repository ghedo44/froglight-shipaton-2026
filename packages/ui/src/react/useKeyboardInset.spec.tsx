// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { KeyboardInsetStore } from '@froglight/foundation';
import {
  KeyboardInsetProvider,
  useKeyboardInset,
} from './useKeyboardInset.js';

let root: Root | null = null;
let store: KeyboardInsetStore | null = null;

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  store?.dispose();
  store = null;
  document.body.replaceChildren();
});

function SnapshotProbe(): React.ReactElement {
  const keyboard = useKeyboardInset();
  return (
    <output data-testid="keyboard-state">
      {`${keyboard.height}:${keyboard.isOpen ? 'open' : 'closed'}:${keyboard.reservedHeight}`}
    </output>
  );
}

describe('useKeyboardInset', () => {
  it('exposes live height/open/reserved state without host/platform knowledge', async () => {
    store = new KeyboardInsetStore({ settleDebounceMs: 0 });
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    act(() => {
      root!.render(
        <KeyboardInsetProvider service={store}>
          <SnapshotProbe />
        </KeyboardInsetProvider>,
      );
    });
    expect(container.textContent).toBe('0:closed:270');

    act(() => {
      store!.handleNativeEvent('target', {
        height: 312,
        durationMs: 0,
        measurement: 'exact',
      });
    });
    expect(container.textContent).toBe('312:open:270');

    await act(async () => {
      store!.handleNativeEvent('settled', { height: 312 });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toBe('312:open:312');

    act(() => {
      store!.handleNativeEvent('didHide', {});
    });
    expect(container.textContent).toBe('0:closed:312');
  });

  it('returns a zero state when no keyboard capability is installed', () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <KeyboardInsetProvider service={null}>
          <SnapshotProbe />
        </KeyboardInsetProvider>,
      );
    });
    expect(container.textContent).toBe('0:closed:0');
  });
});
