// @vitest-environment jsdom
/**
 * Saved-style cards.
 *
 * First-class cards show preview, name, family, color, width, selected, and
 * favorite; all eight operations route through the existing command channel
 * with working-vs-saved semantics (modified indicator, no silent mutation).
 * Tests use hand-crafted structured controls (the same shape
 * `buildActiveToolSettingsControls` emits) so the UI contract is pinned
 * without coupling to provider internals.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  DocumentToolControl,
  SavedStyleCardData,
} from '@froglight/foundation';
import { SavedStylesSection } from './saved-style-cards.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type Call = readonly [id: string, value?: string];

function card(
  id: string,
  name: string,
  extra: Partial<SavedStyleCardData> = {},
): SavedStyleCardData {
  return {
    id,
    name,
    toolKind: 'fountain',
    favorite: false,
    preset: { color: '#123456', size: 3.5 },
    ...extra,
  };
}

function controls(input: {
  styles: readonly SavedStyleCardData[];
  currentId: string | null;
  modified?: boolean;
  workingColor?: string;
}): DocumentToolControl[] {
  const {
    styles,
    currentId,
    modified = false,
    workingColor = '#abcdef',
  } = input;
  const prefix = 'ink';
  const tool = 'fountain';
  const head = `${prefix}.settings.${tool}`;
  const list: DocumentToolControl[] = [
    {
      kind: 'choice',
      id: `${head}.saved-style`,
      group: 'settings',
      label: 'Saved styles',
      value: currentId ?? '',
      options: [
        { value: '', label: 'Working style' },
        ...styles.map((style) => ({ value: style.id, label: style.name })),
      ],
      semanticRole: 'surface.style.saved',
      savedStyles: styles,
      savedStyleModified: modified,
      workingPreset: { color: workingColor, size: 5 },
    } as DocumentToolControl,
    {
      kind: 'input',
      id: `${head}.save-style`,
      group: 'settings',
      label: 'Style name',
      placeholder: 'Style name',
      actionLabel: 'Save as new',
    },
  ];
  if (currentId !== null) {
    const selected = styles.find((style) => style.id === currentId);
    list.push({
      kind: 'input',
      id: `${head}.rename-style`,
      group: 'settings',
      label: 'Rename saved style',
      value: selected?.name,
      actionLabel: 'Rename',
    });
    list.push({
      kind: 'button',
      id: `${head}.favorite-style`,
      group: 'settings',
      label: selected?.favorite === true ? 'Remove' : 'Add',
      shortLabel: 'Favorite',
      active: selected?.favorite === true,
    });
    list.push({
      kind: 'button',
      id: `${head}.move-style-earlier`,
      group: 'settings',
      label: 'Move saved style earlier',
      shortLabel: 'Move earlier',
      disabled: styles[0]?.id === currentId,
    });
    list.push({
      kind: 'button',
      id: `${head}.move-style-later`,
      group: 'settings',
      label: 'Move saved style later',
      shortLabel: 'Move later',
      disabled: styles[styles.length - 1]?.id === currentId,
    });
    list.push({
      kind: 'button',
      id: `${head}.update-style`,
      group: 'settings',
      label: modified ? 'Update modified preset' : 'Update preset',
      shortLabel: 'Update preset',
      disabled: !modified,
    });
    list.push({
      kind: 'button',
      id: `${head}.delete-style`,
      group: 'settings',
      label: 'Delete saved style',
      shortLabel: 'Delete',
    });
    list.push({
      kind: 'button',
      id: `${head}.reset-style`,
      group: 'settings',
      label: 'Reset working style to saved preset',
      shortLabel: 'Reset',
      disabled: !modified,
    });
  }
  return list;
}

describe('SavedStylesSection', () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
  });

  function mount(
    list: readonly DocumentToolControl[],
    calls: Call[],
  ): HTMLElement {
    host?.remove();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(
        <SavedStylesSection
          controls={list}
          execute={(id, value) => {
            calls.push([id, value] as Call);
          }}
        />,
      );
    });
    return host;
  }

  it('returns focus to the selected preset before update or reset disables its action', () => {
    const el = mount(
      controls({
        styles: [card('a', 'Notes')],
        currentId: 'a',
        modified: true,
      }),
      [],
    );
    const selected = el.querySelector<HTMLButtonElement>(
      '[aria-pressed="true"]',
    )!;
    for (const label of [
      'Update Notes to the working style',
      'Reset working style to Notes',
    ]) {
      const action = el.querySelector<HTMLButtonElement>(
        `[aria-label="${label}"]`,
      )!;
      action.focus();
      act(() => action.click());
      expect(document.activeElement).toBe(selected);
    }
  });

  it('shows preview, name, family, color, width, selected, and favorite', () => {
    const calls: Call[] = [];
    const el = mount(
      controls({
        styles: [
          card('a', 'Blue', {
            favorite: true,
            preset: { color: '#123456', size: 3.5 },
          }),
          card('b', 'Notes', { preset: { color: '#ff0000', size: 6 } }),
        ],
        currentId: 'a',
      }),
      calls,
    );
    const blue = el.querySelector(
      '[aria-label="Blue Fountain Pen, 3.5 pt, favorite, selected"]',
    );
    expect(blue).not.toBeNull();
    expect(blue?.getAttribute('aria-pressed')).toBe('true');
    expect(blue?.querySelector('svg')).not.toBeNull();
    expect(blue?.textContent).toContain('Blue');
    expect(blue?.textContent).toContain('Fountain Pen');
    expect(blue?.textContent).toContain('3.5 pt');
    expect(el.textContent).toContain('Favorite');
    const notes = el.querySelector('[aria-label="Notes Fountain Pen, 6 pt"]');
    expect(notes?.getAttribute('aria-pressed')).toBe('false');
    expect(el.querySelector('[aria-label="Favorite Notes"]')).not.toBeNull();
  });

  it('routes apply, favorite, and delete per card', () => {
    const calls: Call[] = [];
    const el = mount(
      controls({
        styles: [card('a', 'Blue'), card('b', 'Notes')],
        currentId: 'a',
      }),
      calls,
    );
    act(() => {
      (
        el.querySelector(
          '[aria-label="Notes Fountain Pen, 3.5 pt"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(calls).toEqual([['ink.settings.fountain.saved-style', 'b']]);
    calls.length = 0;
    act(() => {
      (
        el.querySelector('[aria-label="Favorite Notes"]') as HTMLButtonElement
      ).click();
    });
    expect(calls).toEqual([['ink.settings.fountain.favorite-style', 'b']]);
    calls.length = 0;
    act(() => {
      (
        el.querySelector('[aria-label="Delete Blue"]') as HTMLButtonElement
      ).click();
    });
    expect(calls).toEqual([['ink.settings.fountain.delete-style', 'a']]);
  });

  it('offers exactly one favorite toggle per style (no detail duplicate)', () => {
    const calls: Call[] = [];
    const el = mount(
      controls({
        styles: [card('a', 'Blue', { favorite: true }), card('b', 'Notes')],
        currentId: 'a',
      }),
      calls,
    );
    const favoriteToggles = Array.from(el.querySelectorAll('button')).filter(
      (button) =>
        /^(favorite|unfavorite) /i.test(
          button.getAttribute('aria-label') ?? '',
        ),
    );
    // One per card (star); the selected-style detail keeps update/reset/
    // reorder/delete only, so the same command never appears twice.
    expect(
      favoriteToggles.map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Unfavorite Blue', 'Favorite Notes']);
  });

  it('exposes update, reset, rename, reorder, and save-as-new', () => {
    const calls: Call[] = [];
    const el = mount(
      controls({
        styles: [card('a', 'Blue'), card('b', 'Notes')],
        currentId: 'b',
        modified: true,
      }),
      calls,
    );
    expect(el.querySelector('[role="status"]')?.textContent).toContain(
      'Current style modified',
    );
    act(() => {
      (
        el.querySelector(
          '[aria-label="Update Notes to the working style"]',
        ) as HTMLButtonElement
      ).click();
    });
    act(() => {
      (
        el.querySelector(
          '[aria-label="Reset working style to Notes"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(calls).toEqual([
      ['ink.settings.fountain.update-style', undefined],
      ['ink.settings.fountain.reset-style', undefined],
    ]);
    calls.length = 0;
    act(() => {
      (
        el.querySelector(
          '[aria-label="Move Notes earlier"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(calls).toEqual([
      ['ink.settings.fountain.move-style-earlier', undefined],
    ]);
    // Rename via Enter.
    const rename = el.querySelector(
      '[aria-label="Rename Notes"]',
    ) as HTMLInputElement;
    act(() => {
      rename.focus();
      rename.value = 'Primary';
      rename.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // React controlled input: set via native setter then submit the form.
    act(() => {
      const form = rename.closest('form')!;
      form.dispatchEvent(
        new SubmitEvent('submit', { bubbles: true, cancelable: true }),
      );
    });
    // Save-as-new via Enter (empty names stay disabled).
    const save = el.querySelector(
      '[aria-label="New style name"]',
    ) as HTMLInputElement;
    expect(
      (el.querySelector('[data-action="save"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    act(() => {
      const native = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      native?.call(save, 'Fresh');
      save.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      save
        .closest('form')!
        .dispatchEvent(
          new SubmitEvent('submit', { bubbles: true, cancelable: true }),
        );
    });
    expect(
      calls.some(
        ([id, value]) =>
          id === 'ink.settings.fountain.save-style' && value === 'Fresh',
      ),
    ).toBe(true);
  });

  it('disables update/reset when clean and shows working note when unselected', () => {
    const calls: Call[] = [];
    const el = mount(
      controls({
        styles: [card('a', 'Blue')],
        currentId: 'a',
        modified: false,
      }),
      calls,
    );
    expect(el.querySelector('[role="status"]')).toBeNull();
    expect(
      (
        el.querySelector(
          '[aria-label="Update Blue to the working style"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        el.querySelector(
          '[aria-label="Reset working style to Blue"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    const unselected = mount(
      controls({ styles: [card('a', 'Blue')], currentId: null }),
      [],
    );
    expect(unselected.textContent).toContain('Working style');
  });

  it('keeps saved cards unchanged when working changes (no silent mutation)', () => {
    const calls: Call[] = [];
    const styles = [
      card('a', 'Blue', { preset: { color: '#111111', size: 2 } }),
    ];
    const first = mount(
      controls({ styles, currentId: 'a', workingColor: '#111111' }),
      calls,
    );
    expect(
      first.querySelector('[aria-label="Blue Fountain Pen, 2 pt, selected"]'),
    ).not.toBeNull();
    // Working mutates (color change) → modified, saved card keeps old preset.
    const second = mount(
      controls({
        styles,
        currentId: 'a',
        modified: true,
        workingColor: '#222222',
      }),
      calls,
    );
    expect(
      second.querySelector('[aria-label="Blue Fountain Pen, 2 pt, selected"]'),
    ).not.toBeNull();
    expect(second.querySelector('[role="status"]')).not.toBeNull();
  });

  it('shows empty state with save-as-new when no styles exist', () => {
    const calls: Call[] = [];
    const el = mount(controls({ styles: [], currentId: null }), calls);
    expect(el.textContent).toContain('No saved styles yet');
    expect(el.querySelector('[aria-label="New style name"]')).not.toBeNull();
    expect(el.querySelector('[data-saved-styles]')).not.toBeNull();
  });

  it('returns null for legacy snapshots without structured payload', () => {
    const calls: Call[] = [];
    const legacy: DocumentToolControl[] = [
      {
        kind: 'choice',
        id: 'ink.settings.fountain.saved-style',
        group: 'settings',
        label: 'Saved styles',
        value: '',
        options: [{ value: '', label: 'Working style' }],
        semanticRole: 'surface.style.saved',
      },
    ];
    host?.remove();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    let rendered: React.ReactElement | null = null;
    act(() => {
      rendered = (
        <SavedStylesSection
          controls={legacy}
          execute={(id, value) => {
            calls.push([id, value] as Call);
          }}
        />
      );
      root!.render(rendered);
    });
    expect(host.querySelector('[data-saved-styles]')).toBeNull();
    expect(calls).toEqual([]);
  });
});
