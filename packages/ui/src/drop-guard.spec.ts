// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installWebviewDropGuard } from './drop-guard.js';

function fileTransfer(): DataTransfer {
  return {
    types: ['Files'],
    files: [{ name: 'a.md' } as unknown as File] as unknown as FileList,
    getData: () => '',
    setData: () => undefined,
    dropEffect: 'none',
    effectAllowed: 'all',
  } as unknown as DataTransfer;
}

function dispatch(
  target: EventTarget,
  type: 'dragover' | 'drop',
  dataTransfer: DataTransfer,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('installWebviewDropGuard (never navigate the WebView on drop)', () => {
  it('suppresses the default navigation for file drags anywhere', () => {
    const uninstall = installWebviewDropGuard(window);
    try {
      // Outside the explorer (editor area, empty pane): without the guard
      // the WebView navigates to the file and the whole UI disappears.
      const over = dispatch(document.body, 'dragover', fileTransfer());
      expect(over.defaultPrevented).toBe(true);
      const drop = dispatch(document.body, 'drop', fileTransfer());
      expect(drop.defaultPrevented).toBe(true);
    } finally {
      uninstall();
    }
  });

  it('never stops propagation: explorer handlers still receive the drop', () => {
    const uninstall = installWebviewDropGuard(window);
    try {
      const seen: string[] = [];
      const target = document.createElement('div');
      document.body.appendChild(target);
      try {
        target.addEventListener('drop', () => seen.push('drop'));
        dispatch(target, 'drop', fileTransfer());
        expect(seen).toEqual(['drop']);
      } finally {
        target.remove();
      }
    } finally {
      uninstall();
    }
  });

  it('uninstall removes exactly the installed listeners', () => {
    const uninstall = installWebviewDropGuard(window);
    uninstall();
    uninstall();
    const drop = dispatch(document.body, 'drop', fileTransfer());
    expect(drop.defaultPrevented).toBe(false);
  });

  it('is a no-op without a DOM scope', () => {
    expect(() => installWebviewDropGuard(null)).not.toThrow();
    expect(installWebviewDropGuard(null)).toBeTypeOf('function');
  });
});
