/**
 * Squeeze consumes the full owned pool.
 *
 * The Pencil squeeze palette resolves against the same assembled owned
 * pool as the normal toolbar (provider + shell + trusted/community) with
 * the squeeze projection, so `showInSqueeze` contributions appear and
 * execute via their original owner. Squeeze membership comes from the
 * composition graph alone (explicit projections/semanticRole), never from
 * id-shape inference.
 *
 * Seams: `resolveToolbarComposition` (normal/squeeze projections),
 * `StylusAccessoryBinder` squeeze palette model (`showPalette`), and
 * `executeSqueezeOwned` ownership routing (provider/shell/contribution).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryStylusService,
  type DocumentToolSnapshot,
} from '@froglight/foundation';
import { createDocumentToolbarRegistry } from './document-toolbar-registry.js';
import {
  createToolbarCompositionRegistry,
  resolveToolbarComposition,
} from './toolbar/composition-registry.js';
import { registerCommunityToolbarContribution } from './toolbar/community-contribution.js';
import { assembleOwnedPool } from './toolbar/placement-resolver.js';
import {
  StylusAccessoryBinder,
  type StylusAccessoryMenuAnchor,
  type StylusPaletteHandle,
} from './stylus-accessory.js';
import type { StylusPaletteModel } from './stylus-palette-model.js';
import { createStylusMenuRegistry } from './stylus-menu-registry.js';
import { executeSqueezeOwned } from './react/workspace/hooks/useStylusAccessory.js';

const INK_PEN = 'ink.tool.froglight.ink.pen';
const INK_ERASER = 'ink.tool.froglight.ink.eraser';

function providerButton(
  id: string,
  semanticRole: string,
  toolRole: 'pen' | 'eraser',
  active = false,
): DocumentToolSnapshot['controls'][number] {
  return {
    kind: 'button',
    id,
    group: 'draw',
    label: id,
    role: 'surface-tool',
    toolRole,
    semanticRole,
    ...(active ? { active: true as const } : {}),
  } as DocumentToolSnapshot['controls'][number];
}

function inkSnapshot(): DocumentToolSnapshot {
  return {
    context: 'Ink canvas',
    controls: [
      providerButton(INK_PEN, 'surface.pen.ball', 'pen', true),
      providerButton(INK_ERASER, 'surface.erase', 'eraser'),
    ],
  };
}

function installComposition(
  registry: ReturnType<typeof createToolbarCompositionRegistry>['registry'],
): void {
  registry.registerCategory({
    id: 'surface.write',
    familyId: 'surface',
    label: 'Write',
    icon: 'pen',
  });
  registry.registerCategory({
    id: 'surface.erase',
    familyId: 'surface',
    label: 'Erase',
    icon: 'eraser',
  });
  registry.registerItem({
    id: 'test.write.pen',
    categoryId: 'surface.write',
    semanticRole: 'surface.pen.ball',
    projections: ['normal', 'compact', 'squeeze'],
  });
  registry.registerItem({
    id: 'test.erase.tool',
    categoryId: 'surface.erase',
    semanticRole: 'surface.erase',
    projections: ['normal', 'compact', 'squeeze'],
  });
  registry.registerKindExtension({
    id: 'test-ink-family',
    kindIds: ['froglight.ink'],
    familyIds: ['surface'],
  });
}

describe('squeeze owned pool (provider + shell + community)', () => {
  it('resolves the same owned pool for normal and squeeze; showInSqueeze appears in both', () => {
    const composition = createToolbarCompositionRegistry();
    const controls = createDocumentToolbarRegistry();
    try {
      installComposition(composition.registry);
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
        controls: controls.registry,
        broker: { execute: brokerExecute },
      });
      const snapshot = inkSnapshot();
      const context = {
        pane: 'main',
        documentId: 'doc-1',
        kindId: 'froglight.ink',
        editor: snapshot,
      };
      const entries = controls.registry.entries(context);
      expect(entries.map((entry) => entry.contributionId)).toContain(
        'community.example.diagram.diamond.owner',
      );
      const assembled = assembleOwnedPool({
        providerControls: snapshot.controls,
        shellControls: [],
        contributions: entries,
      });
      const communityOwned = assembled.ownedPool.find(
        (owned) =>
          owned.control.id === 'community.example.diagram.diamond.command',
      );
      expect(communityOwned?.owner).toEqual({
        kind: 'contribution',
        contributionId: 'community.example.diagram.diamond.owner',
      });
      const poolControls = assembled.ownedPool.map((owned) => owned.control);
      const normal = resolveToolbarComposition({
        snapshot: composition.registry.snapshot(),
        kindId: context.kindId,
        controls: poolControls,
        projection: 'normal',
      });
      const squeeze = resolveToolbarComposition({
        snapshot: composition.registry.snapshot(),
        kindId: context.kindId,
        controls: poolControls,
        projection: 'squeeze',
      });
      const normalIds = normal.categories.flatMap((category) =>
        category.items.map((item) => item.control.id),
      );
      const squeezeIds = squeeze.categories.flatMap((category) =>
        category.items.map((item) => item.control.id),
      );
      // Same semantic control instance backs both projections.
      expect(normalIds).toContain('community.example.diagram.diamond.command');
      expect(squeezeIds).toContain('community.example.diagram.diamond.command');
      expect(normalIds).toContain(INK_PEN);
      expect(squeezeIds).toContain(INK_PEN);
      const normalCommunity = normal.categories
        .flatMap((category) => category.items)
        .find(
          (item) =>
            item.control.id === 'community.example.diagram.diamond.command',
        );
      const squeezeCommunity = squeeze.categories
        .flatMap((category) => category.items)
        .find(
          (item) =>
            item.control.id === 'community.example.diagram.diamond.command',
        );
      expect(squeezeCommunity?.control).toBe(normalCommunity?.control);
      registration.dispose();
    } finally {
      composition.dispose();
      controls.dispose();
    }
  });

  it('excludes showInSqueeze=false from squeeze while keeping normal (no id inference)', () => {
    const composition = createToolbarCompositionRegistry();
    const controls = createDocumentToolbarRegistry();
    try {
      installComposition(composition.registry);
      const brokerExecute = vi.fn(() => true);
      const registration = registerCommunityToolbarContribution({
        pluginId: 'example.diagram',
        manifest: {
          id: 'hidden',
          targetCategoryId: 'surface.write',
          label: 'Hidden tool',
          commandId: 'hidden-command',
          // showInSqueeze omitted -> normal/compact only.
        },
        composition: composition.registry,
        controls: controls.registry,
        broker: { execute: brokerExecute },
      });
      const snapshot = inkSnapshot();
      const context = {
        pane: 'main',
        documentId: 'doc-1',
        kindId: 'froglight.ink',
        editor: snapshot,
      };
      const assembled = assembleOwnedPool({
        providerControls: snapshot.controls,
        shellControls: [],
        contributions: controls.registry.entries(context),
      });
      const poolControls = assembled.ownedPool.map((owned) => owned.control);
      const normal = resolveToolbarComposition({
        snapshot: composition.registry.snapshot(),
        kindId: context.kindId,
        controls: poolControls,
        projection: 'normal',
      });
      const squeeze = resolveToolbarComposition({
        snapshot: composition.registry.snapshot(),
        kindId: context.kindId,
        controls: poolControls,
        projection: 'squeeze',
      });
      const normalIds = normal.categories.flatMap((category) =>
        category.items.map((item) => item.control.id),
      );
      const squeezeIds = squeeze.categories.flatMap((category) =>
        category.items.map((item) => item.control.id),
      );
      // Same id shape, different projection membership: proves squeeze
      // membership is the composition graph, not an id regex.
      expect(normalIds).toContain('community.example.diagram.hidden.command');
      expect(squeezeIds).not.toContain(
        'community.example.diagram.hidden.command',
      );
      registration.dispose();
    } finally {
      composition.dispose();
      controls.dispose();
    }
  });

  it('squeeze palette tools follow composition order, not role buckets', () => {
    const service = new InMemoryStylusService();
    const menus = createStylusMenuRegistry();
    const composition = createToolbarCompositionRegistry();
    const toolbarControls = createDocumentToolbarRegistry();
    try {
      installComposition(composition.registry);
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
      const snapshot = inkSnapshot();
      const palettes: Array<{
        model: StylusPaletteModel;
        anchor: StylusAccessoryMenuAnchor;
      }> = [];
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
        showPalette: (model, anchor) => {
          palettes.push({ model, anchor });
          let closed = false;
          const handle: StylusPaletteHandle = {
            updateAnchor: () => undefined,
            close: () => {
              closed = true;
            },
            get closed() {
              return closed;
            },
          };
          return handle;
        },
        commands: {
          canExecEditorCommand: () => true,
          execEditorCommand: () => true,
        },
      });
      service.handleNativeEvent('action', {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 100, y: 100 },
      });
      expect(palettes).toHaveLength(1);
      const model = palettes[0]?.model;
      expect(model).toBeDefined();
      // Expected order is the resolved squeeze composition itself: the
      // palette must not re-sort by coarse tool role (which would put the
      // pen first and bucket the role-less community control last).
      const context = {
        pane: 'main',
        documentId: 'doc-1',
        kindId: 'froglight.ink',
        editor: snapshot,
      };
      const assembled = assembleOwnedPool({
        providerControls: snapshot.controls,
        shellControls: [],
        contributions: toolbarControls.registry.entries(context),
      });
      const expected = resolveToolbarComposition({
        snapshot: composition.registry.snapshot(),
        kindId: context.kindId,
        controls: assembled.ownedPool.map((owned) => owned.control),
        projection: 'squeeze',
      }).categories.flatMap((category) =>
        category.items.map((item) => item.control.id),
      );
      expect(model?.tools.map((tool) => tool.id)).toEqual(expected);
      binder.dispose();
      registration.dispose();
    } finally {
      composition.dispose();
      toolbarControls.dispose();
      menus.dispose();
    }
  });

  it('squeeze palette model carries the community tool with its contribution owner', () => {
    const service = new InMemoryStylusService();
    const menus = createStylusMenuRegistry();
    const composition = createToolbarCompositionRegistry();
    const toolbarControls = createDocumentToolbarRegistry();
    try {
      installComposition(composition.registry);
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
      const snapshot = inkSnapshot();
      const palettes: Array<{
        model: StylusPaletteModel;
        anchor: StylusAccessoryMenuAnchor;
      }> = [];
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
        showPalette: (model, anchor) => {
          palettes.push({ model, anchor });
          let closed = false;
          const handle: StylusPaletteHandle = {
            updateAnchor: () => undefined,
            close: () => {
              closed = true;
            },
            get closed() {
              return closed;
            },
          };
          return handle;
        },
        commands: {
          canExecEditorCommand: () => true,
          execEditorCommand: () => true,
        },
      });
      service.handleNativeEvent('action', {
        type: 'squeeze',
        phase: 'began',
        anchor: { x: 100, y: 100 },
      });
      expect(palettes).toHaveLength(1);
      const model = palettes[0]?.model;
      expect(model).toBeDefined();
      const toolIds = model?.tools.map((tool) => tool.id) ?? [];
      expect(toolIds).toContain(INK_PEN);
      expect(toolIds).toContain('community.example.diagram.diamond.command');
      const communityTool = model?.tools.find(
        (tool) => tool.id === 'community.example.diagram.diamond.command',
      );
      expect(communityTool?.owner).toEqual({
        kind: 'contribution',
        contributionId: 'community.example.diagram.diamond.owner',
      });
      const providerTool = model?.tools.find((tool) => tool.id === INK_PEN);
      expect(providerTool?.owner).toEqual({ kind: 'provider' });
      const ownedIds =
        model?.owned?.map((owned) => owned.control.id) ?? [];
      expect(ownedIds).toContain('community.example.diagram.diamond.command');
      expect(
        model?.owned?.find(
          (owned) =>
            owned.control.id === 'community.example.diagram.diamond.command',
        )?.owner,
      ).toEqual({
        kind: 'contribution',
        contributionId: 'community.example.diagram.diamond.owner',
      });
      binder.dispose();
      registration.dispose();
    } finally {
      composition.dispose();
      toolbarControls.dispose();
      menus.dispose();
    }
  });

  it('executes squeeze selections via the original owner (contribution/provider/shell)', async () => {
    const composition = createToolbarCompositionRegistry();
    const toolbarControls = createDocumentToolbarRegistry();
    try {
      installComposition(composition.registry);
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
      const snapshot = inkSnapshot();
      const context = {
        pane: 'main',
        documentId: 'doc-1',
        kindId: 'froglight.ink',
        editor: snapshot,
      };
      const assembled = assembleOwnedPool({
        providerControls: snapshot.controls,
        shellControls: [
          {
            kind: 'button',
            id: 'shell.history.undo',
            group: 'history',
            label: 'Undo',
          } as DocumentToolSnapshot['controls'][number],
        ],
        contributions: toolbarControls.registry.entries(context),
      });
      const byId = new Map(
        assembled.ownedPool.map((owned) => [owned.control.id, owned]),
      );
      const communityOwned = byId.get(
        'community.example.diagram.diamond.command',
      );
      expect(communityOwned).toBeDefined();
      const providerOwned = byId.get(INK_PEN);
      expect(providerOwned?.owner).toEqual({ kind: 'provider' });
      const shellOwned = byId.get('shell.history.undo');
      expect(shellOwned?.owner).toEqual({ kind: 'shell', command: 'undo' });

      const providerCalls: Array<{ id: string; value?: string }> = [];
      const shellCalls: Array<{ command: string; pane: string }> = [];
      const tools = {
        executeEditorTool: (_pane: string, id: string, value?: string) => {
          providerCalls.push({ id, value });
          return true;
        },
        execEditorCommand: (command: 'undo' | 'redo', pane?: string) => {
          shellCalls.push({ command, pane: pane ?? '' });
          return true;
        },
      };
      // Community routes via the contribution broker, never the provider.
      executeSqueezeOwned(
        {
          tools,
          contributions: toolbarControls.registry,
          pane: 'main',
          context,
        },
        communityOwned!,
      );
      expect(brokerExecute).toHaveBeenCalledWith(
        'example.diagram',
        'insert-diamond',
        context,
      );
      expect(providerCalls).toEqual([]);

      // Provider routes via the provider channel, never the broker.
      brokerExecute.mockClear();
      executeSqueezeOwned(
        {
          tools,
          contributions: toolbarControls.registry,
          pane: 'main',
          context,
        },
        providerOwned!,
      );
      expect(providerCalls).toEqual([{ id: INK_PEN, value: undefined }]);
      expect(brokerExecute).not.toHaveBeenCalled();

      // Shell routes via execEditorCommand.
      executeSqueezeOwned(
        {
          tools,
          contributions: toolbarControls.registry,
          pane: 'main',
          context,
        },
        shellOwned!,
      );
      expect(shellCalls).toEqual([{ command: 'undo', pane: 'main' }]);
      registration.dispose();
    } finally {
      composition.dispose();
      toolbarControls.dispose();
    }
  });
});
