// @vitest-environment jsdom
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { Dialog, type DialogHandle } from './Dialog.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('Dialog', () => {
  it('portals, isolates the background, traps focus and restores the invoker', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    function Example() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open</button>
          <Dialog open={open} onClose={() => setOpen(false)}>
            <Dialog.Content aria-label="Example">
              <button>First</button>
              <button>Last</button>
            </Dialog.Content>
          </Dialog>
        </>
      );
    }
    await act(async () => root!.render(<Example />));
    const invoker = host.querySelector('button')!;
    invoker.focus();
    await act(async () => invoker.click());
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(host.contains(dialog)).toBe(false);
    expect(host.inert).toBe(true);
    expect(document.activeElement?.textContent).toBe('First');
    await act(async () =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(host.inert).not.toBe(true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(host.inert).not.toBe(true);
    expect(document.activeElement).toBe(invoker);
  });

  it('keeps a nested dialog interactive until it closes', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    function Example() {
      const [inner, setInner] = useState(true);
      return (
        <Dialog open onClose={() => undefined}>
          <Dialog.Content aria-label="Outer">
            <Dialog open={inner} onClose={() => setInner(false)}>
              <Dialog.Content aria-label="Inner">
                <button>Close inner</button>
              </Dialog.Content>
            </Dialog>
          </Dialog.Content>
        </Dialog>
      );
    }
    await act(async () => root!.render(<Example />));
    const outer = document.body
      .querySelector<HTMLElement>('[aria-label="Outer"]')
      ?.closest<HTMLElement>('[data-fl-viewport-overlay]');
    const inner = document.body
      .querySelector<HTMLElement>('[aria-label="Inner"]')
      ?.closest<HTMLElement>('[data-fl-viewport-overlay]');
    expect(outer?.inert).toBe(true);
    expect(inner?.inert).toBe(false);
    await act(async () =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(outer?.inert).toBe(false);
    expect(document.activeElement).toBe(
      document.body.querySelector('[aria-label="Outer"]'),
    );
  });

  it('releases background and focus when an exit animation starts', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    function Example() {
      const [active, setActive] = useState(false);
      return (
        <>
          <button onClick={() => setActive(true)}>Open</button>
          <Dialog open active={active} onClose={() => setActive(false)}>
            <Dialog.Content aria-label="Exiting">
              <button>Inside</button>
            </Dialog.Content>
          </Dialog>
        </>
      );
    }
    await act(async () => root!.render(<Example />));
    const invoker = host.querySelector('button')!;
    invoker.focus();
    await act(async () => invoker.click());
    expect(host.inert).toBe(true);
    await act(async () =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(host.inert).not.toBe(true);
    expect(document.activeElement).toBe(invoker);
  });

  it('cancels a pending exit when the same dialog is reopened', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    let handle: DialogHandle | null = null;
    let closes = 0;
    function Example() {
      const closeRef = useRef<DialogHandle | null>(null);
      return (
        <>
          <button onClick={() => closeRef.current?.cancelClose()}>
            Reopen
          </button>
          <Dialog
            open
            closeRef={(value) => {
              closeRef.current = value;
              handle = value;
            }}
            onClose={() => {
              closes += 1;
            }}
          >
            <Dialog.Content aria-label="Reopenable">
              <button>Inside</button>
            </Dialog.Content>
          </Dialog>
        </>
      );
    }
    await act(async () => root!.render(<Example />));
    await act(async () => handle?.close());
    expect(document.body.querySelector('[data-closing]')).not.toBeNull();
    await act(async () => host!.querySelector('button')!.click());
    expect(document.body.querySelector('[data-closing]')).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 210));
    });
    expect(closes).toBe(0);
    expect(
      document.body.querySelector('[aria-label="Reopenable"]'),
    ).not.toBeNull();
  });
});
