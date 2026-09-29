/**
 *  squeeze palette sessions (absolute toggle contract).
 *
 * The squeeze palette is a projection of the same semantic graph,
 * ownership, and style state as the normal toolbar — never a second
 * store. These tests pin the session contract at the binder seam:
 * began toggles (closed opens near the tip, open closes exactly once),
 * changed keeps the opening anchor, ended only settles and leaves the
 * palette open, cancelled closes a squeeze-owned palette only, phaseless
 * squeezes toggle atomically. Focus modes (showColorPalette /
 * showInkAttributes / showContextualPalette) project the same model;
 * system preferred squeeze actions never execute a tool (absolute toggle;
 * double-tap keeps its own semantics).
 * Tool/style/history/plugin execution routing itself is covered by
 * `squeeze-owned-pool.spec.ts` (`executeSqueezeOwned`); here the model is
 * asserted to carry the quick-style region, history, and the community
 * tool with its preserved owner.
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
import { createStylusMenuRegistry } from './stylus-menu-registry.js';
import { createDocumentToolbarRegistry } from './document-toolbar-registry.js';
import {
  createToolbarCompositionRegistry,
  resolveToolbarComposition,
} from './toolbar/composition-registry.js';
import { defaultToolbarComposition } from './toolbar/default-composition.js';
import { registerCommunityToolbarContribution } from './toolbar/community-contribution.js';

function surfaceButton(
  id: string,
  extra: Record<string, unknown> = {},
): DocumentToolSnapshot['controls'][number] {
  const toolRole = id.endsWith('.pen')
    ? 'pen'
    : id.endsWith('.highlighter')
      ? 'highlighter'
      : id.endsWith('.eraser')
        ? 'eraser'
        : undefined;
  const semanticRole = id.endsWith('.pen')
    ? 'surface.pen.ball'
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

interface PaletteCall {
  model: StylusPaletteModel;
  anchor: StylusAccessoryMenuAnchor;
}

function harness() {
  const service = new InMemoryStylusService();
  const menus = createStylusMenuRegistry();
  const composition = createToolbarCompositionRegistry();
  const toolbarControls = createDocumentToolbarRegistry();
  const defaults = defaultToolbarComposition();
  for (const entry of defaults.categories)
    composition.registry.registerCategory(entry);
  for (const entry of defaults.items) composition.registry.registerItem(entry);
  for (const entry of defaults.extensions)
    composition.registry.registerKindExtension(entry);

  const palettes: PaletteCall[] = [];
  const handles: StylusPaletteHandle[] = [];
  const updateAnchors: StylusAccessoryMenuAnchor[][] = [];
  const executed: Array<{ pane: string; id: string }> = [];
  let closedCount = 0;
  const snapshot: DocumentToolSnapshot = surfaceSnapshot();
  const binder = new StylusAccessoryBinder({
    service,
    menuRegistry: menus.registry,
    toolbarComposition: composition.registry,
    toolbarRegistry: toolbarControls.registry,
    tools: {
      editorToolSnapshot: () => snapshot,
      executeEditorTool: (pane, id) => {
        executed.push({ pane, id });
        return true;
      },
    },
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
      const seen: StylusAccessoryMenuAnchor[] = [anchor];
      updateAnchors.push(seen);
      let closed = false;
      const handle: StylusPaletteHandle = {
        updateAnchor(next) {
          seen.push(next);
        },
        close() {
          closed = true;
          closedCount += 1;
        },
        get closed() {
          return closed;
        },
      };
      handles.push(handle);
      return handle;
    },
    commands: {
      canExecEditorCommand: (command) => command === 'undo',
      execEditorCommand: () => true,
    },
  });
  return {
    service,
    binder,
    palettes,
    handles,
    updateAnchors,
    executed,
    closedCount: () => closedCount,
    dispose() {
      binder.dispose();
      menus.dispose();
      composition.dispose();
      toolbarControls.dispose();
    },
  };
}

function act(
  service: InMemoryStylusService,
  payload: Record<string, unknown>,
): void {
  service.handleNativeEvent('action', payload);
}

describe('squeeze palette session', () => {
  it('began anchors once; holding and moving never moves the palette', () => {
    const h = harness();
    act(h.service, {
      type: 'squeeze',
      phase: 'began',
      anchor: { x: 100, y: 100 },
    });
    expect(h.palettes).toHaveLength(1);
    expect(h.palettes[0]?.anchor).toEqual({ x: 100, y: 100 });
    act(h.service, {
      type: 'squeeze',
      phase: 'changed',
      anchor: { x: 120, y: 130 },
    });
    // Hold motion must not change the initial circle center.
    expect(h.palettes).toHaveLength(1);
    expect(h.updateAnchors[0]).toEqual([
      { x: 100, y: 100 },
    ]);
    act(h.service, { type: 'squeeze', phase: 'ended' });
    expect(h.handles[0]?.closed).toBe(false);
    // After completion the palette still ignores hover motion.
    act(h.service, {
      type: 'squeeze',
      phase: 'changed',
      anchor: { x: 400, y: 400 },
    });
    expect(h.updateAnchors[0]).toHaveLength(1);
    expect(h.palettes).toHaveLength(1);
    h.dispose();
  });

  it('cancelled closes a squeeze-owned palette and performs no tool action', () => {
    const h = harness();
    act(h.service, {
      type: 'squeeze',
      phase: 'began',
      anchor: { x: 50, y: 50 },
    });
    expect(h.handles).toHaveLength(1);
    act(h.service, { type: 'squeeze', phase: 'cancelled' });
    expect(h.handles[0]?.closed).toBe(true);
    expect(h.executed).toEqual([]);
    h.dispose();
  });

  it('cancelled after ended does not close the settled palette', () => {
    const h = harness();
    act(h.service, {
      type: 'squeeze',
      phase: 'began',
      anchor: { x: 50, y: 50 },
    });
    act(h.service, { type: 'squeeze', phase: 'ended' });
    expect(h.handles[0]?.closed).toBe(false);
    act(h.service, { type: 'squeeze', phase: 'cancelled' });
    // Ownership released at ended: the settled palette is dismissed by
    // outside interaction, not by the stale gesture.
    expect(h.handles[0]?.closed).toBe(false);
    h.dispose();
  });

  it('squeeze preferred actions project focus modes from the same model', () => {
    const h = harness();
    act(h.service, {
      type: 'squeeze',
      phase: 'began',
      preferredAction: 'showColorPalette',
      anchor: { x: 10, y: 10 },
    });
    expect(h.palettes[0]?.model.focusMode).toBe('color');
    h.dispose();

    const h2 = harness();
    act(h2.service, {
      type: 'squeeze',
      phase: 'began',
      preferredAction: 'showInkAttributes',
      anchor: { x: 10, y: 10 },
    });
    expect(h2.palettes[0]?.model.focusMode).toBe('attributes');
    h2.dispose();

    const h3 = harness();
    act(h3.service, {
      type: 'squeeze',
      phase: 'began',
      preferredAction: 'showContextualPalette',
      anchor: { x: 10, y: 10 },
    });
    expect(h3.palettes[0]?.model.focusMode).toBe('full');
    h3.dispose();
  });

  it('preferred switchEraser executes once per gesture without a palette', () => {
    const h = harness();
    act(h.service, {
      type: 'squeeze',
      phase: 'began',
      preferredAction: 'switchEraser',
    });
    expect(h.executed).toHaveLength(1);
    expect(h.palettes).toHaveLength(0);
    act(h.service, {
      type: 'squeeze',
      phase: 'changed',
      preferredAction: 'switchEraser',
    });
    expect(h.executed).toHaveLength(1);
    expect(h.palettes).toHaveLength(0);
    act(h.service, {
      type: 'squeeze',
      phase: 'ended',
      preferredAction: 'switchEraser',
    });
    expect(h.executed).toHaveLength(1);
    expect(h.palettes).toHaveLength(0);
    act(h.service, {
      type: 'squeeze',
      phase: 'began',
      preferredAction: 'switchEraser',
    });
    expect(h.executed).toHaveLength(2);
    expect(h.palettes).toHaveLength(0);
    h.dispose();
  });

  it('carries tools, quick styles, and history from the same owned pool', () => {
    const h = harness();
    act(h.service, {
      type: 'squeeze',
      phase: 'began',
      anchor: { x: 200, y: 200 },
    });
    const model = h.palettes[0]?.model;
    expect(model).toBeDefined();
    // Same graph as normal: default squeeze composition order, not buckets.
    const poolIds = resolveToolbarComposition({
      snapshot: (() => {
        const created = createToolbarCompositionRegistry();
        try {
          const defaults = defaultToolbarComposition();
          for (const entry of defaults.categories)
            created.registry.registerCategory(entry);
          for (const entry of defaults.items)
            created.registry.registerItem(entry);
          for (const entry of defaults.extensions)
            created.registry.registerKindExtension(entry);
          return created.registry.snapshot();
        } finally {
          created.dispose();
        }
      })(),
      kindId: 'froglight.ink',
      controls: surfaceSnapshot().controls,
      projection: 'squeeze',
    }).categories.flatMap((category) =>
      category.items
        .filter((item) => item.control.kind === 'button')
        .map((item) => item.control.id),
    );
    expect(model?.tools.map((tool) => tool.id)).toEqual(poolIds);
    expect(model?.activeToolId).toBe('ink.tool.froglight.ink.pen');
    // Quick-style region: same style state as the normal popover.
    expect(model?.color?.id).toBe('ink.color');
    expect(model?.color?.options).toEqual(['#37352f', '#7c6cf0']);
    expect(model?.width?.id).toBe('ink.width');
    expect(model?.styles?.id).toBe('ink.settings.pen.saved-style');
    // History from the shell-owned pool.
    expect(model?.canUndo).toBe(true);
    expect(model?.canRedo).toBe(false);
    // Owner routing preserved for every visible entry.
    const owners = new Map(
      (model?.owned ?? []).map((owned) => [owned.control.id, owned.owner]),
    );
    expect(owners.get('ink.tool.froglight.ink.pen')).toEqual({
      kind: 'provider',
    });
    expect(owners.get('ink.color')).toEqual({ kind: 'provider' });
    h.dispose();
  });

  it('exposes a showInSqueeze community tool with its contribution owner', () => {
    const service = new InMemoryStylusService();
    const menus = createStylusMenuRegistry();
    const composition = createToolbarCompositionRegistry();
    const toolbarControls = createDocumentToolbarRegistry();
    try {
      const defaults = defaultToolbarComposition();
      for (const entry of defaults.categories)
        composition.registry.registerCategory(entry);
      for (const entry of defaults.items)
        composition.registry.registerItem(entry);
      for (const entry of defaults.extensions)
        composition.registry.registerKindExtension(entry);
      const brokerExecute = vi.fn(() => true);
      const registration = registerCommunityToolbarContribution({
        pluginId: 'example.diagram',
        manifest: {
          id: 'diamond',
          targetCategoryId: 'surface.write',
          label: 'Decision diamond',
          icon: 'shapes',
          commandId: 'insert-diamond',
          showInSqueeze: true,
        },
        composition: composition.registry,
        controls: toolbarControls.registry,
        broker: { execute: brokerExecute },
      });
      const palettes: PaletteCall[] = [];
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
        showPalette: (model, anchor) => {
          palettes.push({ model, anchor });
          let closed = false;
          return {
            updateAnchor: () => undefined,
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
      act(service, {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 100, y: 100 },
      });
      const model = palettes[0]?.model;
      const diamond = model?.tools.find(
        (tool) => tool.id === 'community.example.diagram.diamond.command',
      );
      expect(diamond).toBeDefined();
      expect(diamond?.owner).toEqual({
        kind: 'contribution',
        contributionId: 'community.example.diagram.diamond.owner',
      });
      // Tiered secondary for the radial strip, still owner-routed.
      expect(diamond?.toolRole).toBeUndefined();
      binder.dispose();
      registration.dispose();
    } finally {
      composition.dispose();
      toolbarControls.dispose();
      menus.dispose();
    }
  });
});

describe('squeeze palette live model (Repairs 4+5: never stale while open)', () => {
  interface LiveHandle extends StylusPaletteHandle {
    updated: StylusPaletteModel[];
  }

  function liveHarness() {
    const service = new InMemoryStylusService();
    const menus = createStylusMenuRegistry();
    const composition = createToolbarCompositionRegistry();
    const toolbarControls = createDocumentToolbarRegistry();
    const defaults = defaultToolbarComposition();
    for (const entry of defaults.categories)
      composition.registry.registerCategory(entry);
    for (const entry of defaults.items)
      composition.registry.registerItem(entry);
    for (const entry of defaults.extensions)
      composition.registry.registerKindExtension(entry);

    const palettes: PaletteCall[] = [];
    const handles: LiveHandle[] = [];
    const executed: Array<{ pane: string; id: string }> = [];
    let snapshot: DocumentToolSnapshot = surfaceSnapshot();
    let canUndo = true;
    let canRedo = false;
    const binder = new StylusAccessoryBinder({
      service,
      menuRegistry: menus.registry,
      toolbarComposition: composition.registry,
      toolbarRegistry: toolbarControls.registry,
      tools: {
        editorToolSnapshot: () => snapshot,
        executeEditorTool: (pane, id) => {
          executed.push({ pane, id });
          // realistic provider commit: a successful surface-tool
          // switch updates the snapshot so the post-execute refresh sees
          // the committed state (no pre-staging needed in tests).
          try {
            const hasTarget = snapshot.controls.some(
              (control) => control.kind === 'button' && control.id === id,
            );
            if (hasTarget) {
              snapshot = {
                ...snapshot,
                controls: snapshot.controls.map((control) =>
                  control.kind === 'button' && control.role === 'surface-tool'
                    ? { ...control, active: control.id === id }
                    : control,
                ),
              } as DocumentToolSnapshot;
            }
          } catch {
            // Commit simulation must never break execution recording.
          }
          return true;
        },
      },
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
        canExecEditorCommand: (command) =>
          command === 'undo' ? canUndo : canRedo,
        execEditorCommand: () => true,
      },
    });
    return {
      service,
      binder,
      menus,
      composition,
      toolbarControls,
      palettes,
      handles,
      executed,
      setSnapshot(next: DocumentToolSnapshot): void {
        snapshot = next;
      },
      setHistory(undo: boolean, redo: boolean): void {
        canUndo = undo;
        canRedo = redo;
      },
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

  function withStyleValues(
    snapshot: DocumentToolSnapshot,
    values: { color?: string; width?: string; saved?: string },
  ): DocumentToolSnapshot {
    return {
      ...snapshot,
      controls: snapshot.controls.map((control) => {
        if (
          control.kind === 'color' &&
          values.color !== undefined &&
          control.id === 'ink.color'
        ) {
          return { ...control, value: values.color };
        }
        if (
          control.kind === 'choice' &&
          values.width !== undefined &&
          control.id === 'ink.width'
        ) {
          return { ...control, value: values.width };
        }
        if (
          control.kind === 'choice' &&
          values.saved !== undefined &&
          control.id === 'ink.settings.pen.saved-style'
        ) {
          return { ...control, value: values.saved };
        }
        return control;
      }),
    } as DocumentToolSnapshot;
  }

  it('refresh pushes tool/color/width/style/undo changes without reopening', () => {
    const h = liveHarness();
    act(h.service, {
      type: 'squeeze',
      phase: 'began',
      anchor: { x: 100, y: 100 },
    });
    expect(h.palettes).toHaveLength(1);
    const opening = h.palettes[0]?.model;
    expect(opening?.activeToolId).toBe('ink.tool.froglight.ink.pen');

    h.setSnapshot(
      withStyleValues(
        withActiveTool(surfaceSnapshot(), 'ink.tool.froglight.ink.eraser'),
        { color: '#7c6cf0', width: '7.0', saved: 'b' },
      ),
    );
    h.setHistory(false, true);
    h.binder.refreshSqueezePalette();

    expect(h.handles[0]?.updated).toHaveLength(1);
    const next = h.handles[0]?.updated[0];
    expect(next?.activeToolId).toBe('ink.tool.froglight.ink.eraser');
    expect(
      next?.tools.find((tool) => tool.id === 'ink.tool.froglight.ink.eraser')
        ?.active,
    ).toBe(true);
    expect(next?.color?.value).toBe('#7c6cf0');
    expect(next?.width?.value).toBe('7.0');
    expect(next?.styles?.value).toBe('b');
    expect(next?.canUndo).toBe(false);
    expect(next?.canRedo).toBe(true);
    // No remount: the opening showPalette call stands alone.
    expect(h.palettes).toHaveLength(1);
    expect(h.handles).toHaveLength(1);
    h.dispose();
  });

  it('refresh is a no-op when nothing changed', () => {
    const h = liveHarness();
    act(h.service, {
      type: 'squeeze',
      phase: 'began',
      anchor: { x: 100, y: 100 },
    });
    h.binder.refreshSqueezePalette();
    expect(h.handles[0]?.updated).toHaveLength(0);
    expect(h.handles[0]?.closed).toBe(false);
    h.dispose();
  });

  it('refresh picks up late plugin menu contributions', () => {
    const h = liveHarness();
    act(h.service, {
      type: 'squeeze',
      phase: 'began',
      anchor: { x: 100, y: 100 },
    });
    expect(h.palettes[0]?.model.contributions).toHaveLength(0);
    const registration = h.menus.registry.register({
      id: 'acme.recipe',
      entries: () => [{ label: 'Acme recipe' }],
    });
    try {
      h.binder.refreshSqueezePalette();
      const next = h.handles[0]?.updated[0];
      expect(
        next?.contributions.map((entry) =>
          entry === 'separator' ? 'separator' : entry.label,
        ),
      ).toEqual(['Acme recipe']);
      expect(h.palettes).toHaveLength(1);
    } finally {
      registration.dispose();
    }
    h.dispose();
  });

  it('refresh closes instead of leaving a stale palette when the model no longer resolves', () => {
    const h = liveHarness();
    act(h.service, {
      type: 'squeeze',
      phase: 'began',
      anchor: { x: 100, y: 100 },
    });
    h.setSnapshot({ context: 'Plain text', controls: [] });
    h.binder.refreshSqueezePalette();
    expect(h.handles[0]?.closed).toBe(true);
    expect(h.handles[0]?.updated).toHaveLength(0);
    h.dispose();
  });

  it('a preferred tool action while the palette is open executes without toggling it', () => {
    const h = liveHarness();
    act(h.service, {
      type: 'squeeze',
      phase: 'began',
      anchor: { x: 100, y: 100 },
    });
    act(h.service, { type: 'squeeze', phase: 'ended' });
    expect(h.palettes[0]?.model.activeToolId).toBe(
      'ink.tool.froglight.ink.pen',
    );
    act(h.service, {
      type: 'squeeze',
      phase: 'began',
      preferredAction: 'switchEraser',
    });
    expect(h.executed).toHaveLength(1);
    expect(h.handles[0]?.closed).toBe(false);
    expect(h.palettes).toHaveLength(1);
    h.dispose();
  });

  it('external tool commit while open refreshes in place via explicit refresh (no squeeze execution)', () => {
    const h = liveHarness();
    act(h.service, {
      type: 'squeeze',
      phase: 'began',
      anchor: { x: 100, y: 100 },
    });
    expect(h.palettes[0]?.model.activeToolId).toBe(
      'ink.tool.froglight.ink.pen',
    );
    // External provider commit lands while open; squeeze `ended` settles
    // without executing, and an explicit refresh pushes the committed
    // state in place without remounting.
    h.setSnapshot(
      withActiveTool(surfaceSnapshot(), 'ink.tool.froglight.ink.eraser'),
    );
    act(h.service, {
      type: 'squeeze',
      phase: 'ended',
      preferredAction: 'switchEraser',
    });
    expect(h.executed).toEqual([]);
    expect(h.handles[0]?.closed).toBe(false);
    h.binder.refreshSqueezePalette();
    const next = h.handles[0]?.updated[0];
    expect(next?.activeToolId).toBe('ink.tool.froglight.ink.eraser');
    expect(h.handles[0]?.closed).toBe(false);
    expect(h.palettes).toHaveLength(1);
    expect(h.handles).toHaveLength(1);
    h.dispose();
  });

  it('removed tool while open never executes via squeeze; palette stays live', () => {
    const h = liveHarness();
    act(h.service, {
      type: 'squeeze',
      phase: 'began',
      anchor: { x: 100, y: 100 },
    });
    // Provider loses the eraser entirely while open.
    h.setSnapshot({
      context: 'Ink canvas',
      controls: surfaceSnapshot().controls.filter(
        (control) => control.id !== 'ink.tool.froglight.ink.eraser',
      ),
    } as DocumentToolSnapshot);
    act(h.service, {
      type: 'squeeze',
      phase: 'ended',
      preferredAction: 'switchEraser',
    });
    expect(h.executed).toEqual([]);
    // Palette stays live (still resolves via remaining tools), no remount.
    expect(h.handles[0]?.closed).toBe(false);
    expect(h.palettes).toHaveLength(1);
    h.dispose();
  });

  it('activationRole-only change pushes without remounting', () => {
    const h = liveHarness();
    act(h.service, {
      type: 'squeeze',
      phase: 'began',
      anchor: { x: 100, y: 100 },
    });
    expect(h.handles[0]?.updated).toHaveLength(0);
    const base = surfaceSnapshot();
    h.setSnapshot({
      ...base,
      controls: base.controls.map((control) =>
        control.kind === 'button' && control.id === 'ink.tool.froglight.ink.pen'
          ? { ...control, activationRole: 'tool' as const }
          : control,
      ),
    } as DocumentToolSnapshot);
    h.binder.refreshSqueezePalette();
    expect(h.handles[0]?.updated).toHaveLength(1);
    expect(h.palettes).toHaveLength(1);
    expect(h.handles).toHaveLength(1);
    h.dispose();
  });

  it('same-id owner change (provider→contribution) pushes without remounting', () => {
    const h = liveHarness();
    act(h.service, {
      type: 'squeeze',
      phase: 'began',
      anchor: { x: 100, y: 100 },
    });
    const openingOwner = h.palettes[0]?.model.tools.find(
      (tool) => tool.id === 'ink.tool.froglight.ink.pen',
    )?.owner;
    expect(openingOwner).toEqual({ kind: 'provider' });
    // Remove provider pen; provide the same id via a toolbar contribution.
    const base = surfaceSnapshot();
    h.setSnapshot({
      ...base,
      controls: base.controls.filter(
        (control) => control.id !== 'ink.tool.froglight.ink.pen',
      ),
    } as DocumentToolSnapshot);
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
      expect(h.palettes).toHaveLength(1);
      expect(h.handles).toHaveLength(1);
    } finally {
      registration.dispose();
    }
    h.dispose();
  });

  it('missing eraserSize, favorite, and showInSqueeze add/remove stay live without remounting', () => {
    const h = liveHarness();
    act(h.service, {
      type: 'squeeze',
      phase: 'began',
      anchor: { x: 100, y: 100 },
    });
    expect(h.palettes[0]?.model.eraserSize).toBeNull();
    const base = surfaceSnapshot();
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
    expect(h.handles[0]?.updated).toHaveLength(1);
    expect(h.handles[0]?.updated[0]?.eraserSize?.value).toBe(10);
    // Eraser-size value change pushes.
    h.setSnapshot({
      ...withEraser,
      controls: withEraser.controls.map((control) =>
        control.kind === 'range' && control.id === 'ink.eraser-radius'
          ? { ...control, value: 22 }
          : control,
      ),
    } as unknown as DocumentToolSnapshot);
    h.binder.refreshSqueezePalette();
    expect(h.handles[0]?.updated).toHaveLength(2);
    expect(h.handles[0]?.updated[1]?.eraserSize?.value).toBe(22);
    // Favorite (saved-style) option change pushes: add a new favorite.
    const withFavorite = {
      ...withEraser,
      controls: withEraser.controls.map((control) =>
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
    } as unknown as DocumentToolSnapshot;
    // Keep eraser 22 in the favorite snapshot.
    (
      withFavorite.controls as unknown as Array<Record<string, unknown>>
    ).forEach((control) => {
      if (
        control['kind'] === 'range' &&
        control['id'] === 'ink.eraser-radius'
      ) {
        control['value'] = 22;
      }
    });
    h.setSnapshot(withFavorite as DocumentToolSnapshot);
    h.binder.refreshSqueezePalette();
    expect(h.handles[0]?.updated).toHaveLength(3);
    expect(h.handles[0]?.updated[2]?.styles?.value).toBe('b');
    // showInSqueeze community tool add pushes (auto via composition +
    // toolbar subscriptions, plus explicit refresh for determinism).
    const brokerExecute = vi.fn(() => true);
    const community = registerCommunityToolbarContribution({
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
      h.binder.refreshSqueezePalette();
      const added = h.handles[0]?.updated[h.handles[0].updated.length - 1];
      expect(
        added?.tools.some(
          (tool) => tool.id === 'community.example.live.live-tool.command',
        ),
      ).toBe(true);
      const countAfterAdd = h.handles[0]?.updated.length ?? 0;
      // Remove pushes again.
      community.dispose();
      h.binder.refreshSqueezePalette();
      const removed =
        h.handles[0]?.updated[(h.handles[0]?.updated.length ?? 1) - 1];
      expect(
        removed?.tools.some(
          (tool) => tool.id === 'community.example.live.live-tool.command',
        ),
      ).toBe(false);
      expect(h.handles[0]?.updated.length).toBeGreaterThan(countAfterAdd);
    } finally {
      try {
        community.dispose();
      } catch {
        // Already disposed in the remove path.
      }
    }
    // Never a remount just to stay live.
    expect(h.palettes).toHaveLength(1);
    expect(h.handles).toHaveLength(1);
    expect(h.handles[0]?.closed).toBe(false);
    h.dispose();
  });

  it('squeeze ended never triggers provider execution (no async discrete path)', async () => {
    const service = new InMemoryStylusService();
    const menus = createStylusMenuRegistry();
    const composition = createToolbarCompositionRegistry();
    const toolbarControls = createDocumentToolbarRegistry();
    const defaults = defaultToolbarComposition();
    for (const entry of defaults.categories)
      composition.registry.registerCategory(entry);
    for (const entry of defaults.items)
      composition.registry.registerItem(entry);
    for (const entry of defaults.extensions)
      composition.registry.registerKindExtension(entry);
    const snapshot: DocumentToolSnapshot = surfaceSnapshot();
    const palettes: PaletteCall[] = [];
    const updated: StylusPaletteModel[] = [];
    let executeCalls = 0;
    const binder = new StylusAccessoryBinder({
      service,
      menuRegistry: menus.registry,
      toolbarComposition: composition.registry,
      toolbarRegistry: toolbarControls.registry,
      tools: {
        editorToolSnapshot: () => snapshot,
        executeEditorTool: () => {
          executeCalls += 1;
          return true;
        },
      },
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
        let closed = false;
        return {
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
        };
      },
      commands: {
        canExecEditorCommand: () => false,
        execEditorCommand: () => true,
      },
    });
    try {
      act(service, {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 100, y: 100 },
      });
      expect(palettes).toHaveLength(1);
      // Absolute toggle: squeeze `ended` settles without executing — the
      // provider is never called, so there is no async commit to refresh.
      act(service, {
        type: 'squeeze',
        phase: 'ended',
        preferredAction: 'switchEraser',
      });
      expect(executeCalls).toBe(0);
      expect(updated).toHaveLength(0);
      await Promise.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(updated).toHaveLength(0);
    } finally {
      binder.dispose();
      menus.dispose();
      composition.dispose();
      toolbarControls.dispose();
    }
  });

  it('routes through the next model using the new owner (binder-level hook equivalent)', async () => {
    // The hook tracks `currentModel` across every `updateModel` push, so a
    // selection after a push routes via `next.owned` (not the opening
    // closure). Prove the binder side: after a contribution-owned tool is
    // added, `updated.owned` carries the contribution owner and
    // `executeSqueezeOwned` routes via the broker (never the provider).
    const { executeSqueezeOwned } = await import(
      './react/workspace/hooks/useStylusAccessory.js'
    );
    const h = liveHarness();
    act(h.service, {
      type: 'squeeze',
      phase: 'began',
      anchor: { x: 100, y: 100 },
    });
    const brokerExecute = vi.fn(() => true);
    const community = registerCommunityToolbarContribution({
      pluginId: 'example.route',
      manifest: {
        id: 'route-tool',
        targetCategoryId: 'surface.write',
        label: 'Route tool',
        icon: 'shapes',
        commandId: 'route-command',
        showInSqueeze: true,
      },
      composition: h.composition.registry,
      controls: h.toolbarControls.registry,
      broker: { execute: brokerExecute },
    });
    try {
      h.binder.refreshSqueezePalette();
      const next = h.handles[0]?.updated[h.handles[0].updated.length - 1];
      expect(next).toBeDefined();
      const owned = (next?.owned ?? []).find(
        (entry) =>
          entry.control.id === 'community.example.route.route-tool.command',
      );
      expect(owned?.owner).toEqual({
        kind: 'contribution',
        contributionId: 'community.example.route.route-tool.owner',
      });
      // Route via the *next* model (what the hook's currentModel holds after
      // the push) — must hit the broker, never the provider channel.
      const providerCalls: Array<string> = [];
      const tools = {
        executeEditorTool: (id: string) => {
          providerCalls.push(id);
          return true;
        },
        execEditorCommand: () => true,
      };
      const context = {
        pane: 'main',
        documentId: 'doc-1',
        kindId: 'froglight.ink',
        editor: surfaceSnapshot(),
      };
      expect(owned).toBeDefined();
      if (owned === undefined) throw new Error('expected owned route tool');
      executeSqueezeOwned(
        {
          tools: tools as unknown as Parameters<
            typeof executeSqueezeOwned
          >[0]['tools'],
          contributions: h.toolbarControls.registry,
          pane: 'main',
          context: context as unknown as Parameters<
            typeof executeSqueezeOwned
          >[0]['context'],
        },
        owned,
      );
      expect(brokerExecute).toHaveBeenCalledWith(
        'example.route',
        'route-command',
        context,
      );
      expect(providerCalls).toEqual([]);
      expect(h.palettes).toHaveLength(1);
    } finally {
      community.dispose();
      h.dispose();
    }
  });
});
