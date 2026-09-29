// @vitest-environment jsdom
/**
 * Contextual shelf refinement.
 *
 * The Pen shelf carries high-frequency controls without the full
 * popover: family buttons, favorite styles, quick widths, quick colors,
 * and a settings disclosure — bounded and explicitly overflowed.
 * Eraser/Select shelves carry their modal equivalents (mode + quick size).
 * Compact policy: the active tool, favorites, and settings survive
 * inline; everything else moves into the explicit More menu.
 *
 * Mounts `FloatingToolbarLayer` (which owns the `CompositionShelf`) with
 * the default composition and real foundation settings controls, so shelf
 * derivation and popover wiring are covered end-to-end.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DocumentToolControl,
  DocumentToolSnapshot,
  SurfaceStylePreset,
} from '@froglight/foundation';
import {
  buildActiveToolSettingsControls,
  type SurfaceToolSettingsHost,
} from '@froglight/foundation';
import type { WorkbenchEditorToolsPort } from '../workbench-ports.js';
import { createDocumentToolbarRegistry } from '../document-toolbar-registry.js';
import { createToolbarPlacementRegistry } from '../toolbar/placement-registry.js';
import { createToolbarCompositionRegistry } from '../toolbar/composition-registry.js';
import { defaultToolbarComposition } from '../toolbar/default-composition.js';
import type { OwnedToolbarControl } from '../toolbar/placement-resolver.js';
import { shelfSettingsForCategory } from '../toolbar/unified-toolbar-model.js';
import {
  FloatingToolbarLayer,
  TopbarCenterTools,
  TOOLBAR_COMPACT_QUERY,
  selectShelfQuicks,
} from './UnifiedToolbar.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type Call = readonly [id: string, value?: string];

const WIDTHS = [2, 3.5, 6] as const;
const SWATCHES = [
  '#37352f',
  '#7c6cf0',
  '#c4554d',
  '#448361',
  '#a08430',
] as const;

const WRITE_FAMILY = [
  { key: 'pen', label: 'Ball Pen', role: 'surface.pen.ball' },
  { key: 'fountain', label: 'Fountain Pen', role: 'surface.pen.fountain' },
  { key: 'brush', label: 'Brush Pen', role: 'surface.pen.brush' },
  { key: 'pencil', label: 'Pencil', role: 'surface.pencil' },
  { key: 'highlighter', label: 'Highlighter', role: 'surface.highlighter' },
] as const;

function style(
  id: string,
  name: string,
  favorite: boolean,
): SurfaceStylePreset {
  return {
    id,
    name,
    toolKind: 'pen',
    preset: { color: '#37352f', size: 3.5 },
    favorite,
    order: 0,
  };
}

function makeHost(
  activeTool: string,
  favoriteCount = 2,
): SurfaceToolSettingsHost {
  const styles: SurfaceStylePreset[] = [
    style('f1', 'Daily', favoriteCount > 0),
    style('f2', 'Fine', favoriteCount > 1),
    style('f3', 'Sketch', favoriteCount > 2),
    style('p1', 'Draft', false),
  ];
  return {
    activeToolId: () => `froglight.ink.${activeTool}`,
    setTool: () => undefined,
    toolPreset: () => ({ color: '#37352f', size: 3.5 }),
    setToolPreset: () => undefined,
    savedStyles: (tool) => (tool === 'pen' ? styles : []),
    currentStyleId: (tool) => (tool === 'pen' ? 'f1' : null),
    saveCurrentStyle: () => null,
    applySavedStyle: () => false,
    updateSavedStyle: () => false,
    renameSavedStyle: () => false,
    favoriteSavedStyle: () => false,
    reorderSavedStyles: () => false,
    deleteSavedStyle: () => false,
    resetSavedStyle: () => false,
    savedStyleModified: () => false,
    eraserPreset: () => ({ radius: 12, mode: 'stroke', filter: 'all' }),
    setEraserPreset: () => undefined,
    lassoPreset: () => ({ mode: 'freehand', filter: 'all' }),
    setLassoPreset: () => undefined,
    recentColors: () => [],
    gestures: () => ({}),
    setGestures: () => undefined,
  };
}

function familyButton(
  prefix: string,
  key: string,
  label: string,
  role: string,
  active: boolean,
): DocumentToolControl {
  return {
    kind: 'button',
    id: `${prefix}.tool.${key}`,
    group: 'draw',
    label,
    shortLabel: label,
    role: 'surface-tool',
    toolId: `${prefix}.tool.${key}`,
    semanticRole: role,
    active,
  };
}

function eraserButton(prefix: string, active: boolean): DocumentToolControl {
  return {
    kind: 'button',
    id: `${prefix}.tool.eraser`,
    group: 'draw',
    label: 'Eraser',
    shortLabel: 'Eraser',
    role: 'surface-tool',
    toolId: `${prefix}.tool.eraser`,
    semanticRole: 'surface.erase',
    active,
  };
}

// Eraser modes: no mode dropdown — selection happens through
// two fixed-mode tools sharing one eraser engine. The legacy single
// `surface.erase` role is dormant (providers no longer emit it).
const ERASER_TOOLS = [
  { mode: 'stroke', label: 'Stroke Eraser', role: 'surface.erase.stroke' },
  {
    mode: 'precision',
    label: 'Precision Eraser',
    role: 'surface.erase.precision',
  },
] as const;

function eraserToolButtons(
  prefix: string,
  activeMode = 'stroke',
): DocumentToolControl[] {
  return ERASER_TOOLS.map((member) => ({
    kind: 'button',
    id: `${prefix}.tool.eraser-${member.mode}`,
    group: 'draw',
    label: member.label,
    shortLabel: member.label,
    role: 'surface-tool',
    toolId: `${prefix}.tool.eraser-${member.mode}`,
    semanticRole: member.role,
    active: member.mode === activeMode,
  }));
}

function writeSnapshot(
  prefix: string,
  activeKey: string,
  favoriteCount = 2,
): DocumentToolSnapshot {
  const settings = buildActiveToolSettingsControls(
    makeHost(activeKey, favoriteCount),
    { prefix, swatches: [...SWATCHES], widths: [...WIDTHS] },
  );
  return {
    context: 'Surface',
    controls: [
      ...WRITE_FAMILY.map((member) =>
        familyButton(
          prefix,
          member.key,
          member.label,
          member.role,
          member.key === activeKey,
        ),
      ),
      eraserButton(prefix, activeKey === 'eraser'),
      ...settings,
    ],
  };
}

function eraserSnapshot(
  prefix: string,
  mode: 'stroke' | 'precision' = 'stroke',
): DocumentToolSnapshot {
  const settings = buildActiveToolSettingsControls(
    {
      ...makeHost('eraser'),
      eraserPreset: () => ({ radius: 12, mode, filter: 'all' }),
    },
    {
      prefix,
      swatches: [...SWATCHES],
      widths: [...WIDTHS],
    },
  );
  return {
    context: 'Surface',
    controls: [
      ...WRITE_FAMILY.map((member) =>
        familyButton(prefix, member.key, member.label, member.role, false),
      ),
      ...eraserToolButtons(prefix, mode),
      ...settings,
    ],
  };
}

interface Harness {
  calls: Call[];
  setSnapshot: (snapshot: DocumentToolSnapshot) => void;
  shelf: (category?: string) => HTMLElement;
  strip: () => HTMLElement;
}

/**
 * Nth live slot trigger inside a shelf quick group (slot rows).
 * Scope is the shelf for inline rows or the More menu for overflowed rows.
 */
function slotTrigger(
  scope: HTMLElement,
  groupLabel: string,
  kind: 'size' | 'color',
  index: number,
): HTMLButtonElement {
  const group = scope.querySelector(`[aria-label="${groupLabel}"]`);
  if (group === null) throw new Error(`missing quick group: ${groupLabel}`);
  const triggers = [
    ...group.querySelectorAll(
      `button[data-slot-kind="${kind}"]:not([data-empty-slot])`,
    ),
  ];
  const trigger = triggers[index];
  if (!(trigger instanceof HTMLButtonElement))
    throw new Error(`missing ${kind} slot ${index} in ${groupLabel}`);
  return trigger;
}

function doubleClickSlot(button: HTMLButtonElement): void {
  act(() => {
    button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
}

function setSlotInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  if (setter === undefined) throw new Error('no input value setter');
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('contextual shelf refinement', () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    vi.unstubAllGlobals();
  });

  function stubCompact(compact: boolean): void {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: compact && query === TOOLBAR_COMPACT_QUERY,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
  }

  function mount(
    snapshot: DocumentToolSnapshot,
    options: {
      compact?: boolean;
      kindId?: string;
      view?: 'shelf' | 'strip';
    } = {},
  ): Harness {
    stubCompact(options.compact ?? false);
    if (root !== null) {
      act(() => root!.unmount());
      root = null;
    }
    host?.remove();
    const calls: Call[] = [];
    const listeners = new Set<() => void>();
    let current: DocumentToolSnapshot | null = snapshot;
    const port: WorkbenchEditorToolsPort = {
      onDidChange: (listener: () => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      execEditorCommand: () => false,
      canExecEditorCommand: () => true,
      editorToolSnapshot: () => current,
      executeEditorTool: (_pane: string, id: string, value?: string) => {
        calls.push([id, value] as Call);
        return true;
      },
    };
    const contributions = createDocumentToolbarRegistry();
    const placements = createToolbarPlacementRegistry();
    const composition = createToolbarCompositionRegistry();
    const defaults = defaultToolbarComposition();
    for (const entry of defaults.categories)
      composition.registry.registerCategory(entry);
    for (const entry of defaults.items)
      composition.registry.registerItem(entry);
    for (const entry of defaults.extensions)
      composition.registry.registerKindExtension(entry);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const view = options.view ?? 'shelf';
    const toolbarProps = {
      tools: port,
      contributions: contributions.registry,
      placements: placements.registry,
      composition: composition.registry,
      pane: 'pane-1',
      documentId: 'doc-1',
      kindId: options.kindId ?? 'froglight.ink',
    };
    act(() => {
      root!.render(
        view === 'strip' ? (
          <TopbarCenterTools {...toolbarProps} />
        ) : (
          <FloatingToolbarLayer {...toolbarProps} />
        ),
      );
    });
    return {
      calls,
      setSnapshot: (next: DocumentToolSnapshot) => {
        act(() => {
          current = next;
          for (const listener of listeners) listener();
        });
      },
      shelf: (category = 'surface.write') => {
        const element = host!.querySelector(`[data-tool-shelf="${category}"]`);
        if (!(element instanceof HTMLElement))
          throw new Error(`missing shelf: ${category}`);
        return element;
      },
      strip: () => {
        const element = host!.querySelector('[data-toolbar="category-strip"]');
        if (!(element instanceof HTMLElement))
          throw new Error('missing category strip');
        return element;
      },
    };
  }

  it('shows family buttons, favorites, and quick widths/colors without a settings gear', () => {
    const harness = mount(writeSnapshot('ink', 'pen'));
    const shelf = harness.shelf();
    for (const name of ['Ball Pen', 'Fountain Pen', 'Brush Pen', 'Pencil']) {
      expect(
        shelf.querySelector(`button[aria-label="${name}"]`),
      ).not.toBeNull();
    }
    expect(
      shelf.querySelector('[aria-label="Favorite styles"]'),
    ).not.toBeNull();
    expect(shelf.querySelector('[aria-label="Quick widths"]')).not.toBeNull();
    expect(shelf.querySelector('[aria-label="Quick colors"]')).not.toBeNull();
    expect(
      shelf.querySelector('button[aria-label="Ball Pen settings"]'),
    ).toBeNull();
    // No overflow on wide layouts: everything inline, bounded.
    expect(shelf.querySelector('button[aria-label="More tools"]')).toBeNull();
  });

  it('puts tools ahead of quicks without a settings gear', () => {
    // The selected tool itself opens settings; the shelf needs no gear.
    for (const compact of [false, true]) {
      const harness = mount(writeSnapshot('ink', 'pen'), { compact });
      const shelf = harness.shelf();
      const tokens = Array.from(shelf.children).map((child) => {
        if (child.matches('button[aria-label$="settings"]')) return 'settings';
        if (child.matches('[role="group"]'))
          return `quick:${child.getAttribute('aria-label')}`;
        if (child.querySelector(':scope button[aria-label]') !== null)
          return 'tool';
        return 'other';
      });
      expect(tokens.find((token) => token !== 'other')).toBe('tool');
      expect(tokens).not.toContain('settings');
      const firstQuick = tokens.findIndex((token) =>
        token.startsWith('quick:'),
      );
      expect(firstQuick).toBeGreaterThan(-1);
      expect(tokens.findIndex((token) => token === 'tool')).toBeLessThan(
        firstQuick,
      );
    }
  });

  it('applies favorites and quick widths/colors through the owner channel', () => {
    const harness = mount(writeSnapshot('ink', 'pen'));
    const shelf = harness.shelf();
    const favorite = shelf.querySelector(
      '[aria-label="Favorite styles"] button',
    );
    if (!(favorite instanceof HTMLButtonElement))
      throw new Error('missing favorite');
    act(() => favorite.click());
    // Size/color quicks are store-driven slot rows: the third size
    // slot carries the 6pt width of the pen-family factory triple.
    const width = slotTrigger(shelf, 'Quick widths', 'size', 2);
    act(() => width.click());
    // …and the third color slot the #c4554d swatch.
    const color = slotTrigger(shelf, 'Quick colors', 'color', 2);
    act(() => color.click());
    expect(harness.calls).toEqual([
      ['ink.settings.pen.saved-style', 'f1'],
      ['ink.settings.pen.size', '6'],
      ['ink.settings.pen.color', '#c4554d'],
    ]);
  });

  it('opens the next family settings by tapping the selected tool', () => {
    const harness = mount(writeSnapshot('ink', 'pen'));
    const openSelected = (name: string): void => {
      const selected = harness
        .shelf()
        .querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
      act(() => selected.click());
      expect(
        host!.querySelector('[role="dialog"]')?.getAttribute('aria-label'),
      ).toBe(`${name} settings`);
    };
    openSelected('Ball Pen');
    const dialog = host!.querySelector('[role="dialog"]')!;
    act(() =>
      dialog.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    harness.setSnapshot(writeSnapshot('ink', 'fountain'));
    openSelected('Fountain Pen');
  });

  it('opens the active tool popover from its selected button', () => {
    const harness = mount(writeSnapshot('ink', 'pen'));
    const selected = harness
      .shelf()
      .querySelector('button[aria-label="Ball Pen"]');
    if (!(selected instanceof HTMLButtonElement))
      throw new Error('missing pen');
    act(() => selected.click());
    const dialog = host!.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-label')).toBe('Ball Pen settings');
  });

  it('keeps pen family switching in the shelf', () => {
    const harness = mount(writeSnapshot('ink', 'pen'));
    for (const name of ['Ball Pen', 'Fountain Pen', 'Brush Pen', 'Pencil']) {
      expect(
        harness.shelf().querySelector(`button[aria-label="${name}"]`),
      ).not.toBeNull();
    }
    const pen = harness.shelf().querySelector('button[aria-label="Ball Pen"]');
    if (!(pen instanceof HTMLButtonElement)) throw new Error('missing pen');
    act(() => pen.click());
    const dialog = host!.querySelector('[role="dialog"]');
    if (!(dialog instanceof HTMLElement)) throw new Error('missing dialog');
    expect(dialog.querySelector('[aria-label="Pen family"]')).toBeNull();
  });

  it('shows size slots only for Precision Eraser', () => {
    const harness = mount(eraserSnapshot('ink'));
    const shelf = harness.shelf('surface.erase');
    for (const name of ['Stroke Eraser', 'Precision Eraser']) {
      expect(
        shelf.querySelector(`button[aria-label="${name}"]`),
      ).not.toBeNull();
    }
    expect(
      shelf
        .querySelector('button[aria-label="Stroke Eraser"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(shelf.querySelector('[aria-label="Eraser mode"]')).toBeNull();
    expect(shelf.querySelector('[aria-label="Eraser size"]')).toBeNull();
    expect(shelf.querySelector('[aria-label="Favorite styles"]')).toBeNull();
    expect(shelf.querySelector('[aria-label="Quick widths"]')).toBeNull();
    expect(shelf.querySelector('[aria-label="Quick colors"]')).toBeNull();
    expect(
      shelf.querySelector('button[aria-label="Stroke Eraser settings"]'),
    ).toBeNull();
    harness.setSnapshot(eraserSnapshot('ink', 'precision'));
    const precisionShelf = harness.shelf('surface.erase');
    const size = precisionShelf.querySelector('[aria-label="Eraser size"]');
    expect(size?.querySelectorAll('button')).toHaveLength(3);
    const medium = size?.querySelector(
      'button[aria-label="Eraser size slot 2: 12"]',
    );
    if (!(medium instanceof HTMLButtonElement))
      throw new Error('missing selected eraser slot');
    act(() => medium.click());
    expect(
      document.body.querySelector(
        '[role="dialog"][aria-label="Edit size slot 2"]',
      ),
    ).not.toBeNull();
  });

  it('keeps notebook shelf parity with ink modulo prefix', () => {
    const harness = mount(writeSnapshot('notebook', 'pen'), {
      kindId: 'froglight.notebook',
    });
    const shelf = harness.shelf();
    for (const name of ['Ball Pen', 'Fountain Pen', 'Brush Pen', 'Pencil']) {
      expect(
        shelf.querySelector(`button[aria-label="${name}"]`),
      ).not.toBeNull();
    }
    expect(
      shelf.querySelector('[aria-label="Favorite styles"]'),
    ).not.toBeNull();
    expect(shelf.querySelector('[aria-label="Quick widths"]')).not.toBeNull();
    expect(shelf.querySelector('[aria-label="Quick colors"]')).not.toBeNull();
    const width = slotTrigger(shelf, 'Quick widths', 'size', 2);
    act(() => width.click());
    expect(harness.calls).toEqual([['notebook.settings.pen.size', '6']]);
  });

  it('survives active, favorites, and settings in compact with explicit overflow', () => {
    const harness = mount(writeSnapshot('ink', 'pen'), { compact: true });
    const shelf = harness.shelf();
    // Survivors inline.
    expect(
      shelf.querySelector(':scope > div button[aria-label="Ball Pen"]'),
    ).not.toBeNull();
    expect(
      shelf.querySelector(':scope > [aria-label="Favorite styles"]'),
    ).not.toBeNull();
    expect(
      shelf.querySelector(':scope > button[aria-label="Ball Pen settings"]'),
    ).toBeNull();
    // Widths/colors overflow explicitly (no invisible scroll reliance).
    expect(
      shelf.querySelector(':scope > [aria-label="Quick widths"]'),
    ).toBeNull();
    expect(
      shelf.querySelector(':scope > [aria-label="Quick colors"]'),
    ).toBeNull();
    const more = shelf.querySelector('button[aria-label="More tools"]');
    if (!(more instanceof HTMLButtonElement)) throw new Error('missing More');
    // Disclosure group (heterogeneous quick controls, not menuitems), so no
    // menu popup semantics — just labelled expansion.
    expect(more.getAttribute('aria-haspopup')).toBeNull();
    expect(more.getAttribute('aria-expanded')).toBe('false');
    act(() => more.click());
    const menu = shelf.querySelector('[role="group"][aria-label="More tools"]');
    if (!(menu instanceof HTMLElement)) throw new Error('missing More menu');
    expect(menu.querySelector('[aria-label="Quick widths"]')).not.toBeNull();
    expect(menu.querySelector('[aria-label="Quick colors"]')).not.toBeNull();
    const thick = slotTrigger(menu, 'Quick widths', 'size', 2);
    act(() => thick.click());
    expect(harness.calls).toEqual([['ink.settings.pen.size', '6']]);
    // Overflow closes after acting.
    expect(
      shelf.querySelector('[role="group"][aria-label="More tools"]'),
    ).toBeNull();
  });

  it('pins a late active tool first in compact overflow', () => {
    const harness = mount(writeSnapshot('ink', 'highlighter'), {
      compact: true,
    });
    const shelf = harness.shelf('surface.highlighter');
    expect(
      shelf.querySelector(':scope > div button[aria-label="Highlighter"]'),
    ).not.toBeNull();
    expect(
      shelf.querySelector('button[aria-label="Highlighter settings"]'),
    ).toBeNull();
  });

  describe('shelf slot app wiring', () => {
    function editDialog(): HTMLElement | null {
      return host!.querySelector('[data-slot-edit-kind]');
    }

    it('selects a size slot on single-click without opening the modal', () => {
      const harness = mount(writeSnapshot('ink', 'pen'));
      const shelf = harness.shelf();
      // Slot identity markers are in the DOM.
      const row = shelf.querySelector('[data-slot-kind="size"]');
      if (!(row instanceof HTMLElement)) throw new Error('missing size slots');
      expect(shelf.querySelector('[data-slot-kind="color"]')).not.toBeNull();
      const first = slotTrigger(shelf, 'Quick widths', 'size', 0);
      expect(first.getAttribute('data-slot-family')).toBe('pen');
      expect(first.getAttribute('data-slot-index')).toBe('0');
      act(() => first.click());
      expect(harness.calls).toEqual([['ink.settings.pen.size', '2']]);
      expect(editDialog()).toBeNull();
    });

    it('tapping the active size opens a live editor scoped to that slot', () => {
      const harness = mount(writeSnapshot('ink', 'pen'));
      act(() =>
        slotTrigger(harness.shelf(), 'Quick widths', 'size', 1).click(),
      );
      const panel = editDialog();
      if (panel === null) throw new Error('missing size editor');
      expect(panel.getAttribute('data-slot-edit-kind')).toBe('size');
      expect(panel.getAttribute('data-slot-edit-index')).toBe('1');
      expect(panel.getAttribute('data-slot-family')).toBe('pen');
      const input = panel.querySelector<HTMLInputElement>(
        'input[aria-label="Slot width in points"]',
      );
      if (input === null) throw new Error('missing width input');
      expect(input.value).toBe('3.5');
      act(() => setSlotInputValue(input, '4.5'));
      // Editing the active preset updates the tool immediately.
      expect(harness.calls).toEqual([['ink.settings.pen.size', '4.5']]);
      expect(editDialog()).not.toBeNull();
      // The edited slot selects its new value; the sibling is untouched.
      act(() =>
        slotTrigger(harness.shelf(), 'Quick widths', 'size', 0).click(),
      );
      act(() =>
        slotTrigger(harness.shelf(), 'Quick widths', 'size', 1).click(),
      );
      expect(harness.calls).toEqual([
        ['ink.settings.pen.size', '4.5'],
        ['ink.settings.pen.size', '2'],
        ['ink.settings.pen.size', '4.5'],
      ]);
    });

    it('tapping the active color opens a live editor scoped to that slot', () => {
      const harness = mount(writeSnapshot('ink', 'pen'));
      act(() =>
        slotTrigger(harness.shelf(), 'Quick colors', 'color', 0).click(),
      );
      const panel = editDialog();
      if (panel === null) throw new Error('missing color editor');
      expect(panel.getAttribute('data-slot-edit-kind')).toBe('color');
      expect(panel.getAttribute('data-slot-family')).toBe('pen');
      const dot = panel.querySelector<HTMLButtonElement>(
        'button[aria-label="Color: #448361"]',
      );
      if (dot === null) throw new Error('missing quick swatch');
      act(() => dot.click());
      expect(harness.calls).toEqual([['ink.settings.pen.color', '#448361']]);
      expect(editDialog()).not.toBeNull();
      act(() =>
        slotTrigger(harness.shelf(), 'Quick colors', 'color', 1).click(),
      );
      act(() =>
        slotTrigger(harness.shelf(), 'Quick colors', 'color', 0).click(),
      );
      expect(harness.calls).toEqual([
        ['ink.settings.pen.color', '#448361'],
        ['ink.settings.pen.color', '#7c6cf0'],
        ['ink.settings.pen.color', '#448361'],
      ]);
    });

    it('never opens the value modal from pen tool slots', () => {
      const harness = mount(writeSnapshot('ink', 'pen'));
      const pen = harness
        .shelf()
        .querySelector('button[aria-label="Ball Pen"]');
      if (!(pen instanceof HTMLButtonElement)) throw new Error('missing pen');
      doubleClickSlot(pen);
      expect(editDialog()).toBeNull();
    });

    it('switching pen↔highlighter swaps the slot triples', () => {
      const harness = mount(writeSnapshot('ink', 'pen'));
      // Pen factory triple.
      act(() =>
        slotTrigger(harness.shelf(), 'Quick widths', 'size', 2).click(),
      );
      expect(harness.calls.at(-1)).toEqual(['ink.settings.pen.size', '6']);
      // Highlighter: independent triple (8/14/20) with the marker-yellow
      // lead dot at marker translucency.
      harness.setSnapshot(writeSnapshot('ink', 'highlighter'));
      const shelf = harness.shelf('surface.highlighter');
      const dot = slotTrigger(shelf, 'Quick colors', 'color', 0);
      expect(dot.getAttribute('data-slot-family')).toBe('highlighter');
      const glyph = dot.querySelector<HTMLElement>('[aria-hidden="true"]');
      if (glyph === null) throw new Error('missing color glyph');
      expect(glyph.style.opacity).toBe('0.35');
      act(() => slotTrigger(shelf, 'Quick widths', 'size', 2).click());
      act(() => dot.click());
      expect(harness.calls.slice(-2)).toEqual([
        ['ink.settings.highlighter.size', '20'],
        ['ink.settings.highlighter.color', '#ffd54f'],
      ]);
      // Pen-family switch keeps the shared set.
      harness.setSnapshot(writeSnapshot('ink', 'fountain'));
      act(() =>
        slotTrigger(harness.shelf(), 'Quick widths', 'size', 2).click(),
      );
      expect(harness.calls.at(-1)).toEqual(['ink.settings.fountain.size', '6']);
    });
  });
  describe('overflow menu dismissal', () => {
    function openShelfMore(): {
      shelf: HTMLElement;
      trigger: HTMLButtonElement;
    } {
      // Compact Write shelf: widths/colors overflow into More tools.
      const harness = mount(writeSnapshot('ink', 'pen'), { compact: true });
      const shelf = harness.shelf();
      const trigger = shelf.querySelector('button[aria-label="More tools"]');
      if (!(trigger instanceof HTMLButtonElement))
        throw new Error('missing More tools trigger');
      act(() => trigger.click());
      const menu = shelf.querySelector(
        '[role="group"][aria-label="More tools"]',
      );
      if (menu === null) throw new Error('More tools menu did not open');
      return { shelf, trigger };
    }

    function pressEscape(target: Element): void {
      act(() => {
        target.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });
    }

    function pointerOutside(): void {
      act(() => {
        document.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true }),
        );
      });
    }

    it('closes the shelf More menu on trigger Escape and returns focus', () => {
      const { shelf, trigger } = openShelfMore();
      act(() => trigger.focus());
      pressEscape(trigger);
      expect(
        shelf.querySelector('[role="group"][aria-label="More tools"]'),
      ).toBeNull();
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(trigger);
    });

    it('closes the shelf More menu on menu-level Escape and returns focus', () => {
      const { shelf, trigger } = openShelfMore();
      const menuItem = shelf.querySelector(
        '[role="group"][aria-label="More tools"] button',
      );
      if (!(menuItem instanceof HTMLButtonElement))
        throw new Error('missing menu item');
      act(() => menuItem.focus());
      pressEscape(menuItem);
      expect(
        shelf.querySelector('[role="group"][aria-label="More tools"]'),
      ).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });

    it('dismisses the shelf More menu on outside pointerdown', () => {
      const { shelf } = openShelfMore();
      pointerOutside();
      expect(
        shelf.querySelector('[role="group"][aria-label="More tools"]'),
      ).toBeNull();
    });

    function openCategoryMore(): {
      strip: HTMLElement;
      trigger: HTMLButtonElement;
    } {
      // Compact category strip: five surface categories overflow. The Write
      // snapshot alone resolves only Write/Erase, so extend it with one
      // control per remaining category to force the overflow.
      const extra = (
        id: string,
        label: string,
        role: string,
      ): DocumentToolControl => ({
        kind: 'button',
        id,
        group: 'draw',
        label,
        shortLabel: label,
        role: 'surface-tool',
        toolId: id,
        semanticRole: role,
        active: false,
      });
      const base = writeSnapshot('ink', 'pen');
      const snapshot: DocumentToolSnapshot = {
        context: base.context,
        controls: [
          ...base.controls,
          extra('ink.tool.select', 'Select', 'surface.select'),
          extra('ink.tool.line', 'Line', 'surface.shape.line'),
          extra('ink.tool.text', 'Text', 'surface.insert.text'),
        ],
      };
      const harness = mount(snapshot, {
        compact: true,
        view: 'strip',
      });
      const strip = harness.strip();
      const trigger = strip.querySelector(
        'button[aria-label="More tool categories"]',
      );
      if (!(trigger instanceof HTMLButtonElement))
        throw new Error('missing category overflow trigger');
      act(() => trigger.click());
      const menu = strip.querySelector(
        '[role="menu"][aria-label="More tool categories"]',
      );
      if (menu === null) throw new Error('category menu did not open');
      return { strip, trigger };
    }

    it('closes the category menu on trigger Escape and returns focus', () => {
      const { strip, trigger } = openCategoryMore();
      act(() => trigger.focus());
      pressEscape(trigger);
      expect(
        strip.querySelector('[role="menu"][aria-label="More tool categories"]'),
      ).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });

    it('closes the category menu on menu-level Escape and returns focus', () => {
      const { strip, trigger } = openCategoryMore();
      const menuItem = strip.querySelector(
        '[role="menu"][aria-label="More tool categories"] button',
      );
      if (!(menuItem instanceof HTMLButtonElement))
        throw new Error('missing category menu item');
      act(() => menuItem.focus());
      pressEscape(menuItem);
      expect(
        strip.querySelector('[role="menu"][aria-label="More tool categories"]'),
      ).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });

    it('dismisses the category menu on outside pointerdown', () => {
      const { strip } = openCategoryMore();
      pointerOutside();
      expect(
        strip.querySelector('[role="menu"][aria-label="More tool categories"]'),
      ).toBeNull();
    });
  });
});

describe('selectShelfQuicks', () => {
  function owned(
    prefix: string,
    activeTool: string,
    favoriteCount: number,
  ): OwnedToolbarControl[] {
    return buildActiveToolSettingsControls(
      makeHost(activeTool, favoriteCount),
      { prefix, swatches: [...SWATCHES], widths: [...WIDTHS] },
    ).map(
      (control) =>
        ({
          control,
          owner: { kind: 'provider' },
        }) as OwnedToolbarControl,
    );
  }

  it('derives pen favorites, color, and size without eraser/lasso cells', () => {
    const quicks = selectShelfQuicks(owned('ink', 'pen', 2));
    expect(quicks.favorites.map((style) => style.id)).toEqual(['f1', 'f2']);
    expect(quicks.currentStyleId).toBe('f1');
    expect(quicks.colorControl?.id).toBe('ink.settings.pen.color');
    expect(quicks.sizeControl?.id).toBe('ink.settings.pen.size');
    expect(quicks.eraserModeControl).toBeNull();
    expect(quicks.eraserRadiusControl).toBeNull();
    expect(quicks.lassoModeControl).toBeNull();
  });

  it('bounds favorites to three', () => {
    const quicks = selectShelfQuicks(owned('ink', 'pen', 3));
    expect(quicks.favorites).toHaveLength(3);
  });

  it('omits eraser radius for Stroke without a mode cell or pen cells', () => {
    const quicks = selectShelfQuicks(owned('ink', 'eraser', 0));
    // Mode changes route through the two eraser tools.
    expect(quicks.eraserModeControl).toBeNull();
    expect(quicks.eraserRadiusControl).toBeNull();
    expect(quicks.favorites).toEqual([]);
    expect(quicks.colorControl).toBeNull();
    expect(quicks.sizeControl).toBeNull();
  });

  it('derives lasso mode without pen cells', () => {
    const quicks = selectShelfQuicks(owned('ink', 'lasso', 0));
    expect(quicks.lassoModeControl?.id).toBe('ink.settings.lasso.mode');
    expect(quicks.colorControl).toBeNull();
    expect(quicks.sizeControl).toBeNull();
  });

  it('hides stale lasso settings for Pointer but retains them for Lasso', () => {
    const settings = owned('ink', 'lasso', 0);
    expect(
      shelfSettingsForCategory({
        browsedIsActive: true,
        activeSemanticRole: 'surface.select',
        settingsControls: settings,
      }),
    ).toEqual([]);
    expect(
      shelfSettingsForCategory({
        browsedIsActive: true,
        activeSemanticRole: 'surface.lasso',
        settingsControls: settings,
      }),
    ).toBe(settings);
  });
});
