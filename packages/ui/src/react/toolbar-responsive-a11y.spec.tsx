// @vitest-environment jsdom
/**
 *  responsive / accessibility verification suite (tests only).
 *
 * Requirements: (compaction -> overflow -> optional-hide NEVER a second
 * row; 760 pane-width compact projection; popover clamp/flip; safe-area and
 * keyboard insets; icon accessible names with no persistent context labels;
 * disabled semantics), (compact coarse targets incl. slot triggers,
 *  strip groups, and deduped shelves; touch-breakpoint geometry via
 * the computed-style seam, never layout measurement), (keyboard/focus
 * contract: focus-first-on-open, roving arrows/Home/End, Escape -> trigger,
 * group-vs-menu semantics; AT names plus aria-pressed/mixed; no trap), plus
 *  analogues (slot geometry/names/second-tap through the
 * wired shelf, keyed by role/name).
 *
 * Conventions (repository rules for this workflow):
 * - Every behavior is keyed by role/name queries (`[aria-label=...]`,
 *   `[role=menu|group|dialog]`, `[data-category]`, `[data-tool-shelf]`),
 *   never by class internals or id substrings.
 * - Touch geometry is asserted through the COMPUTED-STYLE seam: the shipped
 *   `UnifiedToolbar.module.css` declarations (hashed at build time, resolved
 *   through the runtime `styles` mapping so the suite tracks renames) are
 *   injected as real stylesheets and read back via `getComputedStyle`.
 *   Layout measurement (`getBoundingClientRect`/`offsetWidth`, always 0 in
 *   jsdom) is never used. Real-engine pixel truth stays in Playwright
 *   (`apps/web/tests/toolbar-touch-medium.spec.ts`, `toolbar-geometry.spec.ts`).
 * - jsdom cannot evaluate the `(any-pointer: coarse)` media feature, so each
 *   coarse test asserts the two halves independently: (1) the capability gate
 *   through stubbed `matchMedia` + the production JS mirror
 *   (`autoOverflowWidth`/`resolveToolbarPanePresentation`), and (2) the
 *   shipped coarse declarations (extracted from their `any-pointer` media
 *   blocks, whose preludes are pinned to never use primary-only queries)
 *   through `getComputedStyle`.
 * - Failure attribution: assertions name the owning family (surface.write ink
 *   shelf, PDF pages island, notebook management) vs the shared core
 *   (strip/planner/popover/CSS contract) in their messages.
 * - note: `toolbar-composition-diagnostics.spec.tsx`
 *  `renders no suppression diagnostic` fails because the cross-layer
 *   single-owner rule skips the only shelf candidate (geometrically claimed,
 *   non-Text) so no `[data-tool-shelf]` renders. That is shared-core
 *  cross-layer behavior that differs from an outdated expectation; triage belongs to
 *   integration. This suite deliberately gives every asserted shelf an
 *   unclaimed tool so it never depends on that configuration. No production
 *   code is touched here.
 *
 * Scope: this file only. 's lifecycle file and `__fixtures__` are not
 * touched.
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
import { defaultToolbarPlacements } from '../toolbar/default-placements.js';
import {
  COMPACT_MAX_WIDTH,
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
  shouldCompactToolbar,
  TOOLBAR_COMPACT_QUERY,
  TopbarCenterTools,
} from './UnifiedToolbar.jsx';
import {
  computeToolbarPopoverPosition,
  handleMenuListKeyDown,
} from './toolbar-popover.jsx';
import shippedCss from './UnifiedToolbar.module.css?inline';
import styleMap from './UnifiedToolbar.module.css';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Shared harness
// ---------------------------------------------------------------------------

const WIDTHS = [2, 3.5, 6] as const;
const SWATCHES = [
  '#37352f',
  '#7c6cf0',
  '#c4554d',
  '#448361',
  '#a08430',
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
// iPad + trackpad / touchscreen laptop: fine primary, touch available,
// hover intact.
const HYBRID: WorkspaceInteractionCapabilities = {
  pointer: 'mouse',
  coarse: true,
  supportsHover: true,
  anyCoarse: true,
  anyHover: true,
};

type Call = readonly [id: string, value?: string];

interface InkToolDef {
  readonly key: string;
  readonly id: string;
  readonly label: string;
  readonly semanticRole: string;
  readonly toolRole: 'pen' | 'highlighter' | 'eraser';
}

const INK_TOOL_DEFS: readonly InkToolDef[] = [
  {
    key: 'pen',
    id: 'ink.tool.pen',
    label: 'Ball Pen',
    semanticRole: 'surface.pen.ball',
    toolRole: 'pen',
  },
  {
    key: 'fountain',
    id: 'ink.tool.fountain',
    label: 'Fountain Pen',
    semanticRole: 'surface.pen.fountain',
    toolRole: 'pen',
  },
  {
    key: 'brush',
    id: 'ink.tool.brush',
    label: 'Brush Pen',
    semanticRole: 'surface.pen.brush',
    toolRole: 'pen',
  },
  {
    key: 'pencil',
    id: 'ink.tool.pencil',
    label: 'Pencil',
    semanticRole: 'surface.pencil',
    toolRole: 'pen',
  },
  {
    key: 'highlighter',
    id: 'ink.tool.highlighter',
    label: 'Highlighter',
    semanticRole: 'surface.highlighter',
    toolRole: 'highlighter',
  },
  {
    key: 'eraser',
    id: 'ink.tool.eraser',
    label: 'Eraser',
    semanticRole: 'surface.erase',
    toolRole: 'eraser',
  },
];

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

function makeSettingsHost(activeKey: string): SurfaceToolSettingsHost {
  const styles = [
    stylePreset('f1', 'Daily', true),
    stylePreset('f2', 'Fine', true),
    stylePreset('p1', 'Draft', false),
  ];
  return {
    activeToolId: () => `ink.${activeKey}`,
    setTool: () => undefined,
    toolPreset: () => ({ color: '#37352f', size: 3.5 }),
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

function plainButton(
  id: string,
  label: string,
  semanticRole: string,
): DocumentToolControl {
  return {
    kind: 'button',
    id,
    group: 'draw',
    label,
    shortLabel: label,
    semanticRole,
  } as unknown as DocumentToolControl;
}

function createInkProvider(initialKey: string): {
  readonly port: WorkbenchEditorToolsPort;
  readonly calls: Call[];
  readonly setActiveKey: (key: string) => void;
} {
  const calls: Call[] = [];
  const listeners = new Set<() => void>();
  let activeKey = initialKey;
  const snapshot = (): DocumentToolSnapshot => ({
    context: 'Surface',
    controls: [
      ...(INK_TOOL_DEFS.map(
        (def) =>
          ({
            kind: 'button',
            id: def.id,
            group: 'draw',
            label: def.label,
            shortLabel: def.label,
            toolRole: def.toolRole,
            semanticRole: def.semanticRole,
            active: def.key === activeKey,
            activationRole: 'tool',
          }) as unknown as DocumentToolControl,
      ) as DocumentToolControl[]),
      plainButton('ink.tool.select', 'Select', 'surface.select'),
      plainButton('ink.tool.line', 'Line', 'surface.shape.line'),
      plainButton('ink.tool.text', 'Text', 'surface.insert.text'),
      plainButton('ink.tool.image', 'Image', 'surface.insert.image'),
      ...buildActiveToolSettingsControls(makeSettingsHost(activeKey), {
        prefix: 'ink',
        swatches: [...SWATCHES],
        widths: [...WIDTHS],
      }),
    ],
  });
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const port = {
    onDidChange: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    execEditorCommand: () => false,
    canExecEditorCommand: () => true,
    editorToolSnapshot: () => snapshot(),
    executeEditorTool: (_pane: string, id: string, value?: string) => {
      calls.push(value === undefined ? [id] : [id, value]);
      const tool = INK_TOOL_DEFS.find((def) => def.id === id);
      if (tool !== undefined) activeKey = tool.key;
      notify();
      return true;
    },
  } as unknown as WorkbenchEditorToolsPort;
  return {
    port,
    calls,
    setActiveKey: (key: string) => {
      activeKey = key;
      notify();
    },
  };
}

function pdfSnapshot(): DocumentToolSnapshot {
  return {
    context: 'PDF source',
    controls: [
      {
        kind: 'button',
        id: 'pdf.previous',
        group: 'pages',
        label: 'Previous PDF page',
        shortLabel: 'Previous',
        semanticRole: 'pdf.page.previous',
      },
      { kind: 'status', id: 'pdf.page', group: 'pages', label: '3 / 9' },
      {
        kind: 'button',
        id: 'pdf.next',
        group: 'pages',
        label: 'Next PDF page',
        shortLabel: 'Next',
        semanticRole: 'pdf.page.next',
      },
      {
        kind: 'button',
        id: 'pdf.source-select',
        group: 'interaction',
        label: 'Select and copy source text',
        shortLabel: 'Source Select',
        semanticRole: 'pdf.select.source',
      },
      {
        kind: 'button',
        id: 'pdf.import-notebook',
        group: 'document',
        label: 'Annotate / Import as Notebook',
        shortLabel: 'Annotate',
        semanticRole: 'pdf.annotate.notebook',
      },
    ] as unknown as DocumentToolSnapshot['controls'],
  };
}

function stubMedia(input: {
  readonly compact?: boolean;
  readonly coarse?: boolean;
  readonly anyCoarse?: boolean;
  /**
   * Explicit hover overrides. Defaults derive from the pointer
   * state (fine primary hovers; any-hover follows no-coarse-anywhere), but
   * hybrid hosts (fine primary + touch available, e.g. iPad + trackpad)
   * hover AND expose coarse anywhere — only explicit overrides model
   * `hover: true` + `anyCoarse: true` together correctly.
   */
  readonly hover?: boolean;
  readonly anyHover?: boolean;
}): void {
  const compact = input.compact ?? false;
  const coarse = input.coarse ?? false;
  const anyCoarse = input.anyCoarse ?? coarse;
  const hover = input.hover ?? !coarse;
  const anyHover = input.anyHover ?? !anyCoarse;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches:
      query === TOOLBAR_COMPACT_QUERY
        ? compact
        : query === '(pointer: coarse)'
          ? coarse
          : query === '(any-pointer: coarse)'
            ? anyCoarse
            : query === '(hover: hover)'
              ? hover
              : query === '(any-hover: hover)'
                ? anyHover
                : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let injectedStyles: HTMLStyleElement[] = [];

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  for (const style of injectedStyles) style.remove();
  injectedStyles = [];
  vi.unstubAllGlobals();
});

interface MountOptions {
  readonly provider?: ReturnType<typeof createInkProvider>;
  readonly kindId?: string;
  readonly paneWidth?: number;
  readonly coarse?: boolean;
  readonly anyCoarse?: boolean;
  readonly hover?: boolean;
  readonly anyHover?: boolean;
  readonly compact?: boolean;
  readonly withDefaults?: boolean;
  readonly withDefaultPlacements?: boolean;
  readonly placements?: readonly {
    readonly id: string;
    readonly anchor: 'topbar-center' | 'float.top-left' | 'float.bottom-center';
    readonly controlIds: readonly string[];
    readonly order?: number;
    readonly priority?: number;
    readonly compact?: 'auto' | 'never' | 'always';
  }[];
  readonly availableWidth?: number;
  readonly measuredWidths?: Record<string, number>;
}

function mountToolbar(
  options: MountOptions & { readonly view: 'strip' | 'shelf' | 'both' },
): { readonly provider: ReturnType<typeof createInkProvider> } {
  const provider = options.provider ?? createInkProvider('pen');
  return mountWithPort({ ...options, port: provider.port, provider });
}

// Mount helper split so PDF/custom-snapshot harnesses share the DOM wiring.
function mountWithPort(
  options: MountOptions & {
    readonly view: 'strip' | 'shelf' | 'both';
    readonly port: WorkbenchEditorToolsPort;
    readonly provider: ReturnType<typeof createInkProvider>;
  },
): { readonly provider: ReturnType<typeof createInkProvider> } {
  stubMedia({
    compact: options.compact ?? false,
    coarse: options.coarse ?? false,
    anyCoarse: options.anyCoarse ?? options.coarse ?? false,
    ...(options.hover !== undefined ? { hover: options.hover } : {}),
    ...(options.anyHover !== undefined ? { anyHover: options.anyHover } : {}),
  });
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  host?.remove();
  const contributions = createDocumentToolbarRegistry();
  const placements = createToolbarPlacementRegistry();
  if (options.withDefaultPlacements === true) {
    for (const placement of defaultToolbarPlacements()) {
      placements.registry.register(placement);
    }
  }
  for (const placement of options.placements ?? []) {
    placements.registry.register({
      ...placement,
      controlIds: [...placement.controlIds],
    });
  }
  const composition =
    options.withDefaults === false
      ? undefined
      : createToolbarCompositionRegistry();
  if (composition !== undefined) {
    const defaults = defaultToolbarComposition();
    for (const entry of defaults.categories)
      composition.registry.registerCategory(entry);
    for (const entry of defaults.items)
      composition.registry.registerItem(entry);
    for (const entry of defaults.extensions)
      composition.registry.registerKindExtension(entry);
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const toolbarProps = {
    tools: options.port,
    contributions: contributions.registry,
    placements: placements.registry,
    ...(composition !== undefined ? { composition: composition.registry } : {}),
    pane: 'pane-1',
    documentId: 'doc-1',
    kindId: options.kindId ?? 'froglight.ink',
    ...(options.paneWidth !== undefined
      ? { paneWidth: options.paneWidth }
      : {}),
    ...(options.availableWidth !== undefined
      ? { availableWidth: options.availableWidth }
      : {}),
    ...(options.measuredWidths !== undefined
      ? { measuredWidths: options.measuredWidths }
      : {}),
  };
  act(() => {
    if (options.view === 'strip')
      root!.render(<TopbarCenterTools {...toolbarProps} />);
    else if (options.view === 'shelf')
      root!.render(<FloatingToolbarLayer {...toolbarProps} />);
    else
      root!.render(
        <>
          <TopbarCenterTools {...toolbarProps} />
          <FloatingToolbarLayer {...toolbarProps} />
        </>,
      );
  });
  return { provider: options.provider };
}

function strip(): HTMLElement {
  const element = host!.querySelector('[data-toolbar="category-strip"]');
  if (!(element instanceof HTMLElement))
    throw new Error(
      'missing category strip (shared core strip did not render)',
    );
  return element;
}

function shelf(category = 'surface.write'): HTMLElement {
  const element = host!.querySelector(`[data-tool-shelf="${category}"]`);
  if (!(element instanceof HTMLElement))
    throw new Error(
      `missing shelf ${category} (owning family category did not expand)`,
    );
  return element;
}

function buttonByName(scope: ParentNode, name: string): HTMLButtonElement {
  const button = scope.querySelector(`button[aria-label="${name}"]`);
  if (!(button instanceof HTMLButtonElement))
    throw new Error(`missing toolbar trigger by accessible name: ${name}`);
  return button;
}

function press(element: HTMLElement): void {
  act(() => {
    element.focus();
    element.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
  });
}

function keyOn(element: HTMLElement, key: string): void {
  act(() => {
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
  });
}

// ---------------------------------------------------------------------------
// Computed-style seam: shipped declarations -> real cascade -> getComputedStyle
// ---------------------------------------------------------------------------

/**
 * The built `?inline` stylesheet and the runtime `styles` mapping hash CSS
 * module classes differently (`_fl-x_c405ea` vs `_fl-x_008b27`). Both sides
 * use one uniform suffix per build; derive them so extracted shipped rules
 * can be translated onto the live DOM. Any drift (multiple suffixes, missing
 * mapping) fails loudly instead of silently matching nothing.
 */
function cssHashSuffixes(): {
  readonly inline: string;
  readonly runtime: string;
} {
  const clean = shippedCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const inlineSuffixes = new Set<string>();
  for (const match of clean.matchAll(/_fl-[a-z0-9-]+_([A-Za-z0-9]+)/g)) {
    inlineSuffixes.add(match[1] ?? '');
  }
  const runtimeSuffixes = new Set<string>();
  for (const value of Object.values(styleMap as Record<string, string>)) {
    const match = value.split(' ')[0]?.match(/_([A-Za-z0-9]+)$/);
    if (match?.[1] !== undefined) runtimeSuffixes.add(match[1]);
  }
  if (inlineSuffixes.size !== 1 || runtimeSuffixes.size !== 1) {
    throw new Error(
      `CSS module hash drift: inline=[${[...inlineSuffixes]}] runtime=[${[...runtimeSuffixes]}]`,
    );
  }
  return {
    inline: [...inlineSuffixes][0] ?? '',
    runtime: [...runtimeSuffixes][0] ?? '',
  };
}

/** Translate extracted shipped selectors onto the live-DOM hash. */
function translateToRuntimeHash(css: string): string {
  const { inline, runtime } = cssHashSuffixes();
  if (inline === runtime) return css;
  return css.replace(
    new RegExp(`(_fl-[a-z0-9-]+_)${inline}`, 'g'),
    `$1${runtime}`,
  );
}

interface ShippedRule {
  readonly prelude: string;
  readonly body: string;
  /** Media prelude when the rule lives inside a media block. */
  readonly media: string | null;
}

/** Balanced-brace top-level scan of built CSS (comments stripped first). */
function splitTopLevelRules(css: string): ShippedRule[] {
  const rules: ShippedRule[] = [];
  let i = 0;
  const n = css.length;
  while (i < n) {
    while (i < n && /[\s;]/.test(css[i] ?? '')) i += 1;
    if (i >= n) break;
    const brace = css.indexOf('{', i);
    if (brace < 0) break;
    const prelude = css.slice(i, brace).trim();
    let depth = 0;
    let j = brace;
    for (; j < n; j += 1) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    rules.push({ prelude, body: css.slice(brace + 1, j), media: null });
    i = j + 1;
  }
  return rules;
}

function shippedCssNoComments(): string {
  // The built ?inline CSS leads with `@layer a, b, ...;` statements: drop
  // them so the first real rule keeps a clean prelude for selector matching.
  return shippedCss
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@layer[^;{]+;/g, '');
}

/**
 * Shipped rules mentioning a source class (via its hashed mapping), split by
 * branch. `coarse: true` returns the inner rules of `any-pointer: coarse`
 * media blocks with the media wrapper removed (jsdom cannot evaluate the
 * media feature; the gate half is asserted separately via stubbed matchMedia
 * + the production JS mirror). Declaration order mirrors the stylesheet:
 * base first, coarse after.
 */
function shippedRulesFor(
  sourceClass: string,
  branch: 'base' | 'coarse',
): { readonly css: string; readonly mediaPreludes: readonly string[] } {
  const { inline } = cssHashSuffixes();
  const needle = `_${sourceClass}_${inline}`;
  const top = splitTopLevelRules(shippedCssNoComments());
  const css: string[] = [];
  const mediaPreludes: string[] = [];
  // The built stylesheet nests author rules inside `@layer <name> { ... }`
  // blocks: unwrap one level so base/coarse matching sees every rule.
  const flat: ShippedRule[] = [];
  for (const rule of top) {
    if (rule.prelude.startsWith('@layer') && rule.body.includes('{')) {
      for (const inner of splitTopLevelRules(rule.body)) {
        flat.push(
          inner.prelude.startsWith('@media')
            ? { ...inner, media: inner.prelude }
            : inner,
        );
      }
      continue;
    }
    flat.push(rule);
  }
  for (const rule of flat) {
    if (rule.prelude.startsWith('@keyframes')) continue;
    if (!rule.prelude.startsWith('@media')) {
      if (branch === 'base' && rule.prelude.includes(needle)) {
        css.push(`${rule.prelude}{${rule.body}}`);
      }
      continue;
    }
    if (branch !== 'coarse') continue;
    if (!/any-pointer:\s*coarse/.test(rule.prelude)) continue;
    for (const inner of splitTopLevelRules(rule.body)) {
      if (inner.prelude.startsWith('@keyframes')) continue;
      if (inner.prelude.includes(needle)) {
        css.push(`${inner.prelude}{${inner.body}}`);
        mediaPreludes.push(rule.prelude);
      }
    }
  }
  if (css.length === 0 && branch === 'base')
    throw new Error(
      `no shipped ${branch} rules mention ${sourceClass} (shared core stylesheet drift?)`,
    );
  return {
    css: translateToRuntimeHash(css.join('\n')),
    mediaPreludes,
  };
}

/**
 * Inject shipped declarations for the given source classes as a real
 * stylesheet. Coarse rules ride a second element (source order preserved)
 * so fine-only tests inject base alone.
 */
function injectShipped(
  sourceClasses: readonly string[],
  branch: 'base' | 'coarse-included',
): void {
  const base = sourceClasses
    .map((name) => shippedRulesFor(name, 'base').css)
    .join('\n');
  const baseEl = document.createElement('style');
  baseEl.setAttribute('data-t020-seam', 'base');
  baseEl.textContent = base;
  document.head.appendChild(baseEl);
  injectedStyles.push(baseEl);
  if (branch === 'coarse-included') {
    const coarse = sourceClasses
      .map((name) => shippedRulesFor(name, 'coarse').css)
      .join('\n');
    const coarseEl = document.createElement('style');
    coarseEl.setAttribute('data-t020-seam', 'coarse');
    coarseEl.textContent = coarse;
    document.head.appendChild(coarseEl);
    injectedStyles.push(coarseEl);
  }
}

function computedMinTarget(element: HTMLElement): {
  readonly minWidth: string;
  readonly minHeight: string;
} {
  const style = getComputedStyle(element);
  return {
    minWidth: style.minWidth,
    minHeight: style.minHeight === 'auto' ? style.height : style.minHeight,
  };
}

function expectCoarseTarget(
  element: HTMLElement,
  name: string,
  owner: string,
): void {
  const { minWidth, minHeight } = computedMinTarget(element);
  expect(
    minWidth,
    `${owner}: '${name}' computed min-width carries the 30px coarse contract (got ${minWidth})`,
  ).toBe(owner === 'pen slot' ? '32px' : '30px');
  expect(
    minHeight,
    `${owner}: '${name}' computed min-height carries the 30px coarse contract (got ${minHeight})`,
  ).toBe('30px');
}

// ---------------------------------------------------------------------------
// single row, 760 compact projection
// ---------------------------------------------------------------------------

describe('single-row compaction (shared core)', () => {
  it('pins the 760 compact breakpoint behind one shared query', () => {
    expect(COMPACT_MAX_WIDTH).toBe(760);
    expect(TOOLBAR_COMPACT_QUERY).toBe('(max-width: 760px)');
    // Boundary: 760 compacts, 768 (first iPad width) stays medium — for both
    // input densities, so touch never loses compact targets to a density flip.
    for (const capabilities of [MOUSE, TOUCH]) {
      expect(
        resolveToolbarPanePresentation({ width: 760, capabilities }).compact,
        `760 ${capabilities.pointer}`,
      ).toBe(true);
      expect(
        resolveToolbarPanePresentation({ width: 768, capabilities }).compact,
        `768 ${capabilities.pointer}`,
      ).toBe(false);
      expect(
        resolveToolbarPanePresentation({ width: 768, capabilities }).layout,
      ).toBe('medium');
    }
  });

  it('pane width wins over the window fallback at the 760 boundary', () => {
    expect(shouldCompactToolbar({ paneWidth: 760, windowCompact: false })).toBe(
      true,
    );
    expect(shouldCompactToolbar({ paneWidth: 768, windowCompact: false })).toBe(
      false,
    );
    expect(shouldCompactToolbar({ paneWidth: 500, windowCompact: false })).toBe(
      true,
    );
  });

  it('compacts a 760 pane into one strip row with an overlaid More (never a second row)', () => {
    mountToolbar({ view: 'strip', paneWidth: 760 });
    const categories = strip();
    expect(categories.getAttribute('data-compact')).toBe('true');
    // Exactly one strip row element: overflow must not append a second row.
    expect(
      host!.querySelectorAll('[data-toolbar="category-strip"]'),
    ).toHaveLength(1);
    const more = buttonByName(categories, 'More tool categories');
    press(more);
    const menu = document.querySelector(
      '[role="menu"][aria-label="More tool categories"]',
    );
    if (!(menu instanceof HTMLElement))
      throw new Error('shared core category More menu did not open');
    // Overlay semantics (fixed positioning + placement marker), not in-flow.
    expect((menu as HTMLElement).style.position).toBe('fixed');
    expect(menu.getAttribute('data-popover-placement')).not.toBeNull();
    expect(
      host!.querySelectorAll('[data-toolbar="category-strip"]'),
      'opening overflow must not create a second strip row',
    ).toHaveLength(1);
  });

  it('keeps shelf + islands single-row by computed style (never wraps)', () => {
    mountToolbar({ view: 'shelf', paneWidth: 500, coarse: true });
    injectShipped(
      ['fl-shelf-slots', 'fl-floating-island', 'fl-topbar-center'],
      'base',
    );
    const row = shelf().querySelector('[data-slot-kind="pen"]');
    if (!(row instanceof HTMLElement))
      throw new Error('surface.write ink family pen slots did not render');
    // The fixed slot row never wraps: the island owns scrolling instead.
    expect(getComputedStyle(row).flexWrap).toBe('nowrap');
    const island = shelf();
    expect(getComputedStyle(island).overflowX).toBe('auto');
    // One shelf element for the expanded family: no second-row clone.
    expect(
      host!.querySelectorAll('[data-tool-shelf="surface.write"]'),
    ).toHaveLength(1);
  });

  it('keeps icon accessible names when compact hides labels', () => {
    mountToolbar({ view: 'strip', paneWidth: 500 });
    const categories = strip();
    expect(categories.getAttribute('data-compact')).toBe('true');
    press(buttonByName(categories, 'More tool categories'));
    const menu = document.querySelector(
      '[role="menu"][aria-label="More tool categories"]',
    );
    if (!(menu instanceof HTMLElement))
      throw new Error('shared core category More menu did not open');
    const names = [
      ...categories.querySelectorAll(':scope > [aria-label]'),
      ...menu.querySelectorAll('[role="menuitem"]'),
    ].map(
      (item) =>
        item.getAttribute('aria-label') ?? item.textContent?.trim() ?? '',
    );
    for (const name of names) {
      expect(
        name.length,
        'shared core compact categories stay named',
      ).toBeGreaterThan(0);
    }
    expect(names).toEqual(
      expect.arrayContaining(['Pen', 'Highlighter', 'Eraser', 'Selection']),
    );
  });
});

// ---------------------------------------------------------------------------
// popover clamp/flip + safe-area/keyboard insets
// ---------------------------------------------------------------------------

describe('popover geometry (shared core positioner)', () => {
  const pane = { x: 0, y: 0, width: 800, height: 600 };

  it('centers below a normal trigger', () => {
    const position = computeToolbarPopoverPosition({
      trigger: { x: 400, y: 100, width: 40, height: 40 },
      pane,
      popover: { width: 200, height: 100 },
      preferred: 'below',
      inset: 8,
    });
    expect(position.placement).toBe('below');
    expect(position.left).toBe(320);
    expect(position.top).toBe(148);
  });

  it('shifts near pane edges instead of escaping', () => {
    const right = computeToolbarPopoverPosition({
      trigger: { x: 760, y: 100, width: 40, height: 40 },
      pane,
      popover: { width: 200, height: 100 },
      preferred: 'below',
      inset: 8,
    });
    expect(right.left + 200).toBeLessThanOrEqual(800 - 8);
    expect(right.left).toBeGreaterThanOrEqual(8);
    const left = computeToolbarPopoverPosition({
      trigger: { x: 0, y: 100, width: 40, height: 40 },
      pane,
      popover: { width: 200, height: 100 },
      preferred: 'below',
      inset: 8,
    });
    expect(left.left).toBe(8);
  });

  it('flips vertically when the preferred side has no room', () => {
    const flipped = computeToolbarPopoverPosition({
      trigger: { x: 400, y: 540, width: 40, height: 40 },
      pane,
      popover: { width: 200, height: 100 },
      preferred: 'below',
      inset: 8,
    });
    expect(flipped.placement).toBe('above');
    expect(flipped.top).toBe(432);
    const back = computeToolbarPopoverPosition({
      trigger: { x: 400, y: 10, width: 40, height: 40 },
      pane,
      popover: { width: 200, height: 100 },
      preferred: 'above',
      inset: 8,
    });
    expect(back.placement).toBe('below');
  });

  it('clamps a tall popover inside a keyboard-shortened pane', () => {
    // Software keyboard open: the pane keeps only 320px of height for a
    // 420px settings popover — it must clamp (scroll internally), never
    // escape above the keyboard or below the pane.
    const short = { x: 0, y: 0, width: 390, height: 320 };
    const position = computeToolbarPopoverPosition({
      trigger: { x: 175, y: 120, width: 44, height: 44 },
      pane: short,
      popover: { width: 300, height: 420 },
      preferred: 'below',
      inset: 8,
    });
    expect(position.left).toBeGreaterThanOrEqual(8);
    expect(position.left + 300).toBeLessThanOrEqual(390 - 8);
    // Taller than the pane: vertical clamp pins to the inset top so the
    // popover scrolls internally instead of sliding under the keyboard.
    expect(position.top).toBe(8);
  });

  it('respects safe-area insets on all sides', () => {
    const position = computeToolbarPopoverPosition({
      trigger: { x: 400, y: 100, width: 40, height: 40 },
      pane,
      popover: { width: 200, height: 100 },
      preferred: 'below',
      inset: 24,
    });
    expect(position.left).toBeGreaterThanOrEqual(24);
    expect(position.left + 200).toBeLessThanOrEqual(800 - 24);
    expect(position.top).toBeGreaterThanOrEqual(24);
  });

  it('pins safe-area + keyboard insets in the shipped styles', () => {
    const css = shippedCssNoComments();
    const near = (token: string, fragment: string): void => {
      const index = css.indexOf(token, css.indexOf(fragment));
      expect(index, `shipped styles carry ${token}`).toBeGreaterThan(-1);
      const windowText = css.slice(Math.max(0, index - 600), index + 120);
      expect(
        windowText.includes(fragment),
        `shared core: ${token} applies near ${fragment}`,
      ).toBe(true);
    };
    near('--fl-safe-area-left', 'fl-floating-strip');
    near('--fl-safe-area-right', 'fl-floating-strip');
    near('--fl-keyboard-aware-bottom', 'fl-floating-strip');
    near('--fl-keyboard-safe-bottom', 'fl-selection-toolbar-slot');
  });

  it('mounted shelf More overlays fixed (never an in-flow second row)', () => {
    mountToolbar({ view: 'shelf', paneWidth: 500, coarse: true });
    const tools = shelf();
    press(buttonByName(tools, 'More tools'));
    const menu = document.querySelector(
      '[role="group"][aria-label="More tools"]',
    );
    if (!(menu instanceof HTMLElement))
      throw new Error('surface.write ink family More tools did not open');
    expect((menu as HTMLElement).style.position).toBe('fixed');
    expect(menu.getAttribute('data-popover-placement')).not.toBeNull();
    expect(
      host!.querySelectorAll('[data-tool-shelf="surface.write"]'),
      'opening More must not duplicate the shelf row',
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// icon names, no persistent context labels, disabled semantics
// ---------------------------------------------------------------------------

describe('names + disabled semantics', () => {
  it('names every toolbar control; snapshot context survives only as hidden metadata', () => {
    mountToolbar({ view: 'both', paneWidth: 1400 });
    const toolbars = host!.querySelectorAll(
      '[data-toolbar="category-strip"], [data-tool-shelf]',
    );
    expect(toolbars.length).toBeGreaterThan(0);
    for (const toolbar of toolbars) {
      for (const control of toolbar.querySelectorAll('button, select, input')) {
        const name =
          control.getAttribute('aria-label') ??
          control.textContent?.trim() ??
          '';
        expect(
          name.length,
          `surface.write ink family control keeps an accessible name`,
        ).toBeGreaterThan(0);
      }
    }
    // The provider context ('Surface') must not leak as visible toolbar text:
    // every text node carrying it sits inside the visually-hidden metadata.
    const walker = document.createTreeWalker(host!, NodeFilter.SHOW_TEXT);
    const leaks: string[] = [];
    let node = walker.nextNode();
    while (node !== null) {
      if (node.textContent?.includes('Surface') === true) {
        const parent = node.parentElement;
        const hidden =
          parent?.closest('.visually-hidden, [aria-hidden="true"]') !== null;
        if (!hidden) leaks.push(parent?.outerHTML.slice(0, 120) ?? '?');
      }
      node = walker.nextNode();
    }
    expect(leaks, 'no persistent visible context label').toEqual([]);
  });

  it('keeps disabled controls named, inert, and non-executing', () => {
    const listeners = new Set<() => void>();
    const calls: Call[] = [];
    const port = {
      onDidChange: (listener: () => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      execEditorCommand: () => false,
      canExecEditorCommand: () => true,
      editorToolSnapshot: () => ({
        context: 'Surface',
        controls: [
          {
            kind: 'button',
            id: 'test.keep',
            group: 'draw',
            label: 'Keep tool',
          },
          {
            kind: 'button',
            id: 'test.gated',
            group: 'draw',
            label: 'Gated tool',
            disabled: true,
          },
        ],
      }),
      executeEditorTool: (_pane: string, id: string, value?: string) => {
        calls.push(value === undefined ? [id] : [id, value]);
        return true;
      },
    } as unknown as WorkbenchEditorToolsPort;
    const provider = createInkProvider('pen');
    mountWithPort({
      view: 'strip',
      port,
      provider,
      withDefaults: false,
      placements: [
        {
          id: 'test.primary',
          anchor: 'topbar-center',
          controlIds: ['test.keep', 'test.gated'],
          order: 0,
          priority: 100,
          compact: 'never',
        },
      ],
    });
    const bar = host!.querySelector('[data-toolbar="topbar-center"]');
    if (!(bar instanceof HTMLElement))
      throw new Error('shared core legacy topbar did not render');
    const gated = buttonByName(bar, 'Gated tool');
    expect(gated.disabled).toBe(true);
    act(() => {
      gated.click();
    });
    expect(calls, 'disabled control never executes').toEqual([]);
    expect(buttonByName(bar, 'Keep tool').disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// compact coarse targets via the computed-style seam
// ---------------------------------------------------------------------------

describe('coarse 30px targets (computed-style seam)', () => {
  it('mirrors touch availability in JS exactly: 30 coarse, 30 fine', () => {
    stubMedia({ coarse: true });
    expect(autoOverflowWidth()).toBe(30);
    expect(autoOverflowWidth(true)).toBe(30);
    stubMedia({ coarse: false });
    expect(autoOverflowWidth()).toBe(30);
    expect(autoOverflowWidth(false)).toBe(30);
    // Fine primary pointer with touch available anywhere.
    // Availability is OR (not AND, not primary-only): anyCoarse alone must
    // already budget 44 — a primary-only read would return 30 here and an
    // AND read would too, so this leaf distinguishes all three.
    stubMedia({ coarse: false, anyCoarse: true, hover: true, anyHover: true });
    expect(
      autoOverflowWidth(),
      'hybrid any-pointer availability budgets 44',
    ).toBe(30);
    expect(currentInteractionCapabilities()).toMatchObject({
      pointer: 'mouse',
      coarse: true,
      supportsHover: true,
      anyCoarse: true,
      anyHover: true,
    });
    // Contrast leaf: fine primary with no coarse anywhere stays dense even
    // when hover is explicitly on (exercises the overrides).
    stubMedia({ coarse: false, anyCoarse: false, hover: true, anyHover: true });
    expect(autoOverflowWidth(), 'fine-only hosts stay dense at 30').toBe(30);
    expect(currentInteractionCapabilities()).toMatchObject({
      pointer: 'mouse',
      coarse: false,
      anyCoarse: false,
    });
    // Estimator units follow the same availability (never layout reads).
    const touchCells = estimateShelfCells({
      toolIds: ['ink.tool.pen'],
      activeToolId: 'ink.tool.pen',
      hasSettings: true,
      quickCells: estimateShelfQuickBudgets({
        favoriteCount: 0,
        widthOptionCount: 3,
        colorDotCount: 0,
        modeOptionCounts: [],
        touch: true,
      }),
      touch: true,
    });
    const fineCells = estimateShelfCells({
      toolIds: ['ink.tool.pen'],
      activeToolId: 'ink.tool.pen',
      hasSettings: true,
      quickCells: estimateShelfQuickBudgets({
        favoriteCount: 0,
        widthOptionCount: 3,
        colorDotCount: 0,
        modeOptionCounts: [],
        touch: false,
      }),
      touch: false,
    });
    const widthOf = (cells: typeof touchCells, id: string): number =>
      cells.find((cell) => cell.id === id)?.width ?? -1;
    expect(widthOf(touchCells, 'shelf:settings')).toBe(30);
    expect(widthOf(fineCells, 'shelf:settings')).toBe(30);
    expect(shelfCapacityBudget(1024, true)).toBe(
      shelfCapacityBudget(1024, false),
    );
  });

  it('resolves hybrid fine-primary + touch-available hosts to touch density', () => {
    // Capability contract (mirrors interaction-policy.spec.ts): hybrid
    // keeps touch density at every width even though the primary is fine.
    for (const width of [320, 500, 768, 1024, 1400]) {
      expect(
        resolveToolbarPanePresentation({ width, capabilities: HYBRID }).density,
        `hybrid@${width}`,
      ).toBe('touch');
    }
  });

  it('slot triggers compute 30px on coarse (live + placeholder)', () => {
    mountToolbar({ view: 'shelf', paneWidth: 1400, coarse: true });
    injectShipped(['fl-document-tool', 'fl-shelf-slots'], 'coarse-included');
    const slots = shelf().querySelector('[data-slot-kind="pen"]');
    if (!(slots instanceof HTMLElement))
      throw new Error('Pen slots did not render');
    expect(slots.getAttribute('aria-label')).toBe('Pen slots');
    const triggers = [...slots.querySelectorAll(':scope button')];
    expect(triggers.length).toBe(4);
    for (const trigger of triggers) {
      const name =
        trigger.getAttribute('aria-label') ??
        trigger.textContent?.trim() ??
        '?';
      expectCoarseTarget(trigger as HTMLElement, name, 'pen slot');
    }
  });

  it('strip groups compute 30px on coarse (categories + More)', () => {
    mountToolbar({ view: 'strip', paneWidth: 500, coarse: true });
    injectShipped(
      ['fl-toolbar-category', 'fl-document-tool'],
      'coarse-included',
    );
    const categories = strip();
    const triggers = [
      ...categories.querySelectorAll(':scope > button[aria-label]'),
    ];
    expect(triggers.length).toBeGreaterThan(0);
    for (const trigger of triggers) {
      const name = trigger.getAttribute('aria-label') ?? '?';
      const { minHeight } = computedMinTarget(trigger as HTMLElement);
      expect(
        minHeight,
        `Strip group '${name}' computed min-height carries 30px (got ${minHeight})`,
      ).toBe('30px');
    }
  });

  it('deduped shelf: the island owns PDF nav once, at 30px', () => {
    const listeners = new Set<() => void>();
    const provider = createInkProvider('pen');
    const port = {
      onDidChange: (listener: () => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      execEditorCommand: () => false,
      canExecEditorCommand: () => true,
      editorToolSnapshot: () => pdfSnapshot(),
      executeEditorTool: () => true,
    } as unknown as WorkbenchEditorToolsPort;
    mountWithPort({
      view: 'shelf',
      port,
      provider,
      kindId: 'froglight.pdf',
      paneWidth: 1024,
      coarse: true,
      withDefaultPlacements: true,
    });
    injectShipped(['fl-document-tool', 'fl-document-color'], 'coarse-included');
    // Single owner: the control renders exactly once pane-wide, in
    // the geometric island — never duplicated into the composition shelf.
    const navs = host!.querySelectorAll('[aria-label="Previous PDF page"]');
    expect(navs, 'PDF Previous renders exactly once').toHaveLength(1);
    const island = host!.querySelector('[data-anchor="float.bottom-left"]');
    expect(
      island?.querySelector('[aria-label="Previous PDF page"]'),
      'PDF island owns Previous',
    ).not.toBeNull();
    expect(
      island?.querySelector('[aria-label="Next PDF page"]'),
      'PDF island owns Next',
    ).not.toBeNull();
    for (const name of ['Previous PDF page', 'Next PDF page']) {
      const trigger = island!.querySelector(
        `[aria-label="${name}"]`,
      ) as HTMLElement;
      expectCoarseTarget(trigger, name, 'PDF navigation island');
    }
  });

  it('fine-only density stays compact through the same seam (slot box 32px)', () => {
    mountToolbar({ view: 'shelf', paneWidth: 1400, coarse: false });
    // Base alone (no coarse branch): the shared fixed slot box applies.
    injectShipped(['fl-document-tool', 'fl-shelf-slots'], 'base');
    const slots = shelf().querySelector('[data-slot-kind="pen"]');
    if (!(slots instanceof HTMLElement))
      throw new Error('Pen slots did not render');
    const live = slots.querySelector(
      'button[aria-label="Ball Pen"]',
    ) as HTMLElement;
    expect(getComputedStyle(live).width).toBe('32px');
    expect(getComputedStyle(live).minWidth).toBe('32px');
  });
});

// ---------------------------------------------------------------------------
// keyboard / focus contract
// ---------------------------------------------------------------------------

describe('keyboard + focus contract (shared core)', () => {
  it('focus lands inside the category More menu on open', () => {
    mountToolbar({ view: 'strip', paneWidth: 500 });
    press(buttonByName(strip(), 'More tool categories'));
    const menu = document.querySelector(
      '[role="menu"][aria-label="More tool categories"]',
    );
    if (!(menu instanceof HTMLElement))
      throw new Error('shared core category More menu did not open');
    expect(
      menu.contains(document.activeElement),
      'focus-first-on-open lands inside the menu',
    ).toBe(true);
    expect(document.activeElement).toBe(
      menu.querySelector('[role="menuitem"]'),
    );
  });

  it('roves with arrows + Home/End across the More menu (wraps)', () => {
    mountToolbar({ view: 'strip', paneWidth: 500 });
    press(buttonByName(strip(), 'More tool categories'));
    const menu = document.querySelector(
      '[role="menu"][aria-label="More tool categories"]',
    ) as HTMLElement;
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    expect(items.length).toBeGreaterThan(2);
    (items[0] as HTMLElement).focus();
    keyOn(items[0] as HTMLElement, 'ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    keyOn(document.activeElement as HTMLElement, 'ArrowDown');
    expect(document.activeElement).toBe(items[2]);
    // Home/End and wraparound preserve the menu's rendered order.
    keyOn(document.activeElement as HTMLElement, 'End');
    expect(document.activeElement).toBe(items.at(-1));
    keyOn(document.activeElement as HTMLElement, 'ArrowDown');
    expect(document.activeElement).toBe(items[0]);
    keyOn(document.activeElement as HTMLElement, 'ArrowUp');
    expect(document.activeElement).toBe(items.at(-1));
    keyOn(document.activeElement as HTMLElement, 'Home');
    expect(document.activeElement).toBe(items[0]);
  });

  it('Escape closes the More menu and returns focus to its trigger', () => {
    mountToolbar({ view: 'strip', paneWidth: 500 });
    const trigger = buttonByName(strip(), 'More tool categories');
    press(trigger);
    const menu = document.querySelector(
      '[role="menu"][aria-label="More tool categories"]',
    ) as HTMLElement;
    expect(menu).not.toBeNull();
    // Menu-level Escape (keyboard users tabbed into the menu).
    keyOn(menu, 'Escape');
    expect(
      document.querySelector(
        '[role="menu"][aria-label="More tool categories"]',
      ),
      'Escape closes the menu',
    ).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('shelf More is a labelled group with focus-first + Escape-to-trigger', () => {
    mountToolbar({ view: 'shelf', paneWidth: 500, coarse: true });
    const tools = shelf();
    const trigger = buttonByName(tools, 'More tools');
    press(trigger);
    const menu = document.querySelector(
      '[role="group"][aria-label="More tools"]',
    );
    if (!(menu instanceof HTMLElement))
      throw new Error('surface.write ink family More tools did not open');
    // Heterogeneous toolbar controls ride a group, never menu/menuitem.
    expect(menu.querySelector('[role="menuitem"]')).toBeNull();
    expect(
      menu.contains(document.activeElement),
      'focus-first-on-open lands inside the shelf More group',
    ).toBe(true);
    keyOn(menu, 'Escape');
    expect(
      document.querySelector('[role="group"][aria-label="More tools"]'),
      'Escape closes the shelf More group',
    ).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('slot editor dialog: focus-first, Escape returns, Tab never trapped', () => {
    mountToolbar({ view: 'shelf', paneWidth: 1400 });
    const trigger = buttonByName(shelf(), 'Ball Pen');
    press(trigger);
    const dialog = host!.querySelector('[role="dialog"]');
    if (!(dialog instanceof HTMLElement))
      throw new Error('Ball Pen slot editor did not open on second tap');
    expect(dialog.getAttribute('aria-label')).toBe('Ball Pen settings');
    expect(
      dialog.contains(document.activeElement),
      'focus-first-on-open lands inside the slot editor',
    ).toBe(true);
    keyOn(dialog, 'Escape');
    expect(
      host!.querySelector('[role="dialog"]'),
      'Escape closes the slot editor',
    ).toBeNull();
    expect(document.activeElement).toBe(trigger);
    // No trap: the roving handler ignores Tab/Enter/Space so native order
    // always carries focus out of open disclosures.
    const probe = buttonByName(shelf(), 'Ball Pen');
    for (const key of ['Tab', 'Enter', ' ']) {
      expect(
        handleMenuListKeyDown(
          { key, target: probe } as unknown as React.KeyboardEvent,
          shelf(),
        ),
        `Tab-order key '${key}' is never intercepted`,
      ).toBe(false);
    }
  });

  it('group-vs-menu semantics: homogeneous overflow is a menu, heterogeneous is a group', () => {
    mountToolbar({ view: 'both', paneWidth: 500, coarse: true });
    // Homogeneous category overflow: true menu semantics.
    press(buttonByName(strip(), 'More tool categories'));
    const categoryMenu = document.querySelector(
      '[role="menu"][aria-label="More tool categories"]',
    );
    if (!(categoryMenu instanceof HTMLElement))
      throw new Error('shared core category More menu did not open');
    expect(
      categoryMenu.querySelectorAll('[role="menuitem"]').length,
    ).toBeGreaterThan(0);
    keyOn(categoryMenu, 'Escape');
    // Heterogeneous shelf overflow: labelled group (buttons/sliders/selects
    // cannot take menuitem roles).
    press(buttonByName(shelf(), 'More tools'));
    const shelfMenu = document.querySelector(
      '[role="group"][aria-label="More tools"]',
    );
    if (!(shelfMenu instanceof HTMLElement))
      throw new Error('surface.write ink family More tools did not open');
    expect(shelfMenu.getAttribute('role')).toBe('group');
    keyOn(shelfMenu, 'Escape');
  });

  it('placement overflow menu is a labelled group (heterogeneous controls)', () => {
    const listeners = new Set<() => void>();
    const provider = createInkProvider('pen');
    const port = {
      onDidChange: (listener: () => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      execEditorCommand: () => false,
      canExecEditorCommand: () => true,
      editorToolSnapshot: () => ({
        context: 'Surface',
        controls: [
          {
            kind: 'button',
            id: 'test.keep',
            group: 'draw',
            label: 'Keep tool',
          },
          {
            kind: 'button',
            id: 'test.extra',
            group: 'draw',
            label: 'Extra tool',
          },
        ],
      }),
      executeEditorTool: () => true,
    } as unknown as WorkbenchEditorToolsPort;
    mountWithPort({
      view: 'strip',
      port,
      provider,
      withDefaults: false,
      placements: [
        {
          id: 'test.primary',
          anchor: 'topbar-center',
          controlIds: ['test.keep'],
          order: 0,
          priority: 100,
          compact: 'never',
        },
        {
          id: 'test.extra',
          anchor: 'topbar-center',
          controlIds: ['test.extra'],
          order: 10,
          priority: 10,
          compact: 'auto',
        },
      ],
      availableWidth: 260,
      measuredWidths: { 'test.primary': 200, 'test.extra': 200 },
    });
    const bar = host!.querySelector('[data-toolbar="topbar-center"]');
    if (!(bar instanceof HTMLElement))
      throw new Error('shared core legacy topbar did not render');
    expect(buttonByName(bar, 'Keep tool')).not.toBeNull();
    press(buttonByName(bar, 'More document tools'));
    const menu = document.querySelector(
      '[role="group"][aria-label="More document tools"]',
    );
    if (!(menu instanceof HTMLElement))
      throw new Error('shared core placement overflow group did not open');
    expect(menu.querySelector('[role="menuitem"]')).toBeNull();
    expect(
      menu.querySelector('[aria-label="Extra tool"]'),
      'overflowed control stays reachable by name',
    ).not.toBeNull();
  });

  it('exposes AT names + pressed/mixed with a single strip indicator', () => {
    const listeners = new Set<() => void>();
    const provider = createInkProvider('pen');
    const port = {
      onDidChange: (listener: () => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      execEditorCommand: () => false,
      canExecEditorCommand: () => true,
      editorToolSnapshot: () => ({
        context: 'Surface',
        controls: [
          {
            kind: 'button',
            id: 'test.keep',
            group: 'draw',
            label: 'Keep tool',
          },
          {
            kind: 'button',
            id: 'test.mixed',
            group: 'format',
            label: 'Mixed formatting',
            mixed: true,
          },
        ],
      }),
      executeEditorTool: () => true,
    } as unknown as WorkbenchEditorToolsPort;
    mountWithPort({
      view: 'strip',
      port,
      provider,
      withDefaults: false,
      placements: [
        {
          id: 'test.primary',
          anchor: 'topbar-center',
          controlIds: ['test.keep', 'test.mixed'],
          order: 0,
          priority: 100,
          compact: 'never',
        },
      ],
    });
    const bar = host!.querySelector('[data-toolbar="topbar-center"]');
    if (!(bar instanceof HTMLElement))
      throw new Error('shared core legacy topbar did not render');
    // Provider-computed indeterminate state is distinct from active.
    expect(
      buttonByName(bar, 'Mixed formatting').getAttribute('aria-pressed'),
    ).toBe('mixed');
    // Plain buttons without tool state expose no pressed state at all
    // (absent beats a misleading 'false' for stateless actions).
    expect(
      buttonByName(bar, 'Keep tool').getAttribute('aria-pressed'),
    ).toBeNull();
    // Grouped strip: exactly one browsed indicator across strip groups.
    mountToolbar({ view: 'strip', paneWidth: 1400 });
    expect(
      strip().querySelectorAll('[aria-pressed="true"]'),
      'Grouped strip holds one indicator per group (browsed)',
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// analogues: slot geometry/names/second-tap, family-attributed
// ---------------------------------------------------------------------------

describe('slot analogues via the wired shelf (surface.write ink family)', () => {
  it('pen slots render one fixed named group with pressed marked in place', () => {
    mountToolbar({ view: 'shelf', paneWidth: 1400 });
    const slots = shelf().querySelector('[data-slot-kind="pen"]');
    if (!(slots instanceof HTMLElement))
      throw new Error('surface.write ink family pen slots did not render');
    expect(slots.getAttribute('role')).toBe('group');
    expect(slots.getAttribute('aria-label')).toBe('Pen slots');
    expect(slots.getAttribute('data-strip-group')).toBe('surface.write');
    expect(slots.getAttribute('data-overflow-count')).toBe('0');
    const names = [...slots.querySelectorAll(':scope button')].map((button) =>
      button.getAttribute('aria-label'),
    );
    expect(names).toEqual(['Ball Pen', 'Fountain Pen', 'Brush Pen', 'Pencil']);
    expect(
      slots
        .querySelector('button[aria-label="Ball Pen"]')
        ?.getAttribute('aria-pressed'),
      'surface.write marks the live pen in place',
    ).toBe('true');
    expect(
      slots
        .querySelector('button[aria-label="Fountain Pen"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('second tap opens the slot-scoped editor without re-executing the tool', () => {
    const provider = createInkProvider('pen');
    mountToolbar({ view: 'shelf', paneWidth: 1400, provider });
    const callsBefore = provider.calls.length;
    press(buttonByName(shelf(), 'Ball Pen'));
    // Already-active slot: the editor toggles; the canvas tool is untouched.
    expect(
      provider.calls.length,
      'surface.write second tap never re-executes',
    ).toBe(callsBefore);
    const dialog = host!.querySelector('[role="dialog"]');
    if (!(dialog instanceof HTMLElement))
      throw new Error('surface.write Ball Pen slot editor did not open');
    expect(dialog.getAttribute('aria-label')).toBe('Ball Pen settings');
  });

  it('quick settings stay reachable by name inline or behind More', () => {
    // Wide: quicks inline in the surface.write shelf.
    mountToolbar({ view: 'shelf', paneWidth: 1400 });
    const wide = shelf();
    expect(
      wide.querySelector('[aria-label="Quick widths"]') !== null ||
        wide.querySelector('[aria-label="Quick colors"]') !== null,
      'surface.write wide shelf exposes quicks inline',
    ).toBe(true);
    // Narrow touch: quicks overflow explicitly behind More (never scroll-hidden).
    mountToolbar({ view: 'shelf', paneWidth: 500, coarse: true });
    const narrow = shelf();
    press(buttonByName(narrow, 'More tools'));
    const menu = document.querySelector(
      '[role="group"][aria-label="More tools"]',
    );
    if (!(menu instanceof HTMLElement))
      throw new Error('surface.write ink family More tools did not open');
    const widths =
      narrow.querySelector(':scope > [aria-label="Quick widths"]') !== null ||
      menu.querySelector('[aria-label="Quick widths"]') !== null;
    const colors =
      narrow.querySelector(':scope > [aria-label="Quick colors"]') !== null ||
      menu.querySelector('[aria-label="Quick colors"]') !== null;
    expect(widths, 'surface.write widths reachable by name').toBe(true);
    expect(colors, 'surface.write colors reachable by name').toBe(true);
    keyOn(menu, 'Escape');
  });
});
