// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SwitcherOverlay } from './SwitcherOverlay.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe('switcher overlay lifecycle', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  let trigger: HTMLButtonElement | null = null;

  afterEach(() => {
    if (root !== null) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    trigger?.remove();
    trigger = null;
  });

  it('releases focus and keyboard ownership as the exit animation starts', () => {
    trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const onClose = vi.fn();
    const render = (): void => {
      act(() => {
        root?.render(
          createElement(SwitcherOverlay, {
            listDocuments: () => [],
            onPick: vi.fn(),
            onClose,
          }),
        );
      });
    };

    render();
    expect(document.activeElement).toBe(document.body.querySelector('input'));

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.activeElement).toBe(trigger);
    expect(
      document.body.querySelector('[role="dialog"]')?.hasAttribute('aria-modal'),
    ).toBe(false);
    const backdrop = document.body.querySelector<HTMLElement>(
      '[data-fl-component="switcher"]',
    );
    if (backdrop === null) throw new Error('switcher backdrop is missing');
    backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();

    expect(backdrop.hasAttribute('data-closing')).toBe(true);
  });

  it('finishes closing before opening the selected document', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const calls: string[] = [];
    act(() => root!.render(createElement(SwitcherOverlay, {
      listDocuments: () => [{ documentId: 'selected', title: 'Selected', path: 'Selected.md' }],
      onPick: (id) => calls.push(`pick:${id}`),
      onClose: () => { calls.push('close'); },
    })));
    act(() => document.body.querySelector<HTMLButtonElement>('[role="option"]')!.click());
    expect(calls).toEqual([]);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 210)); });
    expect(calls).toEqual(['close', 'pick:selected']);
  });
});
