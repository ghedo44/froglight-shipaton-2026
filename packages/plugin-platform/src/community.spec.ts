import { describe, it, expect } from 'vitest';
import { Runtime, definePlugin } from '@froglight/runtime';
import {
  commandsToken,
  vaultToken,
  createMemoryVault,
  createMemoryVaultState,
  memoryVaultPlugin,
  documentRegistryToken,
  propertyCatalogToken,
  InMemoryDocumentRegistry,
  PropertyCatalog,
  documentKindId,
  workspacePath,
  type VaultService,
} from '@froglight/foundation';
import {
  CommunityPluginManager,
  communityPluginsBinding,
  communityPluginsToken,
  type PluginCodeLoader,
} from './community.js';
import { CrashLoopTracker } from './crash-loop.js';
import { VaultPluginStore } from './vault-store.js';
import { uiSettingsToken, type SdkFacades } from './facades.js';
import type { PluginManifest } from './manifest.js';

function validManifestJson(id = 'froglight.example') {
  return {
    manifestVersion: 1,
    id,
    version: '1.0.0',
    froglightSdk: '^0.1.0',
    permissions: ['workspace.commands.register'] as string[],
  };
}

/** Deterministic test loader: code strings map to activate functions without eval. */
function fakeLoader(
  impl: (
    code: string,
    facades: SdkFacades,
  ) => void | (() => void) | Promise<void | (() => void)>,
): PluginCodeLoader {
  return async (_code: string, _manifest: PluginManifest) =>
    (facades: SdkFacades) =>
      impl(_code, facades);
}

/** Minimal command registry standing in for the workspace-provided service. */
function createCommandRegistry() {
  const registered = new Set<{ id: string }>();
  return {
    register(cmd: { id: string }): { dispose(): void } {
      const entry = { id: cmd.id };
      registered.add(entry);
      return { dispose: () => registered.delete(entry) };
    },
    ids(): string[] {
      return [...registered].map((entry) => entry.id);
    },
  };
}

interface Harness {
  runtime: Runtime;
  vault: VaultService;
  tracker: CrashLoopTracker;
  commands: ReturnType<typeof createCommandRegistry>;
}

async function harness(): Promise<Harness> {
  const runtime = new Runtime();
  const vault = createMemoryVault().vault;
  const commands = createCommandRegistry();
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
  return { runtime, vault, tracker: new CrashLoopTracker(), commands };
}

describe('CommunityPluginManager — vault-backed community plugin lifecycle', () => {
  it('attach on an empty vault registers nothing', async () => {
    const h = await harness();
    const manager = new CommunityPluginManager({ runtime: h.runtime });
    await manager.attach(h.vault);
    expect(manager.list()).toEqual([]);
    expect(
      h.runtime.inspect().slots.filter((s) => s.id.startsWith('community:')),
    ).toHaveLength(0);
    await manager.detach();
    await h.runtime.dispose();
  });

  it('install + enable activates the plugin through brokered facades', async () => {
    const h = await harness();
    const manager = new CommunityPluginManager({ runtime: h.runtime });
    await manager.attach(h.vault);

    let registered = '';
    manager.setLoader(
      fakeLoader((_code, facades) => {
        facades.commands.register({ id: 'example.cmd', execute: () => 'ok' });
        registered = 'example.cmd';
      }),
    );

    await manager.install({
      manifestJson: validManifestJson(),
      code: 'fake-source',
    });
    await manager.enable('froglight.example');

    expect(registered).toBe('example.cmd');
    expect(h.commands.ids()).toContain('example.cmd');
    const entry = manager.list().find((p) => p.id === 'froglight.example');
    expect(entry?.state).toBe('active');
    const slot = h.runtime
      .inspect()
      .slots.find((s) => s.id === 'community:froglight.example');
    expect(slot?.state).toBe('active');

    await manager.detach();
    await h.runtime.dispose();
  });

  it('disable unloads cleanly: zero registrations remain', async () => {
    const h = await harness();
    const manager = new CommunityPluginManager({ runtime: h.runtime });
    await manager.attach(h.vault);
    manager.setLoader(
      fakeLoader((_code, facades) => {
        facades.commands.register({ id: 'p.cmd', execute: () => null });
      }),
    );

    await manager.install({ manifestJson: validManifestJson(), code: 'p1' });
    await manager.enable('froglight.example');
    expect(h.commands.ids()).toContain('p.cmd');

    await manager.disable('froglight.example');

    const snap = h.runtime.inspect();
    expect(
      snap.slots.find((s) => s.id === 'community:froglight.example'),
    ).toBeUndefined();
    // Effect-owned registration is gone with the fiber.
    expect(h.commands.ids()).not.toContain('p.cmd');
    expect(manager.list()[0]?.state).toBe('disabled');
    await manager.detach();
    await h.runtime.dispose();
  });

  it('withdraws and reactivates owned database extensions without touching canonical bytes', async () => {
    const h = await harness();
    const documents = new InMemoryDocumentRegistry();
    const propertyCatalog = new PropertyCatalog();
    await h.runtime.registerSlot({
      id: 'documents',
      plugin: definePlugin({
        id: 'test.documents-binding',
        activate(ctx) {
          ctx.provide(documentRegistryToken, documents);
        },
      }),
    });
    await h.runtime.registerSlot({
      id: 'property-catalog',
      plugin: definePlugin({
        id: 'test.property-catalog-binding',
        activate(ctx) {
          ctx.provide(propertyCatalogToken, propertyCatalog);
        },
      }),
    });
    let documentChanges = 0;
    let propertyChanges = 0;
    const documentSubscription = documents.onDidChange(() => {
      documentChanges += 1;
    });
    const propertySubscription = propertyCatalog.onDidChange(() => {
      propertyChanges += 1;
    });
    const manager = new CommunityPluginManager({ runtime: h.runtime });
    await manager.attach(h.vault);
    let activations = 0;
    manager.setLoader(
      fakeLoader((_code, facades) => {
        activations += 1;
        facades.documents.registerKind({
          id: documentKindId('acme.research.card'),
          decode: (bytes) => ({
            model: JSON.parse(new TextDecoder().decode(bytes)),
            metadata: {},
            relationships: [],
          }),
          encode: (model) => new TextEncoder().encode(JSON.stringify(model)),
        });
        facades.properties.registerType({
          id: 'acme.research.rating',
          label: 'Research rating',
          storage: 'stored',
          editor: 'number',
          validate: (value) =>
            typeof value === 'number' && value >= 0 && value <= 5
              ? null
              : 'Expected rating from 0 to 5',
        });
      }),
    );
    await manager.install({
      manifestJson: {
        manifestVersion: 1,
        id: 'acme.research',
        version: '1.0.0',
        froglightSdk: '^0.1.0',
        permissions: ['documents.registerKind', 'properties.registerType'],
      },
      code: 'independent database extensions',
    });
    await manager.enable('acme.research');

    const canonicalFiles = [
      {
        path: workspacePath('Independent.research-card'),
        bytes: new TextEncoder().encode(
          JSON.stringify({
            title: 'Independent',
            opaque: { futureVersion: 7, payload: ['preserve', 42] },
          }),
        ),
      },
      {
        path: workspacePath('Plugin resources.base'),
        bytes: new TextEncoder().encode(
          JSON.stringify({
            membership: { mode: 'explicit', resourceIds: ['resource-1'] },
            properties: [
              {
                id: 'quality',
                type: 'acme.research.rating',
                providerConfiguration: { palette: 'frog' },
              },
            ],
            templates: [
              {
                kindId: 'acme.research.card',
                providerConfiguration: { mode: 'independent' },
              },
            ],
          }),
        ),
      },
      {
        path: workspacePath('Independent.properties.json'),
        bytes: new TextEncoder().encode(
          JSON.stringify({ values: { quality: 4 } }),
        ),
      },
    ] as const;
    for (const file of canonicalFiles) {
      await h.vault.write(file.path, file.bytes);
    }
    const before = await Promise.all(
      canonicalFiles.map(async (file) => [...(await h.vault.read(file.path))]),
    );
    expect(documents.recognize('acme.research.card')).not.toBeNull();
    expect(propertyCatalog.get('acme.research.rating')).toBeDefined();

    await manager.disable('acme.research');
    expect(documents.recognize('acme.research.card')).toBeNull();
    expect(propertyCatalog.get('acme.research.rating')).toBeUndefined();
    expect(manager.list()[0]?.state).toBe('disabled');

    await manager.enable('acme.research');
    expect(manager.list()[0]?.state).toBe('active');
    expect(
      documents.list().filter((kind) => kind.id === 'acme.research.card'),
    ).toHaveLength(1);
    expect(
      propertyCatalog
        .list()
        .filter((type) => type.id === 'acme.research.rating'),
    ).toHaveLength(1);
    expect(activations).toBe(2);
    expect(documentChanges).toBe(3);
    expect(propertyChanges).toBe(3);
    await expect(
      Promise.all(
        canonicalFiles.map(async (file) => [
          ...(await h.vault.read(file.path)),
        ]),
      ),
    ).resolves.toEqual(before);

    documentSubscription.dispose();
    propertySubscription.dispose();
    await manager.detach();
    await h.runtime.dispose();
  });

  it('plugins lacking permission authority get PermissionDenied from facades', async () => {
    const h = await harness();
    const manager = new CommunityPluginManager({ runtime: h.runtime });
    await manager.attach(h.vault);
    manager.setLoader(
      fakeLoader((_code, facades) => {
        // Manifest only grants workspace.commands.register; vault.write is not granted.
        return facades.vault
          .write('.md' as never, new Uint8Array())
          .then(() => undefined);
      }),
    );

    await manager.install({ manifestJson: validManifestJson(), code: 'nope' });
    await manager.enable('froglight.example');

    const entry = manager.list().find((p) => p.id === 'froglight.example');
    expect(entry?.state).toBe('failed');
    expect(entry?.error).toMatch(/PermissionDenied/i);
    await manager.detach();
    await h.runtime.dispose();
  });

  it('vault path traversal is rejected through the production activation path', async () => {
    const h = await harness();
    const manager = new CommunityPluginManager({ runtime: h.runtime });
    await manager.attach(h.vault);
    manager.setLoader(
      fakeLoader((_code, facades) =>
        facades.vault.write('../outside.md' as never, new Uint8Array([1])),
      ),
    );

    await manager.install({
      manifestJson: {
        ...validManifestJson('froglight.traversal'),
        permissions: ['vault.write'],
      },
      code: 'traversal',
    });
    await manager.enable('froglight.traversal');

    const entry = manager
      .list()
      .find((plugin) => plugin.id === 'froglight.traversal');
    expect(entry?.state).toBe('failed');
    expect(entry?.error).toMatch(/traversal rejected/);
    await expect(h.vault.read('../outside.md' as never)).rejects.toThrow();
    await manager.detach();
    await h.runtime.dispose();
  });

  it('registers UI settings only with its declared permission and withdraws them', async () => {
    const h = await harness();
    const registered = new Set<string>();
    await h.runtime.registerSlot({
      id: 'ui-settings',
      plugin: definePlugin({
        id: 'test.ui-settings',
        activate: (ctx) => {
          ctx.provide(uiSettingsToken, {
            register(section: { id: string; name: string }) {
              registered.add(section.id);
              return { dispose: () => registered.delete(section.id) };
            },
          });
        },
      }),
    });
    const manager = new CommunityPluginManager({ runtime: h.runtime });
    await manager.attach(h.vault);
    let denial: unknown;
    manager.setLoader(
      fakeLoader((_code, facades) => {
        try {
          facades.uiSettings.register({
            id: 'froglight.settings.denied',
            name: 'Denied',
          });
        } catch (error) {
          denial = error;
        }
      }),
    );
    await manager.install({
      manifestJson: validManifestJson('froglight.settings-denied'),
      code: 'denied',
    });
    await manager.enable('froglight.settings-denied');
    expect((denial as Error)?.name).toBe('PermissionDeniedError');
    expect(registered.size).toBe(0);

    manager.setLoader(
      fakeLoader((_code, facades) => {
        facades.uiSettings.register({
          id: 'froglight.settings.allowed',
          name: 'Allowed',
        });
      }),
    );
    await manager.install({
      manifestJson: {
        ...validManifestJson('froglight.settings-allowed'),
        permissions: ['ui.views.register'],
      },
      code: 'allowed',
    });
    await manager.enable('froglight.settings-allowed');
    expect(registered).toEqual(new Set(['froglight.settings.allowed']));
    await manager.disable('froglight.settings-allowed');
    expect(registered.size).toBe(0);
    await manager.detach();
    await h.runtime.dispose();
  });

  it('attributes activation timeouts through the production manager', async () => {
    const h = await harness();
    const manager = new CommunityPluginManager({
      runtime: h.runtime,
      tracker: h.tracker,
      timeoutMs: 20,
    });
    await manager.attach(h.vault);
    manager.setLoader(async () => () => new Promise<void>(() => undefined));
    await manager.install({
      manifestJson: validManifestJson('froglight.timeout'),
      code: 'timeout',
    });
    await manager.enable('froglight.timeout');

    const entry = manager
      .list()
      .find((plugin) => plugin.id === 'froglight.timeout');
    expect(entry?.state).toBe('failed');
    expect(entry?.error).toMatch(/activation timeout/);
    expect(
      h.tracker
        .getState()
        .failures.some(
          (failure) => failure.slotId === 'community:froglight.timeout',
        ),
    ).toBe(true);
    await manager.detach();
    await h.runtime.dispose();
  });

  it('activation failure is attributed and does not break other plugins', async () => {
    const h = await harness();
    const manager = new CommunityPluginManager({
      runtime: h.runtime,
      tracker: h.tracker,
    });
    await manager.attach(h.vault);
    manager.setLoader(
      fakeLoader((code, facades) => {
        if (code === 'boom') throw new Error('boom during activate');
        facades.commands.register({ id: 'good.cmd', execute: () => null });
      }),
    );

    await manager.install({
      manifestJson: validManifestJson('froglight.bad'),
      code: 'boom',
    });
    await manager.install({
      manifestJson: validManifestJson('froglight.good'),
      code: 'fine',
    });
    await manager.enable('froglight.bad');
    await manager.enable('froglight.good');

    const states = new Map(manager.list().map((p) => [p.id, p.state]));
    expect(states.get('froglight.bad')).toBe('failed');
    expect(states.get('froglight.good')).toBe('active');
    expect(
      h.tracker
        .getState()
        .failures.some((f) => f.slotId === 'community:froglight.bad'),
    ).toBe(true);
    await manager.detach();
    await h.runtime.dispose();
  });

  it('a failing activation rolls back registrations it already made', async () => {
    const h = await harness();
    const manager = new CommunityPluginManager({
      runtime: h.runtime,
      tracker: h.tracker,
    });
    await manager.attach(h.vault);
    manager.setLoader(
      fakeLoader((_code, facades) => {
        // Register through the facade, THEN fail — the fiber's rollback must
        // dispose the facade-owned registration (dispose → zero registrations).
        facades.commands.register({ id: 'doomed.cmd', execute: () => null });
        throw new Error('fails after registering');
      }),
    );

    await manager.install({
      manifestJson: validManifestJson('froglight.doomed'),
      code: 'doom',
    });
    await manager.enable('froglight.doomed');

    expect(manager.list()[0]?.state).toBe('failed');
    expect(h.commands.ids()).not.toContain('doomed.cmd');
    await manager.detach();
    await h.runtime.dispose();
  });

  it('a repeatedly failing plugin is parked by crash-loop protection across restarts', async () => {
    const h = await harness();
    const manager = new CommunityPluginManager({
      runtime: h.runtime,
      tracker: h.tracker,
    });
    await manager.attach(h.vault);
    manager.setLoader(
      fakeLoader(() => {
        throw new Error('always fails');
      }),
    );
    await manager.install({ manifestJson: validManifestJson(), code: 'loop' });

    // Three consecutive failures trip the crash-loop threshold.
    for (let i = 0; i < 3; i++) {
      await manager.disable('froglight.example');
      await manager.enable('froglight.example');
    }
    expect(h.tracker.isCrashLoop('community:froglight.example')).toBe(true);

    // "Restart": detach + fresh manager over the same vault.
    await manager.detach();
    await h.runtime.dispose();

    const runtime2 = new Runtime();
    const vault2 = h.vault;
    const commands2 = createCommandRegistry();
    await runtime2.registerSlot({
      id: 'vault',
      plugin: definePlugin({
        id: 'test.vault-binding-2',
        activate: (ctx) => {
          ctx.provide(vaultToken, vault2);
        },
      }),
    });
    await runtime2.registerSlot({
      id: 'commands',
      plugin: definePlugin({
        id: 'test.commands-binding-2',
        activate: (ctx) => {
          ctx.provide(commandsToken, commands2 as unknown);
        },
      }),
    });
    const manager2 = new CommunityPluginManager({ runtime: runtime2 });
    await manager2.attach(vault2);
    // Auto-sync must not reactivate the parked plugin.
    expect(
      manager2.list().find((p) => p.id === 'froglight.example')?.state,
    ).toBe('blocked-crash-loop');
    expect(
      runtime2.inspect().slots.find((s) => s.id.startsWith('community:')),
    ).toBeUndefined();
    await manager2.detach();
    await runtime2.dispose();
  });

  it('safe mode blocks all community plugins and refuses enables until turned off', async () => {
    const h = await harness();
    const manager = new CommunityPluginManager({ runtime: h.runtime });
    await manager.attach(h.vault);
    manager.setLoader(
      fakeLoader((_code, facades) => {
        facades.commands.register({ id: 'x', execute: () => null });
      }),
    );
    await manager.install({ manifestJson: validManifestJson(), code: 's' });
    await manager.enable('froglight.example');
    expect(manager.safeMode).toBe(false);

    await manager.setSafeMode(true);
    expect(manager.safeMode).toBe(true);
    expect(
      h.runtime.inspect().slots.find((s) => s.id.startsWith('community:')),
    ).toBeUndefined();
    expect(manager.list()[0]?.state).toBe('blocked-safe-mode');
    await expect(manager.enable('froglight.example')).rejects.toThrow(
      /safe mode/i,
    );

    await manager.setSafeMode(false);
    await manager.enable('froglight.example');
    expect(manager.list()[0]?.state).toBe('active');
    await manager.detach();
    await h.runtime.dispose();
  });

  it('enablement intent persists across restart', async () => {
    const h = await harness();
    const manager = new CommunityPluginManager({ runtime: h.runtime });
    await manager.attach(h.vault);
    manager.setLoader(
      fakeLoader((_code, facades) => {
        facades.commands.register({ id: 'persisted.cmd', execute: () => null });
      }),
    );
    await manager.install({ manifestJson: validManifestJson(), code: 'p' });
    await manager.enable('froglight.example');

    // Fresh manager over the same vault auto-syncs the enabled plugin.
    const manager2 = new CommunityPluginManager({ runtime: h.runtime });
    await manager2.attach(h.vault);
    expect(manager2.list()[0]?.state).toBe('active');
    await manager2.detach();

    await manager.disable('froglight.example');
    const manager3 = new CommunityPluginManager({ runtime: h.runtime });
    await manager3.attach(h.vault);
    expect(manager3.list()[0]?.state).toBe('disabled');
    await manager3.detach();

    await manager.detach();
    await h.runtime.dispose();
  });

  it('remove disables and deletes the plugin files', async () => {
    const h = await harness();
    const manager = new CommunityPluginManager({ runtime: h.runtime });
    await manager.attach(h.vault);
    manager.setLoader(fakeLoader(() => undefined));
    await manager.install({ manifestJson: validManifestJson(), code: 'gone' });
    await manager.enable('froglight.example');
    await manager.remove('froglight.example');
    expect(manager.list()).toHaveLength(0);
    expect(
      h.runtime.inspect().slots.find((s) => s.id.startsWith('community:')),
    ).toBeUndefined();
    await manager.detach();
    await h.runtime.dispose();
  });

  it('sync withdraws slots after synchronized enablement and install changes', async () => {
    const h = await harness();
    const manager = new CommunityPluginManager({ runtime: h.runtime });
    manager.setLoader(
      fakeLoader((_code, facades) => {
        facades.commands.register({ id: 'external.cmd', execute: () => null });
      }),
    );
    await manager.attach(h.vault);
    await manager.install({
      manifestJson: validManifestJson(),
      code: 'external',
    });
    await manager.enable('froglight.example');
    const store = new VaultPluginStore(h.vault);

    await store.saveState({ version: 1, enabled: [], disabledBySafeMode: [] });
    await manager.sync();
    expect(h.commands.ids()).toEqual([]);
    expect(manager.list()[0]?.state).toBe('disabled');

    await store.saveState({
      version: 1,
      enabled: ['froglight.example'],
      disabledBySafeMode: [],
    });
    await manager.sync();
    expect(h.commands.ids()).toEqual(['external.cmd']);

    await store.saveState({
      version: 1,
      enabled: ['froglight.example'],
      disabledBySafeMode: ['__safe-mode__'],
    });
    await manager.sync();
    expect(manager.safeMode).toBe(true);
    expect(h.commands.ids()).toEqual([]);
    await store.saveState({
      version: 1,
      enabled: ['froglight.example'],
      disabledBySafeMode: [],
    });
    await manager.sync();
    expect(manager.safeMode).toBe(false);
    expect(h.commands.ids()).toEqual(['external.cmd']);

    await store.saveState({
      version: 1,
      enabled: ['froglight.example'],
      disabledBySafeMode: ['froglight.example'],
    });
    await manager.sync();
    expect(h.commands.ids()).toEqual([]);
    expect(manager.list()[0]?.state).toBe('blocked-crash-loop');

    await store.saveState({
      version: 1,
      enabled: ['froglight.example'],
      disabledBySafeMode: [],
    });
    await manager.sync();
    await h.vault.write(
      workspacePath('.froglight/plugins/froglight.example/manifest.json'),
      new TextEncoder().encode('{bad json'),
    );
    await manager.sync();
    expect(h.commands.ids()).toEqual([]);
    expect(manager.list()[0]?.state).toBe('failed');

    await store.remove('froglight.example');
    await manager.sync();
    expect(manager.list()).toEqual([]);
    expect(
      h.runtime
        .inspect()
        .slots.some((slot) => slot.id.startsWith('community:')),
    ).toBe(false);
    await manager.detach();
    await h.runtime.dispose();
  });

  it('serializes overlapping attachments and ignores teardown from an older attachment', async () => {
    const h = await harness();
    const nextVault = createMemoryVault().vault;
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let enteredRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      enteredRead = resolve;
    });
    const slowVault = new Proxy(h.vault, {
      get(target, property, receiver) {
        if (property === 'read') {
          return async (path: string) => {
            if (path === '.froglight/plugins.json') {
              enteredRead();
              await readGate;
            }
            return target.read(workspacePath(path));
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const manager = new CommunityPluginManager({ runtime: h.runtime });
    const older = manager.attach(slowVault);
    await readStarted;
    const newer = manager.attach(nextVault);
    const staleTeardown = manager.detach(older);
    releaseRead();
    await Promise.all([older, newer, staleTeardown]);

    expect(manager.attached).toBe(true);
    await manager.install({
      manifestJson: validManifestJson(),
      code: 'new vault',
    });
    expect(
      await new VaultPluginStore(nextVault).readManifest('froglight.example'),
    ).not.toBeNull();
    expect(
      await new VaultPluginStore(h.vault).readManifest('froglight.example'),
    ).toBeNull();
    await manager.detach();
    await h.runtime.dispose();
  });

  it('runtime withdrawal awaits a pending vault attachment', async () => {
    const runtime = new Runtime();
    const vault = createMemoryVault().vault;
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let enteredRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      enteredRead = resolve;
    });
    const slowVault = new Proxy(vault, {
      get(target, property, receiver) {
        if (property === 'read') {
          return async (path: string) => {
            if (path === '.froglight/plugins.json') {
              enteredRead();
              await readGate;
            }
            return target.read(workspacePath(path));
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    await runtime.registerSlot({
      id: 'vault',
      plugin: definePlugin({
        id: 'test.slow-vault',
        activate(ctx) {
          ctx.provide(vaultToken, slowVault);
        },
      }),
    });
    const manager = new CommunityPluginManager({ runtime });
    await runtime.registerSlot({
      id: 'community',
      plugin: communityPluginsBinding(manager),
    });
    await readStarted;
    let withdrawn = false;
    const removal = runtime.removeSlot('vault').then(() => {
      withdrawn = true;
    });
    await Promise.resolve();
    expect(withdrawn).toBe(false);
    releaseRead();
    await removal;
    expect(manager.attached).toBe(false);
    await runtime.dispose();
  });

  it('binding attaches with the vault and detaches to zero registrations when it closes', async () => {
    const h = await harness();
    const manager = new CommunityPluginManager({ runtime: h.runtime });
    manager.setLoader(
      fakeLoader((_code, facades) => {
        facades.commands.register({ id: 'bound.cmd', execute: () => null });
      }),
    );
    // Install + enable while attached, then detach to simulate pre-boot state.
    await manager.attach(h.vault);
    await manager.install({ manifestJson: validManifestJson(), code: 'b' });
    await manager.enable('froglight.example');
    await manager.detach();

    // Opening a vault = activating the binding slot.
    await h.runtime.registerSlot({
      id: 'community-plugins',
      plugin: communityPluginsBinding(manager),
    });
    // Attach runs concurrently with activation; wait for reconciliation.
    await manager.ready;
    // The catalog is discoverable through the capability token.
    let resolved: CommunityPluginManager | undefined;
    const consumer = await h.runtime.registerSlot({
      id: 'community-consumer',
      plugin: definePlugin({
        id: 'test.community-consumer',
        requirements: { requires: [communityPluginsToken] },
        activate: (ctx) => {
          resolved = ctx.require(communityPluginsToken);
        },
      }),
    });
    void consumer;
    expect(resolved).toBe(manager);
    expect(
      h.runtime
        .inspect()
        .slots.find((s) => s.id === 'community:froglight.example')?.state,
    ).toBe('active');

    // Closing the vault disposes the binding fiber and every community slot.
    await h.runtime.removeSlot('vault');
    expect(
      h.runtime.inspect().slots.find((s) => s.id.startsWith('community:')),
    ).toBeUndefined();
    expect(h.commands.ids()).not.toContain('bound.cmd');

    await manager.detach();
    await h.runtime.dispose();
  });

  it('binding withdraws and reactivates plugin registrations when the vault provider is replaced', async () => {
    const runtime = new Runtime();
    const state = createMemoryVaultState();
    const commands = createCommandRegistry();
    let activations = 0;
    await runtime.registerSlot({
      id: 'vault',
      plugin: memoryVaultPlugin,
      config: { state },
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

    const manager = new CommunityPluginManager({ runtime });
    manager.setLoader(
      fakeLoader((_code, facades) => {
        activations += 1;
        facades.commands.register({
          id: 'replacement.cmd',
          execute: () => null,
        });
      }),
    );
    await runtime.registerSlot({
      id: 'community-plugins',
      plugin: communityPluginsBinding(manager),
    });
    await manager.ready;
    await manager.install({
      manifestJson: validManifestJson('froglight.replacement'),
      code: 'replacement',
    });
    await manager.enable('froglight.replacement');
    expect(activations).toBe(1);
    expect(commands.ids()).toEqual(['replacement.cmd']);

    // The same vault contents survive the provider swap. The binding must
    // tear down the old fiber before reloading enabled plugins from the new
    // provider.
    await runtime.removeSlot('vault');
    expect(manager.attached).toBe(false);
    expect(commands.ids()).toEqual([]);
    await runtime.registerSlot({
      id: 'vault',
      plugin: memoryVaultPlugin,
      config: { state },
    });
    await manager.ready;

    expect(activations).toBe(2);
    expect(commands.ids()).toEqual(['replacement.cmd']);
    expect(
      runtime
        .inspect()
        .slots.find((slot) => slot.id === 'community:froglight.replacement')
        ?.state,
    ).toBe('active');

    await runtime.dispose();
    expect(commands.ids()).toEqual([]);
  });
});
