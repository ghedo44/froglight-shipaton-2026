// @vitest-environment jsdom
/**
 *  responsive / accessibility / polish.
 *
 * Consolidated acceptance pins for the toolbar presentation layer:
 * - responsive matrix: compact touch (iPhone / narrow Split View) keeps the
 *   same hierarchy behind explicit More; medium touch/pointer (iPad) shows
 *   full labels; wide pointer (desktop) stays dense but hover-free;
 * - icon vocabulary: one icon per semantic action, every default category
 *   icon resolves (no invisible icons);
 * - keyboard: focus lands inside opened menus/popovers, Arrow/Home/End
 *   travel, Escape returns focus, outside dismisses;
 * - state sync: shelf quick edits and the settings popover share one
 *   snapshot (no duplicate prefs);
 * - Pencil: pen taps activate through the ordinary click path (no global
 *   pen-as-draw gating in toolbar presentation);
 * - themes: toolbar styles consume tokens only (no hard-coded colors),
 *   focus-visible and reduced-motion honored;
 * - performance: brush previews memoize by stable cache key.
 *
 * Device classes are proxied through the same capability queries production
 * uses (`TOOLBAR_COMPACT_QUERY` + `(pointer: coarse)` /
 * `(any-pointer: coarse)`). Real-device validation (finger/Pencil/squeeze/
 * rotation/Split/Stage) remains manual and is reported in the handoff.
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
import { resolveIconPath } from '../icons.js';
import {
  DEFAULT_TOOLBAR_CATEGORIES,
  defaultToolbarComposition,
} from '../toolbar/default-composition.js';
import type { WorkbenchEditorToolsPort } from '../workbench-ports.js';
import { createDocumentToolbarRegistry } from '../document-toolbar-registry.js';
import {
  createToolbarPlacementRegistry,
  type ToolbarPlacementContribution,
} from '../toolbar/placement-registry.js';
import { createToolbarCompositionRegistry } from '../toolbar/composition-registry.js';
import { getBrushPreviewGeometry } from './brush-preview.jsx';
import { ToolbarPopoverScope } from './toolbar-popover.jsx';
import {
  FloatingToolbarLayer,
  TOOLBAR_COMPACT_QUERY,
  TopbarCenterTools,
} from './UnifiedToolbar.jsx';
import toolbarCss from './UnifiedToolbar.module.css?inline';
import cardsCss from './saved-style-cards.module.css?inline';
import previewCss from './brush-preview.module.css?inline';
import squeezeCss from './StylusPaletteOverlay.module.css?inline';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

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

interface MutablePenState {
  size: number;
}

function makeHost(
  activeTool: string,
  pen: MutablePenState,
): SurfaceToolSettingsHost {
  const styles: SurfaceStylePreset[] = [
    style('f1', 'Daily', true),
    style('f2', 'Fine', true),
    style('p1', 'Draft', false),
  ];
  return {
    activeToolId: () => `ink.${activeTool}`,
    setTool: () => undefined,
    toolPreset: () => ({ color: '#37352f', size: pen.size }),
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
  key: string,
  label: string,
  role: string,
  active: boolean,
): DocumentToolControl {
  return {
    kind: 'button',
    id: `ink.tool.${key}`,
    group: 'draw',
    label,
    shortLabel: label,
    icon: key,
    role: 'surface-tool',
    toolId: `ink.tool.${key}`,
    semanticRole: role,
    active,
  };
}

function eraserButton(active: boolean): DocumentToolControl {
  return {
    kind: 'button',
    id: 'ink.tool.eraser',
    group: 'draw',
    label: 'Eraser',
    shortLabel: 'Eraser',
    icon: 'eraser',
    role: 'surface-tool',
    toolId: 'ink.tool.eraser',
    semanticRole: 'surface.erase',
    active,
  };
}

function writeSnapshot(
  activeKey: string,
  pen: MutablePenState,
  extra: readonly DocumentToolControl[] = [],
): DocumentToolSnapshot {
  const settings = buildActiveToolSettingsControls(makeHost(activeKey, pen), {
    prefix: 'ink',
    swatches: [...SWATCHES],
    widths: [...WIDTHS],
  });
  return {
    context: 'Surface',
    controls: [
      ...WRITE_FAMILY.map((member) =>
        familyButton(
          member.key,
          member.label,
          member.role,
          member.key === activeKey,
        ),
      ),
      eraserButton(activeKey === 'eraser'),
      ...extra,
      ...settings,
    ],
  };
}

const extraCategoryTool = (
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

function fiveCategorySnapshot(pen: MutablePenState): DocumentToolSnapshot {
  return writeSnapshot('pen', pen, [
    extraCategoryTool('ink.tool.select', 'Select', 'surface.select'),
    extraCategoryTool('ink.tool.line', 'Line', 'surface.shape.line'),
    extraCategoryTool('ink.tool.text', 'Text', 'surface.insert.text'),
    // Providers always emit the image control (disabled when insertion
    // is unavailable), so Insert stays live even with Text selected.
    // creation resolves from `surface.text` only.
    extraCategoryTool('ink.image', 'Image', 'surface.insert.image'),
  ]);
}

describe('responsive / accessibility polish', () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    vi.unstubAllGlobals();
  });

  function stubCapabilities(input: {
    readonly compact: boolean;
    readonly coarse: boolean;
    /** Defaults to `coarse` (single-input hosts); hybrid passes false + true. */
    readonly anyCoarse?: boolean;
  }): void {
    const anyCoarse = input.anyCoarse ?? input.coarse;
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches:
        query === TOOLBAR_COMPACT_QUERY
          ? input.compact
          : query === '(pointer: coarse)'
            ? input.coarse
            : query === '(any-pointer: coarse)'
              ? anyCoarse
              : query === '(hover: hover)'
                ? !input.coarse
                : query === '(any-hover: hover)'
                  ? !anyCoarse
                  : false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
  }

  function mount(input: {
    readonly snapshot: DocumentToolSnapshot;
    readonly compact: boolean;
    readonly coarse: boolean;
    readonly anyCoarse?: boolean;
    readonly view?: 'shelf' | 'strip';
    readonly layerProps?: Record<string, unknown>;
    /** Wrap in a real pane popover layer so menus take the production portal path. */
    readonly scope?: boolean;
    /** Extra geometric placements (overflow/island coverage). */
    readonly extraPlacements?: readonly ToolbarPlacementContribution[];
  }): {
    readonly calls: Array<readonly [string, string?]>;
    /**
     * Advance the SAME provider snapshot through the SAME port channel the
     * toolbar already subscribes to (live shared-snapshot proof — never a
     * remount, never a second host or registry set).
     */
    readonly setSnapshot: (next: DocumentToolSnapshot) => void;
  } {
    stubCapabilities(input);
    if (root !== null) {
      act(() => root!.unmount());
      root = null;
    }
    host?.remove();
    const calls: Array<readonly [string, string?]> = [];
    const listeners = new Set<() => void>();
    let current: DocumentToolSnapshot | null = input.snapshot;
    const port: WorkbenchEditorToolsPort = {
      onDidChange: (listener: () => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      execEditorCommand: () => false,
      canExecEditorCommand: () => true,
      editorToolSnapshot: () => current,
      executeEditorTool: (_pane: string, id: string, value?: string) => {
        calls.push(value === undefined ? [id] : [id, value]);
        return true;
      },
    };
    const contributions = createDocumentToolbarRegistry();
    const placements = createToolbarPlacementRegistry();
    for (const placement of input.extraPlacements ?? [])
      placements.registry.register(placement);
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
    const toolbarProps = {
      tools: port,
      contributions: contributions.registry,
      placements: placements.registry,
      composition: composition.registry,
      pane: 'pane-1',
      documentId: 'doc-1',
      kindId: 'froglight.ink',
      ...(input.layerProps ?? {}),
    };
    const toolbar =
      (input.view ?? 'shelf') === 'strip' ? (
        <TopbarCenterTools {...toolbarProps} />
      ) : (
        <FloatingToolbarLayer {...toolbarProps} />
      );
    act(() => {
      root!.render(
        input.scope === true ? (
          <ToolbarPopoverScope>{toolbar}</ToolbarPopoverScope>
        ) : (
          toolbar
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
    };
  }

  function shelf(category = 'surface.write'): HTMLElement {
    const element = host!.querySelector(`[data-tool-shelf="${category}"]`);
    if (!(element instanceof HTMLElement))
      throw new Error(`missing shelf: ${category}`);
    return element;
  }

  function strip(): HTMLElement {
    const element = host!.querySelector('[data-toolbar="category-strip"]');
    if (!(element instanceof HTMLElement))
      throw new Error('missing category strip');
    return element;
  }

  function pressEscape(target: Element): void {
    act(() => {
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
  }

  function pressKey(target: Element, key: string): void {
    act(() => {
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      );
    });
  }

  describe('responsive matrix (same graph, different projection)', () => {
    it('compact touch (iPhone / narrow Split View) keeps hierarchy behind More', () => {
      const pen = { size: 3.5 };
      mount({
        snapshot: fiveCategorySnapshot(pen),
        compact: true,
        coarse: true,
        view: 'strip',
      });
      const categories = strip();
      // First categories stay inline; the rest move behind More.
      expect(
        categories.querySelector('[data-category="surface.write"]'),
      ).not.toBeNull();
      const more = categories.querySelector(
        'button[aria-label="More tool categories"]',
      );
      if (!(more instanceof HTMLButtonElement))
        throw new Error('missing category More');
      expect(more.getAttribute('aria-haspopup')).toBe('menu');
      act(() => more.click());
      expect(
        categories.querySelector(
          '[role="menu"][aria-label="More tool categories"]',
        ) ??
          document.querySelector(
            '[role="menu"][aria-label="More tool categories"]',
          ),
      ).not.toBeNull();

      mount({
        snapshot: writeSnapshot('pen', pen),
        compact: true,
        coarse: true,
        view: 'shelf',
      });
      const tools = shelf();
      expect(
        tools.querySelector('button[aria-label="More tools"]'),
      ).not.toBeNull();
      // Favorites + settings survive inline on compact.
      expect(
        tools.querySelector('[aria-label="Favorite styles"]'),
      ).not.toBeNull();
      expect(
        tools.querySelector('button[aria-label="Ball Pen settings"]'),
      ).toBeNull();
    });

    // At medium touch widths, the strip still fits all five labels without
    // overflow chrome, while the measured shelf partitions by capacity — tools, settings, and
    // favorites stay inline while widths/colors move to explicit More —
    // instead of scroll-hiding settings. The unmeasured first paint still
    // shows all quicks inline until layout reports (show-all projection).
    it('medium touch (iPad) fits the strip, shelves explicitly when measured', () => {
      const pen = { size: 3.5 };
      mount({
        snapshot: fiveCategorySnapshot(pen),
        compact: false,
        coarse: true,
        view: 'strip',
      });
      // six labels (direct Text) fit the strip with no
      // overflow chrome — still a single row, never a second toolbar row.
      for (const name of [
        'Pen',
        'Highlighter',
        'Eraser',
        'Selection',
        'Shapes',
        'Insert',
        'Text',
      ]) {
        expect(strip().querySelector(`[aria-label="${name}"]`)).not.toBeNull();
      }
      expect(
        strip().querySelector('button[aria-label="More tool categories"]'),
      ).toBeNull();

      // Unmeasured first paint: all quicks inline (no measured budget yet).
      mount({
        snapshot: writeSnapshot('pen', pen),
        compact: false,
        coarse: true,
        view: 'shelf',
      });
      expect(
        shelf().querySelector('button[aria-label="More tools"]'),
      ).toBeNull();
      expect(
        shelf().querySelector('[aria-label="Quick widths"]'),
      ).not.toBeNull();
      expect(
        shelf().querySelector('[aria-label="Quick colors"]'),
      ).not.toBeNull();

      // Measured 820px touch pane: compact controls fit inline.
      mount({
        snapshot: writeSnapshot('pen', pen),
        compact: false,
        coarse: true,
        view: 'shelf',
        layerProps: { paneWidth: 820 },
      });
      const tools = shelf();
      expect(tools.querySelector('button[aria-label="More tools"]')).toBeNull();
      expect(
        tools.querySelector('button[aria-label="Ball Pen settings"]'),
      ).toBeNull();
      expect(
        tools.querySelector('[aria-label="Favorite styles"]'),
      ).not.toBeNull();
      expect(
        tools.querySelector(':scope > [aria-label="Quick widths"]'),
      ).not.toBeNull();
      expect(
        tools.querySelector(':scope > [aria-label="Quick colors"]'),
      ).not.toBeNull();
    });

    it('wide pointer (desktop) activates without any hover', () => {
      const pen = { size: 3.5 };
      const { calls } = mount({
        snapshot: writeSnapshot('pen', pen),
        compact: false,
        coarse: false,
        view: 'shelf',
      });
      // No mouseover/hover of any kind: straight to activation.
      const fountain = shelf().querySelector(
        'button[aria-label="Fountain Pen"]',
      );
      if (!(fountain instanceof HTMLButtonElement))
        throw new Error('missing Fountain Pen');
      // Hover remains supplemental (tooltip) but is never required.
      expect(fountain.getAttribute('title')).toBe('Fountain Pen');
      act(() => fountain.click());
      expect(calls).toEqual([['ink.tool.fountain']]);
    });

    // This is a true hybrid stub: fine primary pointer with touch available.
    // Hybrid hosts keep full strip labels (categories fit touch sizes too)
    // while resolving touch
    // density underneath (pinned in toolbar-touch-medium.spec.tsx).
    it('medium pointer (iPad + trackpad) keeps full labels like wide', () => {
      const pen = { size: 3.5 };
      mount({
        snapshot: fiveCategorySnapshot(pen),
        compact: false,
        coarse: false,
        anyCoarse: true,
        view: 'strip',
      });
      expect(
        strip().querySelector('button[aria-label="More tool categories"]'),
      ).toBeNull();
      expect(strip().querySelector('[aria-label="Shapes"]')).not.toBeNull();
    });

    it('Text-active compact keeps Text inline (not Insert) with the active marker', () => {
      // alias: the canonical Text home (not Insert-first)
      // wins the compact active-inclusion slot when Text is active.
      const pen = { size: 3.5 };
      const base = fiveCategorySnapshot(pen);
      const textActive: DocumentToolSnapshot = {
        context: base.context,
        controls: base.controls.map((control) =>
          control.kind === 'button' &&
          control.semanticRole === 'surface.insert.text'
            ? { ...control, active: true }
            : { ...control, active: false },
        ),
      };
      mount({
        snapshot: textActive,
        compact: true,
        coarse: true,
        view: 'strip',
      });
      const categories = strip();
      // Text stays inline with the active marker; Insert never steals it.
      const textButton = categories.querySelector(
        '[data-category="surface.text"]',
      );
      expect(textButton).not.toBeNull();
      expect(textButton?.getAttribute('data-contains-active-tool')).toBe(
        'true',
      );
      expect(
        categories.querySelector(
          '[data-category="surface.insert"][data-contains-active-tool="true"]',
        ),
      ).toBeNull();
      const more = categories.querySelector(
        'button[aria-label="More tool categories"]',
      );
      if (!(more instanceof HTMLButtonElement))
        throw new Error('missing category More');
      act(() => more.click());
      const menu =
        categories.querySelector(
          '[role="menu"][aria-label="More tool categories"]',
        ) ??
        document.querySelector(
          '[role="menu"][aria-label="More tool categories"]',
        );
      if (!(menu instanceof HTMLElement))
        throw new Error('category More menu did not open');
      expect(
        menu.querySelector('[data-contains-active-tool="true"]'),
      ).toBeNull();
      expect(menu.textContent).toContain('Insert');
    });
  });

  describe('shared icon vocabulary', () => {
    it('resolves every default category icon (no invisible icons)', () => {
      for (const category of DEFAULT_TOOLBAR_CATEGORIES) {
        expect(
          resolveIconPath(category.icon),
          `category ${category.id} icon '${category.icon}'`,
        ).toBeDefined();
      }
    });

    it('pins the writing Structure icon to the registered vocabulary', () => {
      const structure = DEFAULT_TOOLBAR_CATEGORIES.find(
        (category) => category.id === 'writing.structure',
      );
      expect(structure?.icon).toBe('list-tree');
      expect(resolveIconPath('list-tree')).toBeDefined();
    });

    it('shares one icon per semantic action across families', () => {
      for (const name of [
        'pen',
        'fountain',
        'brush',
        'pencil',
        'highlighter',
        'eraser',
        'lasso',
        'shapes',
        'plus',
        'bold',
        'italic',
        'link',
        'undo',
        'redo',
        'type',
        'pages',
      ]) {
        expect(resolveIconPath(name), `icon '${name}'`).toBeDefined();
      }
    });

    it('keeps the pen family visually distinct (no shared pen alias)', () => {
      const paths = ['pen', 'fountain', 'brush', 'pencil', 'highlighter'].map(
        (name) => resolveIconPath(name),
      );
      expect(new Set(paths).size).toBe(5);
    });
  });

  describe('keyboard and focus', () => {
    it('lands focus inside the shelf More group on open and travels with arrows', () => {
      const pen = { size: 3.5 };
      mount({
        snapshot: writeSnapshot('pen', pen),
        compact: true,
        coarse: true,
      });
      const tools = shelf();
      const trigger = tools.querySelector('button[aria-label="More tools"]');
      if (!(trigger instanceof HTMLButtonElement))
        throw new Error('missing More tools');
      act(() => trigger.click());
      const menu = document.querySelector(
        '[role="group"][aria-label="More tools"]',
      ) as HTMLElement | null;
      if (menu === null) throw new Error('More tools group did not open');
      expect(menu.contains(document.activeElement)).toBe(true);
      const first = document.activeElement as HTMLButtonElement;
      pressKey(first, 'ArrowDown');
      expect(document.activeElement).not.toBe(first);
      expect(menu.contains(document.activeElement)).toBe(true);
      pressKey(document.activeElement!, 'End');
      const buttons = Array.from(
        menu.querySelectorAll('button:not(:disabled)'),
      );
      expect(document.activeElement).toBe(buttons[buttons.length - 1]);
      pressKey(document.activeElement!, 'Home');
      expect(document.activeElement).toBe(buttons[0]);
    });

    it('opens the shelf More group with ArrowDown and returns focus on Escape', () => {
      const pen = { size: 3.5 };
      mount({
        snapshot: writeSnapshot('pen', pen),
        compact: true,
        coarse: true,
      });
      const tools = shelf();
      const trigger = tools.querySelector('button[aria-label="More tools"]');
      if (!(trigger instanceof HTMLButtonElement))
        throw new Error('missing More tools');
      act(() => trigger.focus());
      pressKey(trigger, 'ArrowDown');
      expect(
        document.querySelector('[role="group"][aria-label="More tools"]'),
      ).not.toBeNull();
      pressEscape(document.activeElement ?? trigger);
      expect(
        document.querySelector('[role="group"][aria-label="More tools"]'),
      ).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });

    it('keeps true menu semantics for the homogeneous category overflow', () => {
      const pen = { size: 3.5 };
      mount({
        snapshot: fiveCategorySnapshot(pen),
        compact: true,
        coarse: true,
        view: 'strip',
      });
      const trigger = strip().querySelector(
        'button[aria-label="More tool categories"]',
      );
      if (!(trigger instanceof HTMLButtonElement))
        throw new Error('missing category More');
      act(() => trigger.click());
      const menu = document.querySelector(
        '[role="menu"][aria-label="More tool categories"]',
      );
      if (!(menu instanceof HTMLElement)) throw new Error('menu did not open');
      // Homogeneous menuitems (unlike the heterogeneous tool groups).
      const items = menu.querySelectorAll('[role="menuitem"]');
      expect(items.length).toBeGreaterThan(0);
      expect(menu.contains(document.activeElement)).toBe(true);
      pressEscape(menu);
      expect(
        document.querySelector(
          '[role="menu"][aria-label="More tool categories"]',
        ),
      ).toBeNull();
    });

    it('lands focus inside the tool settings popover on second tap', () => {
      const pen = { size: 3.5 };
      mount({
        snapshot: writeSnapshot('pen', pen),
        compact: false,
        coarse: true,
      });
      const tool = shelf().querySelector('button[aria-label="Ball Pen"]');
      if (!(tool instanceof HTMLButtonElement))
        throw new Error('missing Ball Pen');
      act(() => tool.click());
      const dialog = document.querySelector(
        '[role="dialog"][aria-label="Ball Pen settings"]',
      );
      if (!(dialog instanceof HTMLElement))
        throw new Error('settings did not open');
      expect(dialog.contains(document.activeElement)).toBe(true);
      pressEscape(dialog);
      expect(
        document.querySelector(
          '[role="dialog"][aria-label="Ball Pen settings"]',
        ),
      ).toBeNull();
      expect(document.activeElement).toBe(tool);
    });
  });

  describe('state sync (one snapshot, no duplicate prefs)', () => {
    it('reflects a shelf quick-width edit in the settings popover readout', () => {
      const pen = { size: 3.5 };
      const { calls, setSnapshot } = mount({
        snapshot: writeSnapshot('pen', pen),
        compact: false,
        coarse: true,
      });
      // Size quicks are store-driven slot rows: the third slot
      // carries the 6pt width of the pen-family factory triple.
      const widthSlots = [
        ...shelf().querySelectorAll(
          '[aria-label="Quick widths"] button[data-slot-kind="size"]:not([data-empty-slot])',
        ),
      ];
      const thick = widthSlots[2];
      if (!(thick instanceof HTMLButtonElement))
        throw new Error('missing quick width');
      act(() => thick.click());
      // The shelf routes through the shared owner channel (not a copy).
      expect(calls).toEqual([['ink.settings.pen.size', '6']]);
      // The provider applies that edit into the SAME snapshot the toolbar
      // already subscribes to — advance it live, without remounting and
      // without a second host, port, or registry set.
      pen.size = 6;
      setSnapshot(writeSnapshot('pen', pen));
      const tool = shelf().querySelector('button[aria-label="Ball Pen"]');
      if (!(tool instanceof HTMLButtonElement))
        throw new Error('missing Ball Pen');
      act(() => tool.click());
      const dialog = document.querySelector(
        '[role="dialog"][aria-label="Ball Pen settings"]',
      );
      if (!(dialog instanceof HTMLElement))
        throw new Error('settings did not open');
      expect(dialog.textContent).toContain('6 pt');
    });
  });

  describe('overflow production path (portal hit-testing)', () => {
    it('portals the shelf More group into the pane layer', () => {
      const pen = { size: 3.5 };
      mount({
        snapshot: writeSnapshot('pen', pen),
        compact: true,
        coarse: true,
        scope: true,
      });
      const trigger = shelf().querySelector('button[aria-label="More tools"]');
      if (!(trigger instanceof HTMLButtonElement))
        throw new Error('missing More tools');
      act(() => trigger.click());
      // Production path (not the layer-less test fallback): the menu lives
      // inside the pane popover layer, where the stylesheet re-enables
      // pointer events (the layer itself stays transparent so canvas
      // gestures pass through everywhere else).
      const menu = host!.querySelector(
        '[data-popover-layer] [role="group"][aria-label="More tools"]',
      );
      expect(menu).not.toBeNull();
    });

    it('lets portaled inline menus receive pointer events in the pane layer', () => {
      const clean = toolbarCss.replace(/\/\*[\s\S]*?\*\//g, '');
      expect(clean).toMatch(
        /\[data-popover-layer\]\s*\.[A-Za-z0-9_-]*inline-menu[A-Za-z0-9_-]*\s*\{[^}]*pointer-events:\s*auto/,
      );
    });
  });

  describe('overflow native controls (no arrow hijack)', () => {
    it('preserves native arrow behavior inside overflow selects', () => {
      mount({
        snapshot: {
          context: 'Surface',
          controls: [
            { kind: 'button', id: 'k.keep', group: 'keep', label: 'Keep' },
            {
              kind: 'choice',
              id: 'k.pick',
              group: 'pick',
              label: 'Pick',
              value: 'a',
              options: [
                { value: 'a', label: 'A' },
                { value: 'b', label: 'B' },
              ],
            },
          ],
        },
        compact: false,
        coarse: false,
        extraPlacements: [
          {
            id: 'k.high',
            anchor: 'float.top-center',
            order: 1,
            controlIds: ['k.keep'],
            priority: 100,
            compact: 'auto',
          },
          {
            id: 'k.low',
            anchor: 'float.top-center',
            order: 2,
            controlIds: ['k.pick'],
            priority: 1,
            compact: 'auto',
          },
        ],
        layerProps: {
          availableWidth: 10,
          measuredWidths: { 'k.high': 100, 'k.low': 100 },
        },
      });
      const trigger = host!.querySelector(
        'button[aria-label="More top center tools"]',
      );
      if (!(trigger instanceof HTMLButtonElement))
        throw new Error('missing overflow trigger');
      act(() => trigger.click());
      const menu = document.querySelector(
        '[role="group"][aria-label="More top center tools"]',
      );
      if (!(menu instanceof HTMLElement))
        throw new Error('overflow group did not open');
      const select = menu.querySelector('select[aria-label="Pick"]');
      if (!(select instanceof HTMLSelectElement))
        throw new Error('missing overflow select');
      act(() => select.focus());
      // Roving must ignore select-originated arrows: focus stays put so the
      // native control keeps option travel instead of jumping to a button.
      pressKey(select, 'ArrowDown');
      expect(document.activeElement).toBe(select);
      pressKey(select, 'Home');
      expect(document.activeElement).toBe(select);
    });
  });

  describe('Pencil operability (no global pen-as-draw)', () => {
    it('activates shelf tools through pen taps on the ordinary click path', () => {
      const pen = { size: 3.5 };
      const { calls } = mount({
        snapshot: writeSnapshot('pen', pen),
        compact: false,
        coarse: true,
      });
      const pencil = shelf().querySelector('button[aria-label="Pencil"]');
      if (!(pencil instanceof HTMLButtonElement))
        throw new Error('missing Pencil');
      act(() => {
        pencil.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            pointerType: 'pen',
          }),
        );
        pencil.click();
      });
      expect(calls).toEqual([['ink.tool.pencil']]);
    });
  });

  describe('themes and tokens', () => {
    it('consumes tokens only: no hard-coded colors in toolbar styles', () => {
      for (const [name, css] of [
        ['toolbar', toolbarCss],
        ['cards', cardsCss],
        ['preview', previewCss],
        ['squeeze', squeezeCss],
      ] as const) {
        const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
        expect(clean, `${name} styles`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      }
    });

    it('keeps visible keyboard focus and reduced-motion handling everywhere', () => {
      for (const [name, css] of [
        ['toolbar', toolbarCss],
        ['cards', cardsCss],
        ['squeeze', squeezeCss],
      ] as const) {
        expect(css, `${name} focus`).toMatch(/:focus-visible/);
        expect(css, `${name} motion`).toMatch(
          /prefers-reduced-motion:\s*reduce/,
        );
      }
    });
  });

  describe('performance (previews memoized)', () => {
    it('returns identical preview geometry for identical style inputs', () => {
      const first = getBrushPreviewGeometry({
        toolKind: 'fountain',
        preset: { color: '#37352f', size: 3.5 },
      });
      const second = getBrushPreviewGeometry({
        toolKind: 'fountain',
        preset: { color: '#37352f', size: 3.5 },
      });
      expect(second).toBe(first);
      const other = getBrushPreviewGeometry({
        toolKind: 'fountain',
        preset: { color: '#37352f', size: 6 },
      });
      expect(other).not.toBe(first);
    });
  });
});
