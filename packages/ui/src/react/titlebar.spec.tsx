// @vitest-environment jsdom
import { act } from 'react';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { noWindowChrome, type WindowChrome } from '../window-chrome.js';
import { chromeDouble } from './test-support.js';
import { Titlebar } from './Titlebar.jsx';
import styles from './Titlebar.module.css';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

interface OverlayFixture {
  chrome: WindowChrome;
  inset: { left: number; right: number };
  fireInsetChange(): void;
  dispose: ReturnType<typeof vi.fn<() => void>>;
}

/** A WCO-like chrome: the OS draws controls; the bar must pad around them. */
function overlayChromeFixture(): OverlayFixture {
  const listeners = new Set<() => void>();
  const fixture: OverlayFixture = {
    inset: { left: 0, right: 138 },
    dispose: vi.fn(),
    fireInsetChange: () => {
      for (const listener of [...listeners]) listener();
    },
    chrome: null as unknown as WindowChrome,
  };
  fixture.chrome = {
    kind: 'window-controls-overlay',
    appControls: false,
    // Installed PWAs drag through the CSS drag region (the OS overlay strip
    // is not draggable on its own).
    dragRegion: true,
    inset: () => fixture.inset,
    onInsetChange: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    minimize: () => Promise.resolve(),
    toggleMaximize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    dispose: () => fixture.dispose(),
  };
  return fixture;
}

describe('Titlebar', () => {
  it('maps every asserted class through the CSS module', () => {
    for (const name of [
      'fl-titlebar',
      'fl-titlebar-main',
      'fl-titlebar-spacer',
      'fl-wincontrols',
      'fl-wincontrol',
      'close',
    ]) {
      expect(styles[name], `module class ${name}`).toMatch(/\S/);
    }
  });

  let host: HTMLDivElement | null = null;
  let root: Root | null = null;

  async function mount(element: React.ReactElement): Promise<HTMLDivElement> {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(element);
    });
    return host;
  }

  afterEach(async () => {
    if (root !== null) {
      await act(async () => {
        root!.unmount();
      });
    }
    host?.remove();
    host = null;
    root = null;
  });

  it('renders as a plain app header when the host has no custom chrome', async () => {
    const dom = await mount(
      createElement(Titlebar, { chrome: noWindowChrome() }, 'content'),
    );
    const bar = dom.querySelector<HTMLElement>(
      '[data-fl-component="titlebar"]',
    );
    expect(bar).not.toBeNull();
    expect(bar!.textContent).toContain('content');
    // No OS chrome to draw and nothing to drag: a normal header.
    expect(bar!.hasAttribute('data-tauri-drag-region')).toBe(false);
    expect(dom.querySelector(`.${styles['fl-wincontrols']}`)).toBeNull();
  });

  it('marks empty regions as the host drag region only when asked', async () => {
    const chrome = {
      ...chromeDouble(),
      startDragging: vi.fn(() => Promise.resolve()),
    };
    const dom = await mount(
      createElement(
        Titlebar,
        { chrome },
        createElement(
          'div',
          null,
          createElement('span', { className: 'empty-title-space' }),
          createElement('span', { className: 'tabstrip empty-tabstrip-space' }),
          createElement('span', { 'data-no-window-drag': '' }),
          createElement('button', null, 'Tab'),
        ),
      ),
    );
    expect(
      dom.querySelector('[data-fl-component="titlebar"]')!.hasAttribute('data-tauri-drag-region'),
    ).toBe(true);
    expect(
      dom
        .querySelector(`.${styles['fl-titlebar-spacer']}`)!
        .hasAttribute('data-tauri-drag-region'),
    ).toBe(true);
    dom
      .querySelector<HTMLElement>('.empty-title-space')!
      .dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    dom
      .querySelector<HTMLElement>('.empty-tabstrip-space')!
      .dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    dom
      .querySelector<HTMLElement>('[data-no-window-drag]')!
      .dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    dom
      .querySelector<HTMLButtonElement>('button')!
      .dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    expect(chrome.startDragging).toHaveBeenCalledTimes(2);
  });

  it('draws minimize/maximize/close and forwards activation to the host', async () => {
    const chrome = chromeDouble();
    const dom = await mount(createElement(Titlebar, { chrome }, 'tabs'));
    const controls = dom.querySelector(`.${styles['fl-wincontrols']}`)!;
    expect(controls.querySelectorAll('button').length).toBe(3);

    await act(async () => {
      dom
        .querySelector<HTMLButtonElement>('[aria-label="Minimize window"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      dom
        .querySelector<HTMLButtonElement>('[aria-label="Maximize window"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      dom
        .querySelector<HTMLButtonElement>('[aria-label="Close window"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(chrome.minimize).toHaveBeenCalledTimes(1);
    expect(chrome.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(chrome.close).toHaveBeenCalledTimes(1);
  });

  it('reflects maximized state changes as a restore affordance', async () => {
    let maximized = false;
    const listeners = new Set<() => void>();
    const chrome = chromeDouble({
      maximized: () => maximized,
      onMaximizedChange: (listener) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    });
    const dom = await mount(createElement(Titlebar, { chrome }));
    expect(dom.querySelector('[aria-label="Maximize window"]')).not.toBeNull();

    await act(async () => {
      maximized = true;
      for (const listener of listeners) listener();
    });
    expect(dom.querySelector('[aria-label="Restore window"]')).not.toBeNull();
    expect(dom.querySelector('[aria-label="Maximize window"]')).toBeNull();
  });

  it('exposes OS-reserved regions to aligned strip content and follows inset changes', async () => {
    const fixture = overlayChromeFixture();
    const dom = await mount(
      createElement(Titlebar, { chrome: fixture.chrome }),
    );
    const bar = dom.querySelector<HTMLElement>(
      '[data-fl-component="titlebar"]',
    )!;
    expect(bar.style.getPropertyValue('--fl-titlebar-inset-right')).toBe(
      '138px',
    );
    expect(dom.querySelector(`.${styles['fl-wincontrols']}`)).toBeNull();
    // Regression: an installed PWA must mark the titlebar as a drag region
    // or the window cannot be moved by its header.
    expect(bar.hasAttribute('data-tauri-drag-region')).toBe(true);

    await act(async () => {
      fixture.inset = { left: 0, right: 124 };
      fixture.fireInsetChange();
    });
    expect(bar.style.getPropertyValue('--fl-titlebar-inset-right')).toBe(
      '124px',
    );
    // Adapter disposal is the mount's job (app-shell spec), not the bar's:
    // the chrome outlives vault close → launcher → vault open.
    expect(fixture.dispose).not.toHaveBeenCalled();
  });
});
