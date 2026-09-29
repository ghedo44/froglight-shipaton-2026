/**
 * Local-write race conformance.
 *
 * Proves a file changing between scan and blob upload can never poison
 * the immutable content address:
 *
 * ```text
 * scan hashes version A
 *   → file becomes version B
 *   → engine reaches blob upload
 *   → upload of B under hash(A) is refused (LOCAL_CHANGED)
 * ```
 *
 * Then a later fresh reconcile hashes B, uploads B under hash(B), and
 * converges. The remote object store is inspected directly to prove
 * `hash(A)` never contains `bytes(B)`.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../vault/memory.js';
import { workspacePath } from '../paths.js';
import { MemorySyncRemote } from './remote-memory.js';
import { createLocalScanCache, reconcileVault } from './engine.js';
import { hashBytes } from './manifest.js';
import type { SyncBase } from './contract.js';

const VAULT_ID = 'race-vault';
const NOW = new Date('2026-09-09T13:10:33.000Z');

describe('mutation-during-upload', () => {
  it('refuses a stale hash upload and converges on retry without poisoning', async () => {
    const remote = new MemorySyncRemote();
    const { vault } = createMemoryVault({});
    await vault.write(
      workspacePath('note.md'),
      new TextEncoder().encode('version-A'),
    );
    let base: SyncBase | null = null;
    const cache = createLocalScanCache();

    // Vault seam that swaps the file between scan and upload: the scan
    // hashes version A (first read), then a concurrent local save lands
    // version B before the upload read (second read returns B).
    let reads = 0;
    const racingVault = {
      ...vault,
      capabilities: vault.capabilities,
      stat: vault.stat.bind(vault),
      list: vault.list.bind(vault),
      createDirectory: vault.createDirectory.bind(vault),
      remove: vault.remove.bind(vault),
      move: vault.move.bind(vault),
      read: async (
        path: Parameters<typeof vault.read>[0],
        options?: Parameters<typeof vault.read>[1],
      ) => {
        reads += 1;
        if ((path as string) === 'note.md' && reads === 2) {
          // Concurrent save between scan hash (read 1 = A) and upload
          // read (read 2): the source now holds B.
          await vault.write(path, new TextEncoder().encode('version-B'));
          return new TextEncoder().encode('version-B');
        }
        return vault.read(path, options);
      },
      write: vault.write.bind(vault),
    };

    // First reconcile: scan hashed A, upload reads B → LOCAL_CHANGED.
    // The engine retries internally (fresh scan hashes B) — but our seam
    // only poisons once, so the retry uploads B under hash(B) and commits.
    // To prove the refusal branch executed, first run with maxAttempts=1
    // (single attempt, no internal retry) and assert LOCAL_CHANGED.
    await expect(
      reconcileVault({
        vault: racingVault as unknown as typeof vault,
        remote,
        vaultId: VAULT_ID,
        name: 'Race',
        base,
        deviceId: 'device-a',
        now: NOW,
        incremental: { cache },
        maxCommitAttempts: 1,
      }),
    ).rejects.toMatchObject({ code: 'LOCAL_CHANGED' });

    // hash(A) must never contain bytes(B) in the remote store.
    const hashA = await hashBytes(new TextEncoder().encode('version-A'));
    expect(await remote.hasBlob(VAULT_ID, hashA)).toBe(false);
    // The stale cache entry was invalidated: the next scan re-hashes.
    expect(cache.get('note.md')).toBeUndefined();

    // Fresh reconcile (no more racing): hashes B, uploads B under hash(B),
    // converges normally.
    const retry = await reconcileVault({
      vault,
      remote,
      vaultId: VAULT_ID,
      name: 'Race',
      base,
      deviceId: 'device-a',
      now: NOW,
      incremental: { cache },
    });
    expect(retry.committed).toBe(true);
    expect(retry.revision).toBe(1);
    base = retry.base;

    const hashB = await hashBytes(new TextEncoder().encode('version-B'));
    expect(await remote.hasBlob(VAULT_ID, hashB)).toBe(true);
    expect(await remote.downloadBlob(VAULT_ID, hashB)).toEqual(
      new TextEncoder().encode('version-B'),
    );
    // And hash(A) still holds nothing (never poisoned).
    expect(await remote.hasBlob(VAULT_ID, hashA)).toBe(false);

    // A second device pulls B (proves the committed manifest references
    // hash(B), not a poisoned hash(A)).
    const { vault: vaultB } = createMemoryVault({});
    const pull = await reconcileVault({
      vault: vaultB,
      remote,
      vaultId: VAULT_ID,
      name: 'Race',
      base: null,
      deviceId: 'device-b',
      now: NOW,
    });
    expect(pull.committed).toBe(false);
    expect(
      new TextDecoder().decode(await vaultB.read(workspacePath('note.md'))),
    ).toBe('version-B');
  });

  it('rejects direct mismatched uploads at the provider boundary (defense in depth)', async () => {
    const remote = new MemorySyncRemote();
    const hashA = await hashBytes(new TextEncoder().encode('A'));
    const bytesB = new TextEncoder().encode('B');
    await expect(
      remote.uploadBlob(VAULT_ID, hashA, bytesB),
    ).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
    expect(await remote.hasBlob(VAULT_ID, hashA)).toBe(false);
  });
});
