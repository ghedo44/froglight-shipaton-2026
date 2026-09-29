/**
 * Web Download & Open staging ownership (data-loss regression).
 *
 * Proves the transaction-owned staging contract at the real web adapter:
 *
 * ```text
 * parent/
 *   ExistingVault/
 *     important.txt          <- pre-existing user data
 * remote display name: ExistingVault
 * Download & Open
 *   -> staging directory MUST be a unique .froglight-download-<id>
 *      (never the display-derived "ExistingVault")
 *   -> discard() removes ONLY the staging directory
 *   -> important.txt survives; ExistingVault is never recursively removed
 * ```
 *
 * Plus materialization-failure (only staging removed, siblings untouched)
 * and activation-success (discard becomes a non-destructive no-op).
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createWebVaultAdapter } from './vault-recents.js';

class FakeFile {
  readonly kind = 'file' as const;
  constructor(readonly name: string) {}
}

class FakeDir {
  readonly kind = 'directory' as const;
  readonly children = new Map<string, FakeDir | FakeFile>();
  readonly removeCalls: string[] = [];
  constructor(readonly name: string) {}

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileSystemDirectoryHandle> {
    const existing = this.children.get(name);
    if (existing !== undefined) {
      if (existing instanceof FakeDir) {
        return existing as unknown as FileSystemDirectoryHandle;
      }
      throw new DOMException('path is a file', 'InvalidModificationError');
    }
    if (options?.create !== true) {
      throw new DOMException('not found', 'NotFoundError');
    }
    const dir = new FakeDir(name);
    this.children.set(name, dir);
    return dir as unknown as FileSystemDirectoryHandle;
  }

  async removeEntry(
    name: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    this.removeCalls.push(name);
    const existing = this.children.get(name);
    if (existing === undefined) {
      throw new DOMException('not found', 'NotFoundError');
    }
    if (
      existing instanceof FakeDir &&
      existing.children.size > 0 &&
      options?.recursive !== true
    ) {
      throw new DOMException('not empty', 'InvalidModificationError');
    }
    this.children.delete(name);
  }

  async *values(): AsyncIterable<FileSystemHandle> {
    for (const child of this.children.values()) {
      yield child as unknown as FileSystemHandle;
    }
  }
}

function stagingNameIn(parent: FakeDir): string | null {
  for (const key of parent.children.keys()) {
    if (key.startsWith('.froglight-download-')) return key;
  }
  return null;
}

describe('web Download & Open staging ownership', () => {
  let parent: FakeDir;
  let picker: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    parent = new FakeDir('parent');
    picker = vi.fn(async () => parent as unknown as FileSystemDirectoryHandle);
    (globalThis as Record<string, unknown>).window = {
      showDirectoryPicker: picker,
    };
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
    vi.restoreAllMocks();
  });

  function adapter(newStagingId?: () => string) {
    const controller = {
      openVault: vi.fn(async () => undefined),
    };
    return {
      controller,
      adapter: createWebVaultAdapter(
        controller as never,
        newStagingId === undefined ? {} : { newStagingId },
      ),
    };
  }

  it('existing directory collision never deletes user data', async () => {
    // parent/ExistingVault/important.txt pre-exists (user data).
    const existing = (await parent.getDirectoryHandle('ExistingVault', {
      create: true,
    })) as unknown as FakeDir;
    existing.children.set('important.txt', new FakeFile('important.txt'));

    const { adapter: vaults } = adapter();
    const store = await vaults.createEmptyVaultStore!('ExistingVault');
    expect(store).not.toBeNull();
    // The transaction stages into its own unguessable directory, never the
    // display-derived name.
    const staging = stagingNameIn(parent);
    expect(staging).not.toBeNull();
    expect(staging).not.toBe('ExistingVault');
    expect(parent.children.has('ExistingVault')).toBe(true);
    // The display name is still the remote vault name (launcher shows it)
    // while the physical directory stays opaque.
    expect(store!.id.length).toBeGreaterThan(0);

    // Simulate a materialization failure → discard.
    await store!.discard();
    // User data survives; only staging was removed.
    expect(parent.children.has('ExistingVault')).toBe(true);
    const surviving = parent.children.get('ExistingVault') as FakeDir;
    expect(surviving.children.has('important.txt')).toBe(true);
    expect(stagingNameIn(parent)).toBeNull();
    expect(parent.removeCalls).toHaveLength(1);
    expect(parent.removeCalls[0]).not.toBe('ExistingVault');
    expect(parent.removeCalls[0]?.startsWith('.froglight-download-')).toBe(
      true,
    );
  });

  it('materialization failure deletes only the transaction-owned staging store', async () => {
    const other = (await parent.getDirectoryHandle('OtherVault', {
      create: true,
    })) as unknown as FakeDir;
    other.children.set('keep.md', new FakeFile('keep.md'));

    const { adapter: vaults } = adapter();
    const store = await vaults.createEmptyVaultStore!('Physics');
    expect(store).not.toBeNull();
    const staging = stagingNameIn(parent);
    expect(staging).not.toBeNull();
    // Simulate: download fails → discard staging.
    await store!.discard();
    expect(stagingNameIn(parent)).toBeNull();
    // Siblings untouched.
    expect(parent.children.has('OtherVault')).toBe(true);
    expect(
      (parent.children.get('OtherVault') as FakeDir).children.has('keep.md'),
    ).toBe(true);
    expect(parent.removeCalls).toEqual([staging]);
  });

  it('activation success + finalization failure never deletes the opened vault', async () => {
    const { controller, adapter: vaults } = adapter();
    const store = await vaults.createEmptyVaultStore!('Physics');
    expect(store).not.toBeNull();
    const staging = stagingNameIn(parent);
    expect(staging).not.toBeNull();

    // Activation succeeds: ownership transfers to the opened user vault.
    const opened = await store!.activate();
    expect(opened).not.toBeNull();
    expect(controller.openVault).toHaveBeenCalledTimes(1);

    // A later sync-metadata (finalize) failure must NOT destructively
    // discard the opened vault: discard is a safe no-op now.
    await store!.discard();
    expect(parent.children.has(staging as string)).toBe(true);
    expect(parent.removeCalls).toEqual([]);
    // Idempotent: a second discard is still a no-op.
    await store!.discard();
    expect(parent.children.has(staging as string)).toBe(true);
    expect(parent.removeCalls).toEqual([]);
  });

  it('staging directories are unguessable and unique per transaction', async () => {
    const { adapter: vaults } = adapter();
    const first = await vaults.createEmptyVaultStore!('Physics');
    const second = await vaults.createEmptyVaultStore!('Physics');
    const names = [...parent.children.keys()].filter((k) =>
      k.startsWith('.froglight-download-'),
    );
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
    await first!.discard();
    await second!.discard();
    expect(stagingNameIn(parent)).toBeNull();
  });

  it('enumeration failure degrades to non-destructive cleanup (never deletes uncertain dirs)', async () => {
    // A staging directory whose emptiness cannot be verified (values()
    // throws) must still materialize, but discard must NOT recursively
    // delete it — ownership was never established.
    class OpaqueDir extends FakeDir {
      override async *values(): AsyncIterable<FileSystemHandle> {
        throw new Error('enumeration unavailable');
        yield undefined as never;
      }
    }
    const opaqueParent = new FakeDir('opaque-parent');
    // Force the adapter to use our opaque parent by patching the picker.
    picker.mockResolvedValueOnce(
      opaqueParent as unknown as FileSystemDirectoryHandle,
    );
    // Make getDirectoryHandle return OpaqueDir instances for staging names.
    const origGet = opaqueParent.getDirectoryHandle.bind(opaqueParent);
    opaqueParent.getDirectoryHandle = (async (
      name: string,
      options?: { create?: boolean },
    ) => {
      const handle = (await origGet(name, options)) as unknown as FakeDir;
      if (name.startsWith('.froglight-download-')) {
        const opaque = new OpaqueDir(name);
        opaqueParent.children.set(name, opaque as unknown as FakeDir);
        return opaque as unknown as FileSystemDirectoryHandle;
      }
      return handle as unknown as FileSystemDirectoryHandle;
    }) as typeof opaqueParent.getDirectoryHandle;
    const { adapter: vaults } = adapter();
    const store = await vaults.createEmptyVaultStore!('Physics');
    expect(store).not.toBeNull();
    const staging = [...opaqueParent.children.keys()].find((k) =>
      k.startsWith('.froglight-download-'),
    );
    expect(staging).toBeTruthy();
    await store!.discard();
    // Uncertain ownership: the directory survives (forget-recents only).
    expect(opaqueParent.children.has(staging as string)).toBe(true);
    expect(opaqueParent.removeCalls).toEqual([]);
  });

  it('probe-before-create skips an occupied candidate and owns only the fresh one', async () => {
    // Inject deterministic ids: the first candidate is occupied (as if a
    // random UUID collided), the second is fresh.
    const occupied = (await parent.getDirectoryHandle(
      '.froglight-download-occupied',
      { create: true },
    )) as unknown as FakeDir;
    occupied.children.set('user.txt', new FakeFile('user.txt'));
    const ids = ['occupied', 'fresh'];
    let index = 0;
    const { adapter: vaults } = adapter(() => ids[index++] as string);
    const store = await vaults.createEmptyVaultStore!('Physics');
    expect(store).not.toBeNull();
    // Collision: occupied candidate untouched; fresh candidate created and
    // transaction-owned.
    expect(parent.children.has('.froglight-download-occupied')).toBe(true);
    expect(
      (
        parent.children.get('.froglight-download-occupied') as FakeDir
      ).children.has('user.txt'),
    ).toBe(true);
    expect(parent.children.has('.froglight-download-fresh')).toBe(true);
    await store!.discard();
    expect(parent.children.has('.froglight-download-fresh')).toBe(false);
    expect(parent.children.has('.froglight-download-occupied')).toBe(true);
    expect(parent.removeCalls).toEqual(['.froglight-download-fresh']);
  });

  it('a pre-existing empty candidate is never claimed as transaction-owned', async () => {
    await parent.getDirectoryHandle('.froglight-download-empty', {
      create: true,
    });
    const ids = ['empty', 'fresh'];
    let index = 0;
    const { adapter: vaults } = adapter(() => ids[index++] as string);
    const store = await vaults.createEmptyVaultStore!('Physics');
    expect(store).not.toBeNull();
    await store!.discard();
    // Existence was established before creation: skip it (collision), and
    // discard removes only the transaction-created candidate.
    expect(parent.children.has('.froglight-download-empty')).toBe(true);
    expect(parent.children.has('.froglight-download-fresh')).toBe(false);
    expect(parent.removeCalls).toEqual(['.froglight-download-fresh']);
  });

  it('unknown existence result degrades to non-destructive cleanup', async () => {
    // The probe throws something that is NOT a not-found result: absence
    // cannot be proven, so ownership must never be claimed.
    class ExistenceOpaqueDir extends FakeDir {
      override async getDirectoryHandle(
        name: string,
        options?: { create?: boolean },
      ): Promise<FileSystemDirectoryHandle> {
        if (
          name === '.froglight-download-unknown' &&
          options?.create !== true
        ) {
          throw new Error('existence not reportable');
        }
        return super.getDirectoryHandle(name, options);
      }
    }
    const opaqueParent = new ExistenceOpaqueDir('opaque-existence');
    picker.mockResolvedValueOnce(
      opaqueParent as unknown as FileSystemDirectoryHandle,
    );
    const { adapter: vaults } = adapter(() => 'unknown');
    const store = await vaults.createEmptyVaultStore!('Physics');
    expect(store).not.toBeNull();
    await store!.discard();
    expect(opaqueParent.children.has('.froglight-download-unknown')).toBe(true);
    expect(opaqueParent.removeCalls).toEqual([]);
  });
});
