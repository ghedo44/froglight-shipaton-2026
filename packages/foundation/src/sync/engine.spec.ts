/**
 * Reconcile engine conformance (§49).
 *
 * Deterministic two-device scenarios over memory vaults and the shared
 * memory remote: create/edit propagation, concurrent-edit preservation
 * with convergence, upload efficiency, restart recovery, interrupted
 * commit recovery, hash verification, revision chains, and refusal
 * paths. No I/O beyond memory, no network.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../vault/memory.js';
import type { VaultService } from '../vault/contract.js';
import { ensureDirectory } from '../vault/helpers.js';
import { workspacePath } from '../paths.js';
import { VaultSyncError } from './errors.js';
import { MemorySyncRemote } from './remote-memory.js';
import {
  createLocalScanCache,
  reconcileVault,
  type ReconcileResult,
  type SyncProgressStage,
} from './engine.js';
import type { ExpectedHead, RemoteHeadInput, SyncBase } from './contract.js';
import { createDatabase } from '../databases/model.js';
import { resourceId } from '../identity.js';

const VAULT_ID = 'cloud-vault-1';
const NOW = new Date('2026-09-09T13:10:33.000Z');

interface Device {
  readonly vault: VaultService;
  base: SyncBase | null;
}

async function makeVault(files: Record<string, string>): Promise<VaultService> {
  const { vault } = createMemoryVault();
  for (const [path, text] of Object.entries(files)) {
    const segments = path.split('/');
    if (segments.length > 1) {
      await ensureDirectory(
        vault,
        workspacePath(segments.slice(0, -1).join('/')),
      );
    }
    await vault.write(workspacePath(path), new TextEncoder().encode(text));
  }
  return vault;
}

async function dumpVault(vault: VaultService): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    const children = await vault.list(
      dir === '' ? workspacePath('') : workspacePath(dir),
    );
    for (const child of children) {
      const path = dir === '' ? child.name : `${dir}/${child.name}`;
      if (child.kind === 'directory') await walk(path);
      else
        out[path] = new TextDecoder().decode(
          await vault.read(workspacePath(path)),
        );
    }
  };
  await walk('');
  return out;
}

function makeDevice(files: Record<string, string>): Promise<Device> {
  return makeVault(files).then((vault) => ({ vault, base: null }));
}

/** Vault decorator counting content reads (incremental-scan proof). */
function countingVault(inner: VaultService): {
  vault: VaultService;
  counts: { read: number; stat: number; list: number };
} {
  const counts = { read: 0, stat: 0, list: 0 };
  const vault: VaultService = {
    get capabilities() {
      return inner.capabilities;
    },
    stat: (path, options) => {
      counts.stat += 1;
      return inner.stat(path, options);
    },
    list: (path, options) => {
      counts.list += 1;
      return inner.list(path, options);
    },
    createDirectory: (path, options) => inner.createDirectory(path, options),
    read: (path, options) => {
      counts.read += 1;
      return inner.read(path, options);
    },
    write: (path, data, options) => inner.write(path, data, options),
    remove: (path, options) => inner.remove(path, options),
    move: (from, to, options) => inner.move(from, to, options),
    ...(inner.readFile === undefined
      ? {}
      : { readFile: inner.readFile.bind(inner) }),
  };
  return { vault, counts };
}

async function removePath(vault: VaultService, path: string): Promise<void> {
  await vault.remove(workspacePath(path));
}

async function sync(
  device: Device,
  remote: MemorySyncRemote,
  name = 'University',
  deviceId = 'device-a',
): Promise<ReconcileResult> {
  const result = await reconcileVault({
    vault: device.vault,
    remote,
    vaultId: VAULT_ID,
    name,
    base: device.base,
    deviceId,
    now: NOW,
  });
  device.base = result.base;
  return result;
}

function uploadBlobCalls(remote: MemorySyncRemote): string[] {
  return remote.calls.filter((call) => call.startsWith('uploadBlob'));
}

/** First CAS fails like a crash after manifest upload.*/
class CrashOnceRemote extends MemorySyncRemote {
  private crashed = false;
  override async compareAndSwapHead(
    vaultId: string,
    expected: ExpectedHead | null,
    next: RemoteHeadInput,
  ) {
    if (!this.crashed) {
      this.crashed = true;
      throw new VaultSyncError('NETWORK', 'simulated crash before HEAD update');
    }
    return super.compareAndSwapHead(vaultId, expected, next);
  }
}

/** First download returns corrupted bytes.*/
class CorruptingRemote extends MemorySyncRemote {
  corruptNextDownload = false;
  override async downloadBlob(
    vaultId: string,
    blob: string,
  ): Promise<Uint8Array> {
    const bytes = await super.downloadBlob(vaultId, blob);
    if (this.corruptNextDownload) {
      this.corruptNextDownload = false;
      bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    }
    return bytes;
  }
}

describe('reconcile engine', () => {
  it('replicates database view settings and canonical member properties across two vaults', async () => {
    const remote = new MemorySyncRemote();
    const model = createDatabase('Projects');
    model.properties.push({ id: 'status', name: 'Status', type: 'text' });
    model.membership = {
      mode: 'explicit',
      resourceIds: [resourceId('member-1')],
    };
    model.views[0] = {
      ...model.views[0]!,
      visibleProperties: ['status'],
      columnWidths: { $title: 260, status: 216 },
    };
    const propertyPath = '.froglight/properties/member-1.json';
    const record = (status: string) =>
      JSON.stringify({
        format: 'froglight.properties',
        version: 1,
        owner: 'member-1',
        values: { status },
        relations: [],
      });
    const a = await makeDevice({
      'Projects.base': JSON.stringify(model),
      'Notes/Member.md': '# Member',
      [propertyPath]: record('To do'),
    });
    const b = await makeDevice({});
    await sync(a, remote);
    await sync(b, remote, 'University', 'device-b');
    const pulled = await dumpVault(b.vault);
    expect(JSON.parse(pulled['Projects.base']!)).toMatchObject({
      views: [{ visibleProperties: ['status'], columnWidths: { status: 216 } }],
    });
    expect(JSON.parse(pulled[propertyPath]!).values.status).toBe('To do');
    model.views[0] = { ...model.views[0]!, columnWidths: { status: 320 } };
    await b.vault.write(
      workspacePath('Projects.base'),
      new TextEncoder().encode(JSON.stringify(model)),
    );
    await b.vault.write(
      workspacePath(propertyPath),
      new TextEncoder().encode(record('Done')),
    );
    await sync(b, remote, 'University', 'device-b');
    await sync(a, remote);
    const returned = await dumpVault(a.vault);
    expect(
      JSON.parse(returned['Projects.base']!).views[0].columnWidths.status,
    ).toBe(320);
    expect(JSON.parse(returned[propertyPath]!).values.status).toBe('Done');
    expect(returned['Notes/Member.md']).toBe('# Member');
  });

  it('propagates A creates → B sees, then B edits → A sees', async () => {
    const remote = new MemorySyncRemote();
    const a = await makeDevice({ 'Notes/a.md': 'hello' });
    const b = await makeDevice({});

    const first = await sync(a, remote);
    expect(first.committed).toBe(true);
    expect(first.revision).toBe(1);
    expect(first.base.manifest.parentHash).toBeNull();

    const pull = await sync(b, remote, 'University', 'device-b');
    expect(pull.committed).toBe(false);
    expect(pull.appliedLocalChanges).toBe(true);
    expect(await dumpVault(b.vault)).toEqual({ 'Notes/a.md': 'hello' });
    expect(b.base!.hash).toBe(a.base!.hash);

    await b.vault.write(
      workspacePath('Notes/a.md'),
      new TextEncoder().encode('hello edited'),
    );
    const second = await sync(b, remote, 'University', 'device-b');
    expect(second.committed).toBe(true);
    expect(second.revision).toBe(2);

    const catchUp = await sync(a, remote);
    expect(catchUp.committed).toBe(false);
    expect(await dumpVault(a.vault)).toEqual({ 'Notes/a.md': 'hello edited' });
  });

  it('preserves both versions on concurrent edit and converges after', async () => {
    const remote = new MemorySyncRemote();
    const a = await makeDevice({ 'note.md': 'v1' });
    const b = await makeDevice({});
    await sync(a, remote);
    await sync(b, remote, 'University', 'device-b');

    await a.vault.write(
      workspacePath('note.md'),
      new TextEncoder().encode('A-side'),
    );
    await b.vault.write(
      workspacePath('note.md'),
      new TextEncoder().encode('B-side'),
    );
    await sync(a, remote);
    const conflicted = await sync(b, remote, 'University', 'device-b');
    expect(conflicted.conflicts).toHaveLength(1);
    expect(conflicted.conflicts[0]).toMatchObject({
      path: 'note.md',
      kept: 'local',
    });

    const bFiles = await dumpVault(b.vault);
    expect(bFiles['note.md']).toBe('B-side');
    const copyPath = conflicted.conflicts[0]!.conflictPath!;
    expect(bFiles[copyPath]).toBe('A-side');

    const catchUp = await sync(a, remote);
    expect(catchUp.appliedLocalChanges).toBe(true);
    expect(catchUp.committed).toBe(false);
    // Both replicas converge with both versions surviving.
    expect(await dumpVault(a.vault)).toEqual(bFiles);
  });

  it('propagates deletes and preserves delete-vs-edit winners', async () => {
    const remote = new MemorySyncRemote();
    const a = await makeDevice({ 'gone.md': 'x', 'duel.md': 'v1' });
    const b = await makeDevice({});
    await sync(a, remote);
    await sync(b, remote, 'University', 'device-b');

    await a.vault.remove(workspacePath('gone.md'));
    await sync(a, remote);
    await sync(b, remote, 'University', 'device-b');
    expect(await dumpVault(b.vault)).toEqual({ 'duel.md': 'v1' });

    // Concurrent delete-vs-edit: the edited version is preserved.
    await a.vault.remove(workspacePath('duel.md'));
    await b.vault.write(
      workspacePath('duel.md'),
      new TextEncoder().encode('v2'),
    );
    await sync(a, remote);
    const restored = await sync(b, remote, 'University', 'device-b');
    expect(restored.conflicts).toHaveLength(1);
    expect(restored.conflicts[0]).toMatchObject({
      path: 'duel.md',
      kept: 'local',
    });
    await sync(a, remote);
    expect(await dumpVault(a.vault)).toEqual({ 'duel.md': 'v2' });
    expect(await dumpVault(b.vault)).toEqual({ 'duel.md': 'v2' });
  });

  it('uploads a large unchanged asset exactly once', async () => {
    const remote = new MemorySyncRemote();
    const big = new Uint8Array(256 * 1024);
    for (let i = 0; i < big.length; i += 1) big[i] = i % 251;
    const vault = await makeVault({ 'note.md': 'v1' });
    await ensureDirectory(vault, workspacePath('Assets'));
    await vault.write(workspacePath('Assets/big.bin'), big);
    const device: Device = { vault, base: null };

    await sync(device, remote);
    expect(uploadBlobCalls(remote)).toHaveLength(2);

    await vault.write(workspacePath('note.md'), new TextEncoder().encode('v2'));
    const second = await sync(device, remote);
    expect(second.committed).toBe(true);
    expect(uploadBlobCalls(remote)).toHaveLength(3);

    // Idle reconcile uploads nothing and commits nothing.
    const idle = await sync(device, remote);
    expect(idle.committed).toBe(false);
    expect(uploadBlobCalls(remote)).toHaveLength(3);
    expect(idle.downloadedFiles).toBe(0);
  });

  it('loses no pending change across restart', async () => {
    const remote = new MemorySyncRemote();
    const a = await makeDevice({ 'a.md': 'v1' });
    await sync(a, remote);
    // Offline edit, "restart" (same persisted base, fresh call), then sync.
    await a.vault.write(workspacePath('a.md'), new TextEncoder().encode('v2'));
    const persisted = a.base;
    const rebooted: Device = { vault: a.vault, base: persisted };
    const result = await reconcileVault({
      vault: rebooted.vault,
      remote,
      vaultId: VAULT_ID,
      name: 'University',
      base: rebooted.base,
      deviceId: 'device-a',
      now: NOW,
    });
    expect(result.committed).toBe(true);
    expect(result.revision).toBe(2);
  });

  it('recovers from an interrupted commit without forking history', async () => {
    const remote = new CrashOnceRemote();
    const a = await makeDevice({ 'a.md': 'v1' });
    await expect(sync(a, remote)).rejects.toMatchObject({ code: 'NETWORK' });
    // Previous HEAD (none yet) stays valid; the orphaned objects are reused.
    const recovered = await sync(a, remote);
    expect(recovered.committed).toBe(true);
    expect(recovered.revision).toBe(1);
    expect(uploadBlobCalls(remote)).toHaveLength(1);

    const b = await makeDevice({});
    await sync(b, remote, 'University', 'device-b');
    expect(await dumpVault(b.vault)).toEqual({ 'a.md': 'v1' });
  });

  it('rejects corrupted downloads and retains the valid local copy', async () => {
    const remote = new CorruptingRemote();
    const a = await makeDevice({ 'a.md': 'good' });
    const b = await makeDevice({});
    await sync(a, remote);
    await sync(b, remote, 'University', 'device-b');

    // Remote-only edit: B must download it; corruption retains B's copy.
    await a.vault.write(
      workspacePath('a.md'),
      new TextEncoder().encode('good2'),
    );
    await sync(a, remote);
    remote.corruptNextDownload = true;
    await expect(
      sync(b, remote, 'University', 'device-b'),
    ).rejects.toMatchObject({
      code: 'HASH_MISMATCH',
    });
    expect(await dumpVault(b.vault)).toEqual({ 'a.md': 'good' });

    const retry = await sync(b, remote, 'University', 'device-b');
    expect(retry.appliedLocalChanges).toBe(true);
    expect(await dumpVault(b.vault)).toEqual({ 'a.md': 'good2' });
  });

  it('chains multiple consecutive revisions with parent hashes', async () => {
    const remote = new MemorySyncRemote();
    const a = await makeDevice({ 'a.md': 'v1' });
    const hashes: string[] = [];
    for (const text of ['v1', 'v2', 'v3']) {
      await a.vault.write(
        workspacePath('a.md'),
        new TextEncoder().encode(text),
      );
      const result = await sync(a, remote);
      expect(result.committed).toBe(true);
      hashes.push(result.base.hash);
    }
    expect(a.base!.manifest.revision).toBe(3);
    const head = (await remote.readHead(VAULT_ID))!;
    expect(head.revision).toBe(3);
    expect(head.manifestHash).toBe(hashes[2]);
    const rev3 = await remote.loadManifest(VAULT_ID, hashes[2]!);
    expect(rev3.revision).toBe(3);
    expect(rev3.parentHash).toBe(hashes[1]);
    const rev2 = await remote.loadManifest(VAULT_ID, hashes[1]!);
    expect(rev2.parentHash).toBe(hashes[0]);
  });

  it('converges after sequential concurrent commits (no forced CAS race)', async () => {
    // NOTE: this test commits A fully before B starts, so B reads the new
    // HEAD and never hits REMOTE_CHANGED. The real pause-before-CAS race
    // (REMOTE_CHANGED → retry branch) is proven in `cas-race.spec.ts`.
    const remote = new MemorySyncRemote();
    const a = await makeDevice({ 'a.md': 'v1' });
    const b = await makeDevice({});
    await sync(a, remote);
    await sync(b, remote, 'University', 'device-b');

    // Both devices edit from the same base; A commits first outside the
    // engine while B reconciles — B's CAS misses once and must retry.
    await a.vault.write(
      workspacePath('shared.md'),
      new TextEncoder().encode('A'),
    );
    await b.vault.write(
      workspacePath('shared.md'),
      new TextEncoder().encode('B'),
    );
    const aResult = await sync(a, remote);
    expect(aResult.committed).toBe(true);
    const bResult = await sync(b, remote, 'University', 'device-b');
    expect(bResult.committed).toBe(true);
    expect(bResult.conflicts).toHaveLength(1);
    await sync(a, remote);
    expect(await dumpVault(a.vault)).toEqual(await dumpVault(b.vault));
  });

  it('is a no-op when everything is already empty', async () => {
    const remote = new MemorySyncRemote();
    const a = await makeDevice({});
    const result = await sync(a, remote);
    expect(result.committed).toBe(false);
    expect(result.revision).toBe(0);
    expect(await remote.readHead(VAULT_ID)).toBeNull();
  });

  it('refuses a bound replica whose remote vault is gone', async () => {
    const remote = new MemorySyncRemote();
    const a = await makeDevice({ 'a.md': 'v1' });
    await sync(a, remote);
    const orphaned: Device = { vault: a.vault, base: a.base };
    const empty = new MemorySyncRemote();
    await expect(
      reconcileVault({
        vault: orphaned.vault,
        remote: empty,
        vaultId: VAULT_ID,
        name: 'University',
        base: orphaned.base,
        deviceId: 'device-a',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'REMOTE_NOT_FOUND' });
  });

  it('rejects a base bound to a different cloud vault', async () => {
    const remote = new MemorySyncRemote();
    const a = await makeDevice({ 'a.md': 'v1' });
    await sync(a, remote);
    await expect(
      reconcileVault({
        vault: a.vault,
        remote,
        vaultId: 'other-vault',
        name: 'University',
        base: a.base,
        deviceId: 'device-a',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'CORRUPT_MANIFEST' });
  });

  it('materializes remote directories and prunes dead empty ones', async () => {
    const remote = new MemorySyncRemote();
    const a = await makeDevice({ 'Docs/note.md': 'x' });
    const dirResult = await sync(a, remote);
    expect(dirResult.committed).toBe(true);
    const b = await makeDevice({});
    await sync(b, remote, 'University', 'device-b');
    expect(await dumpVault(b.vault)).toEqual({ 'Docs/note.md': 'x' });

    // Explicit empty directories sync as entries, not implied state.
    const { vault: c } = createMemoryVault();
    await ensureDirectory(c, workspacePath('Empty'));
    const emptyDir: Device = { vault: c, base: null };
    const created = await reconcileVault({
      vault: emptyDir.vault,
      remote,
      vaultId: 'other-vault-2',
      name: 'Second',
      base: null,
      deviceId: 'device-c',
      now: NOW,
    });
    expect(created.committed).toBe(true);
    expect(created.base.manifest.entries).toEqual([
      { path: 'Empty', kind: 'directory' },
    ]);
  });
});

describe('dirty-session deferral', () => {
  const deferNote = (path: string): boolean => path === 'note.md';

  async function syncedPair(): Promise<{
    remote: MemorySyncRemote;
    a: Device;
    b: Device;
  }> {
    const remote = new MemorySyncRemote();
    const a = await makeDevice({ 'note.md': 'v1' });
    const b = await makeDevice({});
    await sync(a, remote);
    await sync(b, remote, 'University', 'device-b');
    return { remote, a, b };
  }

  function entryBlob(base: SyncBase | null, path: string): string | undefined {
    return base?.manifest.entries.find(
      (entry) => entry.path === path && entry.kind === 'file',
    )?.blob;
  }

  it('skips the dirty file locally while keeping a truthful base', async () => {
    const { remote, b } = await syncedPair();
    const localBlob = entryBlob(b.base, 'note.md');
    // Device A commits a remote-only change while B holds note.md dirty.
    const a2 = await makeDevice({ 'note.md': 'v2-remote' });
    a2.base = b.base;
    await sync(a2, remote);

    const result = await reconcileVault({
      vault: b.vault,
      remote,
      vaultId: VAULT_ID,
      name: 'University',
      base: b.base,
      deviceId: 'device-b',
      now: NOW,
      defer: deferNote,
    });
    b.base = result.base;

    // Vault untouched, base still describes the vault (not the cloud).
    expect(await dumpVault(b.vault)).toEqual({ 'note.md': 'v1' });
    expect(entryBlob(b.base, 'note.md')).toBe(localBlob);
    // The cloud moved on while this replica honestly stayed behind.
    const remoteHead = await remote.readHead(VAULT_ID);
    const remoteManifest = await remote.loadManifest(
      VAULT_ID,
      remoteHead!.manifestHash,
    );
    const remoteEntry = remoteManifest.entries.find(
      (entry) => entry.path === 'note.md',
    );
    expect(remoteEntry).toMatchObject({ kind: 'file' });
    expect(entryBlob(b.base, 'note.md')).not.toBe(
      (remoteEntry as { blob?: string }).blob,
    );
    expect(result.committed).toBe(false);
    expect(result.conflicts).toEqual([]);
  });

  it('reconciles a save after deferral as a genuine concurrent edit', async () => {
    const { remote, b } = await syncedPair();
    const a2 = await makeDevice({ 'note.md': 'v2-remote' });
    a2.base = b.base;
    await sync(a2, remote);

    await reconcileVault({
      vault: b.vault,
      remote,
      vaultId: VAULT_ID,
      name: 'University',
      base: b.base,
      deviceId: 'device-b',
      now: NOW,
      defer: deferNote,
    }).then((result) => {
      b.base = result.base;
    });

    // The session saves: local content changes while deferred.
    await b.vault.write(
      workspacePath('note.md'),
      new TextEncoder().encode('v2-local'),
    );
    const saved = await reconcileVault({
      vault: b.vault,
      remote,
      vaultId: VAULT_ID,
      name: 'University',
      base: b.base,
      deviceId: 'device-b',
      now: NOW,
    });
    b.base = saved.base;

    // Both versions survive: local keeps the path, remote is preserved.
    expect(saved.conflicts).toHaveLength(1);
    expect(saved.conflicts[0]).toMatchObject({
      path: 'note.md',
      kept: 'local',
    });
    const files = await dumpVault(b.vault);
    expect(files['note.md']).toBe('v2-local');
    const copyPath = saved.conflicts[0]!.conflictPath!;
    expect(files[copyPath]).toBe('v2-remote');
  });

  it('converges by downloading after a revert without saving', async () => {
    const { remote, b } = await syncedPair();
    const a2 = await makeDevice({ 'note.md': 'v2-remote' });
    a2.base = b.base;
    await sync(a2, remote);

    const deferred = await reconcileVault({
      vault: b.vault,
      remote,
      vaultId: VAULT_ID,
      name: 'University',
      base: b.base,
      deviceId: 'device-b',
      now: NOW,
      defer: deferNote,
    });
    b.base = deferred.base;
    expect(await dumpVault(b.vault)).toEqual({ 'note.md': 'v1' });

    // The session closes without saving: vault still holds v1, the base
    // truthfully says v1, so the next clean reconcile downloads v2
    // instead of resurrecting the stale version.
    const converged = await reconcileVault({
      vault: b.vault,
      remote,
      vaultId: VAULT_ID,
      name: 'University',
      base: b.base,
      deviceId: 'device-b',
      now: NOW,
    });
    b.base = converged.base;
    expect(converged.committed).toBe(false);
    expect(converged.conflicts).toEqual([]);
    expect(await dumpVault(b.vault)).toEqual({ 'note.md': 'v2-remote' });
  });

  it('defers a remote delete of the dirty file, then applies it when clean', async () => {
    const { remote, b } = await syncedPair();
    // A second device deletes note.md.
    const a2 = await makeDevice({});
    a2.base = b.base;
    await sync(a2, remote);

    const deferred = await reconcileVault({
      vault: b.vault,
      remote,
      vaultId: VAULT_ID,
      name: 'University',
      base: b.base,
      deviceId: 'device-b',
      now: NOW,
      defer: deferNote,
    });
    b.base = deferred.base;
    // Vault keeps the dirty file; base still describes it.
    expect(await dumpVault(b.vault)).toEqual({ 'note.md': 'v1' });
    expect(entryBlob(b.base, 'note.md')).not.toBeUndefined();

    const applied = await reconcileVault({
      vault: b.vault,
      remote,
      vaultId: VAULT_ID,
      name: 'University',
      base: b.base,
      deviceId: 'device-b',
      now: NOW,
    });
    b.base = applied.base;
    expect(await dumpVault(b.vault)).toEqual({});
  });

  it('commits other paths while one file stays deferred', async () => {
    const { remote, b } = await syncedPair();
    // Remote edits note.md AND adds other.md; local adds local.md.
    const a2 = await makeDevice({ 'note.md': 'v2-remote', 'other.md': 'o' });
    a2.base = b.base;
    await sync(a2, remote);
    await b.vault.write(
      workspacePath('local.md'),
      new TextEncoder().encode('mine'),
    );

    const result = await reconcileVault({
      vault: b.vault,
      remote,
      vaultId: VAULT_ID,
      name: 'University',
      base: b.base,
      deviceId: 'device-b',
      now: NOW,
      defer: deferNote,
    });
    b.base = result.base;

    expect(result.committed).toBe(true);
    const files = await dumpVault(b.vault);
    expect(files['note.md']).toBe('v1');
    expect(files['other.md']).toBe('o');
    expect(files['local.md']).toBe('mine');
    // The committed cloud revision carries the truthful merge (v2 for
    // note.md); this replica's base honestly records its own v1.
    const head = await remote.readHead(VAULT_ID);
    const cloud = await remote.loadManifest(VAULT_ID, head!.manifestHash);
    expect(
      cloud.entries.find((entry) => entry.path === 'note.md'),
    ).toMatchObject({ kind: 'file' });
    expect(entryBlob(b.base, 'note.md')).not.toBe(
      (
        cloud.entries.find((entry) => entry.path === 'note.md') as {
          blob?: string;
        }
      ).blob,
    );
    expect(entryBlob(b.base, 'other.md')).toBe(
      (
        cloud.entries.find((entry) => entry.path === 'other.md') as {
          blob?: string;
        }
      ).blob,
    );
  });

  it('reports progress stages in order for status mapping', async () => {
    const remote = new MemorySyncRemote();
    const a = await makeDevice({ 'a.md': 'v1' });
    const stages: SyncProgressStage[] = [];
    const result = await reconcileVault({
      vault: a.vault,
      remote,
      vaultId: VAULT_ID,
      name: 'University',
      base: null,
      deviceId: 'device-a',
      now: NOW,
      onProgress: (stage) => {
        stages.push(stage);
      },
    });
    expect(result.committed).toBe(true);
    expect(stages).toEqual(['scan', 'merge', 'download', 'upload']);

    // A pull-only reconcile ends after download.
    const b = await makeDevice({});
    const pullStages: SyncProgressStage[] = [];
    await reconcileVault({
      vault: b.vault,
      remote,
      vaultId: VAULT_ID,
      name: 'University',
      base: null,
      deviceId: 'device-b',
      now: NOW,
      onProgress: (stage) => {
        pullStages.push(stage);
      },
    });
    expect(pullStages).toEqual(['scan', 'merge', 'download']);
  });

  describe('directory kind transitions and deletions', () => {
    it('materializes a remote directory → file replacement', async () => {
      const remote = new MemorySyncRemote();
      const a = await makeDevice({ 'folder/a.md': 'x' });
      const b = await makeDevice({});
      await sync(a, remote);
      await sync(b, remote);
      expect(await dumpVault(b.vault)).toEqual({ 'folder/a.md': 'x' });

      // Remote replaces folder/ (with a.md) by a file named folder.
      await removePath(a.vault, 'folder/a.md');
      await removePath(a.vault, 'folder');
      await a.vault.write(
        workspacePath('folder'),
        new TextEncoder().encode('F'),
      );
      const committed = await sync(a, remote);
      expect(committed.committed).toBe(true);

      const pulled = await sync(b, remote);
      expect(pulled.appliedLocalChanges).toBe(true);
      expect(await dumpVault(b.vault)).toEqual({ folder: 'F' });
      // Converged: a second sync is a no-op (no resurrection, no churn).
      const settled = await sync(b, remote);
      expect(settled.committed).toBe(false);
      expect(settled.appliedLocalChanges).toBe(false);
      expect(await dumpVault(b.vault)).toEqual({ folder: 'F' });
    });

    it('materializes a remote file → directory replacement', async () => {
      const remote = new MemorySyncRemote();
      const a = await makeDevice({ folder: 'F' });
      const b = await makeDevice({});
      await sync(a, remote);
      await sync(b, remote);

      await removePath(a.vault, 'folder');
      await ensureDirectory(a.vault, workspacePath('folder'));
      await a.vault.write(
        workspacePath('folder/a.md'),
        new TextEncoder().encode('x'),
      );
      await sync(a, remote);

      await sync(b, remote);
      expect(await dumpVault(b.vault)).toEqual({ 'folder/a.md': 'x' });
      const settled = await sync(b, remote);
      expect(settled.committed).toBe(false);
      expect(settled.appliedLocalChanges).toBe(false);
    });

    it('materializes a nested directory → file replacement', async () => {
      const remote = new MemorySyncRemote();
      const a = await makeDevice({ 'folder/sub/a.md': 'deep' });
      const b = await makeDevice({});
      await sync(a, remote);
      await sync(b, remote);

      await removePath(a.vault, 'folder/sub/a.md');
      await removePath(a.vault, 'folder/sub');
      await removePath(a.vault, 'folder');
      await a.vault.write(
        workspacePath('folder'),
        new TextEncoder().encode('F'),
      );
      await sync(a, remote);

      await sync(b, remote);
      expect(await dumpVault(b.vault)).toEqual({ folder: 'F' });
      const settled = await sync(b, remote);
      expect(settled.committed).toBe(false);
      expect(settled.appliedLocalChanges).toBe(false);
    });

    it('deletes nested directories without resurrection', async () => {
      const remote = new MemorySyncRemote();
      const a = await makeDevice({
        'folder/a.md': 'x',
        'folder/sub/b.md': 'y',
      });
      const b = await makeDevice({});
      await sync(a, remote);
      await sync(b, remote);

      await removePath(a.vault, 'folder/a.md');
      await removePath(a.vault, 'folder/sub/b.md');
      await removePath(a.vault, 'folder/sub');
      await removePath(a.vault, 'folder');
      await sync(a, remote);

      await sync(b, remote);
      expect(await dumpVault(b.vault)).toEqual({});
      // The emptied folder/ must not survive to be rediscovered as a new
      // local directory on the next scan: the follow-up sync commits
      // nothing and changes nothing.
      const settled = await sync(b, remote);
      expect(settled.committed).toBe(false);
      expect(settled.appliedLocalChanges).toBe(false);
      expect(await dumpVault(b.vault)).toEqual({});
    });

    it('syncs explicit empty directories and converges', async () => {
      const remote = new MemorySyncRemote();
      const a = await makeDevice({ 'a.md': 'x' });
      const b = await makeDevice({});
      await sync(a, remote);
      await sync(b, remote);

      await ensureDirectory(a.vault, workspacePath('Empty'));
      const committed = await sync(a, remote);
      expect(committed.committed).toBe(true);

      await sync(b, remote);
      expect(await b.vault.stat(workspacePath('Empty'))).toMatchObject({
        kind: 'directory',
      });
      const settledA = await sync(a, remote);
      const settledB = await sync(b, remote);
      expect(settledA.committed).toBe(false);
      expect(settledB.committed).toBe(false);
    });

    it('preserves both sides of a concurrent file/directory conflict', async () => {
      const remote = new MemorySyncRemote();
      // A holds a file D; B holds a directory D/ with f.md. A syncs first.
      const a = await makeDevice({ D: 'local-file' });
      await sync(a, remote);
      const b = await makeDevice({ 'D/f.md': 'remote-file' });
      const result = await sync(b, remote);
      expect(result.committed).toBe(true);
      const conflict = result.conflicts.find(
        (c) => c.kind === 'file-directory',
      );
      expect(conflict?.kept).toBe('local');

      // Both occupants survive on B: the local directory at D and the
      // relocated remote file under a deterministic conflict directory.
      const afterB = await dumpVault(b.vault);
      expect(afterB['D/f.md']).toBe('remote-file');
      const relocated = Object.keys(afterB).filter((path) =>
        path.includes('.conflict-'),
      );
      expect(relocated).toHaveLength(1);

      // A converges onto the same state without losing its file: the edited
      // version wins per the delete/edit rule and both contents are kept.
      await sync(a, remote);
      const afterA = await dumpVault(a.vault);
      expect(afterA).toEqual(afterB);
      expect(Object.values(afterA)).toContain('local-file');
      expect(Object.values(afterA)).toContain('remote-file');
    });
  });

  describe('incremental local scans', () => {
    it('skips re-reading unchanged files across cycles', async () => {
      const remote = new MemorySyncRemote();
      const inner = await makeVault({
        'a.md': 'alpha',
        'b.md': 'beta',
        'Assets/big.bin': 'x'.repeat(200_000),
      });
      const { vault, counts } = countingVault(inner);
      const cache = createLocalScanCache();
      let base: SyncBase | null = null;
      const cycle = async (force?: {
        forceHash?: ReadonlySet<string>;
        forceFullScan?: boolean;
      }): Promise<ReconcileResult> => {
        const result = await reconcileVault({
          vault,
          remote,
          vaultId: VAULT_ID,
          name: 'University',
          base,
          deviceId: 'device-a',
          now: NOW,
          incremental: { cache, ...force },
        });
        base = result.base;
        return result;
      };

      const first = await cycle();
      expect(first.committed).toBe(true);
      expect(first.scannedFiles).toBe(3);
      expect(first.hashedFiles).toBe(3);
      // 3 scan hashes + 3 commit-upload reads (the remote starts empty).
      expect(counts.read).toBe(6);

      // No changes: the authoritative listing still runs, but no content is
      // re-read or re-hashed (and nothing is uploaded).
      const second = await cycle();
      expect(second.committed).toBe(false);
      expect(second.scannedFiles).toBe(3);
      expect(second.hashedFiles).toBe(0);
      expect(counts.read).toBe(6);

      // An unrelated Markdown edit must not re-hash the large asset: one
      // scan hash plus one upload read, nothing else.
      await vault.write(
        workspacePath('a.md'),
        new TextEncoder().encode('alpha2'),
      );
      const third = await cycle();
      expect(third.committed).toBe(true);
      expect(third.hashedFiles).toBe(1);
      expect(counts.read).toBe(8);

      const fourth = await cycle();
      expect(fourth.hashedFiles).toBe(0);
      expect(counts.read).toBe(8);
    });

    it('honors mutation hints and full-scan recovery', async () => {
      const remote = new MemorySyncRemote();
      const inner = await makeVault({ 'a.md': 'alpha', 'b.md': 'beta' });
      const { vault } = countingVault(inner);
      const cache = createLocalScanCache();
      let base: SyncBase | null = null;
      const cycle = async (force?: {
        forceHash?: ReadonlySet<string>;
        forceFullScan?: boolean;
      }): Promise<ReconcileResult> => {
        const result = await reconcileVault({
          vault,
          remote,
          vaultId: VAULT_ID,
          name: 'University',
          base,
          deviceId: 'device-a',
          now: NOW,
          incremental: { cache, ...force },
        });
        base = result.base;
        return result;
      };
      await cycle();
      const cached = await cycle();
      expect(cached.hashedFiles).toBe(0);

      // A hinted path is always re-hashed, even with no content change.
      const hinted = await cycle({ forceHash: new Set(['b.md']) });
      expect(hinted.hashedFiles).toBe(1);

      // Recovery truth: a full scan re-hashes everything and a restart
      // (empty cache) reconstructs correct state from scratch.
      const full = await cycle({ forceFullScan: true });
      expect(full.hashedFiles).toBe(2);
      const freshCache = createLocalScanCache();
      const restarted = await reconcileVault({
        vault,
        remote,
        vaultId: VAULT_ID,
        name: 'University',
        base,
        deviceId: 'device-a',
        now: NOW,
        incremental: { cache: freshCache },
      });
      expect(restarted.hashedFiles).toBe(2);
      expect(restarted.committed).toBe(false);
    });

    it('refreshes the cache for remote-applied files', async () => {
      const remote = new MemorySyncRemote();
      const innerA = await makeVault({ 'a.md': 'v1' });
      const { vault: vaultA } = countingVault(innerA);
      const cacheA = createLocalScanCache();
      let baseA: SyncBase | null = null;
      const cycleA = async (): Promise<ReconcileResult> => {
        const result = await reconcileVault({
          vault: vaultA,
          remote,
          vaultId: VAULT_ID,
          name: 'University',
          base: baseA,
          deviceId: 'device-a',
          now: NOW,
          incremental: { cache: cacheA },
        });
        baseA = result.base;
        return result;
      };
      await cycleA();

      const deviceB = await makeDevice({ 'a.md': 'v1' });
      let baseB: SyncBase | null = null;
      const pull = await reconcileVault({
        vault: deviceB.vault,
        remote,
        vaultId: VAULT_ID,
        name: 'University',
        base: baseB,
        deviceId: 'device-b',
        now: NOW,
      });
      baseB = pull.base;
      await deviceB.vault.write(
        workspacePath('a.md'),
        new TextEncoder().encode('v2-remote'),
      );
      const push = await reconcileVault({
        vault: deviceB.vault,
        remote,
        vaultId: VAULT_ID,
        name: 'University',
        base: baseB,
        deviceId: 'device-b',
        now: NOW,
      });
      expect(push.committed).toBe(true);

      // The download refreshes A's cache entry: the follow-up cycle reads
      // nothing even though the bytes changed under it.
      const downloaded = await cycleA();
      expect(downloaded.appliedLocalChanges).toBe(true);
      expect(await dumpVault(vaultA)).toEqual({ 'a.md': 'v2-remote' });
      const settled = await cycleA();
      expect(settled.hashedFiles).toBe(0);
      expect(settled.committed).toBe(false);
    });
  });

  it('contains a throwing progress hook without breaking the run', async () => {
    const remote = new MemorySyncRemote();
    const a = await makeDevice({ 'a.md': 'v1' });
    const result = await reconcileVault({
      vault: a.vault,
      remote,
      vaultId: VAULT_ID,
      name: 'University',
      base: null,
      deviceId: 'device-a',
      now: NOW,
      onProgress: () => {
        throw new Error('status blew up');
      },
    });
    expect(result.committed).toBe(true);
  });
});
