/**
 * Memory sync remote conformance.
 *
 * HEAD compare-and-swap contention, single-listener control-plane
 * notifications with disposal, vault listing, blob/manifest storage, and
 * crash-safe commit ordering (failed CAS leaves the previous HEAD valid).
 */

import { describe, expect, it, vi } from 'vitest';
import { MemorySyncRemote } from './remote-memory.js';
import { buildManifest, hashManifest } from './manifest.js';
import type { SyncManifest } from './contract.js';

const BLOB_A = `sha256:${'a'.repeat(64)}`;

function manifest(vaultId = 'v1', revision = 1): SyncManifest {
  return buildManifest({
    vaultId,
    revision,
    parentHash: null,
    entries: [{ path: 'a.md', kind: 'file', blob: BLOB_A, size: 1 }],
  });
}

async function commit(
  remote: MemorySyncRemote,
  vaultId: string,
  current: { revision: number; manifestHash: string } | null,
  next: SyncManifest,
  name = 'V',
): Promise<void> {
  const { hash, object } = await remote.uploadManifest(vaultId, next);
  await remote.compareAndSwapHead(vaultId, current, {
    name,
    revision: next.revision,
    manifestHash: hash,
    manifestObject: object,
    fileCount: 1,
    totalBytes: 1,
    updatedByDeviceId: 'd1',
  });
}

describe('memory sync remote', () => {
  it('starts empty and creates the HEAD on first commit', async () => {
    const remote = new MemorySyncRemote();
    expect(await remote.readHead('v1')).toBeNull();
    expect(await remote.listVaults()).toEqual([]);
    await commit(remote, 'v1', null, manifest());
    const head = (await remote.readHead('v1'))!;
    expect(head.revision).toBe(1);
    expect(head.createdAt).toBe(head.updatedAt);
    expect(await remote.listVaults()).toEqual([
      { cloudVaultId: 'v1', name: 'V', revision: 1, updatedAt: head.updatedAt },
    ]);
  });

  it('rejects a second create and a stale compare-and-swap', async () => {
    const remote = new MemorySyncRemote();
    await commit(remote, 'v1', null, manifest());
    await expect(commit(remote, 'v1', null, manifest())).rejects.toMatchObject({
      code: 'REMOTE_CHANGED',
    });
    const head = (await remote.readHead('v1'))!;
    await expect(
      commit(
        remote,
        'v1',
        { revision: 999, manifestHash: head.manifestHash },
        manifest(),
      ),
    ).rejects.toMatchObject({ code: 'REMOTE_CHANGED' });
    // The previous HEAD is still valid after failed swaps.
    expect((await remote.readHead('v1'))?.revision).toBe(1);
  });

  it('advances revisions transactionally', async () => {
    const remote = new MemorySyncRemote();
    await commit(remote, 'v1', null, manifest('v1', 1));
    const first = (await remote.readHead('v1'))!;
    await commit(
      remote,
      'v1',
      { revision: first.revision, manifestHash: first.manifestHash },
      manifest('v1', 2),
    );
    const second = (await remote.readHead('v1'))!;
    expect(second.revision).toBe(2);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.manifestHash).not.toBe(first.manifestHash);
  });

  it('round-trips manifests and blobs', async () => {
    const remote = new MemorySyncRemote();
    const next = manifest();
    const { hash, object } = await remote.uploadManifest('v1', next);
    expect(hash).toBe(await hashManifest(next));
    expect(object).toContain('v1/manifests/1-');
    expect(await remote.loadManifest('v1', hash)).toEqual(next);
    await expect(
      remote.loadManifest('v1', `sha256:${'0'.repeat(64)}`),
    ).rejects.toMatchObject({
      code: 'REMOTE_NOT_FOUND',
    });

    const { hashBytes } = await import('./manifest.js');
    const helloBytes = new TextEncoder().encode('hello');
    const helloBlob = await hashBytes(helloBytes);
    expect(await remote.hasBlob('v1', helloBlob)).toBe(false);
    await remote.uploadBlob('v1', helloBlob, helloBytes);
    expect(await remote.hasBlob('v1', helloBlob)).toBe(true);
    expect(await remote.downloadBlob('v1', helloBlob)).toEqual(helloBytes);
    await expect(
      remote.downloadBlob('v1', `sha256:${'f'.repeat(64)}`),
    ).rejects.toMatchObject({ code: 'REMOTE_NOT_FOUND' });
  });

  it('rejects manifests for the wrong vault', async () => {
    const remote = new MemorySyncRemote();
    await expect(
      remote.uploadManifest('v1', manifest('other')),
    ).rejects.toMatchObject({
      code: 'CORRUPT_MANIFEST',
    });
  });

  it('notifies HEAD watchers once per commit and stops after dispose', async () => {
    const remote = new MemorySyncRemote();
    const seen: (number | null)[] = [];
    const stop = remote.watchHead('v1', (head) =>
      seen.push(head?.revision ?? null),
    );
    await commit(remote, 'v1', null, manifest('v1', 1));
    const first = (await remote.readHead('v1'))!;
    await commit(
      remote,
      'v1',
      { revision: first.revision, manifestHash: first.manifestHash },
      manifest('v1', 2),
    );
    expect(seen).toEqual([1, 2]);
    stop();
    await commit(
      remote,
      'v1',
      {
        revision: 2,
        manifestHash: (await remote.readHead('v1'))!.manifestHash,
      },
      manifest('v1', 3),
    );
    expect(seen).toEqual([1, 2]);

    const failing = vi.fn(() => {
      throw new Error('listener blew up');
    });
    remote.watchHead('v1', failing);
    await commit(
      remote,
      'v1',
      {
        revision: 3,
        manifestHash: (await remote.readHead('v1'))!.manifestHash,
      },
      manifest('v1', 4),
    );
    expect(failing).toHaveBeenCalledTimes(1);
    expect((await remote.readHead('v1'))?.revision).toBe(4);
  });

  it('isolates vaults from each other', async () => {
    const remote = new MemorySyncRemote();
    await commit(remote, 'a', null, manifest('a', 1));
    expect(await remote.readHead('b')).toBeNull();
    expect(await remote.hasBlob('b', BLOB_A)).toBe(false);
  });
});
