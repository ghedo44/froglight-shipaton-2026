// @vitest-environment jsdom
/**
 *  grouped-shelf wiring + stickiness
 *
 *
 * Mounted-Pane specs through `UnifiedToolbarProvider` (the production Pane
 * composition) with the default composition and a fake ink provider:
 * grouped strip (effective strip-group keys, one indicator per group),
 * ephemeral per-group last-used (Write pen / Erase mode, no hijack, toggle
 * never writes), verbatim shelf order across 5+ switches, second-activation
 * slot editors (no re-execute, Esc + focus return, resetKey), and compact /
 * capacity overflow (single row, portaled More).
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocumentToolControl } from '@froglight/foundation';
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
  TOOLBAR_COMPACT_QUERY,
  TopbarCenterTools,
  UnifiedToolbarProvider,
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

interface ToolDef {
  readonly key: string;
  readonly id: string;
  readonly label: string;
  readonly semanticRole: string;
  readonly toolRole:
    | 'pen'
    | 'highlighter'
    | 'eraser'
    | 'select'
    | 'lasso'
    | 'shape'
    | 'text';
}

const TOOL_DEFS: readonly ToolDef[] = [
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
  {
    key: 'select',
    id: 'ink.tool.select',
    label: 'Select',
    semanticRole: 'surface.select',
    toolRole: 'select',
  },
  {
    key: 'lasso',
    id: 'ink.tool.lasso',
    label: 'Lasso',
    semanticRole: 'surface.lasso',
    toolRole: 'lasso',
  },
  {
    key: 'line',
    id: 'ink.tool.line',
    label: 'Line',
    semanticRole: 'surface.shape.line',
    toolRole: 'shape',
  },
  {
    key: 'rect',
    id: 'ink.tool.rect',
    label: 'Rectangle',
    semanticRole: 'surface.shape.rectangle',
    toolRole: 'shape',
  },
  {
    key: 'ellipse',
    id: 'ink.tool.ellipse',
    label: 'Ellipse',
    semanticRole: 'surface.shape.ellipse',
    toolRole: 'shape',
  },
  {
    key: 'text',
    id: 'ink.tool.text',
    label: 'Text',
    semanticRole: 'surface.insert.text',
    toolRole: 'text',
  },
];

/**
 * One-shot actions are live and enabled, but never
 * auto-executed by a strip click. Exactly like production
 * (`buildSurfaceImageControl` and the notebook pager verbs) they carry NO
 * `activationRole` and are never `active`, so every exclusive-tool
 * derivation (`isExclusiveActiveToolControl`, `firstLiveStripCategoryTool`,
 * strip memory) ignores them while composition keeps them live in their
 * shelves. A direct shelf tap still runs the action; a STRIP group click
 * must only browse.
 */
interface ActionDef {
  readonly id: string;
  readonly label: string;
  readonly semanticRole: string;
}

const ACTION_DEFS: readonly ActionDef[] = [
  {
    id: 'ink.tool.image',
    label: 'Image',
    semanticRole: 'surface.insert.image',
  },
  {
    id: 'ink.tool.pdf-before',
    label: 'PDF before',
    semanticRole: 'notebook.insert.pdf.before',
  },
  {
    id: 'ink.tool.pdf-after',
    label: 'PDF after',
    semanticRole: 'notebook.insert.pdf.after',
  },
  {
    id: 'ink.tool.pages-overview',
    label: 'Page overview',
    semanticRole: 'notebook.page.overview',
  },
  {
    id: 'ink.tool.pages-add',
    label: 'Add page',
    semanticRole: 'notebook.page.add',
  },
  {
    id: 'ink.tool.pages-duplicate',
    label: 'Duplicate page',
    semanticRole: 'notebook.page.duplicate',
  },
  {
    id: 'ink.tool.pages-delete',
    label: 'Delete page',
    semanticRole: 'notebook.page.delete',
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

function makeHost(activeKey: string): SurfaceToolSettingsHost {
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

/** Fake ink provider: exclusive tools + one toggle + live settings. */
function createProvider(initialKey: string): {
  port: WorkbenchEditorToolsPort;
  calls: Call[];
  setActiveKey: (key: string) => void;
  toggleHold: () => void;
  holdActive: () => boolean;
  notify: () => void;
} {
  const calls: Call[] = [];
  const listeners = new Set<() => void>();
  let activeKey = initialKey;
  let hold = false;
  let eraserMode = 'stroke';
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const toolControl = (def: ToolDef): DocumentToolControl =>
    ({
      kind: 'button',
      id: def.id,
      group: 'draw',
      label: def.label,
      shortLabel: def.label,
      role: 'surface-tool',
      toolId: def.id,
      toolRole: def.toolRole,
      semanticRole: def.semanticRole,
      active: def.key === activeKey,
      activationRole: 'tool',
    }) as unknown as DocumentToolControl;
  const snapshot = () => ({
    context: 'Surface',
    controls: [
      ...(TOOL_DEFS.map(toolControl) as DocumentToolControl[]),
      // Live one-shot actions have no activationRole and are never active.
      ...ACTION_DEFS.map(
        (def) =>
          ({
            kind: 'button',
            id: def.id,
            group: 'draw',
            label: def.label,
            shortLabel: def.label,
            semanticRole: def.semanticRole,
            active: false,
          }) as unknown as DocumentToolControl,
      ),
      {
        kind: 'button',
        id: 'ink.toggle.hold',
        group: 'draw',
        label: 'Straight-line hold',
        shortLabel: 'Hold',
        role: 'surface-tool',
        toolId: 'ink.toggle.hold',
        semanticRole: 'surface.hold',
        active: hold,
        activationRole: 'toggle',
      } as unknown as DocumentToolControl,
      ...buildActiveToolSettingsControls(makeHost(activeKey), {
        prefix: 'ink',
        swatches: [...SWATCHES],
        widths: [...WIDTHS],
      }),
      {
        kind: 'choice',
        id: 'ink.settings.eraser.mode.probe',
        group: 'settings',
        label: 'Eraser mode probe',
        semanticRole: 'surface.settings.eraser-mode',
        value: eraserMode,
        options: [
          { value: 'stroke', label: 'Stroke' },
          { value: 'object', label: 'Object' },
        ],
      } as unknown as DocumentToolControl,
    ],
  });
  const port: WorkbenchEditorToolsPort = {
    onDidChange: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    execEditorCommand: () => false,
    canExecEditorCommand: () => true,
    editorToolSnapshot: () => snapshot(),
    executeEditorTool: (_pane: string, id: string, value?: string) => {
      calls.push([id, value]);
      const tool = TOOL_DEFS.find((def) => def.id === id);
      if (tool !== undefined) {
        activeKey = tool.key;
        notify();
        return true;
      }
      // One-shot actions run without touching the exclusive tool. A shelf
      // tap still works; the strip click path must never reach here.
      if (ACTION_DEFS.some((def) => def.id === id)) return true;
      if (id === 'ink.toggle.hold') {
        hold = !hold;
        notify();
        return true;
      }
      if (id === 'ink.settings.eraser.mode.probe' && value !== undefined) {
        eraserMode = value;
        notify();
        return true;
      }
      // Settings choices route through the same channel; accept without
      // changing the exclusive tool (toggles/modes never drive it).
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
    toggleHold: () => {
      hold = !hold;
      notify();
    },
    holdActive: () => hold,
    notify,
  };
}

describe('grouped strip + stickiness + stable shelf', () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    vi.unstubAllGlobals();
  });

  function stubMedia(input: {
    compact?: boolean;
    coarse?: boolean;
    anyCoarse?: boolean;
  }): void {
    const compact = input.compact ?? false;
    const coarse = input.coarse ?? false;
    const anyCoarse = input.anyCoarse ?? coarse;
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches:
        query === TOOLBAR_COMPACT_QUERY
          ? compact
          : query === '(pointer: coarse)'
            ? coarse
            : query === '(any-pointer: coarse)'
              ? anyCoarse
              : false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
  }

  function mount(
    initialKey = 'pen',
    options: {
      paneWidth?: number;
      documentId?: string;
      kindId?: string;
      extraCategories?: readonly {
        readonly id: string;
        readonly familyId: string;
        readonly label: string;
        readonly icon: string;
        readonly order?: number;
        readonly priority?: number;
        readonly groupId?: string;
      }[];
      extraItems?: readonly {
        readonly id: string;
        readonly categoryId: string;
        readonly semanticRole: string;
        readonly order?: number;
        readonly slotId?: string;
      }[];
    } = {},
  ): {
    provider: ReturnType<typeof createProvider>;
    strip: () => HTMLElement;
    shelf: (category?: string) => HTMLElement;
    rerender: (next: { documentId?: string; kindId?: string }) => void;
  } {
    stubMedia({});
    if (root !== null) {
      act(() => root!.unmount());
      root = null;
    }
    host?.remove();
    const provider = createProvider(initialKey);
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
    for (const entry of options.extraCategories ?? [])
      composition.registry.registerCategory(entry);
    for (const entry of options.extraItems ?? [])
      composition.registry.registerItem(entry);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    let documentId = options.documentId ?? 'doc-1';
    let kindId = options.kindId ?? 'froglight.ink';
    const render = (): void => {
      const toolbarProps = {
        tools: provider.port,
        contributions: contributions.registry,
        placements: placements.registry,
        composition: composition.registry,
        pane: 'pane-1',
        documentId,
        kindId,
        ...(options.paneWidth !== undefined
          ? { paneWidth: options.paneWidth }
          : {}),
      };
      act(() => {
        root!.render(
          <UnifiedToolbarProvider {...toolbarProps}>
            <TopbarCenterTools {...toolbarProps} />
            <FloatingToolbarLayer {...toolbarProps} />
          </UnifiedToolbarProvider>,
        );
      });
    };
    render();
    return {
      provider,
      strip: () => {
        const element = host!.querySelector('[data-toolbar="category-strip"]');
        if (!(element instanceof HTMLElement))
          throw new Error('missing category strip');
        return element;
      },
      shelf: (category = 'surface.write') => {
        const element = host!.querySelector(`[data-tool-shelf="${category}"]`);
        if (!(element instanceof HTMLElement))
          throw new Error(`missing shelf: ${category}`);
        return element;
      },
      rerender: (next: { documentId?: string; kindId?: string }) => {
        if (next.documentId !== undefined) documentId = next.documentId;
        if (next.kindId !== undefined) kindId = next.kindId;
        render();
      },
    };
  }

  function stripButton(
    harness: ReturnType<typeof mount>,
    category: string,
  ): HTMLButtonElement {
    const button = harness
      .strip()
      .querySelector(`[data-category="${category}"]`);
    if (!(button instanceof HTMLButtonElement))
      throw new Error(`missing strip button: ${category}`);
    return button;
  }

  function shelfTool(shelf: HTMLElement, label: string): HTMLButtonElement {
    const button = shelf.querySelector(`button[aria-label="${label}"]`);
    if (!(button instanceof HTMLButtonElement))
      throw new Error(`missing shelf tool: ${label}`);
    return button;
  }

  function shelfToolOrder(shelf: HTMLElement): readonly string[] {
    const known = new Set([
      'Ball Pen',
      'Fountain Pen',
      'Brush Pen',
      'Pencil',
      'Highlighter',
    ]);
    return [...shelf.querySelectorAll('button[aria-label]')]
      .map((button) => button.getAttribute('aria-label') ?? '')
      .filter((label) => known.has(label));
  }

  it('keys strips by effective strip-group id with one indicator per group', () => {
    const harness = mount('pen');
    const buttons = [...harness.strip().querySelectorAll('[data-category]')];
    const groupOf = (id: string): string | null =>
      harness
        .strip()
        .querySelector(`[data-category="${id}"]`)
        ?.getAttribute('data-strip-group') ?? null;
    // Effective keys: singletons key by category id; Insert merges.
    expect(groupOf('surface.write')).toBe('surface.write');
    expect(groupOf('surface.highlighter')).toBe('surface.highlighter');
    expect(groupOf('surface.erase')).toBe('surface.erase');
    expect(groupOf('surface.shapes')).toBe('surface.shapes');
    expect(groupOf('surface.insert')).toBe('surface.insert');
    expect(groupOf('surface.text')).toBe('surface.text');
    expect(buttons.length).toBeGreaterThan(0);
    // One browsed indicator + one canonical active-tool marker.
    expect([
      ...harness.strip().querySelectorAll('[aria-pressed="true"]'),
    ]).toHaveLength(1);
    expect([
      ...harness.strip().querySelectorAll('[data-contains-active-tool="true"]'),
    ]).toHaveLength(1);
  });

  it('Text dual-homed marks the canonical surface.text only', () => {
    const harness = mount('text');
    const marked = [
      ...harness.strip().querySelectorAll('[data-contains-active-tool="true"]'),
    ].map((element) => element.getAttribute('data-category'));
    expect(marked).toEqual(['surface.text']);
  });

  it('Write and Erase restore their last active tools independently', () => {
    const harness = mount('pen');
    // Fountain becomes the remembered Write sibling.
    act(() => shelfTool(harness.shelf(), 'Fountain Pen').click());
    expect(harness.provider.calls.at(-1)?.[0]).toBe('ink.tool.fountain');
    act(() => stripButton(harness, 'surface.erase').click());
    expect(harness.provider.calls.at(-1)?.[0]).toBe('ink.tool.eraser');
    expect(
      shelfTool(harness.shelf('surface.erase'), 'Eraser').getAttribute(
        'aria-pressed',
      ),
    ).toBe('true');
    const callsAfterFirstLive = harness.provider.calls.length;
    act(() => shelfTool(harness.shelf('surface.erase'), 'Eraser').click());
    expect(harness.provider.calls.length).toBe(callsAfterFirstLive);
    act(() => stripButton(harness, 'surface.write').click());
    expect(harness.provider.calls.at(-1)?.[0]).toBe('ink.tool.fountain');
    expect(
      shelfTool(harness.shelf(), 'Fountain Pen').getAttribute('aria-pressed'),
    ).toBe('true');
    act(() => stripButton(harness, 'surface.erase').click());
    expect(harness.provider.calls.at(-1)?.[0]).toBe('ink.tool.eraser');
  });

  it('Text alias sticky restores Text after Write detour', () => {
    const harness = mount('pen');
    act(() => stripButton(harness, 'surface.text').click());
    expect(harness.provider.calls.at(-1)?.[0]).toBe('ink.tool.text');
    expect(
      harness.shelf('surface.text').querySelector('button[aria-label="Text"]'),
    ).toBeNull();
    act(() => stripButton(harness, 'surface.write').click());
    expect(harness.provider.calls.at(-1)?.[0]).toBe('ink.tool.pen');
    act(() => stripButton(harness, 'surface.text').click());
    expect(harness.provider.calls.at(-1)?.[0]).toBe('ink.tool.text');
  });

  it('Insert without history browses without executing (no picker)', () => {
    const harness = mount('pen');
    const callsBefore = harness.provider.calls.length;
    // No memory for the Insert group, Image is a live one-shot action:
    // the strip click must browse the Insert shelf WITHOUT executing
    // (production: no file picker) and WITHOUT falling back into the
    // sibling Shapes tools (no auto-selected Line).
    act(() => stripButton(harness, 'surface.insert').click());
    expect(harness.provider.calls.length).toBe(callsBefore + 1);
    expect(harness.provider.calls.at(-1)?.[0]).toBe('ink.tool.select');
    const shelf = harness.shelf('surface.insert');
    expect(shelf.querySelector('button[aria-label="Image"]')).not.toBeNull();
    expect(shelf.querySelector('[aria-pressed="true"]')).toBeNull();
  });

  it('Notebook Insert browses actions while Pages stays outside the toolbar', () => {
    const harness = mount('pen', { kindId: 'froglight.notebook' });
    // Insert holds live actions (image + PDF before/after): browse only.
    const callsBeforeInsert = harness.provider.calls.length;
    act(() => stripButton(harness, 'surface.insert').click());
    expect(harness.provider.calls.length).toBe(callsBeforeInsert + 1);
    expect(harness.provider.calls.at(-1)?.[0]).toBe('ink.tool.select');
    const insertShelf = harness.shelf('surface.insert');
    expect(
      insertShelf.querySelector('button[aria-label="Image"]'),
    ).not.toBeNull();
    expect(
      insertShelf.querySelector('button[aria-label="PDF before"]'),
    ).not.toBeNull();
    expect(
      insertShelf.querySelector('button[aria-label="PDF after"]'),
    ).not.toBeNull();
    expect(insertShelf.querySelector('[aria-pressed="true"]')).toBeNull();
    expect(
      harness.strip().querySelector('[data-category="notebook.pages"]'),
    ).toBeNull();
  });

  it('Insert falls back to Select while keeping the chosen shelf open', () => {
    const harness = mount('pen', { kindId: 'froglight.notebook' });

    act(() => stripButton(harness, 'surface.insert').click());

    expect(harness.provider.calls.at(-1)?.[0]).toBe('ink.tool.select');
    expect(harness.shelf('surface.insert')).not.toBeNull();
    expect(
      stripButton(harness, 'surface.insert').getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('toggles the active tool menu from the selected primary tool', () => {
    const harness = mount('pen');
    const write = stripButton(harness, 'surface.write');
    const stack = harness.shelf().parentElement;
    expect(stack?.getAttribute('data-open')).toBe('true');
    expect(stack?.hasAttribute('inert')).toBe(false);
    expect(write.getAttribute('aria-expanded')).toBe('true');

    act(() => write.click());
    expect(stack?.getAttribute('data-open')).toBe('false');
    expect(stack?.hasAttribute('inert')).toBe(true);
    expect(write.getAttribute('aria-expanded')).toBe('false');
    expect(host?.querySelector('[role="dialog"]')).toBeNull();

    act(() => write.click());
    expect(stack?.getAttribute('data-open')).toBe('true');
    expect(write.getAttribute('aria-expanded')).toBe('true');

    act(() => stripButton(harness, 'surface.erase').click());
    expect(
      harness.shelf('surface.erase').parentElement?.getAttribute('data-open'),
    ).toBe('true');
    expect(
      stripButton(harness, 'surface.erase').getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('toggles never overwrite sticky memory', () => {
    const harness = mount('pen');
    act(() => shelfTool(harness.shelf(), 'Brush Pen').click());
    expect(harness.provider.calls.at(-1)?.[0]).toBe('ink.tool.brush');
    // Toggle hold (activationRole toggle): exclusive tool unchanged.
    harness.provider.toggleHold();
    expect(harness.provider.holdActive()).toBe(true);
    act(() => stripButton(harness, 'surface.erase').click());
    expect(harness.provider.calls.at(-1)?.[0]).toBe('ink.tool.eraser');
    const callsAfterFirstLive = harness.provider.calls.length;
    act(() => shelfTool(harness.shelf('surface.erase'), 'Eraser').click());
    expect(harness.provider.calls.length).toBe(callsAfterFirstLive);
    act(() => stripButton(harness, 'surface.write').click());
    expect(harness.provider.calls.at(-1)?.[0]).toBe('ink.tool.brush');
    expect(
      shelfTool(harness.shelf(), 'Brush Pen').getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('keeps the Pen shelf stable and makes Highlighter a direct strip action', () => {
    const harness = mount('pen');
    const orders: string[] = [];
    const record = (): void => {
      orders.push(shelfToolOrder(harness.shelf()).join('|'));
    };
    record();
    for (const label of [
      'Fountain Pen',
      'Brush Pen',
      'Pencil',
      'Ball Pen',
      'Fountain Pen',
    ]) {
      act(() => shelfTool(harness.shelf(), label).click());
      // The newly active tool is pressed exactly where it always sits.
      expect(
        shelfTool(harness.shelf(), label).getAttribute('aria-pressed'),
      ).toBe('true');
      record();
    }
    for (const order of orders) expect(order).toBe(orders[0]);
    expect(orders[0]?.split('|')).toEqual([
      'Ball Pen',
      'Fountain Pen',
      'Brush Pen',
      'Pencil',
    ]);
    act(() => stripButton(harness, 'surface.highlighter').click());
    expect(harness.provider.calls.at(-1)?.[0]).toBe('ink.tool.highlighter');
    expect(
      shelfTool(
        harness.shelf('surface.highlighter'),
        'Highlighter',
      ).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('second activation opens the slot editor without re-executing', () => {
    const harness = mount('pen');
    const size = harness.shelf().querySelector('[data-slot-kind="pen"]');
    expect(size).not.toBeNull();
    const callsBefore = harness.provider.calls.length;
    act(() => shelfTool(harness.shelf(), 'Ball Pen').click());
    // Already active: second activation toggles the editor, no execute.
    expect(harness.provider.calls.length).toBe(callsBefore);
    const dialog = host!.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-label')).toBe('Ball Pen settings');
  });

  it('Esc closes the editor and returns focus to the slot', () => {
    const harness = mount('pen');
    const trigger = shelfTool(harness.shelf(), 'Ball Pen');
    act(() => trigger.click());
    expect(host!.querySelector('[role="dialog"]')).not.toBeNull();
    act(() => {
      trigger.focus();
      trigger.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(host!.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('resetKey (pane:document) clears the open editor', () => {
    const harness = mount('pen');
    act(() => shelfTool(harness.shelf(), 'Ball Pen').click());
    expect(host!.querySelector('[role="dialog"]')).not.toBeNull();
    harness.rerender({ documentId: 'doc-2' });
    expect(host!.querySelector('[role="dialog"]')).toBeNull();
  });

  it('compact strip stays single-row with a portaled More', () => {
    stubMedia({});
    const harness = mount('pen', { paneWidth: 500 });
    expect(harness.strip().getAttribute('data-compact')).toBe('true');
    const more = harness
      .strip()
      .querySelector('button[aria-label="More tool categories"]');
    if (!(more instanceof HTMLButtonElement))
      throw new Error('missing strip More');
    act(() => more.click());
    const menu = document.querySelector(
      '[role="menu"][aria-label="More tool categories"]',
    );
    expect(menu).not.toBeNull();
  });

  it('hides the shelf when category More opens after closing slot settings', () => {
    const harness = mount('pen', { paneWidth: 500 });
    const pen = shelfTool(harness.shelf(), 'Ball Pen');
    act(() => pen.click());
    const dialog = host!.querySelector('[role="dialog"]');
    if (!(dialog instanceof HTMLElement))
      throw new Error('missing Ball Pen settings');
    act(() =>
      dialog.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );

    const more = harness
      .strip()
      .querySelector('button[aria-label="More tool categories"]');
    if (!(more instanceof HTMLButtonElement))
      throw new Error('missing strip More');
    act(() => more.click());

    expect(
      document.querySelector(
        '[role="menu"][aria-label="More tool categories"]',
      ),
    ).not.toBeNull();
    expect(host!.querySelector('[data-tool-shelf]')).toBeNull();
  });

  it('measured shelf uses the space freed by the settings gear', () => {
    stubMedia({ coarse: true });
    const harness = mount('pen', { paneWidth: 768 });
    const shelf = harness.shelf();
    expect(shelf.querySelector('button[aria-label="More tools"]')).toBeNull();
    expect(
      shelf.querySelector(':scope > button[aria-label="Ball Pen settings"]'),
    ).toBeNull();
  });

  it('pen slots keep four fixed positions with the active slot pressed', () => {
    const harness = mount('pen');
    const slots = harness.shelf().querySelector('[data-slot-kind="pen"]');
    if (!(slots instanceof HTMLElement)) throw new Error('missing pen slots');
    expect(slots.getAttribute('data-strip-group')).toBe('surface.write');
    expect(slots.getAttribute('data-overflow-count')).toBe('0');
    const triggers = [...slots.querySelectorAll(':scope button')];
    expect(triggers).toHaveLength(4);
    expect(
      slots
        .querySelector('button[aria-label="Ball Pen"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('non-Write category with pen conduits gets fixed slots (no id gate)', () => {
    // A renamed/regrouped pen family under a foreign category id still
    // slots: the shelf gates on pen-conduit presence, never on
    // `surface.write`.
    const harness = mount('pen', {
      extraCategories: [
        {
          id: 'custom.studio',
          familyId: 'surface',
          label: 'Studio',
          icon: 'pen',
          order: 5,
          priority: 110,
        },
      ],
      extraItems: [
        {
          id: 'custom.studio.ball',
          categoryId: 'custom.studio',
          semanticRole: 'surface.pen.ball',
          order: 10,
        },
        {
          id: 'custom.studio.fountain',
          categoryId: 'custom.studio',
          semanticRole: 'surface.pen.fountain',
          order: 20,
        },
        {
          id: 'custom.studio.brush',
          categoryId: 'custom.studio',
          semanticRole: 'surface.pen.brush',
          order: 30,
        },
        {
          id: 'custom.studio.pencil',
          categoryId: 'custom.studio',
          semanticRole: 'surface.pencil',
          order: 40,
        },
      ],
    });
    expect(
      harness.strip().querySelector('[data-category="custom.studio"]'),
    ).not.toBeNull();
    const shelf = harness.shelf('custom.studio');
    const slots = shelf.querySelector('[data-slot-kind="pen"]');
    if (!(slots instanceof HTMLElement))
      throw new Error('missing pen slots on foreign category');
    expect(slots.getAttribute('data-strip-group')).toBe('custom.studio');
    expect([...slots.querySelectorAll(':scope button')]).toHaveLength(4);
    expect(
      slots
        .querySelector('button[aria-label="Ball Pen"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('kind switch clears sticky memory (ink pen never leaks into notebook)', () => {
    const harness = mount('pen');
    act(() => shelfTool(harness.shelf(), 'Fountain Pen').click());
    expect(harness.provider.calls.at(-1)?.[0]).toBe('ink.tool.fountain');
    // Same pane now hosts a notebook document: the ink scope is gone.
    harness.rerender({ kindId: 'froglight.notebook' });
    const callsBefore = harness.provider.calls.length;
    act(() => stripButton(harness, 'surface.write').click());
    // Browse-only (fail-soft): no stale ink sibling re-executed.
    expect(harness.provider.calls.length).toBe(callsBefore);
  });

  it('document switch clears sticky memory (reload-reset)', () => {
    const harness = mount('pen');
    act(() => shelfTool(harness.shelf(), 'Fountain Pen').click());
    expect(harness.provider.calls.at(-1)?.[0]).toBe('ink.tool.fountain');
    harness.rerender({ documentId: 'doc-2' });
    const callsBefore = harness.provider.calls.length;
    act(() => stripButton(harness, 'surface.write').click());
    expect(harness.provider.calls.length).toBe(callsBefore);
  });

  it('PDF-backed source selection shows no pen quicks or settings', () => {
    // Divergent snapshot replicating notebook pdfBacked source-select
    // draw marks Select active via the PDF override
    // while the settled schema/values stay pen. The shelf must show tools
    // only (Select-has-no-settings) — zero pen quicks/settings — while
    // draw keeps showing Select.
    stubMedia({});
    if (root !== null) {
      act(() => root!.unmount());
      root = null;
    }
    host?.remove();
    const listeners = new Set<() => void>();
    const calls: Call[] = [];
    const selectControl = (def: ToolDef): DocumentToolControl =>
      ({
        kind: 'button',
        id: def.id,
        group: 'draw',
        label: def.label,
        shortLabel: def.label,
        role: 'surface-tool',
        toolId: def.id,
        toolRole: def.toolRole,
        semanticRole: def.semanticRole,
        active: def.key === 'select',
        activationRole: 'tool',
      }) as unknown as DocumentToolControl;
    const snapshot = (): {
      context: string;
      controls: DocumentToolControl[];
    } => ({
      context: 'Surface',
      controls: [
        ...(TOOL_DEFS.map(selectControl) as DocumentToolControl[]),
        ...buildActiveToolSettingsControls(makeHost('pen'), {
          prefix: 'ink',
          swatches: [...SWATCHES],
          widths: [...WIDTHS],
        }),
      ],
    });
    const port = {
      onDidChange: (listener: () => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      execEditorCommand: () => false,
      canExecEditorCommand: () => true,
      editorToolSnapshot: () => snapshot(),
      executeEditorTool: (_pane: string, id: string, value?: string) => {
        calls.push([id, value]);
        return true;
      },
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
    const shelf = host!.querySelector('[data-tool-shelf="surface.select"]');
    if (!(shelf instanceof HTMLElement))
      throw new Error('missing Select shelf');
    // Draw keeps showing Select (readers depend on it): the strip marks
    // the Select category active and the shelf presses Select in place.
    expect(
      host!
        .querySelector('[data-category="surface.select"]')
        ?.getAttribute('data-contains-active-tool'),
    ).toBe('true');
    expect(
      shelf
        .querySelector('button[aria-label="Select"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(shelf.querySelector('button[aria-label="Lasso"]')).not.toBeNull();
    // Select-has-no-settings: zero pen quicks/settings even though the
    // snapshot carries pen settings (settled pen divergence).
    expect(shelf.querySelector('[aria-label="Favorite styles"]')).toBeNull();
    expect(shelf.querySelector('[aria-label="Quick widths"]')).toBeNull();
    expect(shelf.querySelector('[aria-label="Quick colors"]')).toBeNull();
    expect(shelf.querySelector('[aria-label="Eraser mode"]')).toBeNull();
    expect(shelf.querySelector('[aria-label="Eraser size"]')).toBeNull();
    expect(shelf.querySelector('button[aria-label$="settings"]')).toBeNull();
  });

  it('resetKey clears all disclosures (slot, shelf More, and category More)', () => {
    // Narrow pane forces both the strip category More and the shelf More
    // alongside the pen-slot editor, so one rerender must clear every kind.
    const harness = mount('pen', { paneWidth: 500 });
    // Slot editor clears.
    act(() => shelfTool(harness.shelf(), 'Ball Pen').click());
    expect(host!.querySelector('[role="dialog"]')).not.toBeNull();
    harness.rerender({ documentId: 'doc-2' });
    expect(host!.querySelector('[role="dialog"]')).toBeNull();
    // Shelf More clears.
    const shelfMore = harness
      .shelf()
      .querySelector('button[aria-label="More tools"]');
    if (!(shelfMore instanceof HTMLButtonElement))
      throw new Error('missing shelf More for resetKey pin');
    act(() => shelfMore.click());
    expect(
      document.querySelector('[role="group"][aria-label="More tools"]'),
    ).not.toBeNull();
    harness.rerender({ documentId: 'doc-3' });
    expect(
      document.querySelector('[role="group"][aria-label="More tools"]'),
    ).toBeNull();
    expect(host!.querySelector('[role="dialog"]')).toBeNull();
    // Category More clears.
    const categoryMore = harness
      .strip()
      .querySelector('button[aria-label="More tool categories"]');
    if (!(categoryMore instanceof HTMLButtonElement))
      throw new Error('missing category More for resetKey pin');
    act(() => categoryMore.click());
    expect(
      document.querySelector(
        '[role="menu"][aria-label="More tool categories"]',
      ),
    ).not.toBeNull();
    harness.rerender({ documentId: 'doc-4' });
    expect(
      document.querySelector(
        '[role="menu"][aria-label="More tool categories"]',
      ),
    ).toBeNull();
  });

  it('opening More closes the slot editor so only one disclosure stays open', () => {
    const harness = mount('pen', { paneWidth: 500 });
    // Open the pen-slot editor (second tap on the active slot).
    act(() => shelfTool(harness.shelf(), 'Ball Pen').click());
    expect(host!.querySelector('[role="dialog"]')).not.toBeNull();
    // Opening the shelf More claims the same pane scope: the slot editor
    // closes so exactly one disclosure stays open (portaled More intact,
    // Esc/outside + focus return unchanged).
    const shelfMore = harness
      .shelf()
      .querySelector('button[aria-label="More tools"]');
    if (!(shelfMore instanceof HTMLButtonElement))
      throw new Error('missing shelf More for exclusive pin');
    act(() => shelfMore.click());
    expect(host!.querySelector('[role="dialog"]')).toBeNull();
    const menu = document.querySelector(
      '[role="group"][aria-label="More tools"]',
    );
    expect(menu).not.toBeNull();
    const openCount =
      host!.querySelectorAll('[role="dialog"]').length +
      document.querySelectorAll(
        '[role="menu"], [role="group"][aria-label="More tools"]',
      ).length;
    expect(openCount).toBe(1);
  });
});
