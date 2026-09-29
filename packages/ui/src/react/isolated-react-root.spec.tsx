// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { mountIsolatedReactRoot } from './isolated-react-root.js';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function label(text: string) {
  return createElement('span', { className: 'owned-label' }, text);
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('mountIsolatedReactRoot (provider root ownership)', () => {
  it('commits synchronously: the caller reads chrome back immediately', () => {
    const container = document.createElement('div');
    container.textContent = 'stale';
    document.body.appendChild(container);
    const owned = mountIsolatedReactRoot(container, label('chrome'));
    try {
      // No act flush, no frame: the initial commit already happened.
      expect(container.querySelector('.owned-label')?.textContent).toBe(
        'chrome',
      );
    } finally {
      act(() => {
        owned.dispose();
      });
      container.remove();
    }
  });

  it('replaces stale container children on mount', () => {
    const container = document.createElement('div');
    container.textContent = 'stale';
    document.body.appendChild(container);
    const owned = mountIsolatedReactRoot(container, label('fresh'));
    try {
      expect(container.textContent).toBe('fresh');
    } finally {
      act(() => {
        owned.dispose();
      });
      container.remove();
    }
  });

  it('forbids a second concurrent mount on the same container', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const first = mountIsolatedReactRoot(container, label('one'));
    try {
      expect(() => mountIsolatedReactRoot(container, label('two'))).toThrow(
        /already hosts a live React root/,
      );
      expect(container.querySelector('.owned-label')?.textContent).toBe('one');
    } finally {
      act(() => {
        first.dispose();
      });
      container.remove();
    }
  });

  it('dispose is idempotent and clears the container', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    let owned: { dispose(): void } | null = null;
    act(() => {
      owned = mountIsolatedReactRoot(container, label('chrome'));
    });
    act(() => {
      owned!.dispose();
    });
    expect(() => owned!.dispose()).not.toThrow();
    expect(container.querySelector('.owned-label')).toBeNull();
    container.remove();
  });

  it('a stale disposer never unmounts a newer owner root', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const first = mountIsolatedReactRoot(container, label('one'));
    // The first owner is gone; a second owner takes the container. A repeat
    // dispose from the stale owner must leave the live root untouched.
    act(() => {
      first.dispose();
    });
    const second = mountIsolatedReactRoot(container, label('two'));
    try {
      // The stale disposer is a no-op now — the live root survives.
      expect(() => first.dispose()).not.toThrow();
      expect(container.querySelector('.owned-label')?.textContent).toBe('two');
    } finally {
      act(() => {
        second.dispose();
      });
      container.remove();
    }
  });

  it('remounts cleanly after dispose', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const first = mountIsolatedReactRoot(container, label('one'));
    act(() => {
      first.dispose();
    });
    const second = mountIsolatedReactRoot(container, label('two'));
    try {
      expect(container.querySelector('.owned-label')?.textContent).toBe('two');
    } finally {
      act(() => {
        second.dispose();
      });
      container.remove();
    }
  });
});
