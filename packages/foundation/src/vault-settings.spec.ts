import { describe, expect, it } from 'vitest';
import { createMemoryVault, createMemoryVaultState } from './vault/memory.js';
import type { VaultService } from './vault/contract.js';
import type { WorkspacePath } from './paths.js';
import {
  SETTINGS_RECORD_PATH,
  VaultSettingsService,
} from './vault-settings.js';

function decode(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

async function seededVault(record?: unknown) {
  const state = createMemoryVaultState();
  const { vault } = createMemoryVault({ state });
  if (record !== undefined) {
    await vault.createDirectory('.froglight' as WorkspacePath);
    await vault.write(
      SETTINGS_RECORD_PATH,
      new TextEncoder().encode(JSON.stringify(record)),
    );
  }
  return { state, vault };
}

describe('VaultSettingsService', () => {
  it('serializes concurrent changes without losing either settings family', async () => {
    const { vault } = await seededVault();
    let releaseFirstWrite: () => void = () => undefined;
    let markFirstWriteStarted: () => void = () => undefined;
    const firstWriteStarted = new Promise<void>((resolve) => {
      markFirstWriteStarted = resolve;
    });
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let writes = 0;
    const delayedVault = new Proxy(vault, {
      get(target, property, receiver) {
        if (property !== 'write') {
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return async (path: WorkspacePath, data: Uint8Array) => {
          writes += 1;
          if (writes === 1) {
            markFirstWriteStarted();
            await firstWriteBlocked;
          }
          return target.write(path, data);
        };
      },
    }) as VaultService;
    const settings = await VaultSettingsService.open(delayedVault);
    settings.set(
      'toolbar.customization',
      '{"version":1,"slotSizes":["8.5"]}',
    );
    await firstWriteStarted;
    settings.set('ink.preset.pen.size', 8.5);
    settings.set('appearance.theme', 'dark');
    releaseFirstWrite();
    await settings.flush();

    const record = decode(await vault.read(SETTINGS_RECORD_PATH));
    expect(record).toMatchObject({
      format: 'froglight.settings',
      version: 1,
      values: {
        'appearance.theme': 'dark',
        'ink.preset.pen.size': 8.5,
        'toolbar.customization': '{"version":1,"slotSizes":["8.5"]}',
      },
    });
  });

  it('migrates the former format-less envelope without dropping presets', async () => {
    const { vault } = await seededVault({
      version: 1,
      values: { 'ink.preset.pen.size': 8.5 },
    });
    const settings = await VaultSettingsService.open(vault);
    expect(settings.get('ink.preset.pen.size')).toBe(8.5);
    settings.set('appearance.theme', 'dark');
    await settings.flush();
    expect(decode(await vault.read(SETTINGS_RECORD_PATH))).toMatchObject({
      format: 'froglight.settings',
      version: 1,
      values: {
        'appearance.theme': 'dark',
        'ink.preset.pen.size': 8.5,
      },
    });
  });

  it('preserves unknown envelope fields and object-valued settings', async () => {
    const futureValue = { nested: ['keep', 2] };
    const { vault } = await seededVault({
      format: 'froglight.settings',
      version: 1,
      values: {
        'appearance.theme': 'light',
        'future.object': futureValue,
      },
      futureEnvelope: { keep: true },
    });
    const settings = await VaultSettingsService.open(vault);
    expect(settings.get('future.object')).toBeUndefined();
    settings.set('appearance.theme', 'dark');
    await settings.flush();
    expect(decode(await vault.read(SETTINGS_RECORD_PATH))).toMatchObject({
      values: {
        'appearance.theme': 'dark',
        'future.object': futureValue,
      },
      futureEnvelope: { keep: true },
    });
  });

  it('fails explicitly on an unsupported version and leaves bytes untouched', async () => {
    const unsupported = {
      format: 'froglight.settings',
      version: 99,
      values: { 'future.object': { keep: true } },
    };
    const { vault } = await seededVault(unsupported);
    const before = await vault.read(SETTINGS_RECORD_PATH);
    await expect(VaultSettingsService.open(vault)).rejects.toMatchObject({
      code: 'RECORD_VERSION_UNSUPPORTED',
    });
    expect(await vault.read(SETTINGS_RECORD_PATH)).toEqual(before);
  });

  it('degrades corrupt JSON to defaults and writes only after an explicit change', async () => {
    const { vault } = await seededVault();
    await vault.createDirectory('.froglight' as WorkspacePath);
    await vault.write(
      SETTINGS_RECORD_PATH,
      new TextEncoder().encode('not json {{{'),
    );
    const settings = await VaultSettingsService.open(vault);
    expect(settings.get('appearance.theme')).toBeUndefined();
    settings.set('appearance.theme', 'dark');
    await settings.flush();
    expect(decode(await vault.read(SETTINGS_RECORD_PATH))).toMatchObject({
      values: { 'appearance.theme': 'dark' },
    });
  });
});
