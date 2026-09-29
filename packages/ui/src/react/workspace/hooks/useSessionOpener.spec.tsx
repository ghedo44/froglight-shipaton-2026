// @vitest-environment jsdom
import { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { createHarness, makeChoice } from '../../test-support.js';
import { useSessionOpener } from './useSessionOpener.js';

it('attaches a reader outside the shell effect so its isolated root can commit synchronously', async () => {
  const h = await createHarness([makeChoice({ id: 'v1', name: 'Test vault' })]);
  const rootElement = document.createElement('div');
  document.body.append(rootElement);
  const root = createRoot(rootElement);
  let readerRoot: Root | undefined;
  let committed = false;
  const setReaderHost = vi.fn((_pane: string, element: HTMLElement) => {
    readerRoot = createRoot(element);
    flushSync(() =>
      readerRoot!.render(
        <p
          ref={(node) => {
            committed = node !== null;
          }}
        >
          Preview
        </p>,
      ),
    );
    expect(committed).toBe(true);
  });
  const controller = {
    ...h.controller,
    initialize: async () => undefined,
    isPaneAttached: () => true,
    isReaderAttached: () => false,
    setReaderHost,
  };
  function Shell() {
    const hosts = useSessionOpener({
      host: controller,
      reading: {
        ...controller,
        tabMode: () => 'split',
        readingPresentation: () => ({
          kind: 'separate-reader',
          provider: { id: 'test-reader' } as never,
          kindId: 'test' as never,
        }),
      },
      state: controller,
      settingsService: null,
      paneStates: [{ ...h.controller.paneStates()[0]!, mode: 'split' }],
      revision: 1,
      choice: makeChoice({ id: 'v1', name: 'Test vault' }),
      notify: () => undefined,
      onInitialized: () => undefined,
    });
    return (
      <div
        ref={(element) => {
          if (element) hosts.readerHosts.current.set('main', element);
          else hosts.readerHosts.current.delete('main');
        }}
      />
    );
  }
  try {
    await act(async () => {
      root.render(<Shell />);
    });
    expect(setReaderHost).toHaveBeenCalledOnce();
    expect(rootElement.textContent).toBe('Preview');
  } finally {
    await act(async () => {
      readerRoot?.unmount();
      root.unmount();
    });
    rootElement.remove();
    await h.dispose();
  }
});
