// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import {
  PresentationControl,
  projectedPresentationModes,
} from './PresentationControl.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(
  mode: 'edit' | 'split' | 'reading' = 'edit',
  availableModes: readonly ('edit' | 'split' | 'reading')[] = [
    'edit',
    'reading',
  ],
) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const onSetMode = vi.fn();
  act(() =>
    root?.render(
      <PresentationControl
        mode={mode}
        availableModes={availableModes}
        onSetMode={onSetMode}
      />,
    ),
  );
  return onSetMode;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

it('offers Split only at a usable width while keeping an active Split reachable', () => {
  expect(
    projectedPresentationModes(['edit', 'split', 'reading'], 'edit', false),
  ).toEqual(['edit', 'reading']);
  expect(
    projectedPresentationModes(['edit', 'split', 'reading'], 'split', false),
  ).toEqual(['edit', 'split', 'reading']);
  expect(
    projectedPresentationModes(['edit', 'split', 'reading'], 'edit', true),
  ).toEqual(['edit', 'split', 'reading']);
});

it('shows a compact mode menu with keyboard dismissal and no duplicate mode state', () => {
  const onSetMode = mount('edit', ['edit', 'split', 'reading']);
  const trigger = host!.querySelector<HTMLButtonElement>(
    '[aria-haspopup="menu"]',
  )!;
  act(() => trigger.click());
  const menu = host!.querySelector<HTMLElement>('[role="menu"]')!;
  expect(menu.querySelectorAll('[role="menuitemradio"]')).toHaveLength(3);
  act(() =>
    menu.querySelector<HTMLButtonElement>('[aria-checked="false"]')?.click(),
  );
  expect(onSetMode).toHaveBeenCalledWith('split');
  expect(host!.querySelector('[role="menu"]')).toBeNull();
  expect(trigger.getAttribute('aria-label')).toBe('Document view: Edit');
  act(() => trigger.click());
  act(() =>
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    ),
  );
  expect(host!.querySelector('[role="menu"]')).toBeNull();
});

it('keeps the segments controlled by the document mode and offers one tab stop', () => {
  const onSetMode = mount('split', ['edit', 'split', 'reading']);
  const segments = host!.querySelector('[role="radiogroup"]')!;
  const radios = [
    ...segments.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
  ];
  expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, 0, -1]);
  act(() => radios[2]!.click());
  expect(onSetMode).toHaveBeenCalledWith('reading');
  expect(radios[1]!.getAttribute('aria-checked')).toBe('true');
  expect(radios[2]!.getAttribute('aria-checked')).toBe('false');
});

it('moves keyboard focus and mode together for two-position controls', () => {
  const onSetMode = mount();
  const segments = host!.querySelector('[role="radiogroup"]')!;
  const radios = [
    ...segments.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
  ];
  act(() =>
    radios[0]!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    ),
  );
  expect(onSetMode).toHaveBeenLastCalledWith('reading');
  expect(document.activeElement).toBe(radios[1]);
  act(() =>
    radios[1]!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
    ),
  );
  expect(onSetMode).toHaveBeenLastCalledWith('edit');
  expect(document.activeElement).toBe(radios[0]);
});
