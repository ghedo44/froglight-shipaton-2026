/**
 * Immutable Storage idempotency conformance.
 *
 * Production Storage Rules make blobs/manifests create-only; repeat
 * uploads of identical content are normal distributed contention (not
 * entitlement failures) and must be idempotent success after verifying
 * the existing object. Different bytes under the same address are
 * corruption, never silently accepted.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../vault/memory.js';
import { workspacePath } from '../paths.js';
import { MemorySyncRemote } from './remote-memory.js';
import { createLocalScanCache, reconcileVault } from './engine.js';
import { hashBytes, hashManifest, buildManifest } from './manifest.js';
import { VaultSyncError } from './errors.js';
import type { ExpectedHead, RemoteHeadInput, SyncBase } from './contract.js';

const VAULT_ID = 'immutable-vault';
const NOW = new Date('2026-09-09T13:10:33.000Z');

/** Crash-after-manifest remote: first CAS fails like a crash (NETWORK). */
class CrashOnceRemote extends MemorySyncRemote {
  private crashed = false;
  override async compareAndSwapHead(
    vaultId: string,
    expected: ExpectedHead | null,
    next: RemoteHeadInput,
  ) {
    if (!this.crashed) {
      this.crashed = true;
      throw new VaultSyncError('NETWORK', 'simulated crash before HEAD');
    }
    return super.compareAndSwapHead(vaultId, expected, next);
  }
}

describe('immutable Storage idempotency', () => {
  it('treats duplicate blob creates with identical bytes as success', async () => {
    const remote = new MemorySyncRemote();
    const bytes = new TextEncoder().encode('shared-asset');
    const blob = await hashBytes(bytes);
    await remote.uploadBlob(VAULT_ID, blob, bytes);
    // Second identical create (concurrent device race) succeeds.
    await remote.uploadBlob(VAULT_ID, blob, bytes);
    expect(await remote.hasBlob(VAULT_ID, blob)).toBe(true);
    expect(await remote.downloadBlob(VAULT_ID, blob)).toEqual(bytes);
  });

  it('rejects different bytes under the same hash (never poison)', async () => {
    const remote = new MemorySyncRemote();
    const bytesA = new TextEncoder().encode('A-content');
    const blobA = await hashBytes(bytesA);
    await remote.uploadBlob(VAULT_ID, blobA, bytesA);
    const bytesB = new TextEncoder().encode('B-content');
    // Direct mismatched upload is HASH_MISMATCH (provider verification).
    await expect(
      remote.uploadBlob(VAULT_ID, blobA, bytesB),
    ).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
    // The stored object still holds A.
    expect(await remote.downloadBlob(VAULT_ID, blobA)).toEqual(bytesA);
  });

  it('treats duplicate manifest creates with identical bytes as success', async () => {
    const remote = new MemorySyncRemote();
    const manifest = buildManifest({
      vaultId: VAULT_ID,
      revision: 1,
      parentHash: null,
      entries: [],
    });
    const first = await remote.uploadManifest(VAULT_ID, manifest);
    const second = await remote.uploadManifest(VAULT_ID, manifest);
    expect(second.hash).toBe(first.hash);
    expect(second.hash).toBe(await hashManifest(manifest));
  });

  it('recovers from crash-after-manifest-before-HEAD via idempotent retry', async () => {
    const remote = new CrashOnceRemote();
    const { vault } = createMemoryVault({});
    await vault.write(workspacePath('a.md'), new TextEncoder().encode('v1'));
    let base: SyncBase | null = null;
    await expect(
      reconcileVault({
        vault,
        remote,
        vaultId: VAULT_ID,
        name: 'T',
        base,
        deviceId: 'a',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'NETWORK' });

    // The manifest object already exists (uploaded before the crash).
    // Retry uploads the identical manifest again (idempotent success)
    // and commits HEAD.
    const retry = await reconcileVault({
      vault,
      remote,
      vaultId: VAULT_ID,
      name: 'T',
      base,
      deviceId: 'a',
      now: NOW,
    });
    expect(retry.committed).toBe(true);
    expect(retry.revision).toBe(1);
    base = retry.base;

    // A second device converges (no corruption, no overwrite).
    const { vault: vaultB } = createMemoryVault({});
    const pull = await reconcileVault({
      vault: vaultB,
      remote,
      vaultId: VAULT_ID,
      name: 'T',
      base: null,
      deviceId: 'b',
      now: NOW,
    });
    expect(pull.committed).toBe(false);
    expect(
      new TextDecoder().decode(await vaultB.read(workspacePath('a.md'))),
    ).toBe('v1');
  });

  it('two devices racing the same new content both succeed (one creates, one observes)', async () => {
    const remote = new MemorySyncRemote();
    const { vault: vaultA } = createMemoryVault({});
    const { vault: vaultB } = createMemoryVault({});
    await vaultA.write(
      workspacePath('shared.bin'),
      new TextEncoder().encode('same-bytes'),
    );
    await vaultB.write(
      workspacePath('shared.bin'),
      new TextEncoder().encode('same-bytes'),
    );
    let baseA: SyncBase | null = null;
    let baseB: SyncBase | null = null;
    const cacheA = createLocalScanCache();
    const cacheB = createLocalScanCache();

    const rA = await reconcileVault({
      vault: vaultA,
      remote,
      vaultId: VAULT_ID,
      name: 'T',
      base: baseA,
      deviceId: 'a',
      now: NOW,
      incremental: { cache: cacheA },
    });
    baseA = rA.base;
    expect(rA.committed).toBe(true);

    // B's blob already exists (same content): hasBlob true → skip upload,
    // or duplicate upload → idempotent success. Either way converges.
    const rB = await reconcileVault({
      vault: vaultB,
      remote,
      vaultId: VAULT_ID,
      name: 'T',
      base: baseB,
      deviceId: 'b',
      now: NOW,
      incremental: { cache: cacheB },
    });
    expect(rB.committed).toBe(false);
    baseB = rB.base;
    expect(baseB.hash).toBe(baseA.hash);
  });
});
