import { describe, it, expect } from 'vitest';
import { createMemoryVault, ensureDirectory, type VaultService, type WorkspacePath } from '@froglight/foundation';
import {
  PLUGINS_DIR,
  PLUGINS_RECORD_PATH,
  VaultPluginStore,
  type PluginStateRecord,
} from './vault-store.js';

function openVault(): VaultService {
  return createMemoryVault().vault;
}

async function seedFile(vault: VaultService, path: string, text: string): Promise<void> {
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  if (parent) await ensureDirectory(vault, parent as WorkspacePath);
  await vault.write(path as WorkspacePath, new TextEncoder().encode(text));
}

function validManifestJson(id = 'froglight.example') {
  return {
    manifestVersion: 1,
    id,
    version: '1.0.0',
    froglightSdk: '^0.1.0',
    permissions: ['vault.read'],
  };
}

describe('VaultPluginStore — community plugins live inside the vault', () => {
  it('lists installed plugins with validated manifests and code presence', async () => {
    const vault = openVault();
    const store = new VaultPluginStore(vault);
    await store.install({ manifestJson: validManifestJson(), code: 'export default () => {}' });

    const installed = await store.listInstalled();
    expect(installed).toHaveLength(1);
    expect(installed[0]?.id).toBe('froglight.example');
    expect(installed[0]?.manifest?.id).toBe('froglight.example');
    expect(installed[0]?.error).toBeNull();
    expect(installed[0]?.hasCode).toBe(true);
  });

  it('reports invalid manifests as error entries instead of throwing', async () => {
    const vault = openVault();
    await seedFile(
      vault,
      `${PLUGINS_DIR}/broken.vendor/manifest.json`,
      JSON.stringify({ manifestVersion: 7 }),
    );
    const store = new VaultPluginStore(vault);

    const installed = await store.listInstalled();
    expect(installed).toHaveLength(1);
    expect(installed[0]?.id).toBe('broken.vendor');
    expect(installed[0]?.manifest).toBeNull();
    expect(installed[0]?.error).toMatch(/manifest/i);
  });

  it('install validates before writing anything to the vault', async () => {
    const vault = openVault();
    const store = new VaultPluginStore(vault);
    await expect(
      store.install({ manifestJson: validManifestJson('Bad Id'), code: 'x' }),
    ).rejects.toThrow(/invalid id/);
    expect(await store.listInstalled()).toHaveLength(0);
  });

  it('install rejects ids that could escape the plugins directory', async () => {
    const vault = openVault();
    const store = new VaultPluginStore(vault);
    await expect(
      store.install({ manifestJson: validManifestJson('a..b.c'), code: 'x' }),
    ).rejects.toThrow(/id/);
  });

  it('reads code back verbatim', async () => {
    const vault = openVault();
    const store = new VaultPluginStore(vault);
    const code = 'export default function activate() { return () => {}; }';
    await store.install({ manifestJson: validManifestJson(), code });
    expect(await store.readCode('froglight.example')).toBe(code);
  });

  it('remove deletes the plugin directory', async () => {
    const vault = openVault();
    const store = new VaultPluginStore(vault);
    await store.install({ manifestJson: validManifestJson(), code: 'x' });
    await store.remove('froglight.example');
    expect(await store.listInstalled()).toHaveLength(0);
  });

  it('persists enabled/safe-mode state as a versioned record preserving unknown fields', async () => {
    const vault = openVault();
    const store = new VaultPluginStore(vault);

    // Seed an unknown extension field the way a future version would.
    await seedFile(
      vault,
      PLUGINS_RECORD_PATH,
      JSON.stringify({
        format: 'froglight.plugins',
        version: 1,
        enabled: ['froglight.a'],
        disabledBySafeMode: [],
        futureField: { nested: true },
      }),
    );

    const state = await store.loadState();
    expect(state.enabled).toEqual(['froglight.a']);

    const next: PluginStateRecord = {
      ...state,
      enabled: ['froglight.b'],
    };
    await store.saveState(next);

    const raw = JSON.parse(new TextDecoder().decode(await vault.read(PLUGINS_RECORD_PATH)));
    expect(raw.enabled).toEqual(['froglight.b']);
    expect(raw.futureField).toEqual({ nested: true });
  });

  it('a missing or corrupt state record means defaults instead of failing startup', async () => {
    const vault = openVault();
    const store = new VaultPluginStore(vault);
    const missing = await store.loadState();
    expect(missing.version).toBe(1);
    expect(missing.enabled).toEqual([]);
    expect(missing.disabledBySafeMode).toEqual([]);

    await seedFile(vault, PLUGINS_RECORD_PATH, '{not json');    const corrupt = await store.loadState();
    expect(corrupt.enabled).toEqual([]);
  });
});
