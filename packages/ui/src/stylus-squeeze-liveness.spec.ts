/**
 * Squeeze liveness, equality, and diagnostics.
 *
 * Binder-seam proofs (public `StylusAccessoryBinder` interface only) plus
 * hook proxy-seam proofs (`createResubscribingLiveness`,
 * `createStylusAccessoryStablePorts`):
 * - open palette follows external provider state via
 *   `tools.onDidChange` (subscribed once per binder lifetime) with
 *   in-place `updateModel` (no re-open, no remount). Equality gates no-ops.
 *  extends to canUndo/canRedo + saved-style/favorites.
 * - narrow proxy forwards `entries` + `onDidChange` (Deps and
 *   stable proxy Picks); contribution appears/disappears live;
 *   dispose/re-enable subscribes exactly once; the proxy path opens too.
 * - `squeezeModelsEqual` covers id/label/shortLabel/icon/active/
 *   disabled/toolRole/semanticRole/activationRole/owner + More visible
 *   fields + style section labels; never callback/control identity.
 * - throwing registry/composition/provider probes degrade +
 *   produce diagnostics; an absent optional stays silent. Fan-out guards
 *   cover focusedPane/menuContext/subscribe-throw/UI-leak.
 * - (delta): live provider/registry/composition swap while open
 *   re-establishes push without remount/leak (proxy reconcile +
 *   `updateLiveRegistries`).
 *
 * Frozen:, execution ownership, no polling/second store/remount,
 * no squeeze-while-open close+reopen, no changed/ended extra toggles.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryStylusService,
  type DocumentToolSnapshot,
} from '@froglight/foundation';
import {
  StylusAccessoryBinder,
  type StylusAccessoryMenuAnchor,
  type StylusPaletteHandle,
} from './stylus-accessory.js';
import type { StylusPaletteModel } from './stylus-palette-model.js';
import type { MenuEntry } from './menu.js';
import { createStylusMenuRegistry } from './stylus-menu-registry.js';
import { createDocumentToolbarRegistry } from './document-toolbar-registry.js';
import { createToolbarCompositionRegistry } from './toolbar/composition-registry.js';
import { defaultToolbarComposition } from './toolbar/default-composition.js';
import { registerCommunityToolbarContribution } from './toolbar/community-contribution.js';
import {
  createResubscribingLiveness,
  createStylusAccessoryStablePorts,
} from './react/workspace/hooks/useStylusAccessory.js';

function surfaceButton(
  id: string,
  extra: Record<string, unknown> = {},
): DocumentToolSnapshot['controls'][number] {
  const toolRole = id.endsWith('.pen')
    ? 'pen'
    : id.endsWith('.brush')
      ? 'pen'
      : id.endsWith('.highlighter')
        ? 'highlighter'
        : id.endsWith('.eraser')
          ? 'eraser'
          : undefined;
  const semanticRole = id.endsWith('.pen')
    ? 'surface.pen.ball'
    : id.endsWith('.brush')
      ? 'surface.pen.brush'
      : id.endsWith('.highlighter')
        ? 'surface.highlighter'
        : id.endsWith('.eraser')
          ? 'surface.erase'
          : undefined;
  return {
    kind: 'button',
    id,
    group: 'draw',
    label: id,
    role: 'surface-tool',
    ...(toolRole !== undefined ? { toolRole } : {}),
    ...(semanticRole !== undefined ? { semanticRole } : {}),
    ...extra,
  } as DocumentToolSnapshot['controls'][number];
}

function surfaceSnapshot(): DocumentToolSnapshot {
  return {
    context: 'Ink canvas',
    controls: [
      surfaceButton('ink.tool.froglight.ink.pen', { active: true }),
      surfaceButton('ink.tool.froglight.ink.highlighter'),
      surfaceButton('ink.tool.froglight.ink.eraser'),
      {
        kind: 'color',
        id: 'ink.color',
        group: 'style',
        label: 'Stroke color',
        value: '#37352f',
        options: ['#37352f', '#7c6cf0'],
        semanticRole: 'surface.style.color',
      },
      {
        kind: 'choice',
        id: 'ink.width',
        group: 'style',
        label: 'Stroke width',
        value: '3.5',
        options: [{ value: '3.5', label: '3.5 px' }],
        semanticRole: 'surface.style.width',
      },
      {
        kind: 'choice',
        id: 'ink.settings.pen.saved-style',
        group: 'style',
        label: 'Saved styles',
        value: 'a',
        options: [
          { value: '', label: 'Working style' },
          { value: 'a', label: 'Atelier' },
        ],
        semanticRole: 'surface.style.saved',
      },
    ] as DocumentToolSnapshot['controls'],
  };
}

function installDefaults(
  composition: ReturnType<typeof createToolbarCompositionRegistry>['registry'],
): void {
  const defaults = defaultToolbarComposition();
  for (const entry of defaults.categories)
    composition.registerCategory(entry);
  for (const entry of defaults.items) composition.registerItem(entry);
  for (const entry of defaults.extensions)
    composition.registerKindExtension(entry);
}

function act(
  service: InMemoryStylusService,
  payload: Record<string, unknown>,
): void {
  service.handleNativeEvent('action', payload);
}

interface LiveHandle extends StylusPaletteHandle {
  updated: StylusPaletteModel[];
}

/** Tools double with observable `onDidChange` liveness. */
function toolsWithLiveness(initial: DocumentToolSnapshot) {
  let snapshot: DocumentToolSnapshot = initial;
  const listeners = new Set<() => void>();
  let subscribeCount = 0;
  const disposeCounts: number[] = [];
  return {
    get snapshot() {
      return snapshot;
    },
    set snapshot(next: DocumentToolSnapshot) {
      snapshot = next;
    },
    port() {
      return {
        editorToolSnapshot: () => snapshot,
        executeEditorTool: () => true,
        onDidChange: (listener: () => void) => {
          subscribeCount += 1;
          listeners.add(listener);
          let disposed = false;
          return {
            dispose: () => {
              if (disposed) return;
              disposed = true;
              listeners.delete(listener);
              disposeCounts.push(1);
            },
          };
        },
      };
    },
    emit() {
      for (const listener of [...listeners]) listener();
    },
    subscribeCount: () => subscribeCount,
    disposeCount: () => disposeCounts.length,
  };
}

function liveBinderHarness(opts: {
  tools?: ReturnType<typeof toolsWithLiveness>;
  diagnostics?: string[];
} = {}) {
  const service = new InMemoryStylusService();
  const menus = createStylusMenuRegistry();
  const composition = createToolbarCompositionRegistry();
  const toolbarControls = createDocumentToolbarRegistry();
  installDefaults(composition.registry);
  const tools = opts.tools ?? toolsWithLiveness(surfaceSnapshot());
  const diagnostics = opts.diagnostics ?? [];
  const palettes: Array<{
    model: StylusPaletteModel;
    anchor: StylusAccessoryMenuAnchor;
  }> = [];
  const handles: LiveHandle[] = [];
  const binder = new StylusAccessoryBinder({
    service,
    menuRegistry: menus.registry,
    toolbarComposition: composition.registry,
    toolbarRegistry: toolbarControls.registry,
    tools: tools.port(),
    focusedPane: () => 'main',
    menuContext: () => ({
      pane: 'main',
      documentId: 'doc-1',
      kindId: 'froglight.ink',
    }),
    showMenu: () => undefined,
    menuAnchor: () => ({ x: 10, y: 20 }),
    showPalette: (model, anchor) => {
      palettes.push({ model, anchor });
      const updated: StylusPaletteModel[] = [];
      let closed = false;
      const handle = {
        updated,
        updateAnchor: () => undefined,
        updateModel(next: StylusPaletteModel): void {
          updated.push(next);
        },
        close() {
          closed = true;
        },
        get closed() {
          return closed;
        },
      } satisfies LiveHandle;
      handles.push(handle as LiveHandle);
      return handle;
    },
    commands: {
      canExecEditorCommand: (command) => command === 'undo',
      execEditorCommand: () => true,
    },
    diagnostics: (message) => {
      diagnostics.push(message);
    },
  });
  return {
    service,
    binder,
    menus,
    composition,
    toolbarControls,
    tools,
    palettes,
    handles,
    diagnostics,
    dispose() {
      binder.dispose();
      menus.dispose();
      composition.dispose();
      toolbarControls.dispose();
    },
  };
}

function withActiveTool(
  snapshot: DocumentToolSnapshot,
  activeId: string,
): DocumentToolSnapshot {
  return {
    ...snapshot,
    controls: snapshot.controls.map((control) =>
      control.kind === 'button' && control.role === 'surface-tool'
        ? { ...control, active: control.id === activeId }
        : control,
    ),
  } as DocumentToolSnapshot;
}

describe('H1 open squeeze follows external tool state (tools.onDidChange)', () => {
  it('subscribed ONCE per binder lifetime; external Pen→Eraser refreshes in place without re-open', () => {
    const h = liveBinderHarness();
    try {
      act(h.service, {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 100, y: 100 },
      });
      expect(h.palettes).toHaveLength(1);
      expect(h.palettes[0]?.model.activeToolId).toBe(
        'ink.tool.froglight.ink.pen',
      );
      expect(h.tools.subscribeCount()).toBe(1);
      // External provider commit lands while open (no palette selection).
      h.tools.snapshot = withActiveTool(
        surfaceSnapshot(),
        'ink.tool.froglight.ink.eraser',
      );
      h.tools.emit();
      expect(h.handles[0]?.updated).toHaveLength(1);
      expect(h.handles[0]?.updated[0]?.activeToolId).toBe(
        'ink.tool.froglight.ink.eraser',
      );
      // No re-open, no remount: single showPalette/handle, still open.
      expect(h.palettes).toHaveLength(1);
      expect(h.handles).toHaveLength(1);
      expect(h.handles[0]?.closed).toBe(false);
      // Equality gate: emitting without a change pushes nothing.
      h.tools.emit();
      expect(h.handles[0]?.updated).toHaveLength(1);
    } finally {
      h.dispose();
    }
  });

  it('external color/width/history changes refresh in place; no-op emits stay gated', () => {
    const h = liveBinderHarness();
    try {
      act(h.service, {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 10, y: 10 },
      });
      expect(h.palettes).toHaveLength(1);
      const base = surfaceSnapshot();
      h.tools.snapshot = {
        ...base,
        controls: base.controls.map((control) => {
          if (control.kind === 'color' && control.id === 'ink.color')
            return { ...control, value: '#7c6cf0' };
          if (control.kind === 'choice' && control.id === 'ink.width')
            return { ...control, value: '7.0', options: [{ value: '7.0', label: '7.0 px' }] };
          return control;
        }),
      } as DocumentToolSnapshot;
      h.tools.emit();
      expect(h.handles[0]?.updated).toHaveLength(1);
      expect(h.handles[0]?.updated[0]?.color?.value).toBe('#7c6cf0');
      expect(h.handles[0]?.updated[0]?.width?.value).toBe('7.0');
      expect(h.palettes).toHaveLength(1);
    } finally {
      h.dispose();
    }
  });

  it('legacy tools without onDidChange stay valid with no push (no polling)', () => {
    const service = new InMemoryStylusService();
    const menus = createStylusMenuRegistry();
    const composition = createToolbarCompositionRegistry();
    const toolbarControls = createDocumentToolbarRegistry();
    installDefaults(composition.registry);
    const palettes: StylusPaletteModel[] = [];
    const binder = new StylusAccessoryBinder({
      service,
      menuRegistry: menus.registry,
      toolbarComposition: composition.registry,
      toolbarRegistry: toolbarControls.registry,
      tools: {
        editorToolSnapshot: () => surfaceSnapshot(),
        executeEditorTool: () => true,
      },
      focusedPane: () => 'main',
      menuContext: () => ({
        pane: 'main',
        documentId: 'doc-1',
        kindId: 'froglight.ink',
      }),
      showMenu: () => undefined,
      menuAnchor: () => ({ x: 10, y: 20 }),
      showPalette: (model) => {
        palettes.push(model);
        let closed = false;
        return {
          updateAnchor: () => undefined,
          updateModel: () => undefined,
          close() {
            closed = true;
          },
          get closed() {
            return closed;
          },
        };
      },
      commands: {
        canExecEditorCommand: () => false,
        execEditorCommand: () => false,
      },
    });
    try {
      act(service, {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 1, y: 1 },
      });
      expect(palettes).toHaveLength(1);
    } finally {
      binder.dispose();
      menus.dispose();
      composition.dispose();
      toolbarControls.dispose();
    }
  });
});

describe('H2 toolbar registry liveness via narrow proxy', () => {
  it('contribution appears/disappears live without explicit refresh', () => {
    const h = liveBinderHarness();
    try {
      act(h.service, {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 100, y: 100 },
      });
      expect(h.palettes).toHaveLength(1);
      expect(h.handles[0]?.updated).toHaveLength(0);
      const brokerExecute = vi.fn(() => true);
      const registration = registerCommunityToolbarContribution({
        pluginId: 'example.live',
        manifest: {
          id: 'live-tool',
          targetCategoryId: 'surface.write',
          label: 'Live tool',
          icon: 'shapes',
          commandId: 'live-command',
          showInSqueeze: true,
        },
        composition: h.composition.registry,
        controls: h.toolbarControls.registry,
        broker: { execute: brokerExecute },
      });
      try {
        // Registry notify fires synchronously on register: binder auto-pushes.
        const added = h.handles[0]?.updated[h.handles[0].updated.length - 1];
        expect(
          added?.tools.some(
            (tool) => tool.id === 'community.example.live.live-tool.command',
          ),
        ).toBe(true);
        expect(h.palettes).toHaveLength(1);
        expect(h.handles).toHaveLength(1);
        const countAfterAdd = h.handles[0]?.updated.length ?? 0;
        registration.dispose();
        const removed =
          h.handles[0]?.updated[(h.handles[0]?.updated.length ?? 1) - 1];
        expect(
          removed?.tools.some(
            (tool) => tool.id === 'community.example.live.live-tool.command',
          ),
        ).toBe(false);
        expect(h.handles[0]?.updated.length).toBeGreaterThan(countAfterAdd);
        expect(h.handles[0]?.closed).toBe(false);
      } finally {
        try {
          registration.dispose();
        } catch {
          // Already disposed in the remove path.
        }
      }
    } finally {
      h.dispose();
    }
  });

  it('dispose/re-enable subscribes exactly once per source; narrow entries+onDidChange proxy stays live', () => {
    const service = new InMemoryStylusService();
    const menus = createStylusMenuRegistry();
    const composition = createToolbarCompositionRegistry();
    const toolbarControls = createDocumentToolbarRegistry();
    installDefaults(composition.registry);
    const snapshot: DocumentToolSnapshot = surfaceSnapshot();
    const toolListeners = new Set<() => void>();
    let toolSubscribes = 0;
    let toolDisposes = 0;
    const toolsPort = {
      editorToolSnapshot: () => snapshot,
      executeEditorTool: () => true,
      onDidChange: (listener: () => void) => {
        toolSubscribes += 1;
        toolListeners.add(listener);
        let disposed = false;
        return {
          dispose: () => {
            if (disposed) return;
            disposed = true;
            toolListeners.delete(listener);
            toolDisposes += 1;
          },
        };
      },
    };
    let menuSubscribes = 0;
    const menuRegistry = menus.registry;
    const origMenuSub = menuRegistry.onDidChange.bind(menuRegistry);
    (menuRegistry as { onDidChange: typeof origMenuSub }).onDidChange = (
      listener: () => void,
    ) => {
      menuSubscribes += 1;
      return origMenuSub(listener);
    };
    let toolbarSubscribes = 0;
    const toolbarRegistry = toolbarControls.registry;
    const origToolbarSub = toolbarRegistry.onDidChange.bind(toolbarRegistry);
    (
      toolbarRegistry as { onDidChange: typeof origToolbarSub }
    ).onDidChange = (listener: () => void) => {
      toolbarSubscribes += 1;
      return origToolbarSub(listener);
    };
    const makeBinder = () =>
      new StylusAccessoryBinder({
        service,
        menuRegistry,
        toolbarComposition: composition.registry,
        toolbarRegistry,
        tools: toolsPort,
        focusedPane: () => 'main',
        menuContext: () => ({
          pane: 'main',
          documentId: 'doc-1',
          kindId: 'froglight.ink',
        }),
        showMenu: () => undefined,
        menuAnchor: () => ({ x: 10, y: 20 }),
        showPalette: () => {
          let closed = false;
          return {
            updateAnchor: () => undefined,
            updateModel: () => undefined,
            close() {
              closed = true;
            },
            get closed() {
              return closed;
            },
          };
        },
        commands: {
          canExecEditorCommand: () => false,
          execEditorCommand: () => false,
        },
      });
    const first = makeBinder();
    expect(toolSubscribes).toBe(1);
    expect(menuSubscribes).toBe(1);
    expect(toolbarSubscribes).toBe(1);
    first.dispose();
    expect(toolDisposes).toBe(1);
    // Emits after dispose never reach a dead binder (no throw, no push).
    for (const listener of [...toolListeners]) listener();
    const second = makeBinder();
    try {
      expect(toolSubscribes).toBe(2);
      expect(menuSubscribes).toBe(2);
      expect(toolbarSubscribes).toBe(2);
      // Narrow proxy: only entries+onDidChange are forwarded — open via the
      // proxy binder, register a squeeze contribution, assert in-place
      // updateModel (no remount), dispose → disappear. Proves the Pick is
      // sufficient for live squeeze.
      const diagnostics: string[] = [];
      const palettes: StylusPaletteModel[] = [];
      const updated: StylusPaletteModel[] = [];
      let proxySubscribes = 0;
      let proxyDisposes = 0;
      const proxyTarget = toolbarRegistry;
      const proxy = {
        entries: proxyTarget.entries.bind(proxyTarget),
        onDidChange: (listener: () => void) => {
          proxySubscribes += 1;
          const sub = (
            proxyTarget.onDidChange as (l: () => void) => { dispose(): void }
          ).call(proxyTarget, listener);
          let disposed = false;
          return {
            dispose: () => {
              if (disposed) return;
              disposed = true;
              sub.dispose();
              proxyDisposes += 1;
            },
          };
        },
      };
      const proxyService = new InMemoryStylusService();
      const proxyBinder = new StylusAccessoryBinder({
        service: proxyService,
        menuRegistry: menus.registry,
        toolbarComposition: composition.registry,
        toolbarRegistry: proxy,
        tools: toolsPort,
        focusedPane: () => 'main',
        menuContext: () => ({
          pane: 'main',
          documentId: 'doc-1',
          kindId: 'froglight.ink',
        }),
        showMenu: () => undefined,
        menuAnchor: () => ({ x: 10, y: 20 }),
        showPalette: (model) => {
          palettes.push(model);
          let closed = false;
          return {
            updateAnchor: () => undefined,
            updateModel(next: StylusPaletteModel) {
              updated.push(next);
            },
            close() {
              closed = true;
            },
            get closed() {
              return closed;
            },
          };
        },
        commands: {
          canExecEditorCommand: () => false,
          execEditorCommand: () => false,
        },
        diagnostics: (message: string) => {
          diagnostics.push(message);
        },
      });
      try {
        expect(proxySubscribes).toBe(1);
        proxyService.handleNativeEvent('action', {
          type: 'squeeze',
          phase: 'began',
          anchor: { x: 50, y: 50 },
        });
        expect(palettes).toHaveLength(1);
        expect(updated).toHaveLength(0);
        const brokerExecute = vi.fn(() => true);
        const proxyReg = registerCommunityToolbarContribution({
          pluginId: 'example.proxy',
          manifest: {
            id: 'proxy-tool',
            targetCategoryId: 'surface.write',
            label: 'Proxy tool',
            icon: 'shapes',
            commandId: 'proxy-command',
            showInSqueeze: true,
          },
          composition: composition.registry,
          controls: toolbarControls.registry,
          broker: { execute: brokerExecute },
        });
        try {
          expect(updated.length).toBeGreaterThan(0);
          const added = updated[updated.length - 1];
          expect(
            added?.tools.some(
              (tool) => tool.id === 'community.example.proxy.proxy-tool.command',
            ),
          ).toBe(true);
          expect(palettes).toHaveLength(1);
          const countAfterAdd = updated.length;
          proxyReg.dispose();
          const removed = updated[updated.length - 1];
          expect(
            removed?.tools.some(
              (tool) => tool.id === 'community.example.proxy.proxy-tool.command',
            ),
          ).toBe(false);
          expect(updated.length).toBeGreaterThan(countAfterAdd);
        } finally {
          try {
            proxyReg.dispose();
          } catch {
            // Already disposed.
          }
        }
        void diagnostics;
      } finally {
        proxyBinder.dispose();
        expect(proxyDisposes).toBe(1);
      }
    } finally {
      second.dispose();
      menus.dispose();
      composition.dispose();
      toolbarControls.dispose();
    }
  });
});

describe('H5 equality completeness (icon/shortLabel/owner/label + More)', () => {
  function harnessWithIcons() {
    const service = new InMemoryStylusService();
    const menus = createStylusMenuRegistry();
    const composition = createToolbarCompositionRegistry();
    const toolbarControls = createDocumentToolbarRegistry();
    installDefaults(composition.registry);
    let snapshot: DocumentToolSnapshot = {
      ...surfaceSnapshot(),
      controls: surfaceSnapshot().controls.map((control) =>
        control.kind === 'button' && control.id === 'ink.tool.froglight.ink.pen'
          ? { ...control, icon: 'pen', shortLabel: 'Pen' }
          : control,
      ),
    } as DocumentToolSnapshot;
    let moreIcon: string | undefined = 'shapes';
    let moreDisabled = false;
    let moreRun: () => void = () => undefined;
    const menuReg = menus.registry.register({
      id: 'acme.more',
      entries: () => [
        {
          label: 'Acme recipe',
          ...(moreIcon !== undefined ? { icon: moreIcon } : {}),
          ...(moreDisabled ? { disabled: true as const } : {}),
          run: moreRun,
        },
      ],
    });
    const palettes: StylusPaletteModel[] = [];
    const updated: StylusPaletteModel[] = [];
    const binder = new StylusAccessoryBinder({
      service,
      menuRegistry: menus.registry,
      toolbarComposition: composition.registry,
      toolbarRegistry: toolbarControls.registry,
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
      menuAnchor: () => ({ x: 10, y: 20 }),
      showPalette: (model) => {
        palettes.push(model);
        let closed = false;
        return {
          updateAnchor: () => undefined,
          updateModel(next: StylusPaletteModel) {
            updated.push(next);
          },
          close() {
            closed = true;
          },
          get closed() {
            return closed;
          },
        };
      },
      commands: {
        canExecEditorCommand: () => false,
        execEditorCommand: () => false,
      },
    });
    return {
      service,
      binder,
      menus,
      composition,
      toolbarControls,
      menuReg,
      palettes,
      updated,
      setSnapshot(next: DocumentToolSnapshot) {
        snapshot = next;
      },
      getSnapshot() {
        return snapshot;
      },
      setMore(icon: string | undefined, disabled: boolean, run: () => void) {
        moreIcon = icon;
        moreDisabled = disabled;
        moreRun = run;
      },
      dispose() {
        binder.dispose();
        menuReg.dispose();
        menus.dispose();
        composition.dispose();
        toolbarControls.dispose();
      },
    };
  }

  it('same presentation (including icon/shortLabel) pushes nothing', () => {
    const h = harnessWithIcons();
    try {
      act(h.service, {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 5, y: 5 },
      });
      expect(h.palettes).toHaveLength(1);
      h.binder.refreshSqueezePalette();
      expect(h.updated).toHaveLength(0);
    } finally {
      h.dispose();
    }
  });

  it('same-id icon change pushes without remounting', () => {
    const h = harnessWithIcons();
    try {
      act(h.service, {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 5, y: 5 },
      });
      expect(h.palettes[0]?.tools.find((t) => t.id === 'ink.tool.froglight.ink.pen')?.icon).toBe(
        'pen',
      );
      const base = h.getSnapshot();
      h.setSnapshot({
        ...base,
        controls: base.controls.map((control) =>
          control.kind === 'button' && control.id === 'ink.tool.froglight.ink.pen'
            ? { ...control, icon: 'brush' }
            : control,
        ),
      } as DocumentToolSnapshot);
      h.binder.refreshSqueezePalette();
      expect(h.updated).toHaveLength(1);
      expect(
        h.updated[0]?.tools.find((t) => t.id === 'ink.tool.froglight.ink.pen')?.icon,
      ).toBe('brush');
      expect(h.palettes).toHaveLength(1);
    } finally {
      h.dispose();
    }
  });

  it('same-id shortLabel change pushes; label change pushes', () => {
    const h = harnessWithIcons();
    try {
      act(h.service, {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 5, y: 5 },
      });
      const base = h.getSnapshot();
      h.setSnapshot({
        ...base,
        controls: base.controls.map((control) =>
          control.kind === 'button' && control.id === 'ink.tool.froglight.ink.pen'
            ? { ...control, shortLabel: 'Brush' }
            : control,
        ),
      } as DocumentToolSnapshot);
      h.binder.refreshSqueezePalette();
      expect(h.updated).toHaveLength(1);
      expect(
        h.updated[0]?.tools.find((t) => t.id === 'ink.tool.froglight.ink.pen')
          ?.shortLabel,
      ).toBe('Brush');
      // Label change on the same id also pushes.
      const afterShort = h.getSnapshot();
      void afterShort;
      const current: DocumentToolSnapshot = {
        ...h.getSnapshot(),
        controls: h.getSnapshot().controls.map((control) =>
          control.kind === 'button' && control.id === 'ink.tool.froglight.ink.pen'
            ? { ...control, label: 'Renamed pen' }
            : control,
        ),
      } as DocumentToolSnapshot;
      h.setSnapshot(current);
      h.binder.refreshSqueezePalette();
      expect(h.updated).toHaveLength(2);
      expect(
        h.updated[1]?.tools.find((t) => t.id === 'ink.tool.froglight.ink.pen')?.label,
      ).toBe('Renamed pen');
    } finally {
      h.dispose();
    }
  });

  it('More icon/disabled changes push; callback identity alone never pushes', () => {
    const h = harnessWithIcons();
    try {
      act(h.service, {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 5, y: 5 },
      });
      expect(h.palettes[0]?.contributions).toHaveLength(1);
      // Callback identity alone: same visible fields, new run fn → no push.
      h.setMore('shapes', false, () => undefined);
      h.binder.refreshSqueezePalette();
      expect(h.updated).toHaveLength(0);
      // More icon change pushes.
      h.setMore('star', false, () => undefined);
      h.binder.refreshSqueezePalette();
      expect(h.updated).toHaveLength(1);
      // More disabled change pushes.
      h.setMore('star', true, () => undefined);
      h.binder.refreshSqueezePalette();
      expect(h.updated).toHaveLength(2);
      expect(h.updated[1]?.contributions[0]).not.toBe('separator');
      const entry = h.updated[1]?.contributions[0] as Exclude<
        MenuEntry,
        'separator'
      >;
      expect(entry.disabled).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it('same-id owner change pushes (provider→contribution)', () => {
    const h = liveBinderHarness();
    try {
      act(h.service, {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 100, y: 100 },
      });
      expect(
        h.palettes[0]?.model.tools.find(
          (tool) => tool.id === 'ink.tool.froglight.ink.pen',
        )?.owner,
      ).toEqual({ kind: 'provider' });
      const base = surfaceSnapshot();
      h.tools.snapshot = {
        ...base,
        controls: base.controls.filter(
          (control) => control.id !== 'ink.tool.froglight.ink.pen',
        ),
      } as DocumentToolSnapshot;
      const registration = h.toolbarControls.registry.register({
        id: 'owner-a',
        controls: () => [
          {
            kind: 'button',
            id: 'ink.tool.froglight.ink.pen',
            group: 'draw',
            label: 'ink.tool.froglight.ink.pen',
            role: 'surface-tool',
            toolRole: 'pen',
            semanticRole: 'surface.pen.ball',
            active: true,
          } as DocumentToolSnapshot['controls'][number],
        ],
        execute: () => true,
      });
      try {
        h.binder.refreshSqueezePalette();
        const next = h.handles[0]?.updated[0];
        expect(next).toBeDefined();
        expect(
          next?.tools.find((tool) => tool.id === 'ink.tool.froglight.ink.pen')
            ?.owner,
        ).toEqual({ kind: 'contribution', contributionId: 'owner-a' });
      } finally {
        registration.dispose();
      }
    } finally {
      h.dispose();
    }
  });
});

describe('H6-SQZ diagnostics never silently disappear (fail-soft + report)', () => {
  function throwingHarness(opts: {
    toolsThrow?: boolean;
    toolbarEntriesThrow?: boolean;
    compositionSnapshotThrow?: boolean;
    menuEntriesThrow?: boolean;
    historyThrow?: boolean;
    noOptionals?: boolean;
  }) {
    const service = new InMemoryStylusService();
    const menus = createStylusMenuRegistry();
    const composition = createToolbarCompositionRegistry();
    const toolbarControls = createDocumentToolbarRegistry();
    installDefaults(composition.registry);
    const diagnostics: string[] = [];
    const palettes: StylusPaletteModel[] = [];
    const updated: StylusPaletteModel[] = [];
    const snapshot = surfaceSnapshot();
    const toolsPort: {
      editorToolSnapshot: (pane?: string) => DocumentToolSnapshot | null;
      executeEditorTool: () => boolean;
      onDidChange?: (listener: () => void) => { dispose(): void };
    } = {
      editorToolSnapshot: () => {
        if (opts.toolsThrow === true) throw new Error('provider boom');
        return snapshot;
      },
      executeEditorTool: () => true,
    };
    const toolbarRegistry = opts.toolbarEntriesThrow === true
      ? {
          entries: () => {
            throw new Error('toolbar registry boom');
          },
          onDidChange: (listener: () => void) => {
            void listener;
            return { dispose: () => undefined };
          },
        }
      : (toolbarControls.registry as unknown as {
          entries: (
            context: Parameters<typeof toolbarControls.registry.entries>[0],
          ) => ReturnType<typeof toolbarControls.registry.entries>;
          onDidChange: typeof toolbarControls.registry.onDidChange;
        });
    const toolbarComposition = opts.compositionSnapshotThrow === true
      ? {
          snapshot: () => {
            throw new Error('composition boom');
          },
          onDidChange: () => ({ dispose: () => undefined }),
          registerCategory: composition.registry.registerCategory.bind(
            composition.registry,
          ),
          registerItem: composition.registry.registerItem.bind(
            composition.registry,
          ),
          registerSettings: composition.registry.registerSettings.bind(
            composition.registry,
          ),
          registerKindExtension:
            composition.registry.registerKindExtension.bind(
              composition.registry,
            ),
        }
      : composition.registry;
    const menuRegistry = opts.menuEntriesThrow === true
      ? {
          register: menus.registry.register.bind(menus.registry),
          entries: () => {
            throw new Error('menu registry boom');
          },
          ownerOf: menus.registry.ownerOf.bind(menus.registry),
          onDidChange: menus.registry.onDidChange.bind(menus.registry),
        }
      : menus.registry;
    const commands =
      opts.noOptionals === true
        ? null
        : {
            canExecEditorCommand: () => {
              if (opts.historyThrow === true)
                throw new Error('history boom');
              return false;
            },
            execEditorCommand: () => false,
          };
    const binder = new StylusAccessoryBinder({
      service,
      menuRegistry: menuRegistry as unknown as typeof menus.registry,
      toolbarComposition:
        opts.noOptionals === true
          ? null
          : (toolbarComposition as unknown as typeof composition.registry),
      toolbarRegistry:
        opts.noOptionals === true
          ? null
          : (toolbarRegistry as unknown as typeof toolbarControls.registry),
      tools: toolsPort,
      focusedPane: () => 'main',
      menuContext: () => ({
        pane: 'main',
        documentId: 'doc-1',
        kindId: 'froglight.ink',
      }),
      showMenu: () => undefined,
      menuAnchor: () => ({ x: 10, y: 20 }),
      showPalette: (model) => {
        palettes.push(model);
        let closed = false;
        return {
          updateAnchor: () => undefined,
          updateModel(next: StylusPaletteModel) {
            updated.push(next);
          },
          close() {
            closed = true;
          },
          get closed() {
            return closed;
          },
        };
      },
      commands,
      diagnostics: (message) => {
        diagnostics.push(message);
      },
    });
    return {
      service,
      binder,
      menus,
      composition,
      toolbarControls,
      palettes,
      updated,
      diagnostics,
      dispose() {
        binder.dispose();
        menus.dispose();
        composition.dispose();
        toolbarControls.dispose();
      },
    };
  }

  it('throwing provider snapshot degrades without crashing and reports', () => {
    const h = throwingHarness({ toolsThrow: true });
    try {
      let threw = false;
      try {
        act(h.service, {
          type: 'squeeze',
          phase: 'began',
          anchor: { x: 10, y: 10 },
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(h.diagnostics.join('\n')).toContain(
        'squeeze tool snapshot probe failed',
      );
    } finally {
      h.dispose();
    }
  });

  it('throwing toolbar registry entries degrades to provider tools and reports', () => {
    const h = throwingHarness({ toolbarEntriesThrow: true });
    try {
      act(h.service, {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 10, y: 10 },
      });
      expect(h.palettes).toHaveLength(1);
      // Provider pen still presents despite the registry failure.
      expect(
        h.palettes[0]?.tools.some(
          (tool) => tool.id === 'ink.tool.froglight.ink.pen',
        ),
      ).toBe(true);
      expect(h.diagnostics.join('\n')).toContain(
        'squeeze toolbar registry entries failed',
      );
    } finally {
      h.dispose();
    }
  });

  it('throwing composition snapshot degrades to legacy pool and reports', () => {
    const h = throwingHarness({ compositionSnapshotThrow: true });
    try {
      act(h.service, {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 10, y: 10 },
      });
      expect(h.palettes).toHaveLength(1);
      expect(h.diagnostics.join('\n')).toContain(
        'squeeze composition snapshot failed',
      );
    } finally {
      h.dispose();
    }
  });

  it('throwing menu registry + history probes degrade and report', () => {
    const menuHarness = throwingHarness({ menuEntriesThrow: true });
    try {
      act(menuHarness.service, {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 10, y: 10 },
      });
      expect(menuHarness.palettes).toHaveLength(1);
      expect(menuHarness.diagnostics.join('\n')).toContain(
        'squeeze menu registry entries failed',
      );
    } finally {
      menuHarness.dispose();
    }
    const historyHarness = throwingHarness({ historyThrow: true });
    try {
      act(historyHarness.service, {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 10, y: 10 },
      });
      expect(historyHarness.palettes).toHaveLength(1);
      expect(historyHarness.diagnostics.join('\n')).toContain(
        'squeeze history probe failed',
      );
    } finally {
      historyHarness.dispose();
    }
  });

  it('optional absent stays silent (no diagnostic) and still presents', () => {
    const h = throwingHarness({ noOptionals: true });
    try {
      act(h.service, {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 10, y: 10 },
      });
      expect(h.palettes).toHaveLength(1);
      expect(h.diagnostics).toEqual([]);
    } finally {
      h.dispose();
    }
  });

  it('entries-only toolbar proxy (no onDidChange) presents with no diagnostic and no throw', () => {
    const service = new InMemoryStylusService();
    const menus = createStylusMenuRegistry();
    const composition = createToolbarCompositionRegistry();
    const toolbarControls = createDocumentToolbarRegistry();
    // Minimal squeeze graph (no dormant items) so the entries-only proxy
    // itself contributes zero diagnostics.
    composition.registry.registerCategory({
      id: 'surface.write',
      familyId: 'surface',
      label: 'Write',
      icon: 'pen',
    });
    composition.registry.registerCategory({
      id: 'surface.erase',
      familyId: 'surface',
      label: 'Erase',
      icon: 'eraser',
    });
    composition.registry.registerItem({
      id: 'test.write.pen',
      categoryId: 'surface.write',
      semanticRole: 'surface.pen.ball',
      projections: ['squeeze'],
    });
    composition.registry.registerItem({
      id: 'test.erase.tool',
      categoryId: 'surface.erase',
      semanticRole: 'surface.erase',
      projections: ['squeeze'],
    });
    composition.registry.registerKindExtension({
      id: 'test-ink-family',
      kindIds: ['froglight.ink'],
      familyIds: ['surface'],
    });
    const diagnostics: string[] = [];
    const palettes: StylusPaletteModel[] = [];
    const entriesOnly = {
      entries: toolbarControls.registry.entries.bind(toolbarControls.registry),
    };
    const binder = new StylusAccessoryBinder({
      service,
      menuRegistry: menus.registry,
      toolbarComposition: composition.registry,
      toolbarRegistry: entriesOnly,
      tools: {
        editorToolSnapshot: () => surfaceSnapshot(),
        executeEditorTool: () => true,
      },
      focusedPane: () => 'main',
      menuContext: () => ({
        pane: 'main',
        documentId: 'doc-1',
        kindId: 'froglight.ink',
      }),
      showMenu: () => undefined,
      menuAnchor: () => ({ x: 10, y: 20 }),
      showPalette: (model) => {
        palettes.push(model);
        let closed = false;
        return {
          updateAnchor: () => undefined,
          updateModel: () => undefined,
          close() {
            closed = true;
          },
          get closed() {
            return closed;
          },
        };
      },
      commands: {
        canExecEditorCommand: () => false,
        execEditorCommand: () => false,
      },
      diagnostics: (message: string) => {
        diagnostics.push(message);
      },
    });
    try {
      let threw = false;
      try {
        act(service, {
          type: 'squeeze',
          phase: 'began',
          anchor: { x: 10, y: 10 },
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(palettes).toHaveLength(1);
      expect(diagnostics).toEqual([]);
    } finally {
      binder.dispose();
      menus.dispose();
      composition.dispose();
      toolbarControls.dispose();
    }
  });

  it('throwing diagnostics channel never breaks began+refresh', () => {
    const service = new InMemoryStylusService();
    const menus = createStylusMenuRegistry();
    const composition = createToolbarCompositionRegistry();
    const toolbarControls = createDocumentToolbarRegistry();
    installDefaults(composition.registry);
    const palettes: StylusPaletteModel[] = [];
    const updated: StylusPaletteModel[] = [];
    // Diagnostics that throw on every call (fail-closed broker style).
    const throwingDiagnostics = (): void => {
      throw new Error('diagnostics boom');
    };
    const binder = new StylusAccessoryBinder({
      service,
      menuRegistry: menus.registry,
      toolbarComposition: composition.registry,
      toolbarRegistry: toolbarControls.registry,
      tools: {
        editorToolSnapshot: () => surfaceSnapshot(),
        executeEditorTool: () => true,
      },
      focusedPane: () => 'main',
      menuContext: () => ({
        pane: 'main',
        documentId: 'doc-1',
        kindId: 'froglight.ink',
      }),
      showMenu: () => undefined,
      menuAnchor: () => ({ x: 10, y: 20 }),
      showPalette: (model) => {
        palettes.push(model);
        let closed = false;
        return {
          updateAnchor: () => undefined,
          updateModel(next: StylusPaletteModel) {
            updated.push(next);
          },
          close() {
            closed = true;
          },
          get closed() {
            return closed;
          },
        };
      },
      commands: {
        canExecEditorCommand: () => false,
        execEditorCommand: () => false,
      },
      diagnostics: throwingDiagnostics,
    });
    try {
      let threw = false;
      try {
        act(service, {
          type: 'squeeze',
          phase: 'began',
          anchor: { x: 10, y: 10 },
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(palettes).toHaveLength(1);
      let refreshThrew = false;
      try {
        binder.refreshSqueezePalette();
      } catch {
        refreshThrew = true;
      }
      expect(refreshThrew).toBe(false);
    } finally {
      binder.dispose();
      menus.dispose();
      composition.dispose();
      toolbarControls.dispose();
    }
  });
});

describe('H1-3 history + favorites follow external state in place', () => {
  it('canUndo/canRedo + saved-style value refresh in place via tools emit without remount', () => {
    const service = new InMemoryStylusService();
    const menus = createStylusMenuRegistry();
    const composition = createToolbarCompositionRegistry();
    const toolbarControls = createDocumentToolbarRegistry();
    installDefaults(composition.registry);
    let snapshot: DocumentToolSnapshot = surfaceSnapshot();
    const toolListeners = new Set<() => void>();
    const toolsPort = {
      editorToolSnapshot: () => snapshot,
      executeEditorTool: () => true,
      onDidChange: (listener: () => void) => {
        toolListeners.add(listener);
        return { dispose: () => void toolListeners.delete(listener) };
      },
    };
    let canUndo = true;
    let canRedo = false;
    const palettes: StylusPaletteModel[] = [];
    const updated: StylusPaletteModel[] = [];
    const binder = new StylusAccessoryBinder({
      service,
      menuRegistry: menus.registry,
      toolbarComposition: composition.registry,
      toolbarRegistry: toolbarControls.registry,
      tools: toolsPort,
      focusedPane: () => 'main',
      menuContext: () => ({
        pane: 'main',
        documentId: 'doc-1',
        kindId: 'froglight.ink',
      }),
      showMenu: () => undefined,
      menuAnchor: () => ({ x: 10, y: 20 }),
      showPalette: (model) => {
        palettes.push(model);
        let closed = false;
        return {
          updateAnchor: () => undefined,
          updateModel(next: StylusPaletteModel) {
            updated.push(next);
          },
          close() {
            closed = true;
          },
          get closed() {
            return closed;
          },
        };
      },
      commands: {
        canExecEditorCommand: (command: 'undo' | 'redo') =>
          command === 'undo' ? canUndo : canRedo,
        execEditorCommand: () => true,
      },
      diagnostics: () => undefined,
    });
    try {
      act(service, {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 20, y: 20 },
      });
      expect(palettes).toHaveLength(1);
      expect(palettes[0]?.canUndo).toBe(true);
      expect(palettes[0]?.canRedo).toBe(false);
      expect(palettes[0]?.styles?.value).toBe('a');
      // External history + favorite commits land together while open.
      canUndo = false;
      canRedo = true;
      const base = surfaceSnapshot();
      snapshot = {
        ...base,
        controls: base.controls.map((control) =>
          control.kind === 'choice' &&
          control.id === 'ink.settings.pen.saved-style'
            ? {
                ...control,
                value: 'b',
                options: [
                  { value: '', label: 'Working style' },
                  { value: 'a', label: 'Atelier' },
                  { value: 'b', label: 'Atelier Blue' },
                ],
              }
            : control,
        ),
      } as DocumentToolSnapshot;
      for (const listener of [...toolListeners]) listener();
      expect(updated).toHaveLength(1);
      expect(updated[0]?.canUndo).toBe(false);
      expect(updated[0]?.canRedo).toBe(true);
      expect(updated[0]?.styles?.value).toBe('b');
      expect(palettes).toHaveLength(1);
      expect(updated[0] && 'closed' in updated[0]).toBe(false);
    } finally {
      binder.dispose();
      menus.dispose();
      composition.dispose();
      toolbarControls.dispose();
    }
  });
});

describe('H5 equality: disabled/roles + style labels push (arch4)', () => {
  function disabledRoleHarness() {
    const service = new InMemoryStylusService();
    const menus = createStylusMenuRegistry();
    const composition = createToolbarCompositionRegistry();
    const toolbarControls = createDocumentToolbarRegistry();
    installDefaults(composition.registry);
    let snapshot: DocumentToolSnapshot = surfaceSnapshot();
    const palettes: StylusPaletteModel[] = [];
    const updated: StylusPaletteModel[] = [];
    const binder = new StylusAccessoryBinder({
      service,
      menuRegistry: menus.registry,
      toolbarComposition: composition.registry,
      toolbarRegistry: toolbarControls.registry,
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
      menuAnchor: () => ({ x: 10, y: 20 }),
      showPalette: (model) => {
        palettes.push(model);
        let closed = false;
        return {
          updateAnchor: () => undefined,
          updateModel(next: StylusPaletteModel) {
            updated.push(next);
          },
          close() {
            closed = true;
          },
          get closed() {
            return closed;
          },
        };
      },
      commands: {
        canExecEditorCommand: () => false,
        execEditorCommand: () => false,
      },
    });
    return {
      service,
      binder,
      menus,
      composition,
      toolbarControls,
      palettes,
      updated,
      setSnapshot(next: DocumentToolSnapshot) {
        snapshot = next;
      },
      getSnapshot() {
        return snapshot;
      },
      dispose() {
        binder.dispose();
        menus.dispose();
        composition.dispose();
        toolbarControls.dispose();
      },
    };
  }

  it('same-id disabled/toolRole/semanticRole/activationRole changes push; identical re-emit gated', () => {
    const h = disabledRoleHarness();
    try {
      act(h.service, {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 5, y: 5 },
      });
      expect(h.palettes).toHaveLength(1);
      const penId = 'ink.tool.froglight.ink.pen';
      // Disabled flip pushes.
      let base = h.getSnapshot();
      h.setSnapshot({
        ...base,
        controls: base.controls.map((control) =>
          control.kind === 'button' && control.id === penId
            ? { ...control, disabled: true as const }
            : control,
        ),
      } as DocumentToolSnapshot);
      h.binder.refreshSqueezePalette();
      expect(h.updated).toHaveLength(1);
      expect(
        h.updated[0]?.tools.find((t) => t.id === penId)?.disabled,
      ).toBe(true);
      // toolRole change pushes (pen → highlighter repurposes tiering).
      base = h.getSnapshot();
      h.setSnapshot({
        ...base,
        controls: base.controls.map((control) =>
          control.kind === 'button' && control.id === penId
            ? { ...control, disabled: undefined, toolRole: 'highlighter' as const }
            : control,
        ),
      } as DocumentToolSnapshot);
      h.binder.refreshSqueezePalette();
      expect(h.updated).toHaveLength(2);
      // semanticRole change pushes.
      base = h.getSnapshot();
      h.setSnapshot({
        ...base,
        controls: base.controls.map((control) =>
          control.kind === 'button' && control.id === penId
            ? { ...control, semanticRole: 'surface.pen.brush' }
            : control,
        ),
      } as DocumentToolSnapshot);
      h.binder.refreshSqueezePalette();
      expect(h.updated).toHaveLength(3);
      // activationRole change pushes.
      base = h.getSnapshot();
      h.setSnapshot({
        ...base,
        controls: base.controls.map((control) =>
          control.kind === 'button' && control.id === penId
            ? { ...control, activationRole: 'tool' as const }
            : control,
        ),
      } as DocumentToolSnapshot);
      h.binder.refreshSqueezePalette();
      expect(h.updated).toHaveLength(4);
      // Identical re-emit gated (no new push).
      h.binder.refreshSqueezePalette();
      expect(h.updated).toHaveLength(4);
      expect(h.palettes).toHaveLength(1);
    } finally {
      h.dispose();
    }
  });

  it('four style section label changes push (color/width/eraser/styles)', () => {
    const h = disabledRoleHarness();
    try {
      act(h.service, {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 5, y: 5 },
      });
      expect(h.palettes).toHaveLength(1);
      // Color label.
      let base = h.getSnapshot();
      h.setSnapshot({
        ...base,
        controls: base.controls.map((control) =>
          control.kind === 'color' && control.id === 'ink.color'
            ? { ...control, label: 'Ink color' }
            : control,
        ),
      } as DocumentToolSnapshot);
      h.binder.refreshSqueezePalette();
      expect(h.updated).toHaveLength(1);
      expect(h.updated[0]?.color?.label).toBe('Ink color');
      // Width label.
      base = h.getSnapshot();
      h.setSnapshot({
        ...base,
        controls: base.controls.map((control) =>
          control.kind === 'choice' && control.id === 'ink.width'
            ? { ...control, label: 'Ink width' }
            : control,
        ),
      } as DocumentToolSnapshot);
      h.binder.refreshSqueezePalette();
      expect(h.updated).toHaveLength(2);
      expect(h.updated[1]?.width?.label).toBe('Ink width');
      // Saved-style label.
      base = h.getSnapshot();
      h.setSnapshot({
        ...base,
        controls: base.controls.map((control) =>
          control.kind === 'choice' &&
          control.id === 'ink.settings.pen.saved-style'
            ? { ...control, label: 'Pen presets' }
            : control,
        ),
      } as DocumentToolSnapshot);
      h.binder.refreshSqueezePalette();
      expect(h.updated).toHaveLength(3);
      expect(h.updated[2]?.styles?.label).toBe('Pen presets');
      // Eraser-size label (add the control first with a label, then rename).
      base = h.getSnapshot();
      const withEraser = {
        ...base,
        controls: [
          ...base.controls,
          {
            kind: 'range',
            id: 'ink.eraser-radius',
            group: 'style',
            label: 'Eraser size',
            value: 10,
            min: 2,
            max: 40,
            step: 1,
            semanticRole: 'surface.erase.size',
          },
        ],
      } as unknown as DocumentToolSnapshot;
      h.setSnapshot(withEraser);
      h.binder.refreshSqueezePalette();
      expect(h.updated).toHaveLength(4);
      expect(h.updated[3]?.eraserSize?.label).toBe('Eraser size');
      h.setSnapshot({
        ...withEraser,
        controls: withEraser.controls.map((control) =>
          control.kind === 'range' && control.id === 'ink.eraser-radius'
            ? { ...control, label: 'Eraser radius' }
            : control,
        ),
      } as unknown as DocumentToolSnapshot);
      h.binder.refreshSqueezePalette();
      expect(h.updated).toHaveLength(5);
      expect(h.updated[4]?.eraserSize?.label).toBe('Eraser radius');
    } finally {
      h.dispose();
    }
  });
});

describe('hook proxy seam (createResubscribingLiveness + stable ports)', () => {
  function sourceWithLiveness() {
    const listeners = new Set<() => void>();
    let subscribes = 0;
    let disposes = 0;
    return {
      onDidChange: (listener: () => void) => {
        subscribes += 1;
        listeners.add(listener);
        let disposed = false;
        return {
          dispose: () => {
            if (disposed) return;
            disposed = true;
            listeners.delete(listener);
            disposes += 1;
          },
        };
      },
      emit() {
        for (const listener of [...listeners]) listener();
      },
      counts: () => ({ subscribes, disposes }),
    };
  }

  it('direct forwarded: emit pushes; absent no-op never throws', () => {
    const source = sourceWithLiveness();
    const proxy = createResubscribingLiveness(() => source);
    let pushes = 0;
    const sub = proxy.onDidChange(() => {
      pushes += 1;
    });
    try {
      expect(proxy).toBeDefined();
      source.emit();
      expect(pushes).toBe(1);
    } finally {
      sub.dispose();
    }
    const absent = createResubscribingLiveness(() => null);
    let absentThrew = false;
    try {
      const noOp = absent.onDidChange(() => undefined);
      noOp.dispose();
    } catch {
      absentThrew = true;
    }
    expect(absentThrew).toBe(false);
    const entriesOnly = createResubscribingLiveness(
      () => ({}) as { onDidChange?: (l: () => void) => { dispose(): void } },
    );
    const noOp2 = entriesOnly.onDidChange(() => undefined);
    expect(() => noOp2.dispose()).not.toThrow();
  });

  it('service fallback: direct without liveness falls back to service; throwing source degrades with onError', () => {
    const service = sourceWithLiveness();
    const currentDirect: unknown = {};
    const errors: unknown[] = [];
    const proxy = createResubscribingLiveness(
      () => {
        const direct = currentDirect as {
          onDidChange?: (l: () => void) => { dispose(): void };
        };
        if (typeof direct?.onDidChange === 'function') return direct;
        return service as unknown as {
          onDidChange: (l: () => void) => { dispose(): void };
        };
      },
      (error) => {
        errors.push(error);
      },
    );
    let pushes = 0;
    const sub = proxy.onDidChange(() => {
      pushes += 1;
    });
    try {
      service.emit();
      expect(pushes).toBe(1);
      // Throwing onDidChange degrades to no-op with onError, never throws.
      const throwing = {
        onDidChange: () => {
          throw new Error('subscribe boom');
        },
      };
      const throwingProxy = createResubscribingLiveness(() => throwing, (error) => {
        errors.push(error);
      });
      let threw = false;
      try {
        const s = throwingProxy.onDidChange(() => undefined);
        s.dispose();
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(errors.length).toBeGreaterThan(0);
      void currentDirect;
    } finally {
      sub.dispose();
    }
  });

  it('subscribe exactly once per live source; dispose exactly once; reconcile idempotent', () => {
    const first = sourceWithLiveness();
    const second = sourceWithLiveness();
    let current: unknown = first;
    const proxy = createResubscribingLiveness(() => current as {
      onDidChange: (l: () => void) => { dispose(): void };
    });
    let pushes = 0;
    const sub = proxy.onDidChange(() => {
      pushes += 1;
    });
    try {
      expect(first.counts().subscribes).toBe(1);
      // Idempotent reconcile without swap: no new subscribe.
      proxy.reconcile();
      expect(first.counts().subscribes).toBe(1);
      // Swap: old disposed once, new subscribed once, swap notifies.
      current = second;
      proxy.reconcile();
      expect(first.counts().disposes).toBe(1);
      expect(second.counts().subscribes).toBe(1);
      expect(pushes).toBe(1);
      second.emit();
      expect(pushes).toBe(2);
      // Old no longer pushes.
      const before = pushes;
      first.emit();
      expect(pushes).toBe(before);
    } finally {
      sub.dispose();
      expect(second.counts().disposes).toBe(1);
    }
  });

  it('stable ports factory: direct forwarded, absent no-op, fallback live, throwing degrades with report', () => {
    const direct = sourceWithLiveness();
    const serviceControls = createDocumentToolbarRegistry();
    const reports: string[] = [];
    let liveTools: unknown = {
      editorToolSnapshot: () => surfaceSnapshot(),
      executeEditorTool: () => true,
      canExecEditorCommand: () => false,
      execEditorCommand: () => false,
      onDidChange: direct.onDidChange,
    };
    let liveDirect: unknown = {
      entries: () => [],
      executeOwned: () => false,
      onDidChange: direct.onDidChange,
    };
    const fakeServices = {
      try: () => serviceControls.registry,
    } as unknown as import('./workbench.js').UiServiceLookup;
    const toolsLiveness = createResubscribingLiveness(() => liveTools as {
      onDidChange?: (l: () => void) => { dispose(): void };
    });
    const toolbarLiveness = createResubscribingLiveness(() => {
      const d = liveDirect as {
        onDidChange?: (l: () => void) => { dispose(): void };
      } | null;
      if (typeof d?.onDidChange === 'function') return d;
      return serviceControls.registry;
    });
    const ports = createStylusAccessoryStablePorts({
      live: () =>
        ({
          tools: liveTools,
          toolbarRegistry: liveDirect,
          services: fakeServices,
        }) as unknown as Parameters<
          typeof createStylusAccessoryStablePorts
        >[0]['live'] extends () => infer T
          ? T
          : never,
      toolsLiveness,
      toolbarLiveness,
      report: (message) => {
        reports.push(message);
      },
    });
    // Direct forwarded.
    let pushes = 0;
    const sub = ports.toolbarRegistry.onDidChange?.((() => {
      pushes += 1;
    }) as () => void);
    try {
      direct.emit();
      expect(pushes).toBe(1);
    } finally {
      sub?.dispose();
    }
    // Absent no-op.
    liveTools = {
      editorToolSnapshot: () => surfaceSnapshot(),
      executeEditorTool: () => true,
      canExecEditorCommand: () => false,
      execEditorCommand: () => false,
    };
    liveDirect = null;
    const absentPorts = createStylusAccessoryStablePorts({
      live: () =>
        ({
          tools: liveTools,
          toolbarRegistry: liveDirect,
          services: { try: () => undefined },
        }) as unknown as Parameters<
          typeof createStylusAccessoryStablePorts
        >[0]['live'] extends () => infer T
          ? T
          : never,
      toolsLiveness: createResubscribingLiveness(() => liveTools as {
        onDidChange?: (l: () => void) => { dispose(): void };
      }),
      toolbarLiveness: createResubscribingLiveness(() => null),
      report: (message) => {
        reports.push(message);
      },
    });
    expect(() =>
      absentPorts.tools.onDidChange?.(() => undefined).dispose(),
    ).not.toThrow();
    expect(() =>
      absentPorts.toolbarRegistry.onDidChange?.(() => undefined).dispose(),
    ).not.toThrow();
    // Throwing data probes degrade + report, never throw, never leak boom.
    const throwingPorts = createStylusAccessoryStablePorts({
      live: () =>
        ({
          tools: {
            editorToolSnapshot: () => {
              throw new Error('snapshot boom');
            },
            executeEditorTool: () => {
              throw new Error('execute boom');
            },
            canExecEditorCommand: () => {
              throw new Error('history boom');
            },
            execEditorCommand: () => {
              throw new Error('exec boom');
            },
          },
          toolbarRegistry: {
            entries: () => {
              throw new Error('entries boom');
            },
            executeOwned: () => false,
          },
          services: { try: () => undefined },
        }) as unknown as Parameters<
          typeof createStylusAccessoryStablePorts
        >[0]['live'] extends () => infer T
          ? T
          : never,
      toolsLiveness: createResubscribingLiveness(() => null),
      toolbarLiveness: createResubscribingLiveness(() => null),
      report: (message) => {
        reports.push(message);
      },
    });
    expect(throwingPorts.tools.editorToolSnapshot()).toBeNull();
    expect(throwingPorts.tools.executeEditorTool('main', 'x')).toBe(false);
    expect(throwingPorts.tools.canExecEditorCommand('undo')).toBe(false);
    expect(
      throwingPorts.toolbarRegistry.entries({
        pane: 'main',
        documentId: 'doc-1',
        kindId: 'froglight.ink',
        editor: null,
      }),
    ).toEqual([]);
    expect(reports.join('\n')).toContain('squeeze tool snapshot probe failed');
    expect(reports.join('\n')).toContain('squeeze toolbar registry entries failed');
    expect(reports.join('\n')).not.toContain('boom text into UI');
    serviceControls.dispose();
    void reports;
  });
});

describe('throwing probes + UI-leak + absent extended', () => {
  it('focusedPane/menuContext throws degrade + report without crash or UI leak', () => {
    const service = new InMemoryStylusService();
    const menus = createStylusMenuRegistry();
    const composition = createToolbarCompositionRegistry();
    const toolbarControls = createDocumentToolbarRegistry();
    installDefaults(composition.registry);
    const diagnostics: string[] = [];
    const palettes: StylusPaletteModel[] = [];
    const updated: StylusPaletteModel[] = [];
    const shown: MenuEntry[][] = [];
    let focusedThrow = false;
    let contextThrow = false;
    const binder = new StylusAccessoryBinder({
      service,
      menuRegistry: menus.registry,
      toolbarComposition: composition.registry,
      toolbarRegistry: toolbarControls.registry,
      tools: {
        editorToolSnapshot: () => surfaceSnapshot(),
        executeEditorTool: () => true,
      },
      focusedPane: () => {
        if (focusedThrow) throw new Error('pane boom');
        return 'main';
      },
      menuContext: () => {
        if (contextThrow) throw new Error('context boom');
        return { pane: 'main', documentId: 'doc-1', kindId: 'froglight.ink' };
      },
      showMenu: (entries) => {
        shown.push([...entries]);
      },
      menuAnchor: () => ({ x: 10, y: 20 }),
      showPalette: (model) => {
        palettes.push(model);
        let closed = false;
        return {
          updateAnchor: () => undefined,
          updateModel(next: StylusPaletteModel) {
            updated.push(next);
          },
          close() {
            closed = true;
          },
          get closed() {
            return closed;
          },
        };
      },
      commands: {
        canExecEditorCommand: () => false,
        execEditorCommand: () => false,
      },
      diagnostics: (message) => {
        diagnostics.push(message);
      },
    });
    try {
      // Part A: began with throwing focusedPane degrades + reports.
      // Began hardens squeezePane to null; build then reports via safePane.
      focusedThrow = true;
      contextThrow = false;
      act(service, {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 10, y: 10 },
      });
      expect(diagnostics.join('\n')).toContain(
        'squeeze focused pane probe failed',
      );
      expect(JSON.stringify({ palettes, updated, shown })).not.toContain(
        'boom',
      );
      // Recover and open cleanly (probes healthy).
      focusedThrow = false;
      binder.refreshSqueezePalette();
      // The stale began left no palette (pane was null); open cleanly now.
      // Dispose stale tracking by cancelling and re-beginning.
      act(service, { type: 'squeeze', phase: 'cancelled' });
      diagnostics.length = 0;
      palettes.length = 0;
      updated.length = 0;
      act(service, {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 10, y: 10 },
      });
      expect(palettes).toHaveLength(1);
      // Part B: while open, failing menuContext degrades + reports via refresh.
      contextThrow = true;
      let threw = false;
      try {
        binder.refreshSqueezePalette();
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      const joined = diagnostics.join('\n');
      expect(joined).toContain('squeeze menu context probe failed');
      const uiText = JSON.stringify({ palettes, updated, shown });
      expect(uiText).not.toContain('boom');
      // Recover: stop throwing, refresh stays live.
      contextThrow = false;
      binder.refreshSqueezePalette();
      expect(palettes).toHaveLength(1);
    } finally {
      binder.dispose();
      menus.dispose();
      composition.dispose();
      toolbarControls.dispose();
    }
  });

  it('onDidChange subscribe throw never breaks construction; tools-without-onDidChange diagnostics []', () => {
    const service = new InMemoryStylusService();
    const menus = createStylusMenuRegistry();
    const composition = createToolbarCompositionRegistry();
    const toolbarControls = createDocumentToolbarRegistry();
    installDefaults(composition.registry);
    const diagnostics: string[] = [];
    const palettes: StylusPaletteModel[] = [];
    const throwingTools = {
      editorToolSnapshot: () => surfaceSnapshot(),
      executeEditorTool: () => true,
      onDidChange: () => {
        throw new Error('subscribe boom');
      },
    };
    let threw = false;
    let binder: StylusAccessoryBinder | null = null;
    try {
      binder = new StylusAccessoryBinder({
        service,
        menuRegistry: menus.registry,
        toolbarComposition: composition.registry,
        toolbarRegistry: toolbarControls.registry,
        tools: throwingTools,
        focusedPane: () => 'main',
        menuContext: () => ({
          pane: 'main',
          documentId: 'doc-1',
          kindId: 'froglight.ink',
        }),
        showMenu: () => undefined,
        menuAnchor: () => ({ x: 10, y: 20 }),
        showPalette: (model) => {
          palettes.push(model);
          let closed = false;
          return {
            updateAnchor: () => undefined,
            updateModel: () => undefined,
            close() {
              closed = true;
            },
            get closed() {
              return closed;
            },
          };
        },
        commands: {
          canExecEditorCommand: () => false,
          execEditorCommand: () => false,
        },
        diagnostics: (message) => {
          diagnostics.push(message);
        },
      });
    } catch {
      threw = true;
    }
    try {
      expect(threw).toBe(false);
      expect(binder).not.toBeNull();
      act(service, {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 10, y: 10 },
      });
      expect(palettes).toHaveLength(1);
      // Subscribe throw itself stays silent (liveness best-effort), but open
      // still presents and UI never leaks boom.
      expect(JSON.stringify(palettes)).not.toContain('boom');
    } finally {
      binder?.dispose();
      menus.dispose();
      composition.dispose();
      toolbarControls.dispose();
    }
    // Tools without onDidChange: absent stays silent.
    const service2 = new InMemoryStylusService();
    const menus2 = createStylusMenuRegistry();
    const composition2 = createToolbarCompositionRegistry();
    const toolbarControls2 = createDocumentToolbarRegistry();
    // Minimal graph for zero dormant diagnostics.
    composition2.registry.registerCategory({
      id: 'surface.write',
      familyId: 'surface',
      label: 'Write',
      icon: 'pen',
    });
    composition2.registry.registerItem({
      id: 'test.write.pen',
      categoryId: 'surface.write',
      semanticRole: 'surface.pen.ball',
      projections: ['squeeze'],
    });
    composition2.registry.registerKindExtension({
      id: 'test-ink-family',
      kindIds: ['froglight.ink'],
      familyIds: ['surface'],
    });
    const diagnostics2: string[] = [];
    const palettes2: StylusPaletteModel[] = [];
    const binder2 = new StylusAccessoryBinder({
      service: service2,
      menuRegistry: menus2.registry,
      toolbarComposition: composition2.registry,
      toolbarRegistry: { entries: () => [] },
      tools: {
        editorToolSnapshot: () => surfaceSnapshot(),
        executeEditorTool: () => true,
      },
      focusedPane: () => 'main',
      menuContext: () => ({
        pane: 'main',
        documentId: 'doc-1',
        kindId: 'froglight.ink',
      }),
      showMenu: () => undefined,
      menuAnchor: () => ({ x: 10, y: 20 }),
      showPalette: (model) => {
        palettes2.push(model);
        let closed = false;
        return {
          updateAnchor: () => undefined,
          updateModel: () => undefined,
          close() {
            closed = true;
          },
          get closed() {
            return closed;
          },
        };
      },
      commands: null,
      diagnostics: (message) => {
        diagnostics2.push(message);
      },
    });
    try {
      service2.handleNativeEvent('action', {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 10, y: 10 },
      });
      expect(palettes2).toHaveLength(1);
      expect(diagnostics2).toEqual([]);
    } finally {
      binder2.dispose();
      menus2.dispose();
      composition2.dispose();
      toolbarControls2.dispose();
    }
  });
});

describe('Arch5 composition liveness exactly-once + fallback (H1-SWAP part)', () => {
  it('composition subscribes once/disposes once; post-dispose emit never pushes; service fallback live', () => {
    const service = new InMemoryStylusService();
    const menus = createStylusMenuRegistry();
    const firstComposition = createToolbarCompositionRegistry();
    const toolbarControls = createDocumentToolbarRegistry();
    // Minimal squeeze graph on first composition.
    firstComposition.registry.registerCategory({
      id: 'surface.write',
      familyId: 'surface',
      label: 'Write',
      icon: 'pen',
    });
    firstComposition.registry.registerItem({
      id: 'test.write.pen',
      categoryId: 'surface.write',
      semanticRole: 'surface.pen.ball',
      projections: ['squeeze'],
    });
    firstComposition.registry.registerKindExtension({
      id: 'test-ink-family',
      kindIds: ['froglight.ink'],
      familyIds: ['surface'],
    });
    let compSubscribes = 0;
    let compDisposes = 0;
    const origSub = firstComposition.registry.onDidChange.bind(
      firstComposition.registry,
    );
    (firstComposition.registry as { onDidChange: typeof origSub }).onDidChange =
      (listener: () => void) => {
        compSubscribes += 1;
        const sub = origSub(listener);
        let disposed = false;
        return {
          dispose: () => {
            if (disposed) return;
            disposed = true;
            sub.dispose();
            compDisposes += 1;
          },
        };
      };
    const palettes: StylusPaletteModel[] = [];
    const updated: StylusPaletteModel[] = [];
    const binder = new StylusAccessoryBinder({
      service,
      menuRegistry: menus.registry,
      toolbarComposition: firstComposition.registry,
      toolbarRegistry: toolbarControls.registry,
      tools: {
        editorToolSnapshot: () => surfaceSnapshot(),
        executeEditorTool: () => true,
      },
      focusedPane: () => 'main',
      menuContext: () => ({
        pane: 'main',
        documentId: 'doc-1',
        kindId: 'froglight.ink',
      }),
      showMenu: () => undefined,
      menuAnchor: () => ({ x: 10, y: 20 }),
      showPalette: (model) => {
        palettes.push(model);
        let closed = false;
        return {
          updateAnchor: () => undefined,
          updateModel(next: StylusPaletteModel) {
            updated.push(next);
          },
          close() {
            closed = true;
          },
          get closed() {
            return closed;
          },
        };
      },
      commands: {
        canExecEditorCommand: () => false,
        execEditorCommand: () => false,
      },
    });
    try {
      expect(compSubscribes).toBe(1);
      act(service, {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 10, y: 10 },
      });
      expect(palettes).toHaveLength(1);
      // Retain the live listener via a second composition registration that
      // changes the graph (adds an item) → auto-push proves liveness.
      firstComposition.registry.registerItem({
        id: 'test.write.extra',
        categoryId: 'surface.write',
        semanticRole: 'surface.highlighter',
        projections: ['squeeze'],
      });
      expect(updated.length).toBeGreaterThan(0);
      binder.dispose();
      expect(compDisposes).toBe(1);
      // Post-dispose emit via retained registry never pushes/throws.
      const countAfterDispose = updated.length;
      let threw = false;
      try {
        firstComposition.registry.registerItem({
          id: 'test.write.after-dispose',
          categoryId: 'surface.write',
          semanticRole: 'surface.pen.brush',
          projections: ['squeeze'],
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(updated).toHaveLength(countAfterDispose);
    } finally {
      try {
        binder.dispose();
      } catch {
        // Already disposed.
      }
      menus.dispose();
      firstComposition.dispose();
      toolbarControls.dispose();
    }
    // Service fallback live: direct null, service provides entries+liveness.
    const service2 = new InMemoryStylusService();
    const menus2 = createStylusMenuRegistry();
    const composition2 = createToolbarCompositionRegistry();
    const toolbarControls2 = createDocumentToolbarRegistry();
    composition2.registry.registerCategory({
      id: 'surface.write',
      familyId: 'surface',
      label: 'Write',
      icon: 'pen',
    });
    composition2.registry.registerItem({
      id: 'test.write.pen',
      categoryId: 'surface.write',
      semanticRole: 'surface.pen.ball',
      projections: ['squeeze'],
    });
    composition2.registry.registerKindExtension({
      id: 'test-ink-family',
      kindIds: ['froglight.ink'],
      familyIds: ['surface'],
    });
    const live = {
      toolbarRegistry: null as null,
      services: {
        try: () => toolbarControls2.registry,
      } as unknown as import('./workbench.js').UiServiceLookup,
    };
    const toolbarLiveness = createResubscribingLiveness(() => {
      const direct = live.toolbarRegistry as {
        onDidChange?: (l: () => void) => { dispose(): void };
      } | null;
      if (typeof direct?.onDidChange === 'function') return direct;
      return toolbarControls2.registry;
    });
    const ports = createStylusAccessoryStablePorts({
      live: () =>
        ({
          tools: {
            editorToolSnapshot: () => surfaceSnapshot(),
            executeEditorTool: () => true,
            canExecEditorCommand: () => false,
            execEditorCommand: () => false,
          },
          toolbarRegistry: null,
          services: live.services,
        }) as unknown as Parameters<
          typeof createStylusAccessoryStablePorts
        >[0]['live'] extends () => infer T
          ? T
          : never,
      toolsLiveness: createResubscribingLiveness(() => null),
      toolbarLiveness,
      report: () => undefined,
    });
    const palettes2: StylusPaletteModel[] = [];
    const updated2: StylusPaletteModel[] = [];
    const binder2 = new StylusAccessoryBinder({
      service: service2,
      menuRegistry: menus2.registry,
      toolbarComposition: composition2.registry,
      toolbarRegistry: ports.toolbarRegistry,
      tools: ports.tools,
      focusedPane: () => 'main',
      menuContext: () => ({
        pane: 'main',
        documentId: 'doc-1',
        kindId: 'froglight.ink',
      }),
      showMenu: () => undefined,
      menuAnchor: () => ({ x: 10, y: 20 }),
      showPalette: (model) => {
        palettes2.push(model);
        let closed = false;
        return {
          updateAnchor: () => undefined,
          updateModel(next: StylusPaletteModel) {
            updated2.push(next);
          },
          close() {
            closed = true;
          },
          get closed() {
            return closed;
          },
        };
      },
      commands: {
        canExecEditorCommand: () => false,
        execEditorCommand: () => false,
      },
    });
    try {
      service2.handleNativeEvent('action', {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 10, y: 10 },
      });
      expect(palettes2).toHaveLength(1);
    } finally {
      binder2.dispose();
      menus2.dispose();
      composition2.dispose();
      toolbarControls2.dispose();
    }
  });
});

describe('Delta H1-SWAP provider/registry/composition swap stays live without remount', () => {
  it('tools swap: new source emit pushes in place, old no longer pushes, exactly-once, no remount', () => {
    const firstTools = toolsWithLiveness(surfaceSnapshot());
    const h = liveBinderHarness({ tools: firstTools });
    try {
      act(h.service, {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 100, y: 100 },
      });
      expect(h.palettes).toHaveLength(1);
      expect(h.handles).toHaveLength(1);
      // Swap tools via resubscribing proxy seam: independent unit proving the
      // same pattern the hook uses (isolated from the binder above so counts
      // stay exact). The binder palette above stays open throughout (no
      // remount) while the proxy below proves swap semantics.
      const proxyFirst = toolsWithLiveness(surfaceSnapshot());
      let liveTools: unknown = proxyFirst.port();
      const proxyLiveness = createResubscribingLiveness(
        () =>
          liveTools as {
            onDidChange?: (l: () => void) => { dispose(): void };
          },
      );
      let proxyPushes = 0;
      const outer = proxyLiveness.onDidChange(() => {
        proxyPushes += 1;
      });
      try {
        expect(proxyFirst.subscribeCount()).toBe(1);
        // New provider with eraser active.
        const secondTools = toolsWithLiveness(
          withActiveTool(surfaceSnapshot(), 'ink.tool.froglight.ink.eraser'),
        );
        liveTools = secondTools.port();
        proxyLiveness.reconcile();
        // Swap itself notifies (open palette would refresh in place).
        expect(proxyPushes).toBe(1);
        expect(proxyFirst.disposeCount()).toBe(1);
        expect(secondTools.subscribeCount()).toBe(1);
        // Old no longer pushes.
        const before = proxyPushes;
        proxyFirst.emit();
        expect(proxyPushes).toBe(before);
        // New pushes.
        secondTools.emit();
        expect(proxyPushes).toBe(before + 1);
      } finally {
        outer.dispose();
      }
      // Binder-level swap via updateLiveRegistries is covered for
      // menu/composition below; tools path here proves proxy rule.
      expect(h.palettes).toHaveLength(1);
      expect(h.handles).toHaveLength(1);
      expect(h.handles[0]?.closed).toBe(false);
    } finally {
      h.dispose();
    }
  });

  it('menu/composition swap via updateLiveRegistries preserves open palette without remount', () => {
    const service = new InMemoryStylusService();
    const firstMenus = createStylusMenuRegistry();
    const firstComposition = createToolbarCompositionRegistry();
    const toolbarControls = createDocumentToolbarRegistry();
    installDefaults(firstComposition.registry);
    const palettes: StylusPaletteModel[] = [];
    const updated: StylusPaletteModel[] = [];
    const binder = new StylusAccessoryBinder({
      service,
      menuRegistry: firstMenus.registry,
      toolbarComposition: firstComposition.registry,
      toolbarRegistry: toolbarControls.registry,
      tools: {
        editorToolSnapshot: () => surfaceSnapshot(),
        executeEditorTool: () => true,
      },
      focusedPane: () => 'main',
      menuContext: () => ({
        pane: 'main',
        documentId: 'doc-1',
        kindId: 'froglight.ink',
      }),
      showMenu: () => undefined,
      menuAnchor: () => ({ x: 10, y: 20 }),
      showPalette: (model) => {
        palettes.push(model);
        let closed = false;
        return {
          updateAnchor: () => undefined,
          updateModel(next: StylusPaletteModel) {
            updated.push(next);
          },
          close() {
            closed = true;
          },
          get closed() {
            return closed;
          },
        };
      },
      commands: {
        canExecEditorCommand: () => false,
        execEditorCommand: () => false,
      },
    });
    const secondMenus = createStylusMenuRegistry();
    const secondComposition = createToolbarCompositionRegistry();
    installDefaults(secondComposition.registry);
    try {
      act(service, {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 10, y: 10 },
      });
      expect(palettes).toHaveLength(1);
      const handlesBefore = updated.length;
      void handlesBefore;
      // Swap to second instances while open: no remount, still open.
      binder.updateLiveRegistries({
        menuRegistry: secondMenus.registry,
        toolbarComposition: secondComposition.registry,
      });
      expect(palettes).toHaveLength(1);
      // New menu contribution appears live via new subscription.
      const reg = secondMenus.registry.register({
        id: 'swapped.recipe',
        entries: () => [{ label: 'Swapped recipe' }],
      });
      try {
        expect(updated.length).toBeGreaterThan(0);
        const latest = updated[updated.length - 1];
        expect(
          latest?.contributions.map((entry) =>
            entry === 'separator' ? 'separator' : entry.label,
          ),
        ).toContain('Swapped recipe');
        // Old menu no longer pushes: registering on first menus does nothing.
        const countBeforeOld = updated.length;
        const oldReg = firstMenus.registry.register({
          id: 'stale.recipe',
          entries: () => [{ label: 'Stale recipe' }],
        });
        try {
          expect(updated).toHaveLength(countBeforeOld);
        } finally {
          oldReg.dispose();
        }
      } finally {
        reg.dispose();
      }
    } finally {
      binder.dispose();
      firstMenus.dispose();
      firstComposition.dispose();
      secondMenus.dispose();
      secondComposition.dispose();
      toolbarControls.dispose();
    }
  });
});

describe('DIAG-SUBSCRIPTION throwing liveness subscriptions degrade + diagnostic (sanitized, bounded)', () => {
  function subscriptionHarness(opts: {
    toolsThrow?: boolean;
    toolbarThrow?: boolean;
    menuThrow?: boolean;
    compositionThrow?: boolean;
  }) {
    const service = new InMemoryStylusService();
    const menus = createStylusMenuRegistry();
    const composition = createToolbarCompositionRegistry();
    const toolbarControls = createDocumentToolbarRegistry();
    installDefaults(composition.registry);
    const diagnostics: string[] = [];
    const palettes: StylusPaletteModel[] = [];
    const toolsPort: {
      editorToolSnapshot: () => DocumentToolSnapshot;
      executeEditorTool: () => boolean;
      onDidChange?: (listener: () => void) => { dispose(): void };
    } = {
      editorToolSnapshot: () => surfaceSnapshot(),
      executeEditorTool: () => true,
    };
    if (opts.toolsThrow === true) {
      toolsPort.onDidChange = () => {
        throw new Error('tools subscribe boom\nstack: fake\nheapdump: {x:1}');
      };
    }
    const menuRegistry =
      opts.menuThrow === true
        ? ({
            register: menus.registry.register.bind(menus.registry),
            entries: menus.registry.entries.bind(menus.registry),
            ownerOf: menus.registry.ownerOf.bind(menus.registry),
            onDidChange: () => {
              throw new Error('menu subscribe boom');
            },
          } as unknown as typeof menus.registry)
        : menus.registry;
    const toolbarComposition =
      opts.compositionThrow === true
        ? ({
            snapshot: composition.registry.snapshot.bind(composition.registry),
            registerCategory: composition.registry.registerCategory.bind(
              composition.registry,
            ),
            registerItem: composition.registry.registerItem.bind(
              composition.registry,
            ),
            registerSettings: composition.registry.registerSettings.bind(
              composition.registry,
            ),
            registerKindExtension:
              composition.registry.registerKindExtension.bind(
                composition.registry,
              ),
            onDidChange: () => {
              throw new Error('composition subscribe boom');
            },
          } as unknown as typeof composition.registry)
        : composition.registry;
    const toolbarRegistry =
      opts.toolbarThrow === true
        ? {
            entries: toolbarControls.registry.entries.bind(
              toolbarControls.registry,
            ),
            onDidChange: () => {
              throw new Error('toolbar subscribe boom');
            },
          }
        : toolbarControls.registry;
    let threw = false;
    let binder: StylusAccessoryBinder | null = null;
    try {
      binder = new StylusAccessoryBinder({
        service,
        menuRegistry,
        toolbarComposition,
        toolbarRegistry:
          toolbarRegistry as unknown as typeof toolbarControls.registry,
        tools: toolsPort,
        focusedPane: () => 'main',
        menuContext: () => ({
          pane: 'main',
          documentId: 'doc-1',
          kindId: 'froglight.ink',
        }),
        showMenu: () => undefined,
        menuAnchor: () => ({ x: 10, y: 20 }),
        showPalette: (model) => {
          palettes.push(model);
          let closed = false;
          return {
            updateAnchor: () => undefined,
            updateModel: () => undefined,
            close() {
              closed = true;
            },
            get closed() {
              return closed;
            },
          };
        },
        commands: {
          canExecEditorCommand: () => false,
          execEditorCommand: () => false,
        },
        diagnostics: (message) => {
          diagnostics.push(message);
        },
      });
    } catch {
      threw = true;
    }
    return {
      service,
      binder,
      menus,
      composition,
      toolbarControls,
      palettes,
      diagnostics,
      threw,
      dispose() {
        binder?.dispose();
        menus.dispose();
        composition.dispose();
        toolbarControls.dispose();
      },
    };
  }

  it('throwing tools onDidChange degrades + emits sanitized bounded diagnostic, open still works', () => {
    const h = subscriptionHarness({ toolsThrow: true });
    try {
      expect(h.threw).toBe(false);
      expect(h.binder).not.toBeNull();
      act(h.service, {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 10, y: 10 },
      });
      expect(h.palettes).toHaveLength(1);
      const joined = h.diagnostics.join('\n');
      expect(joined).toContain('squeeze tools liveness subscribe failed');
      // Sanitized: message text preserved, no stack/dump leak, bounded.
      expect(joined).toContain('tools subscribe boom');
      expect(joined).not.toContain('heapdump');
      for (const message of h.diagnostics) {
        expect(message.length).toBeLessThanOrEqual(300);
      }
    } finally {
      h.dispose();
    }
  });

  it('throwing toolbar/menu/composition subscriptions each degrade + diagnose', () => {
    const kinds = [
      { key: 'toolbarThrow', label: 'squeeze toolbar liveness subscribe failed' },
      { key: 'menuThrow', label: 'squeeze menu liveness subscribe failed' },
      {
        key: 'compositionThrow',
        label: 'squeeze composition liveness subscribe failed',
      },
    ] as const;
    for (const { key, label } of kinds) {
      const h = subscriptionHarness({ [key]: true });
      try {
        expect(h.threw).toBe(false);
        act(h.service, {
          type: 'squeeze',
          phase: 'began',
          anchor: { x: 10, y: 10 },
        });
        expect(h.palettes).toHaveLength(1);
        expect(h.diagnostics.join('\n')).toContain(label);
        for (const message of h.diagnostics) {
          expect(message.length).toBeLessThanOrEqual(300);
        }
      } finally {
        h.dispose();
      }
    }
  });

  it('updateLiveRegistries swap to a throwing source degrades + diagnoses without remount', () => {
    const service = new InMemoryStylusService();
    const firstMenus = createStylusMenuRegistry();
    const firstComposition = createToolbarCompositionRegistry();
    const toolbarControls = createDocumentToolbarRegistry();
    installDefaults(firstComposition.registry);
    const diagnostics: string[] = [];
    const palettes: StylusPaletteModel[] = [];
    const binder = new StylusAccessoryBinder({
      service,
      menuRegistry: firstMenus.registry,
      toolbarComposition: firstComposition.registry,
      toolbarRegistry: toolbarControls.registry,
      tools: {
        editorToolSnapshot: () => surfaceSnapshot(),
        executeEditorTool: () => true,
      },
      focusedPane: () => 'main',
      menuContext: () => ({
        pane: 'main',
        documentId: 'doc-1',
        kindId: 'froglight.ink',
      }),
      showMenu: () => undefined,
      menuAnchor: () => ({ x: 10, y: 20 }),
      showPalette: (model) => {
        palettes.push(model);
        let closed = false;
        return {
          updateAnchor: () => undefined,
          updateModel: () => undefined,
          close() {
            closed = true;
          },
          get closed() {
            return closed;
          },
        };
      },
      commands: {
        canExecEditorCommand: () => false,
        execEditorCommand: () => false,
      },
      diagnostics: (message) => {
        diagnostics.push(message);
      },
    });
    try {
      act(service, {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 10, y: 10 },
      });
      expect(palettes).toHaveLength(1);
      const throwingMenus = {
        register: firstMenus.registry.register.bind(firstMenus.registry),
        entries: firstMenus.registry.entries.bind(firstMenus.registry),
        ownerOf: firstMenus.registry.ownerOf.bind(firstMenus.registry),
        onDidChange: () => {
          throw new Error('swap subscribe boom');
        },
      } as unknown as typeof firstMenus.registry;
      let threw = false;
      try {
        binder.updateLiveRegistries({ menuRegistry: throwingMenus });
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(diagnostics.join('\n')).toContain(
        'squeeze menu liveness subscribe failed',
      );
      // Open palette preserved (no remount): still one showPalette call.
      expect(palettes).toHaveLength(1);
    } finally {
      binder.dispose();
      firstMenus.dispose();
      firstComposition.dispose();
      toolbarControls.dispose();
    }
  });

  it('optional absent liveness stays silent (no diagnostic)', () => {
    const service = new InMemoryStylusService();
    const menus = createStylusMenuRegistry();
    const composition = createToolbarCompositionRegistry();
    const toolbarControls = createDocumentToolbarRegistry();
    // Minimal squeeze graph so the entries-only absent path itself
    // contributes zero assembly diagnostics.
    composition.registry.registerCategory({
      id: 'surface.write',
      familyId: 'surface',
      label: 'Write',
      icon: 'pen',
    });
    composition.registry.registerCategory({
      id: 'surface.erase',
      familyId: 'surface',
      label: 'Erase',
      icon: 'eraser',
    });
    composition.registry.registerItem({
      id: 'test.write.pen',
      categoryId: 'surface.write',
      semanticRole: 'surface.pen.ball',
      projections: ['squeeze'],
    });
    composition.registry.registerItem({
      id: 'test.erase.tool',
      categoryId: 'surface.erase',
      semanticRole: 'surface.erase',
      projections: ['squeeze'],
    });
    composition.registry.registerKindExtension({
      id: 'test-ink-family',
      kindIds: ['froglight.ink'],
      familyIds: ['surface'],
    });
    const diagnostics: string[] = [];
    const palettes: StylusPaletteModel[] = [];
    const binder = new StylusAccessoryBinder({
      service,
      menuRegistry: menus.registry,
      toolbarComposition: composition.registry,
      toolbarRegistry: { entries: () => [] },
      tools: {
        editorToolSnapshot: () => surfaceSnapshot(),
        executeEditorTool: () => true,
      },
      focusedPane: () => 'main',
      menuContext: () => ({
        pane: 'main',
        documentId: 'doc-1',
        kindId: 'froglight.ink',
      }),
      showMenu: () => undefined,
      menuAnchor: () => ({ x: 10, y: 20 }),
      showPalette: (model) => {
        palettes.push(model);
        let closed = false;
        return {
          updateAnchor: () => undefined,
          updateModel: () => undefined,
          close() {
            closed = true;
          },
          get closed() {
            return closed;
          },
        };
      },
      commands: null,
      diagnostics: (message) => {
        diagnostics.push(message);
      },
    });
    try {
      act(service, {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 10, y: 10 },
      });
      expect(palettes).toHaveLength(1);
      expect(diagnostics).toEqual([]);
    } finally {
      binder.dispose();
      menus.dispose();
      composition.dispose();
      toolbarControls.dispose();
    }
  });
});
