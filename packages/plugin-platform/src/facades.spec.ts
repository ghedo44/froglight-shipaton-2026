import { describe, it, expect } from 'vitest';
import { validateManifest } from './manifest.js';
import { PermissionBroker } from './permissions.js';
import { createSdkFacades } from './facades.js';
import {
  InMemoryBlockRegistry,
  InMemoryDocumentRegistry,
  PropertyCatalog,
  documentKindId,
} from '@froglight/foundation';

describe('Capability Facades — broker-checked, injected services', () => {
  it('vault facade checks permission and path traversal', async () => {
    const manifest = validateManifest({
      manifestVersion: 1,
      id: 'froglight.test',
      version: '1.0.0',
      froglightSdk: '^0.1.0',
      permissions: ['vault.read'] as string[],
    });
    const broker = new PermissionBroker(manifest, 'trusted');
    const vault = {
      read: async () => new Uint8Array(),
      write: async () => undefined,
      remove: async () => undefined,
      stat: async () => null,
      list: async () => [],
    } as any;
    const facades = createSdkFacades({
      broker,
      tier: 'trusted',
      services: { vault } as any,
    });

    await expect(
      facades.vault.write('a.md' as any, new Uint8Array([1])),
    ).rejects.toThrow(/PermissionDenied/);
    await expect(facades.vault.read('../evil' as any)).rejects.toThrow(
      /traversal rejected/,
    );
    await expect(facades.vault.read('bad\\path' as any)).rejects.toThrow(
      /traversal rejected/,
    );
    // Granted read should succeed (vault empty, but stat will not throw permission)
    await expect(facades.vault.list('' as any)).resolves.toBeDefined();
  });

  it('trusted can register ui.views, sandboxed cannot even with service', () => {
    const manifestTrusted = validateManifest({
      manifestVersion: 1,
      id: 'froglight.trusted-ui',
      version: '1.0.0',
      froglightSdk: '^0.1.0',
      permissions: ['ui.views.register'] as string[],
    });
    const brokerTrusted = new PermissionBroker(manifestTrusted, 'trusted');
    const uiService = {
      register: (v: any) => ({
        dispose() {
          /* registration handle */
        },
      }),
    };
    const facadesTrusted = createSdkFacades({
      broker: brokerTrusted,
      tier: 'trusted',
      services: { uiViews: uiService } as any,
    });
    expect(() =>
      facadesTrusted.uiViews.register({ id: 'view1' }),
    ).not.toThrow();

    const manifestSandboxed = validateManifest({
      manifestVersion: 1,
      id: 'froglight.sandboxed-ui',
      version: '1.0.0',
      froglightSdk: '^0.1.0',
      permissions: ['ui.views.register'] as string[],
    });
    const brokerSandboxed = new PermissionBroker(
      manifestSandboxed,
      'sandboxed',
    );
    const facadesSandboxed = createSdkFacades({
      broker: brokerSandboxed,
      tier: 'sandboxed',
      services: { uiViews: uiService } as any,
    });
    expect(() => facadesSandboxed.uiViews.register({ id: 'view1' })).toThrow(
      /PermissionDenied/,
    );
  });

  it('editor.provider trusted-only; trusted passes the gate but registration is reserved', () => {
    const manifest = validateManifest({
      manifestVersion: 1,
      id: 'froglight.editor-test',
      version: '1.0.0',
      froglightSdk: '^0.1.0',
      permissions: ['editor.provider'] as string[],
    });
    const brokerTrusted = new PermissionBroker(manifest, 'trusted');
    const facadesTrusted = createSdkFacades({
      broker: brokerTrusted,
      tier: 'trusted',
      services: { editorProvider: {} as any },
    });
    // Authority is granted, but no community registration path exists yet —
    // the facade fails honestly with "not supported", never a fake success.
    expect(() => facadesTrusted.editorProvider.register({})).toThrow(
      /not supported/,
    );

    const brokerSandboxed = new PermissionBroker(manifest, 'sandboxed');
    const facadesSandboxed = createSdkFacades({
      broker: brokerSandboxed,
      tier: 'sandboxed',
      services: { editorProvider: {} as any },
    });
    expect(() => facadesSandboxed.editorProvider.register({})).toThrow(
      /PermissionDenied/,
    );
  });

  it('block registrations are trusted, permission-gated, prefix-bound, and owner-disposable', () => {
    const manifest = validateManifest({
      manifestVersion: 1,
      id: 'acme.blocks',
      version: '1.0.0',
      froglightSdk: '^0.1.0',
      permissions: ['workspace.blocks.register'] as string[],
    });
    const broker = new PermissionBroker(manifest, 'trusted');
    const registry = new InMemoryBlockRegistry();
    const owned: Array<() => void> = [];
    const facades = createSdkFacades({
      broker,
      tier: 'trusted',
      services: { blocks: registry },
      onRegistration: (dispose) => owned.push(dispose),
    });
    expect(() =>
      facades.blocks.register({ typeId: 'wrong.prefix', version: 1 }),
    ).toThrow(/plugin prefix/);
    facades.blocks.register({ typeId: 'acme.blocks.callout', version: 1 });
    expect(registry.list().map((entry) => entry.typeId)).toEqual([
      'acme.blocks.callout',
    ]);
    owned.forEach((dispose) => dispose());
    expect(registry.list()).toEqual([]);

    const sandboxed = createSdkFacades({
      broker: new PermissionBroker(manifest, 'sandboxed'),
      tier: 'sandboxed',
      services: { blocks: registry },
    });
    expect(() =>
      sandboxed.blocks.register({ typeId: 'acme.blocks.callout', version: 1 }),
    ).toThrow(/PermissionDenied/);
  });

  it('owns namespaced document-kind and property-type registrations', () => {
    const manifest = validateManifest({
      manifestVersion: 1,
      id: 'acme.research',
      version: '1.0.0',
      froglightSdk: '^0.1.0',
      permissions: [
        'documents.registerKind',
        'properties.registerType',
      ] as string[],
    });
    const documents = new InMemoryDocumentRegistry();
    const propertyCatalog = new PropertyCatalog();
    const owned: Array<() => void> = [];
    const facades = createSdkFacades({
      broker: new PermissionBroker(manifest, 'trusted'),
      tier: 'trusted',
      services: { documents, propertyCatalog },
      onRegistration: (dispose) => owned.push(dispose),
    });
    expect(() =>
      facades.documents.registerKind({
        id: documentKindId('wrong.kind'),
        decode: () => ({ model: null, metadata: {}, relationships: [] }),
        encode: () => new Uint8Array(),
      }),
    ).toThrow(/plugin prefix/);
    expect(() =>
      facades.properties.registerType({
        id: 'wrong.type',
        label: 'Wrong',
        storage: 'stored',
        editor: 'text',
        validate: () => null,
      }),
    ).toThrow(/plugin prefix/);

    facades.documents.registerKind({
      id: documentKindId('acme.research.card'),
      decode: () => ({ model: null, metadata: {}, relationships: [] }),
      encode: () => new Uint8Array(),
    });
    facades.properties.registerType({
      id: 'acme.research.rating',
      label: 'Rating',
      storage: 'stored',
      editor: 'number',
      validate: () => null,
    });
    expect(documents.list().map((kind) => kind.id)).toEqual([
      'acme.research.card',
    ]);
    expect(propertyCatalog.get('acme.research.rating')?.label).toBe('Rating');
    owned.forEach((dispose) => dispose());
    expect(documents.list()).toEqual([]);
    expect(propertyCatalog.get('acme.research.rating')).toBeUndefined();

    const sandboxed = createSdkFacades({
      broker: new PermissionBroker(manifest, 'sandboxed'),
      tier: 'sandboxed',
      services: { documents, propertyCatalog },
    });
    expect(() =>
      sandboxed.documents.registerKind({
        id: documentKindId('acme.research.card'),
        decode: () => ({ model: null, metadata: {}, relationships: [] }),
        encode: () => new Uint8Array(),
      }),
    ).toThrow(/PermissionDenied/);
    expect(() =>
      sandboxed.properties.registerType({
        id: 'acme.research.rating',
        label: 'Rating',
        storage: 'stored',
        editor: 'number',
        validate: () => null,
      }),
    ).toThrow(/PermissionDenied/);
  });
});
