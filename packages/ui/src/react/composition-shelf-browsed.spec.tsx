// @vitest-environment jsdom
/**
 * Browsed-vs-active shelf isolation.
 *
 * - browsed===active → active-tool quicks/settings visible.
 * - browsed!==active → tools only, quicks/settings hidden; no
 *   duplicated/synthesized settings for the inactive browsed tool.
 * - Strip keeps aria-pressed=browsed + data-contains-active-tool on the
 *   real active category (no single-id merge).
 * - Settings labels always describe the controlling (active) tool.
 *
 * Mounts FloatingToolbarLayer + TopbarCenterTools under
 * UnifiedToolbarProvider (the production Pane composition) with the
 * default composition and real foundation settings controls.
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
  FloatingToolbarLayer,
  resolveActiveToolCategoryId,
  TopbarCenterTools,
  TOOLBAR_COMPACT_QUERY,
  UnifiedToolbarProvider,
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

type ToolKey =
  | 'pen'
  | 'fountain'
  | 'brush'
  | 'pencil'
  | 'highlighter'
  | 'eraser'
  | 'select'
  | 'lasso'
  | 'line'
  | 'rect'
  | 'ellipse'
  | 'text'
  | 'image';

const TOOL_DEFS: readonly {
  readonly key: ToolKey;
  readonly id: string;
  readonly label: string;
  readonly semanticRole: string;
}[] = [
  {
    key: 'pen',
    id: 'ink.tool.pen',
    label: 'Ball Pen',
    semanticRole: 'surface.pen.ball',
  },
  {
    key: 'fountain',
    id: 'ink.tool.fountain',
    label: 'Fountain Pen',
    semanticRole: 'surface.pen.fountain',
  },
  {
    key: 'brush',
    id: 'ink.tool.brush',
    label: 'Brush Pen',
    semanticRole: 'surface.pen.brush',
  },
  {
    key: 'pencil',
    id: 'ink.tool.pencil',
    label: 'Pencil',
    semanticRole: 'surface.pencil',
  },
  {
    key: 'highlighter',
    id: 'ink.tool.highlighter',
    label: 'Highlighter',
    semanticRole: 'surface.highlighter',
  },
  {
    key: 'eraser',
    id: 'ink.tool.eraser',
    label: 'Eraser',
    semanticRole: 'surface.erase',
  },
  {
    key: 'select',
    id: 'ink.tool.select',
    label: 'Select',
    semanticRole: 'surface.select',
  },
  {
    key: 'lasso',
    id: 'ink.tool.lasso',
    label: 'Lasso',
    semanticRole: 'surface.lasso',
  },
  {
    key: 'line',
    id: 'ink.tool.line',
    label: 'Line',
    semanticRole: 'surface.shape.line',
  },
  {
    key: 'rect',
    id: 'ink.tool.rect',
    label: 'Rectangle',
    semanticRole: 'surface.shape.rectangle',
  },
  {
    key: 'ellipse',
    id: 'ink.tool.ellipse',
    label: 'Ellipse',
    semanticRole: 'surface.shape.ellipse',
  },
  {
    key: 'text',
    id: 'ink.tool.text',
    label: 'Text',
    semanticRole: 'surface.insert.text',
  },
  {
    key: 'image',
    id: 'ink.tool.image',
    label: 'Image',
    semanticRole: 'surface.insert.image',
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
  } as never;
}

function makeHost(activeKey: ToolKey): SurfaceToolSettingsHost {
  // Map shelf tool keys to foundation settings segments (pen/fountain share
  // the pen preset path via TOOL_SEGMENTS; rect/ellipse/text/image/select
  // resolve to null → no settings, which is the correct "tools only" state).
  const segment =
    activeKey === 'pen'
      ? 'pen'
      : activeKey === 'fountain'
        ? 'fountain'
        : activeKey === 'brush'
          ? 'brush'
          : activeKey === 'pencil'
            ? 'pencil'
            : activeKey === 'highlighter'
              ? 'highlighter'
              : activeKey;
  return {
    activeToolId: () => `froglight.ink.${segment}`,
    setTool: () => undefined,
    toolPreset: () => ({ color: '#37352f', size: 3.5 }),
    setToolPreset: () => undefined,
    savedStyles: (tool: string) =>
      tool === 'pen' || tool === 'pencil'
        ? [stylePreset('f1', 'Daily', true), stylePreset('f2', 'Fine', false)]
        : [],
    currentStyleId: (tool: string) =>
      tool === 'pen' || tool === 'pencil' ? 'f1' : null,
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
  } as unknown as SurfaceToolSettingsHost;
}

function toolControl(key: ToolKey, activeKey: ToolKey): DocumentToolControl {
  const def = TOOL_DEFS.find((entry) => entry.key === key);
  if (def === undefined) throw new Error(`unknown tool ${key}`);
  return {
    kind: 'button',
    id: def.id,
    group: 'draw',
    label: def.label,
    shortLabel: def.label,
    role: 'surface-tool',
    toolId: def.id,
    semanticRole: def.semanticRole,
    active: key === activeKey,
    activationRole: 'tool',
  } as unknown as DocumentToolControl;
}

// Eraser modes: eraser-active snapshots carry two
// fixed-mode tools providers emit (no `surface.settings.eraser-mode`
// role, so the mode quick stays dormant). Pen-active snapshots keep the
// legacy single eraser — those tests only assert browsed≠active
// tools-only isolation, never eraser identity.
const ERASER_TOOL_DEFS: readonly {
  readonly key: string;
  readonly id: string;
  readonly label: string;
  readonly semanticRole: string;
}[] = [
  {
    key: 'stroke',
    id: 'ink.tool.eraser-stroke',
    label: 'Stroke Eraser',
    semanticRole: 'surface.erase.stroke',
  },
  {
    key: 'precision',
    id: 'ink.tool.eraser-precision',
    label: 'Precision Eraser',
    semanticRole: 'surface.erase.precision',
  },
];

function eraserTrioControls(): DocumentToolControl[] {
  return ERASER_TOOL_DEFS.map(
    (def) =>
      ({
        kind: 'button',
        id: def.id,
        group: 'draw',
        label: def.label,
        shortLabel: def.label,
        role: 'surface-tool',
        toolId: def.id,
        semanticRole: def.semanticRole,
        active: def.key === 'stroke',
        activationRole: 'tool',
      }) as unknown as DocumentToolControl,
  );
}

function snapshotFor(activeKey: ToolKey): DocumentToolSnapshot {
  const settings = buildActiveToolSettingsControls(makeHost(activeKey), {
    prefix: 'ink',
    swatches: [...SWATCHES],
    widths: [...WIDTHS],
  });
  return {
    context: 'Surface',
    controls: [
      ...(TOOL_DEFS.map((def) =>
        toolControl(def.key, activeKey),
      ) as DocumentToolControl[]),
      ...settings,
    ],
  };
}

// Eraser-active snapshot with the two provider modes: they replace the
// legacy single eraser. Every other snapshot keeps the legacy control so
// browsed≠active isolation tests stay scoped to tools-only behavior and
// never assert eraser identity.
function snapshotForEraserTrio(): DocumentToolSnapshot {
  const settings = buildActiveToolSettingsControls(makeHost('eraser'), {
    prefix: 'ink',
    swatches: [...SWATCHES],
    widths: [...WIDTHS],
  });
  return {
    context: 'Surface',
    controls: [
      ...(TOOL_DEFS.filter((def) => def.key !== 'eraser').map((def) =>
        toolControl(def.key, 'eraser'),
      ) as DocumentToolControl[]),
      ...eraserTrioControls(),
      ...settings,
    ],
  };
}

describe('shelf browsed-vs-active isolation', () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    vi.unstubAllGlobals();
  });

  function mount(activeKey: ToolKey): {
    setSnapshot: (next: DocumentToolSnapshot) => void;
    shelf: (category?: string) => HTMLElement;
    strip: () => HTMLElement;
  } {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
    void TOOLBAR_COMPACT_QUERY;
    const listeners = new Set<() => void>();
    let current: DocumentToolSnapshot | null = snapshotFor(activeKey);
    const port: WorkbenchEditorToolsPort = {
      onDidChange: (listener: () => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      execEditorCommand: () => false,
      canExecEditorCommand: () => true,
      editorToolSnapshot: () => current,
      executeEditorTool: () => true,
    } as unknown as WorkbenchEditorToolsPort;
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
    };
    act(() => {
      root!.render(
        <UnifiedToolbarProvider {...toolbarProps}>
          <TopbarCenterTools {...toolbarProps} />
          <FloatingToolbarLayer {...toolbarProps} />
        </UnifiedToolbarProvider>,
      );
    });
    return {
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

  function browse(harness: ReturnType<typeof mount>, category: string): void {
    const button = harness
      .strip()
      .querySelector(`[data-category="${category}"]`);
    if (!(button instanceof HTMLButtonElement))
      throw new Error(`missing category button: ${category}`);
    act(() => button.click());
  }

  function shelfHasPenQuicks(shelf: HTMLElement): boolean {
    return (
      shelf.querySelector('[aria-label="Favorite styles"]') !== null ||
      shelf.querySelector('[aria-label="Quick widths"]') !== null ||
      shelf.querySelector('[aria-label="Quick colors"]') !== null
    );
  }

  it('G: Pen active shows quicks in Write (browsed===active)', () => {
    const harness = mount('pen');
    const shelf = harness.shelf('surface.write');
    expect(
      shelf.querySelector('[aria-label="Favorite styles"]'),
    ).not.toBeNull();
    expect(shelf.querySelector('[aria-label="Quick widths"]')).not.toBeNull();
    expect(shelf.querySelector('[aria-label="Quick colors"]')).not.toBeNull();
    expect(
      shelf.querySelector('button[aria-label="Ball Pen settings"]'),
    ).toBeNull();
  });

  it('Pen active, browsing Shapes shows tools only (no Pen quicks/settings)', () => {
    const harness = mount('pen');
    browse(harness, 'surface.shapes');
    const shelf = harness.shelf('surface.shapes');
    expect(shelf.querySelector('button[aria-label="Line"]')).not.toBeNull();
    expect(
      shelf.querySelector('button[aria-label="Rectangle"]'),
    ).not.toBeNull();
    expect(shelf.querySelector('button[aria-label="Ellipse"]')).not.toBeNull();
    // No leaked Pen quicks/settings, and no misleading Shapes settings
    // synthesized from the Pen controls.
    expect(shelfHasPenQuicks(shelf)).toBe(false);
    expect(shelf.querySelector('button[aria-label$="settings"]')).toBeNull();
    expect(shelf.querySelector('[aria-label="Eraser mode"]')).toBeNull();
    // Strip keeps quiet active-tool marker on Write while Shapes browsed.
    expect(
      harness
        .strip()
        .querySelector('[data-category="surface.write"]')
        ?.getAttribute('data-contains-active-tool'),
    ).toBe('true');
    expect(
      harness
        .strip()
        .querySelector('[data-category="surface.shapes"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      harness
        .strip()
        .querySelector('[data-category="surface.write"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('Pen active, browsing Erase shows only the Eraser tool (no Pen quicks)', () => {
    const harness = mount('pen');
    browse(harness, 'surface.erase');
    const shelf = harness.shelf('surface.erase');
    expect(shelf.querySelector('button[aria-label="Eraser"]')).not.toBeNull();
    expect(shelfHasPenQuicks(shelf)).toBe(false);
    expect(shelf.querySelector('button[aria-label$="settings"]')).toBeNull();
    expect(shelf.querySelector('[aria-label="Eraser mode"]')).toBeNull();
    expect(
      harness
        .strip()
        .querySelector('[data-category="surface.write"]')
        ?.getAttribute('data-contains-active-tool'),
    ).toBe('true');
  });

  it('Pen active, browsing Select shows tools only (no Pen quicks)', () => {
    const harness = mount('pen');
    browse(harness, 'surface.select');
    const shelf = harness.shelf('surface.select');
    expect(shelf.querySelector('button[aria-label="Select"]')).not.toBeNull();
    expect(shelf.querySelector('button[aria-label="Lasso"]')).not.toBeNull();
    expect(shelfHasPenQuicks(shelf)).toBe(false);
    expect(shelf.querySelector('button[aria-label$="settings"]')).toBeNull();
  });

  it('Pen active, browsing Insert shows tools only (no Pen quicks)', () => {
    const harness = mount('pen');
    browse(harness, 'surface.insert');
    const shelf = harness.shelf('surface.insert');
    // Insert carries no Text voice — creation lives in the
    // Text shelf only.
    expect(shelf.querySelector('button[aria-label="Text"]')).toBeNull();
    expect(shelf.querySelector('button[aria-label="Image"]')).not.toBeNull();
    expect(shelfHasPenQuicks(shelf)).toBe(false);
    expect(shelf.querySelector('button[aria-label$="settings"]')).toBeNull();
  });

  it('G: browse Shapes → activate Rectangle follows the active tool', () => {
    const harness = mount('pen');
    browse(harness, 'surface.shapes');
    expect(harness.shelf('surface.shapes')).not.toBeNull();
    harness.setSnapshot(snapshotFor('rect'));
    // Reconciles back to the active-tool category (Shapes) with Rectangle
    // pressed; Rectangle carries no foundation settings, so tools only.
    const shelf = harness.shelf('surface.shapes');
    expect(
      shelf
        .querySelector('button[aria-label="Rectangle"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(shelfHasPenQuicks(shelf)).toBe(false);
  });

  it('G: browse Erase → activate Eraser follows with Eraser quicks/settings', () => {
    const harness = mount('pen');
    browse(harness, 'surface.erase');
    expect(harness.shelf('surface.erase')).not.toBeNull();
    harness.setSnapshot(snapshotForEraserTrio());
    const shelf = harness.shelf('surface.erase');
    // one mode is active (Stroke); mode changes
    // route via tool executes, never a mode dropdown (dormant: the
    // provider emits no `surface.settings.eraser-mode` role).
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
    // label describes the controlling tool (Stroke Eraser, not Pen/Erase).
    expect(
      shelf.querySelector('button[aria-label="Stroke Eraser settings"]'),
    ).toBeNull();
    expect(shelf.querySelector('[aria-label="Eraser mode"]')).toBeNull();
    expect(shelf.querySelector('[aria-label="Eraser size"]')).toBeNull();
    expect(shelf.querySelector('[aria-label="Favorite styles"]')).toBeNull();
  });

  it('G: same-category Pen → Pencil while browsing Shapes reconciles to Write', () => {
    const harness = mount('pen');
    browse(harness, 'surface.shapes');
    expect(harness.shelf('surface.shapes')).not.toBeNull();
    harness.setSnapshot(snapshotFor('pencil'));
    const shelf = harness.shelf('surface.write');
    expect(
      shelf
        .querySelector('button[aria-label="Pencil"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      shelf
        .querySelector('button[aria-label="Ball Pen"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('false');
    // Pencil controls the shelf now — never a stale Ball Pen label.
    expect(
      shelf.querySelector('button[aria-label="Pencil settings"]'),
    ).toBeNull();
    expect(
      shelf.querySelector('button[aria-label="Ball Pen settings"]'),
    ).toBeNull();
  });

  it('G: external Eraser activation while browsing Shapes reconciles to Erase', () => {
    const harness = mount('pen');
    browse(harness, 'surface.shapes');
    expect(harness.shelf('surface.shapes')).not.toBeNull();
    harness.setSnapshot(snapshotFor('eraser'));
    expect(
      host!.querySelector('[data-tool-shelf="surface.shapes"]'),
    ).toBeNull();
    const shelf = harness.shelf('surface.erase');
    expect(
      shelf
        .querySelector('button[aria-label="Eraser"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      shelf.querySelector('button[aria-label="Eraser settings"]'),
    ).toBeNull();
    expect(shelfHasPenQuicks(shelf)).toBe(false);
  });

  it('settings labels always describe the controlling tool', () => {
    const penHarness = mount('pen');
    expect(
      penHarness
        .shelf('surface.write')
        .querySelector('button[aria-label="Ball Pen settings"]'),
    ).toBeNull();
    // Browsing must never synthesize a misleading category-named settings
    // button backed by another tool's controls.
    browse(penHarness, 'surface.shapes');
    expect(
      penHarness
        .shelf('surface.shapes')
        .querySelector('button[aria-label="Shapes settings"]'),
    ).toBeNull();
  });

  it('browse Text then activate Text keeps the shelf on Text (no eject to Insert)', () => {
    // alias: Text creation is dual-homed in surface.insert +
    // surface.text behind one control. Browsing the Text presenter, then
    // activating Text, must keep the Text shelf — the reconcile guard
    // treats either presenter as current when Text is active.
    const harness = mount('pen');
    browse(harness, 'surface.text');
    expect(host!.querySelector('[data-tool-shelf="surface.text"]')).toBeNull();
    harness.setSnapshot(snapshotFor('text'));
    // Shelf stays on Text (not ejected to Insert).
    expect(host!.querySelector('[data-tool-shelf="surface.text"]')).toBeNull();
    expect(
      host!.querySelector('[data-tool-shelf="surface.insert"]'),
    ).toBeNull();
    // Strip keeps the quiet active marker on the canonical Text home
    // while aria-pressed follows the browsed shelf.
    expect(
      harness
        .strip()
        .querySelector('[data-category="surface.text"]')
        ?.getAttribute('data-contains-active-tool'),
    ).toBe('true');
    expect(
      harness
        .strip()
        .querySelector('[data-category="surface.text"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('Text-active attributes to the canonical Text home (not Insert-first)', () => {
    const harness = mount('pen');
    harness.setSnapshot(snapshotFor('text'));
    // No browsing: the alias-aware derivation still attributes Text
    // creation to surface.text so shelf/marker/compact agree on Text.
    expect(host!.querySelector('[data-tool-shelf="surface.text"]')).toBeNull();
    expect(
      host!.querySelector('[data-tool-shelf="surface.insert"]'),
    ).toBeNull();
    expect(
      harness
        .strip()
        .querySelector('[data-category="surface.text"]')
        ?.getAttribute('data-contains-active-tool'),
    ).toBe('true');
    expect(resolveActiveToolCategoryId).toBeDefined();
  });
});
