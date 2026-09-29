// @vitest-environment jsdom
/**
 * Responsive toolbar policy follows available pane width, not just
 * window width.
 *
 * The toolbar compacts on the real available pane width with input
 * density resolved independently from layout — never on
 * `window.matchMedia(760)` alone. A ~500px split pane inside a wide
 * window compacts even though the viewport never crosses
 * `COMPACT_MAX_WIDTH`; medium iPad widths (768/820/834/1024) stay
 * content-first. Touch and pointer share compact controls; measured pane
 * capacity determines which tools remain inline and which enter More.
 *
 * No UA/iPad detection, no second mobile toolbar model: the same
 * composition graph projects differently behind `data-compact` + the
 * shared workspace breakpoint (single source in
 * `workspace/interaction-policy.js`).
 */

import { act } from 'react';
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
import {
  COMPACT_MAX_WIDTH,
  type WorkspaceInteractionCapabilities,
} from './workspace/interaction-policy.js';
import {
  autoOverflowWidth,
  FloatingToolbarLayer,
  resolveToolbarPanePresentation,
  shouldCompactToolbar,
  TOOLBAR_COMPACT_QUERY,
  TopbarCenterTools,
} from './UnifiedToolbar.jsx';
import toolbarCss from './UnifiedToolbar.module.css?inline';

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

const MOUSE: WorkspaceInteractionCapabilities = {
  pointer: 'mouse',
  coarse: false,
  supportsHover: true,
  anyCoarse: false,
  anyHover: true,
};
const TOUCH: WorkspaceInteractionCapabilities = {
  pointer: 'touch',
  coarse: true,
  supportsHover: false,
  anyCoarse: true,
  anyHover: false,
};
const PEN: WorkspaceInteractionCapabilities = {
  pointer: 'pen',
  coarse: false,
  supportsHover: true,
  anyCoarse: false,
  anyHover: true,
};
// iPad + trackpad / touchscreen laptop: fine primary, touch available.
const HYBRID: WorkspaceInteractionCapabilities = {
  pointer: 'mouse',
  coarse: true,
  supportsHover: true,
  anyCoarse: true,
  anyHover: true,
};

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
      {
        kind: 'button',
        id: 'ink.tool.eraser',
        group: 'draw',
        label: 'Eraser',
        shortLabel: 'Eraser',
        icon: 'eraser',
        role: 'surface-tool',
        toolId: 'ink.tool.eraser',
        semanticRole: 'surface.erase',
        active: activeKey === 'eraser',
      },
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
    // Providers always emit the image control (disabled when insertion
    // is unavailable), so Insert stays live even with Text selected.
    // creation resolves from `surface.text` only.
    extraCategoryTool('ink.image', 'Image', 'surface.insert.image'),
  ]);
}

describe('pane-driven compact policy (Repair 10)', () => {
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
    /** Defaults to `coarse` (single-input hosts); pass false with coarse false for fine-only. */
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

  function strip(): HTMLElement {
    const element = host!.querySelector('[data-toolbar="category-strip"]');
    if (!(element instanceof HTMLElement))
      throw new Error('missing category strip');
    return element;
  }

  function shelf(category = 'surface.write'): HTMLElement {
    const element = host!.querySelector(`[data-tool-shelf="${category}"]`);
    if (!(element instanceof HTMLElement))
      throw new Error(`missing shelf: ${category}`);
    return element;
  }

  describe('shared breakpoint stays single-sourced', () => {
    it('keeps COMPACT_MAX_WIDTH at 760 behind TOOLBAR_COMPACT_QUERY', () => {
      expect(COMPACT_MAX_WIDTH).toBe(760);
      expect(TOOLBAR_COMPACT_QUERY).toBe('(max-width: 760px)');
    });
  });

  describe('resolveToolbarPanePresentation (width × input matrix)', () => {
    it.each([
      { width: 320, layout: 'compact' },
      { width: 500, layout: 'compact' },
      { width: 760, layout: 'compact' },
      { width: 768, layout: 'medium' },
      { width: 820, layout: 'medium' },
      { width: 834, layout: 'medium' },
      { width: 1024, layout: 'medium' },
      { width: 1180, layout: 'wide' },
      { width: 1400, layout: 'wide' },
    ] as const)('maps $width px to $layout', ({ width, layout }) => {
      for (const capabilities of [MOUSE, TOUCH, PEN]) {
        const presentation = resolveToolbarPanePresentation({
          width,
          capabilities,
        });
        expect(presentation.layout).toBe(layout);
        expect(presentation.compact).toBe(layout === 'compact');
      }
    });

    it('keeps touch density on coarse pointers at every width', () => {
      for (const width of [320, 500, 768, 1024, 1400]) {
        expect(
          resolveToolbarPanePresentation({ width, capabilities: TOUCH })
            .density,
        ).toBe('touch');
      }
    });

    it('keeps touch density for hybrid fine-primary + touch-available hosts', () => {
      for (const width of [320, 500, 768, 1024, 1400]) {
        expect(
          resolveToolbarPanePresentation({ width, capabilities: HYBRID })
            .density,
        ).toBe('touch');
      }
    });

    it('allows denser mouse presentation while pen stays operable without UA detection', () => {
      for (const width of [768, 1024, 1400]) {
        expect(
          resolveToolbarPanePresentation({ width, capabilities: MOUSE })
            .density,
        ).toBe('compact');
        // Pen is a precise pointer, not a coarse one: no special density,
        // no device sniffing — taps ride the ordinary click path.
        expect(
          resolveToolbarPanePresentation({ width, capabilities: PEN }).density,
        ).toBe('compact');
      }
    });
  });

  describe('shouldCompactToolbar (pane wins over window)', () => {
    it('compacts a narrow split pane inside a wide window', () => {
      expect(
        shouldCompactToolbar({ paneWidth: 500, windowCompact: false }),
      ).toBe(true);
      expect(
        shouldCompactToolbar({ paneWidth: 320, windowCompact: false }),
      ).toBe(true);
    });

    it('leaves medium and wide panes expanded in a wide window', () => {
      for (const paneWidth of [768, 820, 834, 1024, 1180, 1400]) {
        expect(shouldCompactToolbar({ paneWidth, windowCompact: false })).toBe(
          false,
        );
      }
    });

    it('falls back to the window query before measurement', () => {
      expect(
        shouldCompactToolbar({ paneWidth: undefined, windowCompact: true }),
      ).toBe(true);
      expect(
        shouldCompactToolbar({ paneWidth: undefined, windowCompact: false }),
      ).toBe(false);
    });

    it('treats non-positive widths as unmeasured (jsdom reports 0)', () => {
      expect(shouldCompactToolbar({ paneWidth: 0, windowCompact: false })).toBe(
        false,
      );
      expect(shouldCompactToolbar({ paneWidth: 0, windowCompact: true })).toBe(
        true,
      );
    });

    it('lets explicit pane geometry override a narrow window stub', () => {
      expect(
        shouldCompactToolbar({ paneWidth: 1400, windowCompact: true }),
      ).toBe(false);
    });
  });

  describe('autoOverflowWidth (pointer-aware planner reserve)', () => {
    it('pins 30 on coarse and fine without matchMedia stubbing', () => {
      expect(autoOverflowWidth(true)).toBe(30);
      expect(autoOverflowWidth(false)).toBe(30);
    });

    it('reads the live coarse query by default', () => {
      stubWindow({ compact: false, coarse: true });
      expect(autoOverflowWidth()).toBe(30);
      stubWindow({ compact: false, coarse: false });
      expect(autoOverflowWidth()).toBe(30);
    });
  });

  describe('category strip follows pane width', () => {
    it('compacts a ~500px split pane inside a wide window', () => {
      const pen = { size: 3.5 };
      mount({
        snapshot: fiveCategorySnapshot(pen),
        compact: false,
        coarse: false,
        view: 'strip',
        paneWidth: 500,
      });
      const categories = strip();
      expect(categories.getAttribute('data-compact')).toBe('true');
      expect(
        categories.querySelector('[data-category="surface.write"]'),
      ).not.toBeNull();
      expect(
        categories.querySelector('button[aria-label="More tool categories"]'),
      ).not.toBeNull();
    });

    it('keeps a wide window expanded without pane geometry', () => {
      const pen = { size: 3.5 };
      mount({
        snapshot: fiveCategorySnapshot(pen),
        compact: false,
        coarse: false,
        view: 'strip',
      });
      const categories = strip();
      expect(categories.getAttribute('data-compact')).toBe('false');
      expect(
        categories.querySelector('button[aria-label="More tool categories"]'),
      ).toBeNull();
    });

    it('preserves the narrow-window fallback before measurement', () => {
      const pen = { size: 3.5 };
      mount({
        snapshot: fiveCategorySnapshot(pen),
        compact: true,
        coarse: true,
        view: 'strip',
      });
      expect(strip().getAttribute('data-compact')).toBe('true');
      expect(
        strip().querySelector('button[aria-label="More tool categories"]'),
      ).not.toBeNull();
    });

    it.each([768, 820, 834, 1024])(
      'shows full iPad labels with no overflow chrome at %ipx touch',
      (paneWidth) => {
        const pen = { size: 3.5 };
        mount({
          snapshot: fiveCategorySnapshot(pen),
          compact: false,
          coarse: true,
          view: 'strip',
          paneWidth,
        });
        expect(strip().getAttribute('data-compact')).toBe('false');
        // six labels (direct Text) fit with no overflow chrome
        // at iPad widths — still a single row, never a second toolbar row.
        for (const name of [
          'Pen',
          'Highlighter',
          'Eraser',
          'Selection',
          'Shapes',
          'Insert',
          'Text',
        ]) {
          expect(
            strip().querySelector(`[aria-label="${name}"]`),
          ).not.toBeNull();
        }
        expect(
          strip().querySelector('button[aria-label="More tool categories"]'),
        ).toBeNull();
      },
    );

    it('compacts a 320px phone pane with touch', () => {
      const pen = { size: 3.5 };
      mount({
        snapshot: fiveCategorySnapshot(pen),
        compact: false,
        coarse: true,
        view: 'strip',
        paneWidth: 320,
      });
      expect(strip().getAttribute('data-compact')).toBe('true');
      expect(
        strip().querySelector('button[aria-label="More tool categories"]'),
      ).not.toBeNull();
    });

    it('stays dense and expanded on wide desktop mouse', () => {
      const pen = { size: 3.5 };
      mount({
        snapshot: fiveCategorySnapshot(pen),
        compact: false,
        coarse: false,
        view: 'strip',
        paneWidth: 1400,
      });
      expect(strip().getAttribute('data-compact')).toBe('false');
      expect(
        strip().querySelector('button[aria-label="More tool categories"]'),
      ).toBeNull();
      expect(strip().querySelector('[aria-label="Shapes"]')).not.toBeNull();
    });

    it('Text-active compact keeps Text inline (not Insert) with the active marker', () => {
      // alias: Text creation resolves in Insert + Text, but
      // the canonical home is Text. In compact the active-inclusion slot
      // (first three + active) must keep Text inline with
      // data-contains-active-tool, while Insert overflows to More without
      // the marker — never Insert-first stealing Text.
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
        compact: false,
        coarse: false,
        view: 'strip',
        paneWidth: 500,
      });
      expect(strip().getAttribute('data-compact')).toBe('true');
      // Active-inclusion keeps the canonical Text presenter inline.
      const textButton = strip().querySelector(
        '[data-category="surface.text"]',
      );
      expect(textButton).not.toBeNull();
      expect(textButton?.getAttribute('data-contains-active-tool')).toBe(
        'true',
      );
      const insertInline = strip().querySelector(
        ':scope > [data-category="surface.insert"]',
      );
      // Insert overflows (or at minimum never carries the active marker
      // when Text is the active tool).
      const more = strip().querySelector(
        'button[aria-label="More tool categories"]',
      );
      if (!(more instanceof HTMLButtonElement))
        throw new Error('missing category More');
      expect(
        strip().querySelector(
          ':scope > [data-category="surface.insert"][data-contains-active-tool="true"]',
        ),
      ).toBeNull();
      void insertInline;
      act(() => more.click());
      const menu =
        strip().querySelector(
          '[role="menu"][aria-label="More tool categories"]',
        ) ??
        document.querySelector(
          '[role="menu"][aria-label="More tool categories"]',
        );
      if (!(menu instanceof HTMLElement))
        throw new Error('category More menu did not open');
      // Overflow holds the non-canonical Insert presenter without the
      // active marker; Text itself stays inline (not duplicated into More).
      expect(
        menu.querySelector('[data-contains-active-tool="true"]'),
      ).toBeNull();
      expect(menu.textContent).toContain('Insert');
    });
  });

  describe('contextual shelf follows pane width', () => {
    // DELTA INTENTIONAL CHANGE (was: active tool + favorites + settings
    // inline at measured 500px): capacity now partitions below 760 too, so
    // at a 212–284px center budget only required cells (active tool,
    // settings) plus the highest-priority family tools stay inline —
    // favorites join widths/colors in the explicit More menu instead of
    // forcing the island into invisible scroll. The 760 compact STRUCTURE
    // (strip, data-compact) is unchanged; unmeasured hosts keep the legacy
    // slice.
    it('compacts a ~500px split pane inside a wide window', () => {
      const pen = { size: 3.5 };
      mount({
        snapshot: writeSnapshot('pen', pen),
        compact: false,
        coarse: false,
        view: 'shelf',
        paneWidth: 500,
      });
      const tools = shelf();
      const more = tools.querySelector('button[aria-label="More tools"]');
      if (!(more instanceof HTMLButtonElement))
        throw new Error('missing More tools');
      // Required cells survive inline; lower-priority cells overflow
      // explicitly instead of hiding in invisible scroll.
      expect(
        tools.querySelector(':scope > div button[aria-label="Ball Pen"]'),
      ).not.toBeNull();
      expect(
        tools.querySelector('button[aria-label="Ball Pen settings"]'),
      ).toBeNull();
      expect(
        tools.querySelector(':scope > [aria-label="Favorite styles"]'),
      ).toBeNull();
      expect(
        tools.querySelector(':scope > [aria-label="Quick widths"]'),
      ).not.toBeNull();
      expect(
        tools.querySelector(':scope > [aria-label="Quick colors"]'),
      ).toBeNull();
      act(() => more.click());
      const menu = document.querySelector(
        '[role="group"][aria-label="More tools"]',
      );
      if (!(menu instanceof HTMLElement))
        throw new Error('More tools group did not open');
      expect(
        menu.querySelector('[aria-label="Favorite styles"]'),
      ).not.toBeNull();
      expect(menu.querySelector('[aria-label="Quick widths"]')).toBeNull();
      expect(menu.querySelector('[aria-label="Quick colors"]')).not.toBeNull();
    });

    // Removing the gear frees enough room for the whole shelf at 1024px.
    it('shows every quick inline at 1024 touch', () => {
      const pen = { size: 3.5 };
      mount({
        snapshot: writeSnapshot('pen', pen),
        compact: false,
        coarse: true,
        view: 'shelf',
        paneWidth: 1024,
      });
      const tools = shelf();
      const more = tools.querySelector('button[aria-label="More tools"]');
      expect(more).toBeNull();
      // Priority retention: active tool + settings + favorites + widths inline.
      expect(
        tools.querySelector(':scope > div button[aria-label="Ball Pen"]'),
      ).not.toBeNull();
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

    it('preserves the narrow-window shelf fallback before measurement', () => {
      const pen = { size: 3.5 };
      mount({
        snapshot: writeSnapshot('pen', pen),
        compact: true,
        coarse: true,
        view: 'shelf',
      });
      expect(
        shelf().querySelector('button[aria-label="More tools"]'),
      ).not.toBeNull();
    });

    it('compacts a 320px phone pane with touch', () => {
      const pen = { size: 3.5 };
      mount({
        snapshot: writeSnapshot('pen', pen),
        compact: false,
        coarse: true,
        view: 'shelf',
        paneWidth: 320,
      });
      expect(
        shelf().querySelector('button[aria-label="More tools"]'),
      ).not.toBeNull();
    });

    it('stays expanded on wide desktop mouse', () => {
      const pen = { size: 3.5 };
      mount({
        snapshot: writeSnapshot('pen', pen),
        compact: false,
        coarse: false,
        view: 'shelf',
        paneWidth: 1400,
      });
      expect(
        shelf().querySelector('button[aria-label="More tools"]'),
      ).toBeNull();
    });
  });

  describe('pane-driven compact styles', () => {
    it('mirrors the window compact projection behind data-compact', () => {
      const clean = toolbarCss.replace(/\/\*[\s\S]*?\*\//g, '');
      // The shared window breakpoint stays as the first-paint fallback.
      expect(clean).toMatch(/@media\s*\(max-width:\s*760px\)/);
      // Narrow panes inside wide windows retain touch-sized icon targets.
      expect(clean).toMatch(
        /fl-toolbar-categories[\w-]*\[data-compact='true'\]/,
      );
      expect(clean).toMatch(
        /fl-toolbar-categories[\w-]*\[data-compact='true'\][\s\S]*?fl-toolbar-category[\w-]*\s*\{[\s\S]*?min-width:\s*34px/,
      );
    });

    it('keeps token-only styles with no hard-coded colors', () => {
      const clean = toolbarCss.replace(/\/\*[\s\S]*?\*\//g, '');
      expect(clean).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    });

    it('marks the active-tool category while browsing (no invisible state)', () => {
      const clean = toolbarCss.replace(/\/\*[\s\S]*?\*\//g, '');
      expect(clean).toMatch(
        /fl-toolbar-category[\w-]*\[data-contains-active-tool='true'\]/,
      );
    });

    it('clusters shelf tools without per-tool dividers', () => {
      const clean = toolbarCss.replace(/\/\*[\s\S]*?\*\//g, '');
      expect(clean).toMatch(
        /fl-tool-shelf[\w-]*\s*>\s*\.?_?fl-document-tool-group[\w-]*[\s\S]*?border-right:\s*0/,
      );
    });

    it('pins the settings title against flex collapse in scrolled popovers', () => {
      const clean = toolbarCss.replace(/\/\*[\s\S]*?\*\//g, '');
      expect(clean).toMatch(
        /fl-tool-settings-title[\w-]*[\s\S]*?flex:\s*0 0 auto/,
      );
    });
  });
});
