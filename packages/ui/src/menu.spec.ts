// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clampMenuPosition,
  closeOpenMenu,
  dispatchContextMenu,
  isEditableTarget,
  registerContextMenu,
  showContextMenu,
  type MenuEntry,
} from './menu.js';
import styles from './react/Overlays.module.css';

describe('clampMenuPosition', () => {
  it('keeps a menu at the pointer when there is room', () => {
    const position = clampMenuPosition(200, 150, 180, 200, 1024, 768);
    expect(position).toEqual({ left: 200, top: 150 });
  });

  it('never pins a menu to the top-left corner', () => {
    // The historical bug: menus without coordinates spawned at (0,0).
    for (const [x, y] of [
      [0, 0],
      [-50, -50],
      [5000, 5000],
    ]) {
      const position = clampMenuPosition(x, y, 180, 200, 1024, 768);
      expect(position.left).toBeGreaterThanOrEqual(8);
      expect(position.top).toBeGreaterThanOrEqual(8);
      expect(position.left).toBeLessThanOrEqual(1024 - 8);
      expect(position.top).toBeLessThanOrEqual(768 - 8);
    }
  });

  it('flips oversized menus back inside the viewport', () => {
    const position = clampMenuPosition(1000, 700, 300, 400, 1024, 768);
    expect(position.left + 300).toBeLessThanOrEqual(1024);
    expect(position.top + 400).toBeLessThanOrEqual(768);
  });
});

describe('showContextMenu', () => {
  afterEach(() => closeOpenMenu());

  it('positions the panel near the pointer and clamps into the viewport', () => {
    const handle = showContextMenu([{ label: 'One', run: () => undefined }], {
      x: 40,
      y: 60,
    });
    const panel = document.body.querySelector<HTMLElement>(
      `.${styles['fl-menu'].split(' ').join('.')}`,
    );
    expect(panel).not.toBeNull();
    expect(panel!.style.left).toBe('40px');
    expect(panel!.style.top).toBe('60px');
    expect(handle.closed).toBe(false);
    handle.close();
    expect(
      document.body.querySelector(`.${styles['fl-menu'].split(' ').join('.')}`),
    ).toBeNull();
    expect(handle.closed).toBe(true);
  });

  it('closes the previous menu when opening a new one', () => {
    const first = showContextMenu([{ label: 'A' }], { x: 10, y: 10 });
    const second = showContextMenu([{ label: 'B' }], { x: 30, y: 30 });
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
    expect(
      document.body.querySelectorAll(
        `.${styles['fl-menu'].split(' ').join('.')}`,
      ).length,
    ).toBe(1);
    closeOpenMenu();
    expect(second.closed).toBe(true);
  });

  it('renders separators and danger items without making them separators in the DOM', () => {
    showContextMenu(
      [{ label: 'Rename' }, 'separator', { label: 'Delete', danger: true }],
      { x: 12, y: 12 },
    );
    const items = [
      ...document.querySelectorAll<HTMLElement>(`.${styles['fl-menu-item']}`),
    ];
    expect(items.length).toBe(2);
    expect(items[1]!.dataset.danger).toBe('true');
    expect(
      document.querySelectorAll(`.${styles['fl-menu-separator']}`).length,
    ).toBe(1);
    closeOpenMenu();
  });

  it('runs the clicked item and closes the menu', () => {
    let ran = false;
    const entries: MenuEntry[] = [{ label: 'Do it', run: () => (ran = true) }];
    showContextMenu(entries, { x: 5, y: 5 });
    const item = document.querySelector<HTMLButtonElement>(
      `.${styles['fl-menu-item']}`,
    )!;
    item.click();
    expect(ran).toBe(true);
    expect(
      document.querySelector(`.${styles['fl-menu'].split(' ').join('.')}`),
    ).toBeNull();
  });

  it('skips disabled items but keeps them visible', () => {
    showContextMenu([{ label: 'Locked', disabled: true }], { x: 5, y: 5 });
    const item = document.querySelector<HTMLButtonElement>(
      `.${styles['fl-menu-item']}`,
    )!;
    expect(item.disabled).toBe(true);
    let ran = false;
    item.addEventListener('click', () => (ran = true));
    item.click();
    expect(ran).toBe(false);
    closeOpenMenu();
  });

  it('focuses the first enabled item, wraps arrows, and restores its invoker', () => {
    const invoker = document.createElement('button');
    document.body.appendChild(invoker);
    invoker.focus();
    showContextMenu(
      [
        { label: 'Locked', disabled: true },
        { label: 'First' },
        { label: 'Last' },
      ],
      { x: 5, y: 5, invoker },
    );

    const items = [
      ...document.querySelectorAll<HTMLButtonElement>(
        `.${styles['fl-menu-item']}`,
      ),
    ];
    expect(document.activeElement).toBe(items[1]);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
    );
    expect(document.activeElement).toBe(items[2]);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
    );
    expect(
      document.querySelector(`.${styles['fl-menu'].split(' ').join('.')}`),
    ).toBeNull();
    expect(document.activeElement).toBe(invoker);
  });

  it('uses checkbox roles and keeps a check column aligned for mixed entries', () => {
    showContextMenu(
      [
        { label: 'Enabled', checked: true },
        { label: 'Disabled', checked: false },
        { label: 'Plain' },
      ],
      { x: 5, y: 5 },
    );
    const items = [
      ...document.querySelectorAll<HTMLButtonElement>(
        `.${styles['fl-menu-item']}`,
      ),
    ];
    expect(items[0]!.getAttribute('role')).toBe('menuitemcheckbox');
    expect(items[0]!.getAttribute('aria-checked')).toBe('true');
    expect(items[1]!.getAttribute('aria-checked')).toBe('false');
    expect(items[2]!.getAttribute('role')).toBe('menuitem');
    expect(
      document.querySelectorAll(`.${styles['fl-menu-item-check']}`),
    ).toHaveLength(3);
  });

  it('dismisses when its coordinate space scrolls', () => {
    const run = vi.fn();
    showContextMenu([{ label: 'Action', run }], { x: 5, y: 5 });
    window.dispatchEvent(new Event('scroll'));
    expect(
      document.querySelector(`.${styles['fl-menu'].split(' ').join('.')}`),
    ).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps a newly opened menu through a scroll queued before opening', () => {
    const staleScroll = new Event('scroll');
    Object.defineProperty(staleScroll, 'timeStamp', { value: 0 });
    showContextMenu([{ label: 'Action' }], { x: 5, y: 5 });
    window.dispatchEvent(staleScroll);
    expect(
      document.querySelector(`.${styles['fl-menu'].split(' ').join('.')}`),
    ).not.toBeNull();
  });

  it('stays open when its own scrollable panel scrolls', () => {
    showContextMenu([{ label: 'Action' }], { x: 5, y: 5 });
    const panel = document.querySelector<HTMLElement>(
      `.${styles['fl-menu'].split(' ').join('.')}`,
    )!;
    panel.dispatchEvent(new Event('scroll', { bubbles: false }));
    expect(
      document.querySelector(`.${styles['fl-menu'].split(' ').join('.')}`),
    ).toBe(panel);
  });

  it('ignores scrolling in a region unrelated to an element anchor', () => {
    const invoker = document.createElement('button');
    const unrelated = document.createElement('div');
    document.body.append(invoker, unrelated);
    showContextMenu([{ label: 'Action' }], invoker);

    unrelated.dispatchEvent(new Event('scroll', { bubbles: false }));
    expect(
      document.querySelector(`.${styles['fl-menu'].split(' ').join('.')}`),
    ).not.toBeNull();

    invoker.parentElement!.dispatchEvent(
      new Event('scroll', { bubbles: false }),
    );
    expect(
      document.querySelector(`.${styles['fl-menu'].split(' ').join('.')}`),
    ).toBeNull();
  });

  it('dismisses when an ancestor withdraws its element anchor', async () => {
    const region = document.createElement('div');
    const invoker = document.createElement('button');
    region.append(invoker);
    document.body.append(region);
    showContextMenu([{ label: 'Action' }], invoker);

    region.style.pointerEvents = 'none';
    await vi.waitFor(() => {
      expect(
        document.querySelector(`.${styles['fl-menu'].split(' ').join('.')}`),
      ).toBeNull();
    });
  });
});

describe('context menu registry', () => {
  it('dispatches to the innermost registered provider and reports handling', () => {
    const outer = document.createElement('div');
    const inner = document.createElement('button');
    outer.appendChild(inner);
    document.body.appendChild(outer);

    const disposeOuter = registerContextMenu(outer, () => [{ label: 'Outer' }]);
    const disposeInner = registerContextMenu(inner, () => [{ label: 'Inner' }]);

    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 24,
    });
    Object.defineProperty(event, 'composedPath', {
      value: () => [inner, outer, document.body],
    });
    expect(dispatchContextMenu(event)).toBe(true);
    expect(
      document.querySelector<HTMLElement>(`.${styles['fl-menu-item-label']}`)
        ?.textContent,
    ).toBe('Inner');
    closeOpenMenu();

    disposeInner.dispose();
    const second = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 24,
    });
    Object.defineProperty(second, 'composedPath', {
      value: () => [inner, outer, document.body],
    });
    expect(dispatchContextMenu(second)).toBe(true);
    expect(
      document.querySelector<HTMLElement>(`.${styles['fl-menu-item-label']}`)
        ?.textContent,
    ).toBe('Outer');
    closeOpenMenu();

    disposeOuter.dispose();
  });

  it('returns false when no provider is registered on the path', () => {
    const orphan = document.createElement('div');
    document.body.appendChild(orphan);
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, 'composedPath', { value: () => [orphan] });
    expect(dispatchContextMenu(event)).toBe(false);
  });

  it('restores focus to the focusable control inside a registered row', () => {
    const row = document.createElement('div');
    const button = document.createElement('button');
    const label = document.createElement('span');
    button.appendChild(label);
    row.appendChild(button);
    document.body.appendChild(row);
    button.focus();
    const registration = registerContextMenu(row, () => [{ label: 'Rename' }]);
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 24,
    });
    Object.defineProperty(event, 'composedPath', {
      value: () => [label, button, row, document.body],
    });

    expect(dispatchContextMenu(event)).toBe(true);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(document.activeElement).toBe(button);
    registration.dispose();
  });

  it('keeps the native edit menu only on text fields', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    expect(isEditableTarget(input)).toBe(true);
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    document.body.appendChild(editor);
    expect(isEditableTarget(editor)).toBe(false);
    expect(isEditableTarget(document.createElement('span'))).toBe(false);
  });
});
