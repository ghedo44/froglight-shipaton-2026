// @vitest-environment jsdom
/**
 * GoodNotes-style fixed slot shelf renderer.
 *
 * Mounts `ShelfSlotShelf` from `./tool-controls.jsx` directly (renderer
 * scope only — no `UnifiedToolbar.tsx` model wiring): fixed 3/3/4 counts
 * with never-collapsing empty placeholders, verbatim stable order with
 * in-place active marking, generalized second-tap slot editors reusing
 * `SurfaceSettingsPopoverBody` sections scoped to one slot, browsed!=active
 * editor hiding while browsing, disabled passthrough, keyboard/focus/Esc, and
 * token-only single-row slot geometry.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocumentToolControl } from '@froglight/foundation';
import {
  activeOverflowSlots,
  isShelfSlotActive,
  SHELF_COLOR_SLOT_COUNT,
  SHELF_PEN_SLOT_COUNT,
  SHELF_SIZE_SLOT_COUNT,
  toFixedSlots,
  ShelfSlotShelf,
  type ShelfSlotEntry,
  type ShelfSlotShelfProps,
} from './tool-controls.jsx';
import css from './UnifiedToolbar.module.css?inline';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type Call = readonly [id: string, value?: string];

function penButton(
  id: string,
  label: string,
  active: boolean,
  extra: Partial<Extract<DocumentToolControl, { kind: 'button' }>> = {},
): DocumentToolControl {
  return {
    kind: 'button',
    id,
    group: 'draw',
    label,
    shortLabel: label,
    role: 'surface-tool',
    toolId: id,
    active,
    ...extra,
  };
}

function penEntry(
  key: string,
  label: string,
  active: boolean,
  slotId?: string,
): ShelfSlotEntry {
  const id = `ink.tool.${key}`;
  return {
    id,
    ...(slotId === undefined ? {} : { slotId }),
    control: penButton(id, label, active),
  };
}

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

function colorControl(): DocumentToolControl {
  return {
    kind: 'color',
    id: 'ink.settings.pen.color',
    group: 'settings',
    label: 'Color',
    value: '#37352f',
    options: ['#37352f', '#7c6cf0', '#c4554d', '#448361', '#a08430', '#111111'],
    semanticRole: 'surface.settings.color',
  };
}

function penTypeChoice(): DocumentToolControl {
  return {
    kind: 'choice',
    id: 'ink.settings.pen.type',
    group: 'settings',
    label: 'Pen type',
    value: 'ball',
    options: [
      { value: 'ball', label: 'Ball' },
      { value: 'fountain', label: 'Fountain' },
      { value: 'brush', label: 'Brush' },
      { value: 'pencil', label: 'Pencil' },
    ],
    semanticRole: 'surface.settings.pen-type',
  };
}

/** Provider-emitted advanced vocabulary (`BRUSH_ADVANCED_SUPPORT`). */
function advancedControls(): DocumentToolControl[] {
  return [
    {
      kind: 'range',
      id: 'ink.settings.pen.pressure',
      group: 'settings',
      label: 'Pressure response',
      value: 60,
      min: 0,
      max: 100,
      step: 1,
    },
    {
      kind: 'choice',
      id: 'ink.settings.pen.tip',
      group: 'settings',
      label: 'Tip',
      value: 'round',
      options: [
        { value: 'round', label: 'Round' },
        { value: 'flat', label: 'Flat' },
        { value: 'ellipse', label: 'Ellipse' },
      ],
    },
  ];
}

function slotSettings(): DocumentToolControl[] {
  return [penTypeChoice(), sizeChoice(), colorControl(), ...advancedControls()];
}

describe('shelf slot renderer', () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    vi.unstubAllGlobals();
  });

  type ShelfProps = Pick<
    ShelfSlotShelfProps,
    'kind' | 'entries' | 'isActiveContext'
  > &
    Partial<ShelfSlotShelfProps>;

  function renderShelf(props: ShelfProps): {
    calls: Call[];
    slotKeys: string[];
    rerender: (next: ShelfProps) => void;
  } {
    if (root !== null) {
      act(() => root!.unmount());
      root = null;
    }
    host?.remove();
    const calls: Call[] = [];
    const slotKeys: string[] = [];
    const execute = (id: string, value?: string): void => {
      calls.push([id, value]);
    };
    const render = (overrides: ShelfProps): void => {
      act(() => {
        root!.render(
          <ShelfSlotShelf
            label="Pen slots"
            group={{ id: 'surface.write', groupId: 'write' }}
            execute={execute}
            settingsForSlot={(slotKey) => {
              slotKeys.push(slotKey);
              return {
                controls: slotSettings(),
                execute,
              };
            }}
            resetKey="pane-1:doc-1"
            {...overrides}
          />,
        );
      });
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    render(props);
    return { calls, slotKeys, rerender: render };
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

  function dialog(): HTMLElement | null {
    // No Pane layer in this harness, so the portal fallback renders inline.
    return host!.querySelector('[role="dialog"]');
  }

  it('pins fixed 3/3/4 counts', () => {
    expect(SHELF_SIZE_SLOT_COUNT).toBe(3);
    expect(SHELF_COLOR_SLOT_COUNT).toBe(3);
    expect(SHELF_PEN_SLOT_COUNT).toBe(4);
  });

  it('pads short rows with placeholders and splits surplus verbatim', () => {
    const entries = [penEntry('pen', 'Ball Pen', true, 'pen-slot-1')];
    const padded = toFixedSlots(entries, SHELF_PEN_SLOT_COUNT);
    expect(padded.inline).toHaveLength(4);
    expect(padded.inline[0]).toBe(entries[0]);
    expect(padded.inline.slice(1)).toEqual([null, null, null]);
    expect(padded.overflow).toEqual([]);
    const surplus = [
      penEntry('a', 'A', false),
      penEntry('b', 'B', false),
      penEntry('c', 'C', false),
      penEntry('d', 'D', false),
      penEntry('e', 'E', true),
    ];
    const split = toFixedSlots(surplus, SHELF_PEN_SLOT_COUNT);
    expect(split.inline.map((entry) => entry?.id)).toEqual([
      'ink.tool.a',
      'ink.tool.b',
      'ink.tool.c',
      'ink.tool.d',
    ]);
    expect(split.overflow.map((entry) => entry.id)).toEqual(['ink.tool.e']);
  });

  it('renders fixed pen positions with never-collapsing empty placeholders', () => {
    renderShelf({
      kind: 'pen',
      entries: [
        penEntry('pen', 'Ball Pen', true, 'pen-slot-1'),
        penEntry('fountain', 'Fountain Pen', false, 'pen-slot-2'),
      ],
    });
    const group = shelf();
    expect(group.getAttribute('aria-label')).toBe('Pen slots');
    expect(group.getAttribute('data-slot-kind')).toBe('pen');
    expect(group.getAttribute('data-strip-group')).toBe('write');
    const triggers = [...group.querySelectorAll(':scope button')];
    expect(triggers).toHaveLength(SHELF_PEN_SLOT_COUNT);
    const empties = group.querySelectorAll('[data-empty-slot="true"]');
    expect(empties).toHaveLength(2);
    for (const empty of empties) {
      expect((empty as HTMLButtonElement).disabled).toBe(true);
      expect(empty.getAttribute('aria-label')).toMatch(/^Empty pen slot \d$/);
    }
    // Filled slots keep their accessible names; placeholders carry none.
    expect(trigger('Ball Pen').getAttribute('aria-pressed')).toBe('true');
    expect(trigger('Fountain Pen').getAttribute('aria-pressed')).toBe('false');
  });

  it('keys slots through slotIdForItem with id fallback', () => {
    // `settingsForSlot` receives the effective slot id per position:
    // the declared `slotId` when present, otherwise the item id.
    const { slotKeys } = renderShelf({
      kind: 'pen',
      entries: [
        penEntry('pen', 'Ball Pen', true, 'pen-slot-1'),
        penEntry('fountain', 'Fountain Pen', false),
      ],
    });
    expect(slotKeys).toEqual(['pen-slot-1', 'ink.tool.fountain']);
  });

  it('keeps verbatim order and marks active in place across switches', () => {
    const order = () =>
      [...shelf().querySelectorAll(':scope button:not([data-empty-slot])')].map(
        (button) => button.getAttribute('aria-label'),
      );
    const first = renderShelf({
      kind: 'pen',
      entries: [
        penEntry('pen', 'Ball Pen', true, 'pen-slot-1'),
        penEntry('fountain', 'Fountain Pen', false, 'pen-slot-2'),
        penEntry('brush', 'Brush Pen', false, 'pen-slot-3'),
        penEntry('pencil', 'Pencil', false, 'pen-slot-4'),
      ],
    });
    expect(order()).toEqual([
      'Ball Pen',
      'Fountain Pen',
      'Brush Pen',
      'Pencil',
    ]);
    expect(trigger('Ball Pen').getAttribute('aria-pressed')).toBe('true');
    void first;
    renderShelf({
      kind: 'pen',
      entries: [
        penEntry('pen', 'Ball Pen', false, 'pen-slot-1'),
        penEntry('fountain', 'Fountain Pen', false, 'pen-slot-2'),
        penEntry('brush', 'Brush Pen', true, 'pen-slot-3'),
        penEntry('pencil', 'Pencil', false, 'pen-slot-4'),
      ],
    });
    // Order never moves; only the pressed marker travels.
    expect(order()).toEqual([
      'Ball Pen',
      'Fountain Pen',
      'Brush Pen',
      'Pencil',
    ]);
    expect(trigger('Ball Pen').getAttribute('aria-pressed')).toBe('false');
    expect(trigger('Brush Pen').getAttribute('aria-pressed')).toBe('true');
  });

  it('executes on first tap without opening; second tap opens without re-executing', () => {
    const { calls } = renderShelf({
      kind: 'pen',
      entries: [
        penEntry('pen', 'Ball Pen', true, 'pen-slot-1'),
        penEntry('fountain', 'Fountain Pen', false, 'pen-slot-2'),
      ],
    });
    act(() => trigger('Fountain Pen').click());
    expect(calls).toEqual([['ink.tool.fountain', undefined]]);
    expect(dialog()).toBeNull();
    act(() => trigger('Ball Pen').click());
    expect(calls).toEqual([['ink.tool.fountain', undefined]]);
    const panel = dialog();
    expect(panel?.getAttribute('aria-label')).toBe('Ball Pen settings');
  });

  it('shows pen-specific controls in the pen editor', () => {
    renderShelf({
      kind: 'pen',
      entries: [penEntry('pen', 'Ball Pen', true, 'pen-slot-1')],
    });
    act(() => trigger('Ball Pen').click());
    const panel = dialog();
    if (panel === null) throw new Error('missing pen editor');
    expect(
      panel.querySelector('input[aria-label="Pressure response"]'),
    ).not.toBeNull();
    expect(panel.querySelector('[aria-label="Pen family"]')).toBeNull();
    expect(panel.querySelector('section[aria-label="Color"]')).toBeNull();
    expect(panel.querySelector('section[aria-label="Size"]')).toBeNull();
  });

  it('scopes the size editor to its own slot', () => {
    renderShelf({
      kind: 'size',
      label: 'Size slots',
      entries: [
        {
          id: 'ink.size.medium',
          slotId: 'size-slot-2',
          control: sizeChoice(),
          active: true,
        },
      ],
    });
    act(() => trigger('Size').click());
    const panel = dialog();
    if (panel === null) throw new Error('missing size editor');
    expect(panel.querySelector('section[aria-label="Size"]')).not.toBeNull();
    expect(panel.querySelector('section[aria-label="Color"]')).toBeNull();
    expect(panel.querySelector('[aria-label="Pen family"]')).toBeNull();
    expect(
      [...panel.querySelectorAll('button')].some(
        (button) => button.textContent === 'Advanced',
      ),
    ).toBe(false);
  });

  it('scopes the color editor to its own slot', () => {
    const { calls } = renderShelf({
      kind: 'color',
      label: 'Color slots',
      entries: [
        {
          id: 'ink.color.primary',
          slotId: 'color-slot-1',
          control: colorControl(),
          active: true,
        },
      ],
    });
    act(() => trigger('Color').click());
    const panel = dialog();
    if (panel === null) throw new Error('missing color editor');
    expect(panel.querySelector('section[aria-label="Color"]')).not.toBeNull();
    expect(panel.querySelector('section[aria-label="Size"]')).toBeNull();
    const dot = panel.querySelector(
      'section[aria-label="Color"] button[aria-label="Color: #c4554d"]',
    );
    if (!(dot instanceof HTMLButtonElement)) throw new Error('missing dot');
    act(() => dot.click());
    expect(calls).toEqual([['ink.settings.pen.color', '#c4554d']]);
  });

  it('hides editors when browsing away from the active tool', () => {
    const { calls } = renderShelf({
      kind: 'pen',
      isActiveContext: false,
      entries: [penEntry('pen', 'Ball Pen', true, 'pen-slot-1')],
    });
    // Tools still execute; no editor opens and no quicks/settings leak.
    act(() => trigger('Ball Pen').click());
    expect(calls).toEqual([['ink.tool.pen', undefined]]);
    expect(dialog()).toBeNull();
  });

  it('passes disabled through without executing', () => {
    const { calls } = renderShelf({
      kind: 'pen',
      entries: [
        {
          id: 'ink.tool.pen',
          slotId: 'pen-slot-1',
          control: penButton('ink.tool.pen', 'Ball Pen', true, {
            disabled: true,
          }),
        },
      ],
    });
    expect(trigger('Ball Pen').disabled).toBe(true);
    act(() => trigger('Ball Pen').click());
    expect(calls).toEqual([]);
    expect(dialog()).toBeNull();
  });

  it('closes on Escape with focus return and on outside pointerdown', () => {
    renderShelf({
      kind: 'pen',
      entries: [penEntry('pen', 'Ball Pen', true, 'pen-slot-1')],
    });
    const pen = trigger('Ball Pen');
    act(() => pen.click());
    expect(dialog()).not.toBeNull();
    act(() => {
      dialog()!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(pen);
    act(() => trigger('Ball Pen').click());
    expect(dialog()).not.toBeNull();
    act(() => {
      document.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true }),
      );
    });
    expect(dialog()).toBeNull();
  });

  it('exposes surplus slots through the overflow outlet', () => {
    const overflowActivations: Call[] = [];
    const seen: ShelfSlotEntry[][] = [];
    renderShelf({
      kind: 'pen',
      entries: [
        penEntry('pen', 'Ball Pen', false, 'pen-slot-1'),
        penEntry('fountain', 'Fountain Pen', false, 'pen-slot-2'),
        penEntry('brush', 'Brush Pen', false, 'pen-slot-3'),
        penEntry('pencil', 'Pencil', false, 'pen-slot-4'),
        penEntry('highlighter', 'Highlighter', true, 'pen-slot-5'),
      ],
      renderOverflow: (overflow) => {
        seen.push([...overflow]);
        return (
          <div role="group" aria-label="More pen slots">
            {overflow.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-label={entry.control.label}
                aria-pressed={isShelfSlotActive(entry)}
                onClick={() =>
                  overflowActivations.push([entry.control.id, entry.value])
                }
              >
                {entry.control.label}
              </button>
            ))}
          </div>
        );
      },
    });
    // Inline keeps the first four verbatim; the 5th is reachable, not lost.
    const group = shelf();
    expect(group.getAttribute('data-overflow-count')).toBe('1');
    expect(group.getAttribute('data-active-overflow')).toBe('true');
    const more = group.querySelector('[aria-label="More pen slots"]');
    if (!(more instanceof HTMLElement)) throw new Error('missing outlet');
    const extra = more.querySelector('button[aria-label="Highlighter"]');
    if (!(extra instanceof HTMLButtonElement))
      throw new Error('missing surplus slot');
    // The overflowed live tool keeps its pressed marker.
    expect(extra.getAttribute('aria-pressed')).toBe('true');
    expect(activeOverflowSlots(seen[0] ?? [])).toHaveLength(1);
    act(() => extra.click());
    // Command domain: activation routes by control id, never the slot id.
    expect(overflowActivations).toEqual([['ink.tool.highlighter', undefined]]);
  });

  it('marks no active overflow when the live tool sits inline', () => {
    renderShelf({
      kind: 'pen',
      entries: [
        penEntry('pen', 'Ball Pen', true, 'pen-slot-1'),
        penEntry('fountain', 'Fountain Pen', false, 'pen-slot-2'),
      ],
      renderOverflow: () => null,
    });
    expect(shelf().getAttribute('data-overflow-count')).toBe('0');
    expect(shelf().hasAttribute('data-active-overflow')).toBe(false);
  });

  it('keeps a single open editor across slots', () => {
    renderShelf({
      kind: 'pen',
      entries: [
        penEntry('pen', 'Ball Pen', true, 'pen-slot-1'),
        penEntry('fountain', 'Fountain Pen', true, 'pen-slot-2'),
      ],
    });
    const dialogs = (): string[] =>
      [...host!.querySelectorAll('[role="dialog"]')].map(
        (panel) => panel.getAttribute('aria-label') ?? '',
      );
    act(() => trigger('Ball Pen').click());
    expect(dialogs()).toEqual(['Ball Pen settings']);
    // Opening the second editor claims exclusivity: the first closes.
    act(() => trigger('Fountain Pen').click());
    expect(dialogs()).toEqual(['Fountain Pen settings']);
  });

  it('clears open editors when the pane:document key changes', () => {
    const base = {
      kind: 'pen' as const,
      entries: [penEntry('pen', 'Ball Pen', true, 'pen-slot-1')],
    };
    const { rerender } = renderShelf(base);
    act(() => trigger('Ball Pen').click());
    expect(dialog()).not.toBeNull();
    rerender({ ...base, resetKey: 'pane-1:doc-2' });
    expect(dialog()).toBeNull();
  });

  it('ignores entry.active on button entries: control.active is the truth', () => {
    const { calls } = renderShelf({
      kind: 'pen',
      entries: [
        {
          id: 'ink.tool.pen',
          slotId: 'pen-slot-1',
          active: true,
          control: penButton('ink.tool.pen', 'Ball Pen', false),
        },
      ],
    });
    // Stale entry.active must not fork the SurfaceToolButton derivation:
    // unpressed, plain execute, no editor.
    expect(trigger('Ball Pen').getAttribute('aria-pressed')).toBe('false');
    act(() => trigger('Ball Pen').click());
    expect(calls).toEqual([['ink.tool.pen', undefined]]);
    expect(dialog()).toBeNull();
  });

  it('separates command ids from slot keys', () => {
    const { calls, slotKeys } = renderShelf({
      kind: 'pen',
      entries: [
        {
          id: 'ink.tool.pen',
          slotId: 'pen-slot-9',
          control: penButton('ink.tool.pen', 'Ball Pen', false),
        },
      ],
    });
    act(() => trigger('Ball Pen').click());
    // Activation routes by executable command owner (control id)…
    expect(calls).toEqual([['ink.tool.pen', undefined]]);
    // …while slot scoping keys by the effective slot id.
    expect(slotKeys).toContain('pen-slot-9');
    expect(slotKeys).not.toContain('ink.tool.pen');
  });

  it('shares one fixed box between live triggers and placeholders', () => {
    renderShelf({
      kind: 'pen',
      entries: [penEntry('pen', 'Ball Pen', true, 'pen-slot-1')],
    });
    const buttons = [...shelf().querySelectorAll(':scope button')];
    // 1 live + 3 placeholders, every inline cell on the same hit target.
    expect(buttons).toHaveLength(SHELF_PEN_SLOT_COUNT);
    for (const button of buttons) {
      expect(button.className).toMatch(/fl-document-tool/);
    }
  });

  it('keeps slot geometry single-row and token-only', () => {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const block = (name: string): string => {
      const match = clean.match(
        new RegExp(`\\.${name}_[A-Za-z0-9]+\\s*\\{([^}]*)\\}`),
      );
      if (match === null) throw new Error(`missing style block: ${name}`);
      return match[1] ?? '';
    };
    // Single row by construction: flex without wrap (the shelf island owns
    // scrolling, so slots never create a second toolbar row).
    expect(block('_fl-shelf-slots')).toMatch(/flex-wrap:\s*nowrap/);
    expect(block('_fl-shelf-slots')).not.toMatch(/flex-wrap:\s*wrap/);
    // Token-only chrome: no hard-coded palette in the new slot rules.
    for (const name of ['_fl-shelf-slots', '_fl-shelf-slot-empty']) {
      const body = block(name);
      expect(body).toMatch(/var\(--fl-/);
      expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}/);
      expect(body).not.toMatch(/rgba?\(/);
    }
  });

  it('fixes one shared compact trigger box for all inputs', () => {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const hashed = (name: string): string => `\\.${name}_[A-Za-z0-9]+`;
    // inline triggers (live and placeholder alike) share one
    // fixed box scoped by child combinators, so assigning a slot never
    // shifts siblings; dialogs render deeper and keep their own layout.
    const triggerBox = new RegExp(
      `${hashed('_fl-shelf-slots')}[^{]*${hashed('_fl-document-tool')}[^{]*\\{[^}]*width:\\s*32px[^}]*min-width:\\s*32px`,
    );
    expect(clean).toMatch(triggerBox);
  });
});
