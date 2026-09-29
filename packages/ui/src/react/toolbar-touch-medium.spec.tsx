// @vitest-environment jsdom
/**
 *  Covers touch capability and explicit overflow at medium widths.
 *
 * Touch and pointer hosts share compact visual geometry. Input capability
 * remains independent of pane width.
 *
 * At medium pane widths the composition shelf partitions by measured
 * pane capacity through the shared planner (priority: active tool >
 * family tools > settings disclosure > favorites > widths/colors > modes)
 * into inline + explicit More. The settings disclosure is required inline
 * (never scroll-hidden); one observer per pane; hysteresis settles dither.
 *
 * Real-device finger/Pencil validation remains NOT VERIFIED (physical iPad
 * gate); headless-Chromium geometry lives in
 * `apps/web/tests/toolbar-touch-medium.spec.ts`.
 */

import { act } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DocumentToolControl,
  DocumentToolSnapshot,
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
import { planShelfCells } from '../toolbar/placement-resolver.js';
import {
  currentInteractionCapabilities,
  type WorkspaceInteractionCapabilities,
} from './workspace/interaction-policy.js';
import {
  autoOverflowWidth,
  estimateShelfCells,
  estimateShelfQuickBudgets,
  FloatingToolbarLayer,
  resolveToolbarPanePresentation,
  shelfCapacityBudget,
  TOOLBAR_COMPACT_QUERY,
  TopbarCenterTools,
} from './UnifiedToolbar.jsx';

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

function capabilities(
  overrides: Partial<WorkspaceInteractionCapabilities> & {
    readonly pointer: WorkspaceInteractionCapabilities['pointer'];
  },
): WorkspaceInteractionCapabilities {
  return {
    coarse: false,
    supportsHover: true,
    anyCoarse: false,
    anyHover: true,
    ...overrides,
  };
}

const FINE_ONLY = capabilities({ pointer: 'mouse' });
const COARSE_ONLY = capabilities({
  pointer: 'touch',
  coarse: true,
  supportsHover: false,
  anyCoarse: true,
  anyHover: false,
});
// iPad + trackpad / touchscreen laptop: fine primary, touch available.
const HYBRID = capabilities({
  pointer: 'mouse',
  coarse: true,
  anyCoarse: true,
});
const PEN = capabilities({ pointer: 'pen' });
// Pen + touch hybrid (iPad Pencil + finger): precise primary, touch available.
const PEN_TOUCH = capabilities({
  pointer: 'pen',
  coarse: true,
  anyCoarse: true,
});

function stylePreset(id: string, name: string, favorite: boolean) {
  return {
    id,
    name,
    toolKind: 'pen',
    preset: { color: '#37352f', size: 3.5 },
    favorite,
    order: 0,
  } as const;
}

function makeHost(
  activeTool: string,
  pen: { size: number },
): SurfaceToolSettingsHost {
  const styles = [
    stylePreset('f1', 'Daily', true),
    stylePreset('f2', 'Fine', true),
    stylePreset('p1', 'Draft', false),
  ];
  return {
    activeToolId: () => `ink.${activeTool}`,
    setTool: () => undefined,
    toolPreset: () => ({ color: '#37352f', size: pen.size }),
    setToolPreset: () => undefined,
    savedStyles: (tool) => (tool === 'pen' ? [...styles] : []),
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
    icon: key,
    group: 'draw',
    label,
    shortLabel: label,
    role: 'surface-tool',
    toolId: `ink.tool.${key}`,
    semanticRole: role,
    active,
  };
}

function writeSnapshot(
  activeKey: string,
  pen: { size: number },
  extra: readonly DocumentToolControl[] = [],
): DocumentToolSnapshot {
  const settings = buildActiveToolSettingsControls(makeHost(activeKey, pen), {
    prefix: 'ink',
    swatches: [...SWATCHES],
    widths: [...WIDTHS],
  });
  // Eraser modes: eraser-active snapshots carry two
  // fixed-mode tools providers emit — no `surface.settings.eraser-mode`
  // role, so the mode quick stays dormant. Every other snapshot keeps the
  // legacy single eraser (those tests never assert eraser identity).
  const eraserTools: DocumentToolControl[] =
    activeKey === 'eraser'
      ? [
          {
            kind: 'button',
            id: 'ink.tool.eraser-stroke',
            icon: 'eraser',
            group: 'draw',
            label: 'Stroke Eraser',
            shortLabel: 'Stroke Eraser',
            role: 'surface-tool',
            toolId: 'ink.tool.eraser-stroke',
            semanticRole: 'surface.erase.stroke',
            active: true,
          },
          {
            kind: 'button',
            id: 'ink.tool.eraser-precision',
            icon: 'eraser',
            group: 'draw',
            label: 'Precision Eraser',
            shortLabel: 'Precision Eraser',
            role: 'surface-tool',
            toolId: 'ink.tool.eraser-precision',
            semanticRole: 'surface.erase.precision',
            active: false,
          },
        ]
      : [
          {
            kind: 'button',
            id: 'ink.tool.eraser',
            icon: 'eraser',
            group: 'draw',
            label: 'Eraser',
            shortLabel: 'Eraser',
            role: 'surface-tool',
            toolId: 'ink.tool.eraser',
            semanticRole: 'surface.erase',
            active: false,
          },
        ];
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
      ...eraserTools,
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

function fiveCategorySnapshot(pen: { size: number }): DocumentToolSnapshot {
  return writeSnapshot('pen', pen, [
    extraCategoryTool('ink.tool.select', 'Select', 'surface.select'),
    extraCategoryTool('ink.tool.line', 'Line', 'surface.shape.line'),
    extraCategoryTool('ink.tool.text', 'Text', 'surface.insert.text'),
  ]);
}

describe('touch capability (not primary-only)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubCapabilities(input: {
    readonly compact: boolean;
    readonly coarse: boolean;
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

  it('keeps touch density for hybrid, coarse-only, and pen-touch; dense for fine-only and pen', () => {
    for (const width of [320, 500, 768, 820, 834, 1024, 1400]) {
      expect(
        resolveToolbarPanePresentation({ width, capabilities: HYBRID }).density,
        `hybrid@${width}`,
      ).toBe('touch');
      expect(
        resolveToolbarPanePresentation({ width, capabilities: COARSE_ONLY })
          .density,
        `coarse@${width}`,
      ).toBe('touch');
      expect(
        resolveToolbarPanePresentation({ width, capabilities: PEN_TOUCH })
          .density,
        `pen-touch@${width}`,
      ).toBe('touch');
      expect(
        resolveToolbarPanePresentation({ width, capabilities: FINE_ONLY })
          .density,
        `fine@${width}`,
      ).toBe('compact');
      // Pen reports through the ordinary fine path (no device sniffing).
      expect(
        resolveToolbarPanePresentation({ width, capabilities: PEN }).density,
        `pen@${width}`,
      ).toBe('compact');
    }
  });

  it('derives capability touch availability from any-pointer', () => {
    stubCapabilities({ compact: false, coarse: false, anyCoarse: true });
    expect(currentInteractionCapabilities()).toMatchObject({
      pointer: 'mouse',
      coarse: true,
      anyCoarse: true,
    });
    stubCapabilities({ compact: false, coarse: false, anyCoarse: false });
    expect(currentInteractionCapabilities()).toMatchObject({
      pointer: 'mouse',
      coarse: false,
      anyCoarse: false,
    });
  });

  it('keeps the compact trigger reserve on hybrid hosts', () => {
    stubCapabilities({ compact: false, coarse: false, anyCoarse: true });
    expect(autoOverflowWidth()).toBe(30);
    stubCapabilities({ compact: false, coarse: false, anyCoarse: false });
    expect(autoOverflowWidth()).toBe(30);
    stubCapabilities({ compact: false, coarse: true });
    expect(autoOverflowWidth()).toBe(30);
    expect(autoOverflowWidth(true)).toBe(30);
    expect(autoOverflowWidth(false)).toBe(30);
  });
});

describe('medium explicit overflow', () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    vi.unstubAllGlobals();
  });

  function stubWindow(input: {
    readonly compact: boolean;
    readonly coarse: boolean;
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
    readonly paneWidth?: number;
  }): void {
    stubWindow(input);
    if (root !== null) {
      act(() => root!.unmount());
      root = null;
    }
    host?.remove();
    const listeners = new Set<() => void>();
    const current: DocumentToolSnapshot | null = input.snapshot;
    const port: WorkbenchEditorToolsPort = {
      onDidChange: (listener: () => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      execEditorCommand: () => false,
      canExecEditorCommand: () => true,
      editorToolSnapshot: () => current,
      executeEditorTool: () => true,
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
    const toolbarProps = {
      tools: port,
      contributions: contributions.registry,
      placements: placements.registry,
      composition: composition.registry,
      pane: 'pane-1',
      documentId: 'doc-1',
      kindId: 'froglight.ink',
      ...(input.paneWidth !== undefined ? { paneWidth: input.paneWidth } : {}),
    };
    const toolbar =
      (input.view ?? 'shelf') === 'strip' ? (
        <TopbarCenterTools {...toolbarProps} />
      ) : (
        <FloatingToolbarLayer {...toolbarProps} />
      );
    act(() => {
      root!.render(toolbar);
    });
  }

  function shelf(category = 'surface.write'): HTMLElement {
    const element = host!.querySelector(`[data-tool-shelf="${category}"]`);
    if (!(element instanceof HTMLElement))
      throw new Error(`missing shelf: ${category}`);
    return element;
  }

  function openMore(tools: HTMLElement): HTMLElement {
    const more = tools.querySelector('button[aria-label="More tools"]');
    if (!(more instanceof HTMLButtonElement))
      throw new Error('missing More tools');
    act(() => more.click());
    const menu = document.querySelector(
      '[role="group"][aria-label="More tools"]',
    );
    if (!(menu instanceof HTMLElement))
      throw new Error('More tools group did not open');
    return menu;
  }

  describe('planShelfCells (shared planner reuse)', () => {
    function writeCells(touch: boolean) {
      // Five family tools: the eraser lives in the surface.erase category
      // and never renders in the pen-active write shelf.
      return estimateShelfCells({
        toolIds: [
          'ink.tool.pen',
          'ink.tool.fountain',
          'ink.tool.brush',
          'ink.tool.pencil',
          'ink.tool.highlighter',
        ],
        activeToolId: 'ink.tool.pen',
        hasSettings: false,
        quickCells: estimateShelfQuickBudgets({
          favoriteCount: 2,
          widthOptionCount: 3,
          colorDotCount: 5,
          modeOptionCounts: [],
          touch,
        }),
        touch,
      });
    }

    it('matches the compact gear-free write-shelf budget', () => {
      const cells = writeCells(true);
      const total = cells.reduce((sum, cell) => sum + cell.width, 0);
      expect(total).toBe(545);
      expect(shelfCapacityBudget(1024, true)).toBe(808);
      expect(shelfCapacityBudget(1400, true)).toBe(1184);
    });

    it('keeps required cells inline and overflows lowest priority first', () => {
      const cells = writeCells(true);
      const planned = planShelfCells(cells, shelfCapacityBudget(700, true), {
        overflowWidth: 30,
        overflowGap: 4,
      });
      expect(planned.visible).toContain('shelf:tool:ink.tool.pen');
      expect(planned.visible).not.toContain('shelf:settings');
      expect(planned.visible).toContain('shelf:widths');
      expect(planned.overflow).toEqual(['shelf:colors']);
    });

    it('fits the complete compact shelf at 768 touch', () => {
      const cells = writeCells(true);
      const planned = planShelfCells(cells, shelfCapacityBudget(768, true), {
        overflowWidth: 30,
        overflowGap: 4,
      });
      for (const id of [
        'shelf:tool:ink.tool.pen',
        'shelf:tool:ink.tool.highlighter',
      ]) {
        expect(planned.visible, id).toContain(id);
      }
      expect(planned.visible).toContain('shelf:widths');
      expect(planned.visible).toContain('shelf:colors');
    });

    it('shows everything when the budget fits (1400 touch)', () => {
      const cells = writeCells(true);
      const planned = planShelfCells(cells, shelfCapacityBudget(1400, true), {
        overflowWidth: 30,
        overflowGap: 4,
      });
      expect(planned.overflow).toEqual([]);
      expect(planned.visible).toHaveLength(cells.length);
    });

    it('holds overflowed cells across 1px dither with hysteresis', () => {
      const cells = [
        { id: 'shelf:tool:b', order: 0, priority: 90, width: 100 },
        { id: 'shelf:colors', order: 1, priority: 55, width: 100 },
      ];
      const tight = planShelfCells(cells, 144, {
        overflowWidth: 40,
        overflowGap: 4,
      });
      expect(tight.overflow).toEqual(['shelf:colors']);
      const held = planShelfCells(cells, 145, {
        overflowWidth: 40,
        overflowGap: 4,
        hysteresis: 8,
        overflowIds: new Set(tight.overflow),
      });
      expect(held.overflow).toEqual(['shelf:colors']);
      const returned = planShelfCells(cells, 260, {
        overflowWidth: 40,
        overflowGap: 4,
        hysteresis: 8,
        overflowIds: new Set(tight.overflow),
      });
      expect(returned.overflow).toEqual([]);
    });

    it('overflows later mode cells before earlier ones (canonical order)', () => {
      const cells = estimateShelfCells({
        toolIds: [],
        activeToolId: null,
        hasSettings: true,
        quickCells: estimateShelfQuickBudgets({
          favoriteCount: 0,
          widthOptionCount: 0,
          colorDotCount: 0,
          modeOptionCounts: [2, 1],
          touch: true,
        }),
        touch: true,
      });
      expect(cells.map((cell) => cell.id)).toEqual([
        'shelf:settings',
        'shelf:mode:0',
        'shelf:mode:1',
      ]);
      // Room for settings + mode:0 + trigger, but not mode:1.
      const planned = planShelfCells(cells, 150, {
        overflowWidth: 30,
        overflowGap: 4,
      });
      expect(planned.visible).toEqual(['shelf:settings', 'shelf:mode:0']);
      expect(planned.overflow).toEqual(['shelf:mode:1']);
    });

    it('treats non-finite budgets as unmeasured (show-all first paint)', () => {
      const cells = writeCells(true);
      for (const budget of [Number.NaN, -1]) {
        const planned = planShelfCells(cells, budget, { overflowWidth: 30 });
        expect(planned.overflow).toEqual([]);
        expect(planned.visible).toHaveLength(cells.length);
      }
    });
  });

  describe('shelf capacity across widths', () => {
    it.each([768, 820, 834])(
      'keeps compact tools inline at %ipx touch',
      (paneWidth) => {
        const pen = { size: 3.5 };
        mount({
          snapshot: writeSnapshot('pen', pen),
          compact: false,
          coarse: true,
          view: 'shelf',
          paneWidth,
        });
        const tools = shelf();
        expect(
          tools.querySelector('button[aria-label="More tools"]'),
        ).toBeNull();
        // Settings disclosure is inline — never only via invisible scroll.
        expect(
          tools.querySelector(
            ':scope > button[aria-label="Ball Pen settings"]',
          ),
        ).toBeNull();
        expect(
          tools.querySelector(':scope > div button[aria-label="Ball Pen"]'),
        ).not.toBeNull();
        expect(
          tools.querySelector('[aria-label="Quick widths"]'),
        ).not.toBeNull();
        expect(
          tools.querySelector('[aria-label="Quick colors"]'),
        ).not.toBeNull();
      },
    );

    it('keeps hybrid medium shelves compact', () => {
      const pen = { size: 3.5 };
      mount({
        snapshot: writeSnapshot('pen', pen),
        compact: false,
        coarse: false,
        anyCoarse: true,
        view: 'shelf',
        paneWidth: 820,
      });
      const tools = shelf();
      expect(tools.querySelector('button[aria-label="More tools"]')).toBeNull();
      expect(
        tools.querySelector(':scope > button[aria-label="Ball Pen settings"]'),
      ).toBeNull();
    });

    it.each([320, 390, 500, 600, 700])(
      'keeps compact hierarchy behind More at %ipx (pane-width wins)',
      (paneWidth) => {
        const pen = { size: 3.5 };
        mount({
          snapshot: fiveCategorySnapshot(pen),
          compact: false,
          coarse: true,
          view: 'strip',
          paneWidth,
        });
        const strip = host!.querySelector('[data-toolbar="category-strip"]');
        if (!(strip instanceof HTMLElement))
          throw new Error('missing category strip');
        expect(strip.getAttribute('data-compact')).toBe('true');
        expect(
          strip.querySelector('button[aria-label="More tool categories"]'),
        ).not.toBeNull();

        mount({
          snapshot: writeSnapshot('pen', pen),
          compact: false,
          coarse: true,
          view: 'shelf',
          paneWidth,
        });
        const tools = shelf();
        expect(
          tools.querySelector('button[aria-label="More tools"]'),
        ).not.toBeNull();
        expect(
          tools.querySelector('button[aria-label="Ball Pen settings"]'),
        ).toBeNull();
      },
    );

    it('compacts a 500px pane inside a wide window with touch (500-in-1400)', () => {
      const pen = { size: 3.5 };
      mount({
        snapshot: fiveCategorySnapshot(pen),
        compact: false,
        coarse: true,
        view: 'strip',
        paneWidth: 500,
      });
      const strip = host!.querySelector('[data-toolbar="category-strip"]');
      if (!(strip instanceof HTMLElement))
        throw new Error('missing category strip');
      expect(strip.getAttribute('data-compact')).toBe('true');

      mount({
        snapshot: writeSnapshot('pen', pen),
        compact: false,
        coarse: true,
        view: 'shelf',
        paneWidth: 500,
      });
      const tools = shelf();
      expect(
        tools.querySelector('button[aria-label="More tools"]'),
      ).not.toBeNull();
      expect(
        tools.querySelector('button[aria-label="Ball Pen settings"]'),
      ).toBeNull();
      expect(
        tools.querySelector(':scope > [aria-label="Quick widths"]'),
      ).not.toBeNull();
      expect(
        tools.querySelector(':scope > [aria-label="Quick colors"]'),
      ).toBeNull();
    });

    it('stays fully inline on wide desktop touch and mouse (1400)', () => {
      const pen = { size: 3.5 };
      for (const coarse of [true, false]) {
        mount({
          snapshot: writeSnapshot('pen', pen),
          compact: false,
          coarse,
          view: 'shelf',
          paneWidth: 1400,
        });
        expect(
          shelf().querySelector('button[aria-label="More tools"]'),
        ).toBeNull();
      }
    });

    it('keeps the four-pen shelf fully inline at medium fine widths', () => {
      const pen = { size: 3.5 };
      mount({
        snapshot: writeSnapshot('pen', pen),
        compact: false,
        coarse: false,
        view: 'shelf',
        paneWidth: 1024,
      });
      expect(
        shelf().querySelector('button[aria-label="More tools"]'),
      ).toBeNull();

      mount({
        snapshot: writeSnapshot('pen', pen),
        compact: false,
        coarse: false,
        view: 'shelf',
        paneWidth: 768,
      });
      expect(
        shelf().querySelector('button[aria-label="More tools"]'),
      ).toBeNull();
    });

    // The eraser shelf (trio + settings + one size cell) genuinely
    // fits a 768px pane, so capacity keeps everything inline with no More —
    // the honest "if it fits, it sits" half of the contract.
    it('keeps a fitting eraser shelf fully inline at 768 touch', () => {
      const pen = { size: 3.5 };
      mount({
        snapshot: writeSnapshot('eraser', pen),
        compact: false,
        coarse: true,
        view: 'shelf',
        paneWidth: 768,
      });
      const tools = shelf('surface.erase');
      expect(tools.querySelector('button[aria-label="More tools"]')).toBeNull();
      // two fixed-mode tools, never a mode dropdown (the
      // provider emits no `surface.settings.eraser-mode` role, so the
      // shelf quick stays dormant per-tool).
      for (const name of ['Stroke Eraser', 'Precision Eraser']) {
        expect(
          tools.querySelector(`button[aria-label="${name}"]`),
        ).not.toBeNull();
      }
      expect(tools.querySelector('[aria-label="Eraser mode"]')).toBeNull();
      expect(tools.querySelector('[aria-label="Eraser size"]')).toBeNull();
    });
  });

  describe('observer budget', () => {
    it('uses one observer per pane for the floating layer', () => {
      let constructs = 0;
      class CountingObserver {
        observed = 0;
        constructor() {
          constructs += 1;
        }
        observe(): void {
          this.observed += 1;
        }
        unobserve(): void {
          this.observed -= 1;
        }
        disconnect(): void {
          this.observed = 0;
        }
      }
      vi.stubGlobal('ResizeObserver', CountingObserver);
      stubWindow({ compact: false, coarse: true });
      const pen = { size: 3.5 };
      mount({
        snapshot: writeSnapshot('pen', pen),
        compact: false,
        coarse: true,
        view: 'shelf',
        paneWidth: 1024,
      });
      // The layer owns the single pane observation; the shelf budgets from
      // the passed-down width and never subscribes its own observer — even
      // with six tools plus five quick cells rendered.
      expect(constructs).toBe(1);
    });
  });

  describe('fixture linkage (React partition == checked-in fixture)', () => {
    interface FixtureScenario {
      readonly paneWidth: number;
      readonly touch: boolean;
      readonly compact: boolean;
      readonly inlineTools: readonly string[];
      readonly inlineSettings: string | null;
      readonly inlineQuicks: readonly string[];
      readonly menuTools: readonly string[];
      readonly menuQuicks: readonly string[];
      readonly moreVisible: boolean;
    }

    interface ShelfFixture {
      readonly writeShelf: {
        readonly toolIds: readonly string[];
        readonly activeToolId: string;
        readonly cells: Record<
          string,
          readonly {
            readonly id: string;
            readonly order: number;
            readonly priority: number;
            readonly width: number;
            readonly required: boolean;
          }[]
        >;
        readonly budgets: Record<string, Record<string, number>>;
      };
      readonly scenarios: Record<string, FixtureScenario>;
    }

    function loadFixture(): ShelfFixture {
      // Kept as JSON (not TS) so Playwright reads the identical file.
      // Vitest runs with the ui package as cwd.
      return JSON.parse(
        readFileSync(
          join(process.cwd(), 'src/react/__fixtures__/shelf-partitions.json'),
          'utf8',
        ),
      ) as ShelfFixture;
    }

    function writeCellsFor(touch: boolean) {
      return estimateShelfCells({
        toolIds: [
          'ink.tool.pen',
          'ink.tool.fountain',
          'ink.tool.brush',
          'ink.tool.pencil',
        ],
        activeToolId: 'ink.tool.pen',
        hasSettings: false,
        quickCells: estimateShelfQuickBudgets({
          favoriteCount: 2,
          widthOptionCount: 3,
          colorDotCount: 5,
          modeOptionCounts: [],
          touch,
        }),
        touch,
      });
    }

    it('pins estimator cells + budgets to the fixture (drift fails loudly)', () => {
      const fixture = loadFixture();
      for (const touch of [true, false]) {
        const key = touch ? 'touch' : 'fine';
        const cells = writeCellsFor(touch).map((cell) => ({
          id: cell.id,
          order: cell.order,
          priority: cell.priority,
          width: cell.width,
          required: cell.required ?? false,
        }));
        // Regenerate the fixture intentionally after any estimator change —
        // never hand-edit values (Playwright geometry pins these numbers).
        expect(cells, `${key} cells`).toEqual(fixture.writeShelf.cells[key]);
        for (const width of [390, 500, 768, 820, 834, 1024, 1400]) {
          expect(
            shelfCapacityBudget(width, touch),
            `${key} budget@${width}`,
          ).toBe(fixture.writeShelf.budgets[key]?.[String(width)]);
        }
      }
    });

    it.each(['768-touch', '1024-touch', '500-touch', '390-touch'])(
      'renders the %s fixture partition',
      (name) => {
        const scenario = loadFixture().scenarios[name];
        if (scenario === undefined) throw new Error(`missing scenario ${name}`);
        const pen = { size: 3.5 };
        mount({
          snapshot: writeSnapshot('pen', pen),
          compact: false,
          coarse: scenario.touch,
          view: 'shelf',
          paneWidth: scenario.paneWidth,
        });
        const tools = shelf();
        const labelOf = (element: Element | null): string | null =>
          element instanceof HTMLElement
            ? element.getAttribute('aria-label')
            : null;
        // Tool buttons live in role-less group divs; quick cells carry
        // role="group", so the selectors below cannot confuse them. The
        // More trigger shares a role-less wrapper and is filtered out.
        const inlineTools = [
          ...tools.querySelectorAll(
            ':scope > div:not([role="group"]) button[aria-label]',
          ),
        ]
          .map((element) => labelOf(element))
          .filter((label) => label !== 'More tools');
        expect(inlineTools, `${name} inlineTools`).toEqual(
          scenario.inlineTools,
        );
        expect(
          labelOf(
            tools.querySelector(':scope > button[aria-label$="settings"]'),
          ),
        ).toBe(scenario.inlineSettings);
        const inlineQuicks = [
          ...tools.querySelectorAll(':scope > div[role="group"][aria-label]'),
        ].map((element) => labelOf(element));
        expect(inlineQuicks, `${name} inlineQuicks`).toEqual(
          scenario.inlineQuicks,
        );
        expect(
          tools.querySelector('button[aria-label="More tools"]') !== null,
          `${name} moreVisible`,
        ).toBe(scenario.moreVisible);
        if (!scenario.moreVisible) return;
        const menu = openMore(tools);
        const menuTools = [...menu.querySelectorAll('button[aria-label]')]
          .filter((element) => element.closest('[role="group"]') === menu)
          .map((element) => labelOf(element));
        expect(menuTools, `${name} menuTools`).toEqual(scenario.menuTools);
        const menuQuicks = [
          ...menu.querySelectorAll('[role="group"][aria-label]'),
        ].map((element) => labelOf(element));
        expect(menuQuicks, `${name} menuQuicks`).toEqual(scenario.menuQuicks);
      },
    );
  });
});
