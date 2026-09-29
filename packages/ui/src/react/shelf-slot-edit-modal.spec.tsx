// @vitest-environment jsdom
/**
 * Per-slot live value editor.
 *
 * Mounts `ShelfSlotShelf` from `./tool-controls.jsx` directly (renderer
 * scope only, mirroring `shelf-slots.spec.tsx`): a first tap selects,
 * a tap on the active preset opens its anchored editor, and valid changes
 * route immediately to that slot and family.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { DocumentToolControl } from '@froglight/foundation';
import {
  ShelfSlotEditPopover,
  ShelfSlotShelf,
  type ShelfSlotEntry,
  type ShelfSlotShelfProps,
} from './tool-controls.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type Call = readonly [id: string, value?: string];

function sizeChoice(value = '3.5'): DocumentToolControl {
  return {
    kind: 'choice',
    id: 'ink.settings.pen.size',
    group: 'settings',
    label: 'Size',
    value,
    options: [
      { value: '2', label: 'Thin' },
      { value: '3.5', label: 'Medium' },
      { value: '6', label: 'Thick' },
    ],
    semanticRole: 'surface.settings.size',
  };
}

function colorControl(value = '#37352f'): DocumentToolControl {
  return {
    kind: 'color',
    id: 'ink.settings.pen.color',
    group: 'settings',
    label: 'Color',
    value,
    options: ['#37352f', '#7c6cf0', '#c4554d', '#448361', '#a08430'],
    semanticRole: 'surface.settings.color',
  };
}

function slotSettings(): DocumentToolControl[] {
  return [sizeChoice(), colorControl()];
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  if (setter === undefined) throw new Error('no input value setter');
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('shelf slot edit modal', () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
  });

  function renderShelf(
    props: Pick<ShelfSlotShelfProps, 'kind' | 'entries'> &
      Partial<ShelfSlotShelfProps>,
  ): {
    calls: Call[];
    sizeEdits: [index: number, value: number][];
    colorEdits: [index: number, color: string][];
    rerender: (
      next: Pick<ShelfSlotShelfProps, 'kind' | 'entries'> &
        Partial<ShelfSlotShelfProps>,
    ) => void;
  } {
    if (root !== null) {
      act(() => root!.unmount());
      root = null;
    }
    host?.remove();
    const calls: Call[] = [];
    const sizeEdits: [number, number][] = [];
    const colorEdits: [number, string][] = [];
    const execute = (id: string, value?: string): void => {
      calls.push([id, value]);
    };
    const render = (
      overrides: Pick<ShelfSlotShelfProps, 'kind' | 'entries'> &
        Partial<ShelfSlotShelfProps>,
    ): void => {
      act(() => {
        root!.render(
          <ShelfSlotShelf
            label="Size slots"
            group={{ id: 'surface.write', groupId: 'write' }}
            execute={execute}
            settingsForSlot={() => ({ controls: slotSettings(), execute })}
            resetKey="pane-1:doc-1"
            {...overrides}
          />,
        );
      });
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    // Live slot editing is opt-in per shelf.
    render({
      onEditSlotSize: (index, value) => {
        sizeEdits.push([index, value]);
      },
      onEditSlotColor: (index, color) => {
        colorEdits.push([index, color]);
      },
      ...props,
    });
    return { calls, sizeEdits, colorEdits, rerender: render };
  }

  function shelf(): HTMLElement {
    const element = host!.querySelector('[data-slot-kind]');
    if (!(element instanceof HTMLElement)) throw new Error('missing shelf');
    return element;
  }

  function trigger(label: string): HTMLButtonElement {
    const button = shelf().querySelector(`button[aria-label="${label}"]`);
    if (!(button instanceof HTMLButtonElement))
      throw new Error(`missing slot trigger: ${label}`);
    return button;
  }

  function editDialog(): HTMLElement | null {
    return host!.querySelector('[data-slot-edit-kind]');
  }

  function anyDialog(): HTMLElement | null {
    return host!.querySelector('[role="dialog"]');
  }

  function tap(button: HTMLButtonElement): void {
    act(() => button.click());
  }

  const sizeEntry = (slotId: string, active: boolean): ShelfSlotEntry => ({
    id: `ink.size.${slotId}`,
    slotId,
    control: sizeChoice(),
    active,
  });

  const colorEntry = (slotId: string, active: boolean): ShelfSlotEntry => ({
    id: `ink.color.${slotId}`,
    slotId,
    control: colorControl(),
    active,
  });

  it('selects on single-click without opening the modal', () => {
    const { calls } = renderShelf({
      kind: 'size',
      entries: [sizeEntry('size-slot-1', false)],
      slotSizes: [2, 3.5, 6],
    });
    act(() => trigger('Size').click());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('ink.settings.pen.size');
    expect(editDialog()).toBeNull();
    expect(anyDialog()).toBeNull();
  });

  it('opens the active size preset on tap and updates only that slot live', () => {
    const { calls, sizeEdits } = renderShelf({
      kind: 'size',
      family: 'pen',
      entries: [
        sizeEntry('size-slot-1', false),
        sizeEntry('size-slot-2', true),
      ],
      slotSizes: [2, 3.5, 6],
    });
    const triggers = [
      ...shelf().querySelectorAll<HTMLButtonElement>(
        ':scope button:not([data-empty-slot])',
      ),
    ];
    if (triggers.length !== 2) throw new Error('expected two size slots');
    tap(triggers[1]!);
    const panel = editDialog();
    if (panel === null) throw new Error('missing size editor');
    expect(panel.getAttribute('data-slot-edit-kind')).toBe('size');
    expect(panel.getAttribute('data-slot-edit-index')).toBe('1');
    expect(panel.getAttribute('data-slot-family')).toBe('pen');
    expect(panel.getAttribute('aria-label')).toBe('Edit size slot 2');
    const input = panel.querySelector<HTMLInputElement>(
      'input[aria-label="Slot width in points"]',
    );
    if (input === null) throw new Error('missing width input');
    expect(input.value).toBe('3.5');
    act(() => setInputValue(input, '4.5'));
    // Exactly one slot commit; the select channel stays quiet while editing.
    expect(sizeEdits).toEqual([[1, 4.5]]);
    expect(editDialog()).not.toBeNull();
    expect(panel.getAttribute('aria-modal')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('opens the active color preset on tap and updates it live', () => {
    const { colorEdits } = renderShelf({
      kind: 'color',
      label: 'Color slots',
      family: 'highlighter',
      entries: [colorEntry('color-slot-1', true)],
      slotColors: ['#ffd54f', '#7c6cf0', '#c4554d'],
    });
    tap(trigger('Color'));
    const panel = editDialog();
    if (panel === null) throw new Error('missing color editor');
    expect(panel.getAttribute('data-slot-edit-kind')).toBe('color');
    expect(panel.getAttribute('data-slot-family')).toBe('highlighter');
    expect(panel.getAttribute('aria-label')).toBe('Edit color slot 1');
    expect(
      panel.querySelector('input[aria-label="Slot color picker"]'),
    ).not.toBeNull();
    const dot = panel.querySelector<HTMLButtonElement>(
      'button[aria-label="Color: #c4554d"]',
    );
    if (dot === null) throw new Error('missing quick swatch');
    act(() => dot.click());
    expect(colorEdits).toEqual([[0, '#c4554d']]);
    expect(editDialog()).not.toBeNull();
  });

  it('keeps the active color editor open after a double click', () => {
    renderShelf({
      kind: 'color',
      entries: [colorEntry('color-slot-1', true)],
      slotColors: ['#37352f', '#7c6cf0', '#c4554d'],
    });
    const button = trigger('Color');
    tap(button);
    tap(button);
    act(() =>
      button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
    );
    expect(editDialog()?.getAttribute('aria-label')).toBe('Edit color slot 1');
  });

  it('keeps the active size editor open after a double click', () => {
    renderShelf({
      kind: 'size',
      entries: [sizeEntry('size-slot-1', true)],
      slotSizes: [2, 3.5, 6],
    });
    const button = trigger('Size');
    tap(button);
    tap(button);
    act(() =>
      button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
    );
    expect(editDialog()?.getAttribute('aria-label')).toBe('Edit size slot 1');
  });

  it('toggles one live editor by tapping the active preset', () => {
    const { calls } = renderShelf({
      kind: 'size',
      entries: [sizeEntry('size-slot-1', true)],
      slotSizes: [2, 3.5, 6],
    });
    tap(trigger('Size'));
    const panel = editDialog();
    if (panel === null) throw new Error('missing value editor');
    expect(host!.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    tap(trigger('Size'));
    expect(editDialog()).toBeNull();
    expect(calls).toEqual([]);
  });

  it('does not open a value editor without an edit channel', () => {
    const plain = renderShelf({
      kind: 'size',
      entries: [sizeEntry('size-slot-1', true)],
      onEditSlotSize: undefined,
      onEditSlotColor: undefined,
    });
    tap(trigger('Size'));
    expect(editDialog()).toBeNull();
    expect(plain.calls).toHaveLength(0);
  });

  it('never opens the value modal from pen slots', () => {
    renderShelf({
      kind: 'pen',
      label: 'Pen slots',
      entries: [
        {
          id: 'ink.tool.pen',
          slotId: 'pen-slot-1',
          control: {
            kind: 'button',
            id: 'ink.tool.pen',
            group: 'draw',
            label: 'Ball Pen',
            shortLabel: 'Ball Pen',
            role: 'surface-tool',
            toolId: 'ink.tool.pen',
            active: true,
          },
        },
      ],
    });
    const pen = trigger('Ball Pen');
    tap(pen);
    expect(editDialog()).toBeNull();
  });

  it('reflects the active family in size/color glyphs', () => {
    const glyphOf = (family: 'pen' | 'highlighter'): HTMLElement => {
      renderShelf({
        kind: 'color',
        label: 'Color slots',
        family,
        entries: [colorEntry('color-slot-1', false)],
        slotColors: ['#7c6cf0', '#c4554d', '#448361'],
      });
      const button = trigger('Color');
      expect(button.getAttribute('data-slot-family')).toBe(family);
      const glyph = button.querySelector<HTMLElement>('[aria-hidden="true"]');
      if (glyph === null) throw new Error('missing glyph');
      return glyph;
    };
    // Marker translucency only on the highlighter dot.
    expect(glyphOf('pen').style.opacity).toBe('');
    expect(glyphOf('highlighter').style.opacity).toBe('0.35');
    // Width bars match the stored value regardless of the active family.
    const barOf = (family: 'pen' | 'highlighter'): number => {
      renderShelf({
        kind: 'size',
        family,
        entries: [sizeEntry('size-slot-1', false)],
        slotSizes: [3.5, 3.5, 3.5],
      });
      const bar = trigger('Size').querySelector<HTMLElement>(
        '[aria-hidden="true"]',
      );
      if (bar === null) throw new Error('missing bar');
      return Number.parseFloat(bar.style.height);
    };
    const penBar = barOf('pen');
    const highlighterBar = barOf('highlighter');
    expect(penBar).toBe(3.5);
    expect(highlighterBar).toBe(3.5);
  });

  it('ignores invalid input and closes on Escape without another commit', () => {
    const { sizeEdits } = renderShelf({
      kind: 'size',
      entries: [sizeEntry('size-slot-1', true)],
      slotSizes: [2, 3.5, 6],
    });
    tap(trigger('Size'));
    const panel = editDialog();
    if (panel === null) throw new Error('missing editor');
    const input = panel.querySelector<HTMLInputElement>(
      'input[aria-label="Slot width in points"]',
    );
    if (input === null) throw new Error('missing width input');
    act(() => setInputValue(input, '0'));
    expect(sizeEdits).toEqual([]);
    expect(editDialog()).not.toBeNull();
    act(() => {
      editDialog()!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(editDialog()).toBeNull();
    expect(document.activeElement).toBe(trigger('Size'));
    expect(sizeEdits).toEqual([]);
  });

  it('renders width-bar glyphs at their stored numeric size', () => {
    const wideSizeEntry = (
      slotId: string,
      active: boolean,
    ): ShelfSlotEntry => ({
      id: `ink.size.${slotId}`,
      slotId,
      control: {
        kind: 'choice',
        id: 'ink.settings.pen.size',
        group: 'settings',
        label: 'Size',
        value: '20',
        options: [
          { value: '0.5', label: 'Hairline' },
          { value: '20', label: 'Custom' },
          { value: '200', label: 'Maximum' },
        ],
        semanticRole: 'surface.settings.size',
      },
      active,
    });
    const barHeightOf = (
      family: 'pen' | 'highlighter',
      sizes: readonly number[],
      entry: ShelfSlotEntry,
    ): number => {
      renderShelf({ kind: 'size', family, entries: [entry], slotSizes: sizes });
      const bar = trigger('Size').querySelector<HTMLElement>(
        '[aria-hidden="true"]',
      );
      if (bar === null) throw new Error('missing bar');
      return Number.parseFloat(bar.style.height);
    };
    // Option ranges do not normalize or distort the stored width.
    expect(
      barHeightOf('pen', [20, 3.5, 6], wideSizeEntry('size-slot-1', false)),
    ).toBe(20);
    expect(
      barHeightOf(
        'highlighter',
        [20, 3.5, 6],
        wideSizeEntry('size-slot-1', false),
      ),
    ).toBe(20);
    expect(
      barHeightOf('pen', [200, 3.5, 6], wideSizeEntry('size-slot-1', false)),
    ).toBe(200);
    expect(
      barHeightOf(
        'highlighter',
        [200, 3.5, 6],
        wideSizeEntry('size-slot-1', false),
      ),
    ).toBe(200);
    // Values outside the provider's option range remain faithful too.
    expect(
      barHeightOf('pen', [20, 3.5, 6], sizeEntry('size-slot-1', false)),
    ).toBe(20);
    expect(
      barHeightOf('highlighter', [20, 3.5, 6], sizeEntry('size-slot-1', false)),
    ).toBe(20);
    expect(
      barHeightOf('pen', [0.25, 3.5, 6], sizeEntry('size-slot-1', false)),
    ).toBe(0.25);
    expect(
      barHeightOf(
        'highlighter',
        [0.25, 3.5, 6],
        sizeEntry('size-slot-1', false),
      ),
    ).toBe(0.25);
  });

  it('never opens the value editor while browsing a foreign category', () => {
    const { calls, sizeEdits, colorEdits } = renderShelf({
      kind: 'size',
      entries: [sizeEntry('size-slot-1', false)],
      slotSizes: [2, 3.5, 6],
      isActiveContext: false,
    });
    tap(trigger('Size'));
    expect(editDialog()).toBeNull();
    expect(anyDialog()).toBeNull();
    expect(sizeEdits).toEqual([]);
    expect(colorEdits).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(editDialog()).toBeNull();
    expect(anyDialog()).toBeNull();
  });

  it('renders the standalone editor with family scope and live commit payload', () => {
    const commits: unknown[] = [];
    const closes: unknown[] = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(
        <ShelfSlotEditPopover
          kind="color"
          family="highlighter"
          index={2}
          sizeValue={14}
          colorValue="#ffd54f"
          onCommit={(commit) => commits.push(commit)}
          onClose={() => closes.push(true)}
        />,
      );
    });
    const panel = editDialog();
    if (panel === null) throw new Error('missing modal');
    expect(panel.getAttribute('aria-label')).toBe('Edit color slot 3');
    expect(panel.getAttribute('data-slot-edit-index')).toBe('2');
    const swatch = panel.querySelector<HTMLButtonElement>(
      'button[aria-label="Color: #7c6cf0"]',
    );
    if (swatch === null) throw new Error('missing swatch');
    tap(swatch);
    expect(commits).toEqual([
      {
        kind: 'color',
        family: 'highlighter',
        index: 2,
        colorValue: '#7c6cf0',
      },
    ]);
  });
});
