/**
 *  production community lifecycle.
 *
 * Community plugins contribute toolbar structure through a validated,
 * sandbox-safe DTO and execute through the command broker. They never
 * receive React, DOM, CSS, handles, or registry objects. Lifecycle is
 * effect-owned by a `community:<id>` slot: load → registered,
 * disable → disposed, reenable → restored once, uninstall → no orphan.
 * `showInSqueeze` works end-to-end with primary/secondary/More
 * classification; focus modes preserve the community tool.
 *
 * Seams: `CommunityPluginManager` (real lifecycle) + `createSdkFacades`
 * toolbar bridge + `registerCommunityToolbarContribution` host +
 * `resolveToolbarComposition` (normal/squeeze) + `buildStylusPaletteModel`
 * tiers. Tests run against the real manager/runtime, not isolated
 * registry functions.
 */

import { describe, expect, it, vi } from 'vitest';
import { Runtime, definePlugin } from '@froglight/runtime';
import {
  commandsToken,
  vaultToken,
  createMemoryVault,
  InMemoryCommandService,
  memoryVaultPlugin,
  workspacePlugin,
  type VaultService,
} from '@froglight/foundation';
import {
  CommunityPluginManager,
  PermissionBroker,
  communityToolbarToken,
  createSdkFacades,
  validateManifest,
  type CommunityToolbarHost,
  type PluginCodeLoader,
  type SdkFacades,
} from '@froglight/plugin-platform';
import { installDefaultUi } from '../workbench.js';
import { createDocumentToolbarRegistry } from '../document-toolbar-registry.js';
import {
  createToolbarCompositionRegistry,
  resolveToolbarComposition,
} from './composition-registry.js';
import { createCommunityToolbarHost } from './community-lifecycle.js';
import { assembleOwnedPool } from './placement-resolver.js';
import {
  buildStylusPaletteModel,
  splitSqueezeTools,
} from '../stylus-palette-model.js';

const KIND_INK = 'froglight.ink';

function manifestJson(
  id = 'example.diagram',
  permissions: string[] = ['workspace.commands.register'],
) {
  return {
    manifestVersion: 1,
    id,
    version: '1.0.0',
    froglightSdk: '^0.1.0',
    permissions,
  };
}

function fakeLoader(
  impl: (code: string, facades: SdkFacades) => void | (() => void) | Promise<void | (() => void)>,
): PluginCodeLoader {
  return async (code: string) =>
    (facades: SdkFacades) =>
      impl(code, facades);
}

interface Harness {
  runtime: Runtime;
  vault: VaultService;
  commands: InMemoryCommandService;
  composition: ReturnType<typeof createToolbarCompositionRegistry>;
  controls: ReturnType<typeof createDocumentToolbarRegistry>;
  manager: CommunityPluginManager;
}

async function harness(): Promise<Harness> {
  const runtime = new Runtime();
  const vault = createMemoryVault().vault;
  const commands = new InMemoryCommandService();
  const composition = createToolbarCompositionRegistry();
  const controls = createDocumentToolbarRegistry();
  // First-party frame so the community target category exists.
  composition.registry.registerCategory({
    id: 'surface.shapes',
    familyId: 'surface',
    label: 'Shapes',
    icon: 'shapes',
  });
  composition.registry.registerKindExtension({
    id: 'surface-kind',
    kindIds: [KIND_INK],
    familyIds: ['surface'],
  });
  const host = createCommunityToolbarHost({
    composition: composition.registry,
    controls: controls.registry,
    commands,
  });
  await runtime.registerSlot({
    id: 'vault',
    plugin: definePlugin({
      id: 'test.vault-binding',
      activate: (ctx) => {
        ctx.provide(vaultToken, vault);
      },
    }),
  });
  await runtime.registerSlot({
    id: 'commands',
    plugin: definePlugin({
      id: 'test.commands-binding',
      activate: (ctx) => {
        ctx.provide(commandsToken, commands as unknown);
      },
    }),
  });
  await runtime.registerSlot({
    id: 'community-toolbar',
    plugin: definePlugin({
      id: 'test.toolbar-binding',
      activate: (ctx) => {
        ctx.provide(communityToolbarToken, host);
      },
    }),
  });
  const manager = new CommunityPluginManager({ runtime });
  await manager.attach(vault);
  return { runtime, vault, commands, composition, controls, manager };
}

function poolControls(harness: Harness) {
  const context = {
    pane: 'main',
    documentId: 'doc-1',
    kindId: KIND_INK,
    editor: null,
  };
  return { context, controls: harness.controls.registry.controls(context) };
}

describe('community lifecycle via real manager', () => {
  it('loads → registered, disables → disposed, reenables → restored once, uninstalls → no orphan', async () => {
    const h = await harness();
    try {
      let commandCalls = 0;
      h.manager.setLoader(
        fakeLoader((_code, facades) => {
          facades.commands.register({
            id: 'insert-diamond',
            execute: () => {
              commandCalls += 1;
            },
          });
          facades.toolbar.register({
            id: 'diamond',
            targetCategoryId: 'surface.shapes',
            label: 'Decision diamond',
            icon: 'shapes',
            commandId: 'insert-diamond',
            showInSqueeze: true,
          });
        }),
      );
      await h.manager.install({
        manifestJson: manifestJson(),
        code: 'diamond-source',
      });
      await h.manager.enable('example.diagram');
      expect(
        h.manager.list().find((entry) => entry.id === 'example.diagram')
          ?.state,
      ).toBe('active');

      // Registered: structure + execution both present, exactly once.
      expect(
        h.composition.registry
          .snapshot()
          .items.filter((item) =>
            item.id.startsWith('community.example.diagram.'),
          ),
      ).toHaveLength(1);
      const { context, controls: pool } = poolControls(h);
      expect(
        pool.filter(
          (control) =>
            control.id === 'community.example.diagram.diamond.command',
        ),
      ).toHaveLength(1);
      const resolved = resolveToolbarComposition({
        snapshot: h.composition.registry.snapshot(),
        kindId: KIND_INK,
        controls: pool,
      });
      expect(
        resolved.categories
          .flatMap((category) => category.items)
          .map((item) => item.control.id),
      ).toContain('community.example.diagram.diamond.command');

      // Execution routes via the broker to the plugin command, never the
      // provider channel.
      const control = pool.find(
        (entry) => entry.id === 'community.example.diagram.diamond.command',
      );
      expect(control).toBeDefined();
      if (control === undefined) throw new Error('missing community control');
      expect(
        await h.controls.registry.execute(context, control.id),
      ).toBe(true);
      expect(commandCalls).toBe(1);

      // Disable: both registrations disposed, no orphan.
      await h.manager.disable('example.diagram');
      expect(
        h.manager.list().find((entry) => entry.id === 'example.diagram')
          ?.state,
      ).toBe('disabled');
      expect(
        h.composition.registry
          .snapshot()
          .items.filter((item) =>
            item.id.startsWith('community.example.diagram.'),
          ),
      ).toHaveLength(0);
      expect(poolControls(h).controls).toEqual([]);
      expect(h.commands.list()).not.toContain('insert-diamond');

      // Reenable: restored exactly once (no duplicate).
      await h.manager.enable('example.diagram');
      expect(
        h.composition.registry
          .snapshot()
          .items.filter((item) =>
            item.id.startsWith('community.example.diagram.'),
          ),
      ).toHaveLength(1);
      expect(
        poolControls(h).controls.filter(
          (control) =>
            control.id === 'community.example.diagram.diamond.command',
        ),
      ).toHaveLength(1);

      // Uninstall: no orphan contribution.
      await h.manager.remove('example.diagram');
      expect(h.manager.list()).toHaveLength(0);
      expect(
        h.composition.registry
          .snapshot()
          .items.filter((item) => item.id.startsWith('community.')),
      ).toHaveLength(0);
      expect(poolControls(h).controls).toEqual([]);
    } finally {
      await h.manager.detach();
      h.composition.dispose();
      h.controls.dispose();
      await h.runtime.dispose();
    }
  });

  it('excludes showInSqueeze=false from squeeze while keeping normal', async () => {
    const h = await harness();
    try {
      h.manager.setLoader(
        fakeLoader((_code, facades) => {
          facades.commands.register({
            id: 'hidden-command',
            execute: () => null,
          });
          facades.toolbar.register({
            id: 'hidden',
            targetCategoryId: 'surface.shapes',
            label: 'Hidden tool',
            commandId: 'hidden-command',
          });
        }),
      );
      await h.manager.install({
        manifestJson: manifestJson('example.hidden'),
        code: 'hidden-source',
      });
      await h.manager.enable('example.hidden');
      const { controls: pool } = poolControls(h);
      const normal = resolveToolbarComposition({
        snapshot: h.composition.registry.snapshot(),
        kindId: KIND_INK,
        controls: pool,
        projection: 'normal',
      });
      const squeeze = resolveToolbarComposition({
        snapshot: h.composition.registry.snapshot(),
        kindId: KIND_INK,
        controls: pool,
        projection: 'squeeze',
      });
      const normalIds = normal.categories.flatMap((category) =>
        category.items.map((item) => item.control.id),
      );
      const squeezeIds = squeeze.categories.flatMap((category) =>
        category.items.map((item) => item.control.id),
      );
      expect(normalIds).toContain('community.example.hidden.hidden.command');
      expect(squeezeIds).not.toContain(
        'community.example.hidden.hidden.command',
      );
    } finally {
      await h.manager.detach();
      h.composition.dispose();
      h.controls.dispose();
      await h.runtime.dispose();
    }
  });

  it('classifies squeeze as primary/secondary/More end-to-end with preserved owners', async () => {
    const h = await harness();
    try {
      h.manager.setLoader(
        fakeLoader((_code, facades) => {
          facades.commands.register({
            id: 'insert-diamond',
            execute: () => null,
          });
          facades.toolbar.register({
            id: 'diamond',
            targetCategoryId: 'surface.shapes',
            label: 'Decision diamond',
            icon: 'shapes',
            commandId: 'insert-diamond',
            showInSqueeze: true,
          });
        }),
      );
      await h.manager.install({
        manifestJson: manifestJson(),
        code: 'diamond-source',
      });
      await h.manager.enable('example.diagram');
      const providerPen = {
        kind: 'button',
        id: 'ink.tool.pen',
        group: 'draw',
        label: 'Pen',
        role: 'surface-tool',
        toolRole: 'pen',
        semanticRole: 'surface.pen.ball',
      } as const;
      // Provider pen must resolve too: give it a composition item.
      h.composition.registry.registerCategory({
        id: 'surface.write',
        familyId: 'surface',
        label: 'Write',
        icon: 'pen',
        order: 5,
      });
      h.composition.registry.registerItem({
        id: 'test.write.pen',
        categoryId: 'surface.write',
        semanticRole: 'surface.pen.ball',
        order: 10,
        projections: ['normal', 'compact', 'squeeze'],
      });
      const context = {
        pane: 'main',
        documentId: 'doc-1',
        kindId: KIND_INK,
        editor: null,
      };
      // Provider pen is provider-owned; the community control arrives
      // only via contributions (never duplicated as a provider control),
      // so ownership precedence keeps the contribution owner.
      const assembled = assembleOwnedPool({
        providerControls: [providerPen] as never as Parameters<
          typeof assembleOwnedPool
        >[0]['providerControls'],
        contributions: h.controls.registry.entries(context),
      });
      const poolControls = assembled.ownedPool.map((owned) => owned.control);
      const squeeze = resolveToolbarComposition({
        snapshot: h.composition.registry.snapshot(),
        kindId: KIND_INK,
        controls: poolControls,
        projection: 'squeeze',
      });
      const model = buildStylusPaletteModel(
        { context: 'Ink canvas', controls: poolControls } as never,
        {
          composition: squeeze,
          ownedPool: assembled.ownedPool,
          contributions: [{ label: 'Acme recipe' }],
        },
      );
      expect(model).not.toBeNull();
      const { primary, secondary } = splitSqueezeTools(model?.tools ?? []);
      expect(primary.map((tool) => tool.id)).toContain('ink.tool.pen');
      expect(secondary.map((tool) => tool.id)).toContain(
        'community.example.diagram.diamond.command',
      );
      // Owners preserved through tiering.
      expect(
        secondary
          .find(
            (tool) =>
              tool.id === 'community.example.diagram.diamond.command',
          )
          ?.owner,
      ).toEqual({
        kind: 'contribution',
        contributionId: 'community.example.diagram.diamond.owner',
      });
      // More stays separate from squeeze tools.
      expect(model?.contributions).toEqual([{ label: 'Acme recipe' }]);
    } finally {
      await h.manager.detach();
      h.composition.dispose();
      h.controls.dispose();
      await h.runtime.dispose();
    }
  });

  it('keeps the community tool visible across squeeze focus modes', async () => {
    const h = await harness();
    try {
      h.manager.setLoader(
        fakeLoader((_code, facades) => {
          facades.commands.register({
            id: 'insert-diamond',
            execute: () => null,
          });
          facades.toolbar.register({
            id: 'diamond',
            targetCategoryId: 'surface.shapes',
            label: 'Decision diamond',
            icon: 'shapes',
            commandId: 'insert-diamond',
            showInSqueeze: true,
          });
        }),
      );
      await h.manager.install({
        manifestJson: manifestJson(),
        code: 'diamond-source',
      });
      await h.manager.enable('example.diagram');
      h.composition.registry.registerCategory({
        id: 'surface.write',
        familyId: 'surface',
        label: 'Write',
        icon: 'pen',
        order: 5,
      });
      h.composition.registry.registerItem({
        id: 'test.write.pen',
        categoryId: 'surface.write',
        semanticRole: 'surface.pen.ball',
        order: 10,
        projections: ['normal', 'compact', 'squeeze'],
      });
      const context = {
        pane: 'main',
        documentId: 'doc-1',
        kindId: KIND_INK,
        editor: null,
      };
      const providerPen = {
        kind: 'button',
        id: 'ink.tool.pen',
        group: 'draw',
        label: 'Pen',
        role: 'surface-tool',
        toolRole: 'pen',
        semanticRole: 'surface.pen.ball',
      } as const;
      const assembled = assembleOwnedPool({
        providerControls: [providerPen] as never as Parameters<
          typeof assembleOwnedPool
        >[0]['providerControls'],
        contributions: h.controls.registry.entries(context),
      });
      const deduped = assembled.ownedPool.map((owned) => owned.control);
      const squeeze = resolveToolbarComposition({
        snapshot: h.composition.registry.snapshot(),
        kindId: KIND_INK,
        controls: deduped,
        projection: 'squeeze',
      });
      for (const focusMode of ['full', 'color', 'attributes'] as const) {
        const model = buildStylusPaletteModel(
          { context: 'Ink canvas', controls: deduped } as never,
          { composition: squeeze, ownedPool: assembled.ownedPool, focusMode },
        );
        expect(
          model?.tools.map((tool) => tool.id),
          `focusMode ${focusMode}`,
        ).toContain('community.example.diagram.diamond.command');
        expect(model?.focusMode).toBe(focusMode);
      }
    } finally {
      await h.manager.detach();
      h.composition.dispose();
      h.controls.dispose();
      await h.runtime.dispose();
    }
  });

  it('rejects unsafe DTOs and permission-less registration without orphan state', async () => {
    const h = await harness();
    try {
      const execute = vi.fn(() => true);
      void execute;
      h.manager.setLoader(
        fakeLoader((_code, facades) => {
          // Unsafe manifest: must throw TypeError, no registration.
          expect(() =>
            facades.toolbar.register({
              id: '../bad',
              targetCategoryId: 'surface.shapes',
              label: '',
              commandId: 'run',
            }),
          ).toThrow(/stable|label/i);
          // Function-valued field: rejected as non-data.
          expect(() =>
            facades.toolbar.register({
              id: 'bad',
              targetCategoryId: 'surface.shapes',
              label: 'Bad',
              commandId: 'run',
              // @ts-expect-error — hostile input probe, not a type error in prod.
              execute: () => true,
            }),
          ).toThrow(/data, not a function/i);
        }),
      );
      await h.manager.install({
        manifestJson: manifestJson('example.bad'),
        code: 'bad-source',
      });
      await h.manager.enable('example.bad');
      expect(
        h.composition.registry
          .snapshot()
          .items.filter((item) => item.id.startsWith('community.')),
      ).toHaveLength(0);
      expect(poolControls(h).controls).toEqual([]);
    } finally {
      await h.manager.detach();
      h.composition.dispose();
      h.controls.dispose();
      await h.runtime.dispose();
    }
  });

  it('rejects unregistered icons at the trusted host without orphan state; missing icon stays dormant-safe', async () => {
    const h = await harness();
    try {
      const host = createCommunityToolbarHost({
        composition: h.composition.registry,
        controls: h.controls.registry,
        commands: h.commands,
      });
      // Regex-valid but unregistered: rejected fail-closed with a clear
      // error, never an empty <path d="">.
      expect(() =>
        host.registerToolbar('example.diagram', {
          id: 'tool',
          targetCategoryId: 'surface.shapes',
          label: 'Tool',
          icon: 'not-an-icon',
          commandId: 'run',
        }),
      ).toThrow(/not-an-icon.*approv|approv.*not-an-icon/i);
      expect(
        h.composition.registry
          .snapshot()
          .items.filter((item) => item.id.startsWith('community.')),
      ).toHaveLength(0);
      expect(poolControls(h).controls).toEqual([]);

      // Missing icon is valid: label-only control, dormant until its
      // category resolves (already registered by the harness), then
      // dispose → zero, re-register → one.
      const handle = host.registerToolbar('example.diagram', {
        id: 'tool',
        targetCategoryId: 'surface.shapes',
        label: 'Tool',
        commandId: 'run',
      });
      const { controls: pool } = poolControls(h);
      expect(
        pool.filter(
          (control) => control.id === 'community.example.diagram.tool.command',
        ),
      ).toHaveLength(1);
      expect(
        pool.find(
          (control) => control.id === 'community.example.diagram.tool.command',
        ),
      ).not.toHaveProperty('icon');
      handle.dispose();
      expect(poolControls(h).controls).toEqual([]);
      const revived = host.registerToolbar('example.diagram', {
        id: 'tool',
        targetCategoryId: 'surface.shapes',
        label: 'Tool',
        commandId: 'run',
      });
      expect(
        poolControls(h).controls.filter(
          (control) => control.id === 'community.example.diagram.tool.command',
        ),
      ).toHaveLength(1);
      revived.dispose();
      expect(poolControls(h).controls).toEqual([]);
    } finally {
      await h.manager.detach();
      h.composition.dispose();
      h.controls.dispose();
      await h.runtime.dispose();
    }
  });

  it('denies toolbar registration without the commands permission (trusted-side authority)', async () => {
    const h = await harness();
    try {
      let threw: unknown = null;
      h.manager.setLoader(
        fakeLoader((_code, facades) => {
          try {
            facades.toolbar.register({
              id: 'diamond',
              targetCategoryId: 'surface.shapes',
              label: 'Diamond',
              commandId: 'insert-diamond',
            });
          } catch (error) {
            threw = error;
            throw error;
          }
        }),
      );
      await h.manager.install({
        manifestJson: manifestJson('example.noperm', []),
        code: 'noperm-source',
      });
      await h.manager.enable('example.noperm');
      expect(String(threw)).toMatch(/PermissionDenied/i);
      expect(
        h.manager.list().find((entry) => entry.id === 'example.noperm')
          ?.state,
      ).toBe('failed');
      expect(
        h.composition.registry
          .snapshot()
          .items.filter((item) => item.id.startsWith('community.')),
      ).toHaveLength(0);
    } finally {
      await h.manager.detach();
      h.composition.dispose();
      h.controls.dispose();
      await h.runtime.dispose();
    }
  });

  it('exposes no React/DOM/CSS/handles/registry to community code', async () => {
    const h = await harness();
    try {
      let seenKeys: string[] = [];
      let toolbarKeys: string[] = [];
      h.manager.setLoader(
        fakeLoader((_code, facades) => {
          seenKeys = Object.keys(facades).sort();
          toolbarKeys = Object.keys(
            (facades as unknown as Record<string, unknown>)['toolbar'] as Record<
              string,
              unknown
            >,
          ).sort();
          // The toolbar facade is data-only: one method, no registry.
          const toolbar = (facades as unknown as Record<string, unknown>)[
            'toolbar'
          ] as Record<string, unknown>;
          expect(typeof toolbar['register']).toBe('function');
          expect(toolbar['composition']).toBeUndefined();
          expect(toolbar['controls']).toBeUndefined();
          expect(toolbar['registry']).toBeUndefined();
          // No React/DOM/CSS globals are handed out through facades.
          for (const key of seenKeys) {
            expect(key).not.toMatch(/react|dom|css|handle|registry/i);
          }
        }),
      );
      await h.manager.install({
        manifestJson: manifestJson('example.probe'),
        code: 'probe-source',
      });
      await h.manager.enable('example.probe');
      expect(seenKeys).toEqual([
        'blocks',
        'commands',
        'documents',
        'editorProvider',
        'properties',
        'settings',
        'toolbar',
        'uiSettings',
        'uiViews',
        'vault',
      ]);
      expect(toolbarKeys).toEqual(['register']);
    } finally {
      await h.manager.detach();
      h.composition.dispose();
      h.controls.dispose();
      await h.runtime.dispose();
    }
  });
});

function communityManifest() {
  return validateManifest({
    manifestVersion: 1,
    id: 'example.diagram',
    version: '1.0.0',
    froglightSdk: '^0.1.0',
    permissions: ['workspace.commands.register'],
  });
}

function toolbarFacades(host: CommunityToolbarHost): SdkFacades {
  return createSdkFacades({
    broker: new PermissionBroker(communityManifest(), 'trusted'),
    tier: 'trusted',
    services: { toolbar: host },
  });
}

async function productionHost(runtime: Runtime): Promise<CommunityToolbarHost> {
  let host: CommunityToolbarHost | undefined;
  await runtime.registerSlot({
    id: 'test.toolbar-probe',
    plugin: definePlugin({
      id: 'test.toolbar-probe',
      requirements: { requires: [communityToolbarToken] },
      activate: (ctx) => {
        host = ctx.require(communityToolbarToken);
      },
    }),
  });
  if (host === undefined)
    throw new Error('production community toolbar host did not activate');
  return host;
}

describe('production community toolbar binding (installDefaultUi)', () => {
  it('provides communityToolbarToken; facade register lands in production composition; broker fails closed without workspace', async () => {
    const runtime = new Runtime();
    const ui = await installDefaultUi(runtime);
    try {
      const host = await productionHost(runtime);
      const facades = toolbarFacades(host);
      const handle = facades.toolbar.register({
        id: 'diamond',
        targetCategoryId: 'surface.shapes',
        label: 'Decision diamond',
        commandId: 'insert-diamond',
        showInSqueeze: true,
      });
      expect(
        ui.toolbarComposition.snapshot().items.map((item) => item.id),
      ).toContain('community.example.diagram.diamond.item');
      // No workspace commands in this graph: execution fails closed
      // (false), never throws into the toolbar.
      const context = {
        pane: 'main',
        documentId: 'doc-1',
        kindId: KIND_INK,
        editor: null,
      };
      const pool = ui.documentTools.controls(context);
      expect(pool.map((control) => control.id)).toContain(
        'community.example.diagram.diamond.command',
      );
      await expect(
        ui.documentTools.execute(
          context,
          'community.example.diagram.diamond.command',
        ),
      ).resolves.toBe(false);
      handle.dispose();
      expect(
        ui.toolbarComposition.snapshot().items.map((item) => item.id),
      ).not.toContain('community.example.diagram.diamond.item');
    } finally {
      await runtime.dispose();
    }
  });

  it('routes broker execution to live workspace commands once a vault is open', async () => {
    const runtime = new Runtime();
    await runtime.registerSlot({ id: 'vault', plugin: memoryVaultPlugin });
    await runtime.registerSlot({ id: 'workspace', plugin: workspacePlugin });
    const ui = await installDefaultUi(runtime);
    try {
      let workspaceCommands:
        | Pick<InMemoryCommandService, 'register' | 'execute'>
        | undefined;
      await runtime.registerSlot({
        id: 'test.commands-probe',
        plugin: definePlugin({
          id: 'test.commands-probe',
          requirements: { requires: [commandsToken] },
          activate: (ctx) => {
            workspaceCommands = ctx.require(commandsToken) as Pick<
              InMemoryCommandService,
              'register' | 'execute'
            >;
          },
        }),
      });
      if (workspaceCommands === undefined)
        throw new Error('workspace commands did not activate');
      const host = await productionHost(runtime);
      let commandCalls = 0;
      workspaceCommands.register({
        id: 'insert-diamond',
        execute: () => {
          commandCalls += 1;
        },
      });
      const facades = toolbarFacades(host);
      const handle = facades.toolbar.register({
        id: 'diamond',
        targetCategoryId: 'surface.shapes',
        label: 'Decision diamond',
        commandId: 'insert-diamond',
        showInSqueeze: true,
      });
      try {
        const context = {
          pane: 'main',
          documentId: 'doc-1',
          kindId: KIND_INK,
          editor: null,
        };
        await expect(
          ui.documentTools.execute(
            context,
            'community.example.diagram.diamond.command',
          ),
        ).resolves.toBe(true);
        expect(commandCalls).toBe(1);
      } finally {
        handle.dispose();
      }
    } finally {
      await runtime.dispose();
    }
  });
});
