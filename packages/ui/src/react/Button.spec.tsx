// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button, IconButton } from './Button.jsx';
import styles from './Button.module.css';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(node: React.ReactElement): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

/**
 * Button primitives (spec section 8) — appearance, semantics, and
 * accessibility defaults are one unit. External hooks are deliberate
 * `data-*` attributes; module class names are implementation, not API.
 */
describe('Button primitives', () => {
  it('maps every asserted class through the CSS module', () => {
    for (const name of ['btn', 'icon-button']) {
      expect(styles[name], `module class ${name}`).toMatch(/\S/);
    }
  });

  it('renders a button with the component hook and default variant', () => {
    const mounted = mount(createElement(Button, null, 'Create'));
    const button = mounted.querySelector('button')!;
    expect(button.dataset.flComponent).toBe('button');
    expect(button.getAttribute('data-variant')).toBe('default');
    expect(button.textContent).toBe('Create');
  });

  it('renders each variant through data-variant, not global class names', () => {
    for (const variant of ['primary', 'secondary', 'ghost', 'danger'] as const) {
      const mounted = mount(createElement(Button, { variant }, 'X'));
      const button = mounted.querySelector(
        '[data-fl-component="button"]',
      ) as HTMLElement;
      expect(button.getAttribute('data-variant')).toBe(variant);
      expect(button.className).not.toContain('primary');
      expect(button.className).not.toContain('secondary');
      unmountOne();
    }
  });

  it('forwards clicks, type, disabled, and merged class names', () => {
    const onClick = vi.fn();
    const mounted = mount(
      createElement(
        Button,
        {
          variant: 'primary',
          type: 'button',
          disabled: true,
          className: 'extra-hook',
          onClick,
        },
        'Delete',
      ),
    );
    const button = mounted.querySelector('button')!;
    expect(button.className).toContain('extra-hook');
    expect(button.disabled).toBe(true);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('renders an anchor when href is provided', () => {
    const mounted = mount(
      createElement(
        Button,
        { variant: 'primary', href: 'file.bin', download: 'file.bin' },
        'Download',
      ),
    );
    const anchor = mounted.querySelector('a[data-fl-component="button"]')!;
    expect(anchor.getAttribute('href')).toBe('file.bin');
    expect(anchor.getAttribute('data-variant')).toBe('primary');
  });

  it('IconButton renders an accessible icon-only button', () => {
    const onClick = vi.fn();
    const mounted = mount(
      createElement(IconButton, {
        icon: 'close',
        label: 'Close settings',
        onClick,
      }),
    );
    const button = mounted.querySelector(
      'button[data-fl-component="icon-button"]',
    ) as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toBe('Close settings');
    expect(button.querySelector('svg')).not.toBeNull();
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('IconButton active renders the global state hook class', () => {
    const mounted = mount(
      createElement(IconButton, {
        icon: 'book',
        label: 'Toggle reading view',
        active: true,
      }),
    );
    const button = mounted.querySelector(
      'button[data-fl-component="icon-button"]',
    )!;
    expect(button.classList.contains('active')).toBe(true);
  });
});

function unmountOne(): void {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}
