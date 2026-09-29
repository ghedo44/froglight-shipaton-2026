// @vitest-environment jsdom
/**
 * explicit semantic roles + isolated fallbacks (a)-(f).
 *
 * Verdict table:
 * - (a) placement-resolver ownership: EXPLICIT. Providers, shell controls,
 *   and contributions enter `assembleOwnedPool` before
 *   `resolveToolbarGroups`; no caller gets an implicit provider owner.
 * - (b) palette color `role === undefined` fallback: HARDENED TO EXPLICIT.
 *   Untagged colors stay inert; only `surface.style.color` /
 *   `surface.settings.color` resolve. Same strictness already held for
 *   width/size/saved/erase.size and is pinned here.
 * - (c) eraser/active id-suffix: ISOLATED LEGACY WITH TEST. Explicit
 *   `*Explicit*` helpers are metadata-only; `*ControlId` suffix matchers
 *   remain as marked LEGACY for pre-metadata snapshots.
 * - (d) binder menu seam + viewport-center anchor: KEEP AS LEGACY WITH TEST.
 *   Documented with LEGACY markers; production provides `showPalette`.
 * - (e) topbar-center primaries: REMOVED IN. The composition graph
 *   is the sole primary source; default placements keep geometric utilities
 *   only. Pinned as absence.
 * - (f) TopbarCenterTools show-all when unmeasured: KEEP AS EXPLICIT
 *   FIRST-PAINT WITH TEST. Not semantic inference; jsdom/first-paint only.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  DocumentToolControl,
  DocumentToolSnapshot,
} from '@froglight/foundation';
import { InMemoryStylusService } from '@froglight/foundation';
import type { WorkbenchEditorToolsPort } from './workbench-ports.js';
import { createDocumentToolbarRegistry } from './document-toolbar-registry.js';
import { createToolbarPlacementRegistry } from './toolbar/placement-registry.js';
import {
  assembleOwnedPool,
  resolveToolbarGroups,
} from './toolbar/placement-resolver.js';
import { defaultToolbarPlacements } from './toolbar/default-placements.js';
import { buildStylusPaletteModel } from './stylus-palette-model.js';
import {
  findActiveSurfaceToolId,
  findExplicitActiveSurfaceToolId,
  findExplicitSurfaceEraserControlId,
  findSurfaceEraserControlId,
  isExplicitSurfaceEraserControl,
  isSurfaceEraserControl,
  isSurfaceEraserControlId,
  isSurfaceToolControlId,
} from './stylus-accessory-helpers.js';
import {
  StylusAccessoryBinder,
  type StylusAccessoryMenuAnchor,
} from './stylus-accessory.js';
import { createStylusMenuRegistry } from './stylus-menu-registry.js';
import { TopbarCenterTools } from './react/UnifiedToolbar.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function penTool(active = true): DocumentToolControl {
  return {
    kind: 'button',
    id: 'ink.tool.froglight.ink.pen',
    group: 'draw',
    label: 'Pen',
    role: 'surface-tool',
    toolRole: 'pen',
    semanticRole: 'surface.pen.ball',
    ...(active ? { active: true as const } : {}),
  } as DocumentToolControl;
}

function snapshotWith(
  ...controls: readonly DocumentToolControl[]
): DocumentToolSnapshot {
  return { context: 'Ink canvas', controls: [penTool(true), ...controls] };
}

function colorControl(id: string, role?: string): DocumentToolControl {
  return {
    kind: 'color',
    id,
    group: 'style',
    label: 'Color',
    value: '#111111',
    options: ['#111111', '#222222'],
    ...(role !== undefined ? { semanticRole: role } : {}),
  } as DocumentToolControl;
}

function widthControl(id: string, role?: string): DocumentToolControl {
  return {
    kind: 'choice',
    id,
    group: 'style',
    label: 'Width',
    value: '2',
    options: [
      { value: '2', label: '2 px' },
      { value: '4', label: '4 px' },
    ],
    ...(role !== undefined ? { semanticRole: role } : {}),
  } as DocumentToolControl;
}

function savedControl(id: string, role?: string): DocumentToolControl {
  return {
    kind: 'choice',
    id,
    group: 'style',
    label: 'Saved',
    value: 'a',
    options: [
      { value: '', label: 'Working style' },
      { value: 'a', label: 'A' },
    ],
    ...(role !== undefined ? { semanticRole: role } : {}),
  } as DocumentToolControl;
}

function eraserControl(id: string, role?: string): DocumentToolControl {
  return {
    kind: 'range',
    id,
    group: 'style',
    label: 'Eraser size',
    value: 10,
    min: 2,
    max: 40,
    step: 1,
    ...(role !== undefined ? { semanticRole: role } : {}),
  } as DocumentToolControl;
}

describe('strict semantic roles (b): explicit only, untagged inert', () => {
  it('rejects an arbitrary untagged color control', () => {
    const model = buildStylusPaletteModel(
      snapshotWith(colorControl('ink.color')),
    );
    expect(model).not.toBeNull();
    expect(model?.color).toBeNull();
  });

  it('accepts explicit surface.style.color', () => {
    const model = buildStylusPaletteModel(
      snapshotWith(colorControl('ink.color', 'surface.style.color')),
    );
    expect(model?.color?.id).toBe('ink.color');
    expect(model?.color?.value).toBe('#111111');
  });

  it('accepts explicit surface.settings.color when quick is absent', () => {
    const model = buildStylusPaletteModel(
      snapshotWith(
        colorControl('ink.settings.pen.color', 'surface.settings.color'),
      ),
    );
    expect(model?.color?.id).toBe('ink.settings.pen.color');
  });

  it('rejects unknown color roles', () => {
    const model = buildStylusPaletteModel(
      snapshotWith(colorControl('ink.color', 'surface.unknown')),
    );
    expect(model?.color).toBeNull();
  });

  it('rejects untagged width/size controls', () => {
    const model = buildStylusPaletteModel(
      snapshotWith(widthControl('ink.width')),
    );
    expect(model?.width).toBeNull();
  });

  it('accepts explicit surface.style.width and surface.settings.size', () => {
    const quick = buildStylusPaletteModel(
      snapshotWith(widthControl('ink.width', 'surface.style.width')),
    );
    expect(quick?.width?.id).toBe('ink.width');
    const settings = buildStylusPaletteModel(
      snapshotWith(
        widthControl('ink.settings.pen.size', 'surface.settings.size'),
      ),
    );
    expect(settings?.width?.id).toBe('ink.settings.pen.size');
  });

  it('rejects untagged saved-style controls', () => {
    const model = buildStylusPaletteModel(
      snapshotWith(savedControl('ink.saved')),
    );
    expect(model?.styles).toBeNull();
  });

  it('accepts explicit surface.style.saved', () => {
    const model = buildStylusPaletteModel(
      snapshotWith(savedControl('ink.saved', 'surface.style.saved')),
    );
    expect(model?.styles?.id).toBe('ink.saved');
  });

  it('rejects untagged eraser-size controls', () => {
    const model = buildStylusPaletteModel(
      snapshotWith(eraserControl('ink.eraser-radius')),
    );
    expect(model?.eraserSize).toBeNull();
  });

  it('accepts explicit surface.erase.size and surface.settings.eraser-size', () => {
    const quick = buildStylusPaletteModel(
      snapshotWith(eraserControl('ink.eraser-radius', 'surface.erase.size')),
    );
    expect(quick?.eraserSize?.id).toBe('ink.eraser-radius');
    const settings = buildStylusPaletteModel(
      snapshotWith(
        eraserControl(
          'ink.settings.eraser.radius',
          'surface.settings.eraser-size',
        ),
      ),
    );
    expect(settings?.eraserSize?.id).toBe('ink.settings.eraser.radius');
  });

  it('stays strict through the ownedPool path', () => {
    const untagged = colorControl('ink.color');
    const snapshot = snapshotWith(untagged);
    const model = buildStylusPaletteModel(snapshot, {
      ownedPool: [
        { control: penTool(true), owner: { kind: 'provider' } },
        { control: untagged, owner: { kind: 'provider' } },
      ],
    });
    expect(model?.color).toBeNull();
  });
});

describe('explicit placement ownership (a)', () => {
  const button = (id: string): DocumentToolControl => ({
    kind: 'button',
    id,
    group: 'test',
    label: id,
  });
  const ctx = (pool: readonly DocumentToolControl[]) => ({
    pane: 'main',
    documentId: 'doc-1',
    kindId: 'froglight.markdown',
    editor: {
      context: 'Paragraph',
      controls: [] as readonly DocumentToolControl[],
    },
  });

  const placements = [
    {
      id: 'p',
      anchor: 'topbar-center' as const,
      order: 0,
      controlIds: ['a', 'b'],
    },
  ];

  it('assigns providers their explicit owner before placement', () => {
    const pool = [button('a')];
    const assembled = assembleOwnedPool({ providerControls: pool });
    const resolved = resolveToolbarGroups({
      placements,
      ownedPool: assembled.ownedPool,
      context: ctx(pool),
    });
    expect(resolved.owned.map((o) => o.owner)).toEqual([{ kind: 'provider' }]);
  });

  it('assigns contribution controls their explicit owner before placement', () => {
    const pool = [button('a')];
    const assembled = assembleOwnedPool({
      providerControls: [],
      contributions: [{ contributionId: 'c1', controls: pool }],
    });
    const resolved = resolveToolbarGroups({
      placements,
      ownedPool: assembled.ownedPool,
      context: ctx(pool),
    });
    expect(resolved.owned[0]?.owner).toEqual({
      kind: 'contribution',
      contributionId: 'c1',
    });
  });

  it('keeps provider ownership when a contribution duplicates its id', () => {
    const pool = [button('a'), button('b')];
    const assembled = assembleOwnedPool({
      providerControls: pool,
      contributions: [{ contributionId: 'c1', controls: [button('a')] }],
    });
    const resolved = resolveToolbarGroups({
      placements,
      ownedPool: assembled.ownedPool,
      context: ctx(pool),
    });
    const byId = new Map(resolved.owned.map((o) => [o.control.id, o.owner]));
    expect(byId.get('a')).toEqual({ kind: 'provider' });
    expect(byId.get('b')).toEqual({ kind: 'provider' });
    expect(assembled.diagnostics.join('\n')).toContain(
      'already owned by provider',
    );
  });
});

describe('explicit vs legacy eraser/active matchers (c)', () => {
  const INK_ERASER = 'ink.tool.froglight.ink.eraser';
  const INK_PEN = 'ink.tool.froglight.ink.pen';

  function metaButton(
    id: string,
    extra: Record<string, unknown>,
  ): DocumentToolSnapshot['controls'][number] {
    return {
      kind: 'button',
      id,
      group: 'draw',
      label: id,
      ...extra,
    } as DocumentToolSnapshot['controls'][number];
  }

  it('explicit eraser match uses metadata only', () => {
    const eraser = metaButton(INK_ERASER, {
      role: 'surface-tool',
      toolRole: 'eraser',
    });
    const penWithEraserId = metaButton(INK_ERASER, {
      role: 'surface-tool',
      toolRole: 'pen',
    });
    const untagged = metaButton(INK_ERASER, {});
    expect(isExplicitSurfaceEraserControl(eraser)).toBe(true);
    // A pen never matches as eraser by id shape.
    expect(isExplicitSurfaceEraserControl(penWithEraserId)).toBe(false);
    expect(isExplicitSurfaceEraserControl(untagged)).toBe(false);
  });

  it('legacy suffix matchers stay pinned as legacy', () => {
    expect(isSurfaceEraserControlId(INK_ERASER)).toBe(true);
    expect(isSurfaceEraserControlId('whiteboard.tool.eraser')).toBe(true);
    expect(isSurfaceEraserControlId(INK_PEN)).toBe(false);
    expect(isSurfaceToolControlId(INK_ERASER)).toBe(true);
    expect(isSurfaceToolControlId('ink.export')).toBe(false);
  });

  it('legacy dispatcher prefers metadata, falls back to suffix in isolation', () => {
    const penWithEraserId = metaButton(INK_ERASER, {
      role: 'surface-tool',
      toolRole: 'pen',
    });
    // Explicit wins: pen with eraser-shaped id is not an eraser.
    expect(isSurfaceEraserControl(penWithEraserId)).toBe(false);
    // Pre-metadata untagged eraser id still matches via isolated legacy.
    const untaggedEraser = metaButton(INK_ERASER, {});
    expect(isSurfaceEraserControl(untaggedEraser)).toBe(true);
  });

  it('explicit eraser lookup ignores untagged ids; legacy finds them', () => {
    const snapshot: DocumentToolSnapshot = {
      context: 'Ink',
      controls: [metaButton(INK_PEN, {}), metaButton(INK_ERASER, {})],
    };
    expect(findExplicitSurfaceEraserControlId(snapshot)).toBeNull();
    expect(findSurfaceEraserControlId(snapshot)).toBe(INK_ERASER);
    const explicit: DocumentToolSnapshot = {
      context: 'Ink',
      controls: [
        metaButton(INK_PEN, { role: 'surface-tool', toolRole: 'pen' }),
        metaButton(INK_ERASER, { role: 'surface-tool', toolRole: 'eraser' }),
      ],
    };
    expect(findExplicitSurfaceEraserControlId(explicit)).toBe(INK_ERASER);
    expect(findSurfaceEraserControlId(explicit)).toBe(INK_ERASER);
  });

  it('explicit active lookup ignores untagged ids; legacy finds them', () => {
    const untaggedActive: DocumentToolSnapshot = {
      context: 'Ink',
      controls: [metaButton(INK_PEN, { active: true })],
    };
    expect(findExplicitActiveSurfaceToolId(untaggedActive)).toBeNull();
    expect(findActiveSurfaceToolId(untaggedActive)).toBe(INK_PEN);
    const explicitActive: DocumentToolSnapshot = {
      context: 'Ink',
      controls: [
        metaButton(INK_PEN, {
          role: 'surface-tool',
          toolRole: 'pen',
          active: true,
        }),
      ],
    };
    expect(findExplicitActiveSurfaceToolId(explicitActive)).toBe(INK_PEN);
    expect(findActiveSurfaceToolId(explicitActive)).toBe(INK_PEN);
  });
});

describe('binder legacy seams (d)', () => {
  function legacyHarness(opts: {
    showPalette?: (
      model: unknown,
      anchor: StylusAccessoryMenuAnchor,
    ) => {
      updateAnchor: (a: StylusAccessoryMenuAnchor) => void;
      close: () => void;
      readonly closed: boolean;
    };
    menuAnchor?: () => StylusAccessoryMenuAnchor;
    snapshot?: DocumentToolSnapshot | null;
  }) {
    const service = new InMemoryStylusService();
    const created = createStylusMenuRegistry();
    const shown: Array<{
      entries: readonly { label?: string }[];
      anchor: StylusAccessoryMenuAnchor;
    }> = [];
    const palettes: Array<{ anchor: StylusAccessoryMenuAnchor }> = [];
    const snapshot: DocumentToolSnapshot = opts.snapshot ?? {
      context: 'Ink canvas',
      controls: [
        {
          kind: 'button',
          id: 'ink.tool.froglight.ink.pen',
          group: 'draw',
          label: 'Pen',
          role: 'surface-tool',
          toolRole: 'pen',
          semanticRole: 'surface.pen.ball',
          active: true,
        },
        {
          kind: 'button',
          id: 'ink.tool.froglight.ink.eraser',
          group: 'draw',
          label: 'Eraser',
          role: 'surface-tool',
          toolRole: 'eraser',
          semanticRole: 'surface.erase',
        },
      ] as DocumentToolSnapshot['controls'],
    };
    const binder = new StylusAccessoryBinder({
      service,
      menuRegistry: created.registry,
      tools: {
        editorToolSnapshot: () => snapshot,
        executeEditorTool: () => true,
      },
      focusedPane: () => 'main',
      menuContext: () => ({
        pane: 'main',
        documentId: 'doc-1',
        kindId: 'froglight.ink',
      }),
      showMenu: (entries, anchor) => {
        shown.push({
          entries: entries as readonly { label?: string }[],
          anchor,
        });
      },
      menuAnchor: opts.menuAnchor ?? (() => ({ x: 7, y: 8 })),
      ...(opts.showPalette !== undefined
        ? { showPalette: opts.showPalette as never }
        : {}),
    });
    // Capture palette anchors when a host exists.
    if (opts.showPalette === undefined) {
      // No host: legacy menu seam path.
    }
    return {
      service,
      binder,
      shown,
      palettes,
      dispose() {
        binder.dispose();
        created.dispose();
      },
    };
  }

  it('falls back to the legacy menu seam when showPalette is absent', () => {
    const h = legacyHarness({});
    h.service.handleNativeEvent('action', { type: 'squeeze', phase: 'began' });
    expect(h.shown).toHaveLength(1);
    const labels = h.shown[0]?.entries.map(
      (e) => (e as { label?: string }).label,
    );
    // LEGACY seam renders core-tool labels (not semantic ids) plus registry
    // entries; production hosts provide showPalette instead.
    expect(labels).toContain('Pen');
    expect(labels).toContain('Eraser');
    h.dispose();
  });

  it('uses the viewport-center menuAnchor as isolated last-resort geometry', () => {
    const seen: StylusAccessoryMenuAnchor[] = [];
    const service = new InMemoryStylusService();
    const created = createStylusMenuRegistry();
    const snapshot: DocumentToolSnapshot = {
      context: 'Ink canvas',
      controls: [
        {
          kind: 'button',
          id: 'ink.tool.froglight.ink.pen',
          group: 'draw',
          label: 'Pen',
          role: 'surface-tool',
          toolRole: 'pen',
          semanticRole: 'surface.pen.ball',
          active: true,
        },
      ] as DocumentToolSnapshot['controls'],
    };
    const binder = new StylusAccessoryBinder({
      service,
      menuRegistry: created.registry,
      tools: {
        editorToolSnapshot: () => snapshot,
        executeEditorTool: () => true,
      },
      focusedPane: () => 'main',
      menuContext: () => ({
        pane: 'main',
        documentId: 'doc-1',
        kindId: 'froglight.ink',
      }),
      showMenu: () => undefined,
      menuAnchor: () => ({ x: 7, y: 8 }),
      showPalette: ((model: unknown, anchor: StylusAccessoryMenuAnchor) => {
        seen.push(anchor);
        let closed = false;
        return {
          updateAnchor: () => undefined,
          close: () => {
            closed = true;
          },
          get closed() {
            return closed;
          },
        };
      }) as never,
    });
    // No native anchor, no pen/center deps: must land on menuAnchor.
    service.handleNativeEvent('action', { type: 'squeeze', phase: 'began' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ x: 7, y: 8 });
    binder.dispose();
    created.dispose();
  });
});

describe('topbar-center primaries removed (e)', () => {
  it('keeps no topbar-center primaries: composition is the sole primary source', () => {
    const placements = defaultToolbarPlacements();
    const primaries = placements.filter(
      (p) => p.anchor === 'topbar-center' && p.id.endsWith('.primary'),
    );
    // gate: migrated primaries must stay deleted.
    expect(primaries).toEqual([]);
    for (const id of [
      'froglight.toolbar-placement.markdown.primary',
      'froglight.toolbar-placement.ink.primary',
      'froglight.toolbar-placement.notebook.primary',
      'froglight.toolbar-placement.whiteboard.primary',
    ]) {
      expect(placements.map((p) => p.id)).not.toContain(id);
    }
  });
});

describe('explicit first-paint show-all (f)', () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;
  });

  function mountTopbar(opts: {
    availableWidth?: number;
    measuredWidths?: ReadonlyMap<string, number> | Record<string, number>;
  }): HTMLElement {
    const tools = {
      editorToolSnapshot: (): DocumentToolSnapshot => ({
        context: 'Test',
        controls: [
          { kind: 'button', id: 'a', group: 'test', label: 'A' },
          { kind: 'button', id: 'b', group: 'test', label: 'B' },
        ] as DocumentToolSnapshot['controls'],
      }),
      executeEditorTool: () => true,
      canExecEditorCommand: () => true,
      execEditorCommand: () => true,
      onDidChange: () => ({ dispose: () => undefined }),
    } as unknown as WorkbenchEditorToolsPort;
    const contributions = createDocumentToolbarRegistry();
    const placements = createToolbarPlacementRegistry();
    placements.registry.register({
      id: 'test.group-a',
      anchor: 'topbar-center',
      order: 1,
      controlIds: ['a'],
      priority: 100,
    });
    placements.registry.register({
      id: 'test.group-b',
      anchor: 'topbar-center',
      order: 2,
      controlIds: ['b'],
      priority: 1,
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const props = {
      tools,
      contributions: contributions.registry,
      placements: placements.registry,
      pane: 'pane-1',
      documentId: 'doc-1',
      kindId: 'froglight.test',
      ...(opts.availableWidth !== undefined
        ? { availableWidth: opts.availableWidth }
        : {}),
      ...(opts.measuredWidths !== undefined
        ? { measuredWidths: opts.measuredWidths }
        : {}),
    };
    act(() => {
      root!.render(<TopbarCenterTools {...props} />);
    });
    // Keep registries alive for the mounted tree; dispose on unmount.
    (host as unknown as { __dispose?: () => void }).__dispose = () => {
      contributions.dispose();
      placements.dispose();
    };
    return host;
  }

  it('shows all groups when unmeasured (jsdom/first-paint explicit)', () => {
    const el = mountTopbar({});
    try {
      const bar = el.querySelector('[data-toolbar="topbar-center"]');
      expect(bar).not.toBeNull();
      // Both groups render inline; no overflow trigger before measurement.
      expect(
        bar?.querySelector('[data-placement="test.group-a"]'),
      ).not.toBeNull();
      expect(
        bar?.querySelector('[data-placement="test.group-b"]'),
      ).not.toBeNull();
      expect(bar?.querySelector('[data-overflow-trigger]')).toBeNull();
    } finally {
      (host as unknown as { __dispose?: () => void }).__dispose?.();
    }
  });

  it('overflows low-priority groups once measured', () => {
    const el = mountTopbar({
      availableWidth: 10,
      measuredWidths: { 'test.group-a': 100, 'test.group-b': 100 },
    });
    try {
      const bar = el.querySelector('[data-toolbar="topbar-center"]');
      expect(bar).not.toBeNull();
      expect(bar?.querySelector('[data-overflow-trigger]')).not.toBeNull();
    } finally {
      (host as unknown as { __dispose?: () => void }).__dispose?.();
    }
  });
});
