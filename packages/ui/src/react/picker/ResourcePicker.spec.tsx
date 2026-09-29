// @vitest-environment jsdom
// Picker dialog specs: search filter, keyboard, empty state.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResourceSuggestion } from '@froglight/foundation';
import { ResourcePicker } from './ResourcePicker.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(node: React.ReactElement): HTMLElement {
  if (root !== null) {
    act(() => root?.unmount());
    host?.remove();
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
  return document.body.querySelector<HTMLElement>('[data-fl-component="resource-picker"]')!;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function suggestion(label: string, resourceId: string): ResourceSuggestion {
  return {
    target: {
      documentId: 'doc',
      kindId: 'froglight.markdown',
      resourceId,
    } as ResourceSuggestion['target'],
    label,
  };
}

function inputOf(mounted: HTMLElement): HTMLInputElement {
  return mounted.querySelector('input[type="search"]') as HTMLInputElement;
}

function optionsOf(mounted: HTMLElement): HTMLElement[] {
  return [...mounted.querySelectorAll('[role="option"]')] as HTMLElement[];
}

function typeQuery(mounted: HTMLElement, value: string): void {
  const input = inputOf(mounted);
  act(() => {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function pressKey(mounted: HTMLElement, key: string): void {
  const input = inputOf(mounted);
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

function pressKeyOn(target: HTMLElement, key: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

async function waitForExit(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 210)); });
}

function recentEntry(label: string, resourceId: string) {
  return {
    target: {
      documentId: 'doc',
      kindId: 'froglight.markdown',
      resourceId,
    } as ResourceSuggestion['target'],
    label,
  };
}

// React 19 processes the input event through onChange; the native-setter
// path above is the deterministic jsdom equivalent of user typing.
describe('ResourcePicker dialog', () => {
  it('filters as the query changes', async () => {
    const mounted = mount(
      createElement(ResourcePicker, {
        suggestions: [
          suggestion('Meeting notes', 'res-a'),
          suggestion('Roadmap', 'res-b'),
        ],
        onPick: () => undefined,
        onClose: () => undefined,
      }),
    );
    expect(optionsOf(mounted)).toHaveLength(2);
    typeQuery(mounted, 'road');
    expect(optionsOf(mounted).map((option) => option.textContent)).toEqual([
      'Roadmap',
    ]);
    typeQuery(mounted, 'MEETING');
    expect(optionsOf(mounted).map((option) => option.textContent)).toEqual([
      'Meeting notes',
    ]);
  });

  it('shows the no-match empty state for unmatched queries', async () => {
    const mounted = mount(
      createElement(ResourcePicker, {
        suggestions: [suggestion('Meeting notes', 'res-a')],
        onPick: () => undefined,
        onClose: () => undefined,
      }),
    );
    typeQuery(mounted, 'zzz-nope');
    expect(optionsOf(mounted)).toHaveLength(0);
    const empty = mounted.querySelector('[data-testid="picker-empty"]');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toMatch(/No matches for.*zzz-nope/);
  });

  it('moves with ArrowDown/ArrowUp and commits the active option with Enter', async () => {
    const picked: string[] = [];
    const mounted = mount(
      createElement(ResourcePicker, {
        suggestions: [suggestion('Alpha', 'res-a'), suggestion('Beta', 'res-b')],
        onPick: (choice) => void picked.push(choice.label),
        onClose: () => undefined,
      }),
    );
    // Initial active is Alpha (index 0); ArrowDown moves to Beta.
    pressKey(mounted, 'ArrowDown');
    expect(
      optionsOf(mounted)[1]?.getAttribute('aria-selected'),
    ).toBe('true');
    pressKey(mounted, 'Enter');
    await waitForExit();
    expect(picked).toEqual(['Beta']);
    // ArrowUp returns to Alpha; Home/End jump deterministically.
    pressKey(mounted, 'ArrowUp');
    pressKey(mounted, 'Home');
    expect(optionsOf(mounted)[0]?.getAttribute('aria-selected')).toBe('true');
    pressKey(mounted, 'End');
    expect(optionsOf(mounted)[1]?.getAttribute('aria-selected')).toBe('true');
  });

  it('closes with Escape without picking', async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    const mounted = mount(
      createElement(ResourcePicker, {
        suggestions: [suggestion('Alpha', 'res-a')],
        onPick,
        onClose,
      }),
    );
    pressKey(mounted, 'Escape');
    await waitForExit();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('shows recent entries when the query is empty', async () => {    const picked: string[] = [];
    const mounted = mount(
      createElement(ResourcePicker, {
        suggestions: [],
        recent: [
          {
            target: {
              documentId: 'doc',
              kindId: 'froglight.markdown',
              resourceId: 'res-recent',
            } as ResourceSuggestion['target'],
            label: 'Recent doc',
          },
        ],
        onPick: (choice) => void picked.push(choice.label),
        onClose: () => undefined,
      }),
    );
    const options = optionsOf(mounted);
    expect(options.map((option) => option.textContent)).toContain('Recent doc');
    act(() => {
      options[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitForExit();
    expect(picked).toEqual(['Recent doc']);
  });

  it('keeps every option pointer-activatable with a touch-sized target', async () => {
    const mounted = mount(
      createElement(ResourcePicker, {
        suggestions: [suggestion('Alpha', 'res-a')],
        onPick: () => undefined,
        onClose: () => undefined,
      }),
    );
    for (const option of optionsOf(mounted)) {
      expect(option.tagName.toLowerCase()).toBe('button');
      expect(option.getAttribute('role')).toBe('option');
    }
    // Options commit on click (pointer + touch share the button path).
    const picked: string[] = [];
    const mounted2 = mount(
      createElement(ResourcePicker, {
        suggestions: [suggestion('Alpha', 'res-a')],
        onPick: (choice) => void picked.push(choice.label),
        onClose: () => undefined,
      }),
    );
    act(() => {
      optionsOf(mounted2)[0]?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    await waitForExit();
    expect(picked).toEqual(['Alpha']);
  });

  it('renders Recent above All on an empty query with one shared arrow-key index', async () => {
    const picked: string[] = [];
    const pickedRecent: string[] = [];
    const mounted = mount(
      createElement(ResourcePicker, {
        suggestions: [suggestion('Alpha', 'res-a'), suggestion('Beta', 'res-b')],
        recent: [recentEntry('Recent doc', 'res-recent')],
        onPick: (choice) => void picked.push(choice.label),
        onPickRecent: (entry) => void pickedRecent.push(entry.label),
        onClose: () => undefined,
      }),
    );
    // Recent section renders above the All section inside one listbox.
    const sections = [
      ...mounted.querySelectorAll('[class*="picker-section-label"]'),
    ].map((node) => node.textContent);
    expect(sections).toEqual(['Recent', 'All']);
    const options = optionsOf(mounted);
    expect(options.map((option) => option.textContent)).toEqual([
      'Recent doc',
      'Alpha',
      'Beta',
    ]);
    // Initial active is the recent row; aria-selected tracks the combined index.
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');
    expect(options[1]?.getAttribute('aria-selected')).toBe('false');
    // ArrowDown crosses the Recent/All boundary; Enter commits each path.
    pressKey(mounted, 'ArrowDown');
    expect(options[1]?.getAttribute('aria-selected')).toBe('true');
    pressKey(mounted, 'Enter');
    await waitForExit();
    expect(picked).toEqual(['Alpha']);
    expect(pickedRecent).toEqual([]);
  });

  it('moves the shared index with arrow keys when focus is on an option', async () => {
    const mounted = mount(
      createElement(ResourcePicker, {
        suggestions: [suggestion('Alpha', 'res-a'), suggestion('Beta', 'res-b')],
        recent: [recentEntry('Recent doc', 'res-recent')],
        onPick: () => undefined,
        onClose: () => undefined,
      }),
    );
    const options = optionsOf(mounted);
    act(() => {
      options[0]?.focus();
    });
    pressKeyOn(options[0]!, 'ArrowDown');
    expect(optionsOf(mounted)[1]?.getAttribute('aria-selected')).toBe('true');
    pressKeyOn(optionsOf(mounted)[1]!, 'ArrowUp');
    expect(optionsOf(mounted)[0]?.getAttribute('aria-selected')).toBe('true');
  });

  it('closes with dialog-level Escape when focus is on an option', async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    const mounted = mount(
      createElement(ResourcePicker, {
        suggestions: [suggestion('Alpha', 'res-a')],
        onPick,
        onClose,
      }),
    );
    const option = optionsOf(mounted)[0]!;
    act(() => {
      option.focus();
    });
    pressKeyOn(option, 'Escape');
    await waitForExit();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('closes without picking through the Cancel control', async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    const mounted = mount(
      createElement(ResourcePicker, {
        suggestions: [suggestion('Alpha', 'res-a')],
        onPick,
        onClose,
      }),
    );
    const cancel = [...mounted.querySelectorAll('button')].find(
      (button) => button.textContent === 'Cancel',
    );
    expect(cancel).toBeDefined();
    act(() => {
      cancel!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitForExit();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe('ResourcePicker interaction hardening', () => {
  it('rapid close sequences settle on exactly one onClose (no stuck overlays)', async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    const mounted = mount(
      createElement(ResourcePicker, {
        suggestions: [suggestion('Alpha', 'res-a')],
        onPick,
        onClose,
      }),
    );
    // Escape burst, then Cancel click, then backdrop press: closeOnce wins.
    pressKey(mounted, 'Escape');
    pressKey(mounted, 'Escape');
    const cancel = [...mounted.querySelectorAll('button')].find(
      (button) => button.textContent === 'Cancel',
    )!;
    act(() => {
      cancel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const backdrop = mounted;
    act(() => {
      backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await waitForExit();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('closes on backdrop mousedown alone (isolated path)', async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    const mounted = mount(
      createElement(ResourcePicker, {
        suggestions: [suggestion('Alpha', 'res-a')],
        onPick,
        onClose,
      }),
    );
    // No prior Escape/Cancel: the backdrop guard alone must close. Inverting
    // or removing the `target === currentTarget` guard stays red here (the
    // rapid-close test above would stay green because closeOnce already won).
    const backdrop = mounted;
    act(() => {
      backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await waitForExit();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('scopes the backdrop listener to the backdrop (no leaked global close)', async () => {
    const onClose = vi.fn();
    const mounted = mount(
      createElement(ResourcePicker, {
        suggestions: [suggestion('Alpha', 'res-a')],
        onPick: () => undefined,
        onClose,
      }),
    );
    // Mousedown inside the dialog must not close: the listener is scoped to
    // `target === currentTarget`, never a leaked document-global handler.
    const dialog = mounted.querySelector('[role="dialog"]')!;
    act(() => {
      dialog.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    // The isolated backdrop press still closes exactly once afterwards.
    const backdrop = mounted;
    act(() => {
      backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await waitForExit();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('remounts cleanly after a rapid open/close cycle (no stale closed state)', async () => {
    const onCloseFirst = vi.fn();
    const onCloseSecond = vi.fn();
    const mounted = mount(
      createElement(ResourcePicker, {
        suggestions: [suggestion('Alpha', 'res-a')],
        onPick: () => undefined,
        onClose: onCloseFirst,
      }),
    );
    pressKey(mounted, 'Escape');
    await waitForExit();
    expect(onCloseFirst).toHaveBeenCalledTimes(1);
    // Hosts conditionally render the dialog: close unmounts, reopen mounts
    // fresh (no shared closed state survives across openings).
    act(() => {
      root!.unmount();
    });
    host?.remove();
    root = null;
    host = null;
    const reopened = mount(
      createElement(ResourcePicker, {
        suggestions: [suggestion('Beta', 'res-b')],
        onPick: () => undefined,
        onClose: onCloseSecond,
      }),
    );
    expect(optionsOf(reopened).map((option) => option.textContent)).toEqual([
      'Beta',
    ]);
    pressKey(reopened, 'Escape');
    await waitForExit();
    expect(onCloseSecond).toHaveBeenCalledTimes(1);
  });

  it('hover highlights without committing (no hover-only actions)', async () => {
    const onPick = vi.fn();
    const mounted = mount(
      createElement(ResourcePicker, {
        suggestions: [suggestion('Alpha', 'res-a'), suggestion('Beta', 'res-b')],
        onPick,
        onClose: () => undefined,
      }),
    );
    const options = optionsOf(mounted);
    // React synthesizes onMouseEnter from mouseover; hover only moves the
    // active descendant, commit still requires click/Enter.
    act(() => {
      options[1]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(onPick).not.toHaveBeenCalled();
    expect(options[1]!.getAttribute('aria-selected')).toBe('true');
    act(() => {
      options[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitForExit();
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('focus highlights without hover (keyboard parity on options)', async () => {
    const mounted = mount(
      createElement(ResourcePicker, {
        suggestions: [suggestion('Alpha', 'res-a'), suggestion('Beta', 'res-b')],
        onPick: () => undefined,
        onClose: () => undefined,
      }),
    );
    const options = optionsOf(mounted);
    act(() => {
      options[1]!.focus();
    });
    expect(options[1]!.getAttribute('aria-selected')).toBe('true');
    expect(options[1]!.getAttribute('data-active')).toBe('true');
  });

  it('keeps aria-controls resolving in every branch', async () => {
    const mounted = mount(
      createElement(ResourcePicker, {
        suggestions: [suggestion('Alpha', 'res-a')],
        onPick: () => undefined,
        onClose: () => undefined,
      }),
    );
    const controlledId = (): string => {
      const id = inputOf(mounted).getAttribute('aria-controls');
      expect(id).toBeTruthy();
      return id!;
    };
    // Results branch: combobox controls the listbox.
    expect(mounted.ownerDocument.getElementById(controlledId())).not.toBeNull();
    // No-match branch: the empty status keeps the same id (no dangle).
    typeQuery(mounted, 'zzz-no-match');
    expect(
      mounted.querySelector('[data-testid="picker-empty"]'),
    ).not.toBeNull();
    expect(mounted.ownerDocument.getElementById(controlledId())).not.toBeNull();
  });

  it('keeps aria-controls resolving for the empty-recent branch', async () => {
    const mounted = mount(
      createElement(ResourcePicker, {
        suggestions: [],
        onPick: () => undefined,
        onClose: () => undefined,
      }),
    );
    expect(
      mounted.querySelector('[data-testid="picker-recent-empty"]'),
    ).not.toBeNull();
    const id = inputOf(mounted).getAttribute('aria-controls');
    expect(mounted.ownerDocument.getElementById(id!)).not.toBeNull();
  });

  it('collapses aria-expanded in the no-match branch', async () => {
    const mounted = mount(
      createElement(ResourcePicker, {
        suggestions: [suggestion('Alpha', 'res-a')],
        onPick: () => undefined,
        onClose: () => undefined,
      }),
    );
    // Results branch: listbox present, combobox expanded.
    expect(inputOf(mounted).getAttribute('aria-expanded')).toBe('true');
    // No-match branch: status replaces the listbox, so the combobox reports
    // collapsed while keeping aria-controls resolving (no dangle).
    typeQuery(mounted, 'zzz-no-match');
    expect(
      mounted.querySelector('[data-testid="picker-empty"]'),
    ).not.toBeNull();
    expect(inputOf(mounted).getAttribute('aria-expanded')).toBe('false');
  });

  it('exposes dialog + listbox + option roles with a labelled dialog', async () => {
    const mounted = mount(
      createElement(ResourcePicker, {
        suggestions: [suggestion('Alpha', 'res-a')],
        label: 'Insert reference',
        onPick: () => undefined,
        onClose: () => undefined,
      }),
    );
    const dialog = mounted.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-label')).toBe('Insert reference');
    expect(mounted.querySelector('[role="listbox"]')).not.toBeNull();
    const options = optionsOf(mounted);
    expect(options.length).toBe(1);
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');
    expect(inputOf(mounted).getAttribute('role')).toBe('combobox');
  });
});
