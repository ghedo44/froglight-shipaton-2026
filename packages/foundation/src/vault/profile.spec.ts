import { describe, expect, it } from 'vitest';
import { workspacePath } from '../paths.js';
import { createMemoryVault } from './memory.js';
import {
  decodeVaultProfile,
  readVaultProfile,
  writeVaultProfile,
  VAULT_PROFILE_PATH,
  type VaultProfile,
} from './profile.js';
import { reconcileVault } from '../sync/engine.js';
import { MemorySyncRemote } from '../sync/remote-memory.js';
import type { SyncBase } from '../sync/contract.js';

const profile: VaultProfile = {
  name: 'Research',
  icon: 'satellite',
  color: 'blue',
};
const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
describe('portable vault profiles', () => {
  it('round trips and preserves unknown fields on editing', async () => {
    const { vault } = createMemoryVault();
    expect(await readVaultProfile(vault)).toBeNull();
    await writeVaultProfile(vault, profile);
    const record = JSON.parse(
      new TextDecoder().decode(await vault.read(VAULT_PROFILE_PATH)),
    );
    await vault.write(
      VAULT_PROFILE_PATH,
      encode({ ...record, custom: { owner: 'me' } }),
    );
    await writeVaultProfile(vault, {
      ...profile,
      name: 'Renamed',
      icon: 'apple',
    });
    expect(await readVaultProfile(vault)).toEqual({
      ...profile,
      name: 'Renamed',
      icon: 'apple',
    });
    expect(
      JSON.parse(new TextDecoder().decode(await vault.read(VAULT_PROFILE_PATH)))
        .custom,
    ).toEqual({ owner: 'me' });
  });
  it.each([
    { version: 2 },
    { name: '  ' },
    { name: 'x'.repeat(121) },
    { icon: 'unknown' },
    { color: 'unknown' },
    { name: 'bad\nname' },
  ])(
    'rejects unsupported details without overwriting them: %j',
    async (invalid) => {
      const { vault } = createMemoryVault();
      await writeVaultProfile(vault, profile);
      const bytes = encode({
        format: 'froglight.vault',
        version: 1,
        ...profile,
        ...invalid,
      });
      await vault.write(VAULT_PROFILE_PATH, bytes);
      await expect(writeVaultProfile(vault, profile)).rejects.toThrow();
      expect(await vault.read(VAULT_PROFILE_PATH)).toEqual(bytes);
    },
  );
  it('rejects malformed JSON, oversized data and invalid UTF-8', () => {
    expect(() => decodeVaultProfile(new Uint8Array([0xff]))).toThrow();
    expect(() => decodeVaultProfile(new TextEncoder().encode('{'))).toThrow();
    expect(() => decodeVaultProfile(new Uint8Array(16385))).toThrow();
  });
  it('syncs offline profile edits across replicas and preserves concurrent changes', async () => {
    const remote = new MemorySyncRemote();
    const a = createMemoryVault().vault;
    const b = createMemoryVault().vault;
    let baseA: SyncBase | null = null;
    let baseB: SyncBase | null = null;
    const syncA = async () => {
      const result = await reconcileVault({
        vault: a,
        remote,
        vaultId: 'profile-vault',
        name: 'Original',
        deviceId: 'a',
        base: baseA,
      });
      baseA = result.base;
      return result;
    };
    const syncB = async () => {
      const result = await reconcileVault({
        vault: b,
        remote,
        vaultId: 'profile-vault',
        name: 'Original',
        deviceId: 'b',
        base: baseB,
      });
      baseB = result.base;
      return result;
    };
    await writeVaultProfile(a, profile);
    await syncA();
    await syncB();
    expect(await readVaultProfile(b)).toEqual(profile);
    await writeVaultProfile(b, {
      name: 'Biology',
      icon: 'apple',
      color: 'green',
    });
    await syncB();
    await syncA();
    expect(await readVaultProfile(a)).toEqual({
      name: 'Biology',
      icon: 'apple',
      color: 'green',
    });
    await writeVaultProfile(a, { ...profile, name: 'A edit' });
    await writeVaultProfile(b, { ...profile, name: 'B edit' });
    await syncA();
    const result = await syncB();
    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0]?.conflictPath;
    if (!conflict) throw new Error('Expected preserved conflict');
    const names = [
      (await readVaultProfile(b))?.name,
      decodeVaultProfile(await b.read(workspacePath(conflict))).name,
    ];
    expect(names.sort()).toEqual(['A edit', 'B edit']);
  });
});
