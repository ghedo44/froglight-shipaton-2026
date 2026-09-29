/**
 * Tauri native vault contract suite.
 *
 * The highest-risk subsystem must prove the same behavioral contract as the
 * reference providers. `TauriVault` is a thin IPC wrapper, so this suite
 * drives it through a fake `invoke` bridge backed by a shared `MemoryVault`
 * instance — the same reference semantics the portable suite defines.
 *
 * This covers: full contract suite (reopen + failure injection), error-code
 * passthrough (including QUOTA_EXCEEDED), ABORTED handling, invalid paths,
 * deleted-file reopen, rename/delete conflicts, interrupted writes, and
 * cancelled-picker behavior at the adapter layer.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createMemoryVaultState,
  MemoryVault,
  VaultError,
  checksumOf,
  workspacePath,
  type WorkspacePath,
  type VaultOperation,
} from '@froglight/foundation';
import { registerVaultContractSuite } from '@froglight/foundation/testing';
import { TauriVault, createNativeVaultAdapter } from './tauri-vault.js';

const VAULT_ID = 'test-native-vault';

type InvokeArgs = Record<string, unknown>;

function makeFakeBackend() {
  const state = createMemoryVaultState();
  let failNextWrite = false;
  const memory = new MemoryVault(state, {
    fail: (operation: VaultOperation, path: WorkspacePath) => {
      if (operation === 'write' && failNextWrite) {
        failNextWrite = false;
        return new VaultError('IO', 'injected native write failure', { path });
      }
      return null;
    },
  });

  const invoke = async <T>(
    command: string,
    payload: InvokeArgs | Uint8Array = {},
    options?: { headers?: HeadersInit },
  ): Promise<T> => {
    const args: InvokeArgs = payload instanceof Uint8Array
      ? JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(new Headers(options?.headers).get('x-froglight-vault-write')!), character => character.charCodeAt(0)))) as InvokeArgs
      : payload;
    const path = args['path'] as WorkspacePath | undefined;
    switch (command) {
      case 'native_vault_stat':
        return (await memory.stat(path!)) as T;
      case 'native_vault_list':
        return (await memory.list(path!)) as T;
      case 'native_vault_create_directory':
        return (await memory.createDirectory(path!)) as T;
      case 'native_vault_read':
        return (await memory.read(path!)).buffer as T;
      case 'native_vault_write': {
        if (!(payload instanceof Uint8Array)) throw new Error('expected binary payload');
        if (typeof args['expectedChecksum'] === 'string' && checksumOf(await memory.read(path!)) !== args['expectedChecksum']) {
          throw new VaultError('CONFLICT', 'External change', { path });
        }
        await memory.write(path!, payload);
        return undefined as T;
      }
      case 'native_vault_remove':
        return (await memory.remove(path!)) as T;
      case 'native_vault_move': {
        const from = args['from'] as WorkspacePath;
        const to = args['to'] as WorkspacePath;
        return (await memory.move(from, to)) as T;
      }
      default:
        throw new Error(`unexpected native command: ${command}`);
    }
  };

  return {
    state,
    memory,
    invoke,
    failNextWrite: () => {
      failNextWrite = true;
    },
    clearFailures: () => {
      failNextWrite = false;
    },
  };
}

describe('TauriVault contract suite (fake native bridge)', () => {
  const backend = makeFakeBackend();
  const provider = new TauriVault(VAULT_ID, backend.invoke);
  registerVaultContractSuite('TauriVault (fake bridge)', {
    provider,
    reopen: () => new TauriVault(VAULT_ID, backend.invoke),
    failureInjection: {
      failNextWrite: backend.failNextWrite,
      clearFailures: backend.clearFailures,
    },
  });
});

describe('TauriVault error mapping regressions', () => {
  it('passes through QUOTA_EXCEEDED instead of collapsing to IO', async () => {
    const vault = new TauriVault(VAULT_ID, async () => {
      throw { code: 'QUOTA_EXCEEDED', message: 'disk full' };
    });
    await expect(
      vault.write(workspacePath('a.txt'), new Uint8Array([1])),
    ).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
  });

  it('maps native ENOSPC/STORAGE_FULL strings to QUOTA_EXCEEDED', async () => {
    for (const code of ['ENOSPC', 'EDQUOT', 'STORAGE_FULL']) {
      const vault = new TauriVault(VAULT_ID, async () => {
        throw { code, message: 'no space' };
      });
      await expect(
        vault.write(workspacePath('a.txt'), new Uint8Array([1])),
      ).rejects.toMatchObject({
        code: 'QUOTA_EXCEEDED',
      });
    }
  });

  it('maps FOLDER_NOT_FOUND to NOT_FOUND and STALE_BOOKMARK to PERMISSION_DENIED', async () => {
    const notFound = new TauriVault(VAULT_ID, async () => {
      throw { code: 'FOLDER_NOT_FOUND', message: 'gone' };
    });
    await expect(notFound.stat(workspacePath('a.txt'))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const stale = new TauriVault(VAULT_ID, async () => {
      throw { code: 'STALE_BOOKMARK', message: 'stale' };
    });
    await expect(stale.read(workspacePath('a.txt'))).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('maps INVALID_ARGUMENT to INVALID_PATH', async () => {
    const vault = new TauriVault(VAULT_ID, async () => {
      throw { code: 'INVALID_ARGUMENT', message: 'bad' };
    });
    await expect(vault.stat(workspacePath('a.txt'))).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
  });

  it('rejects with ABORTED when the signal is already aborted', async () => {
    const backend = makeFakeBackend();
    const vault = new TauriVault(VAULT_ID, backend.invoke);
    const controller = new AbortController();
    controller.abort();
    // #assertActive throws synchronously (not a rejected promise).
    expect(() =>
      vault.stat(workspacePath('a.txt'), { signal: controller.signal }),
    ).toThrow(expect.objectContaining({ code: 'ABORTED' }));
  });

  it('a failed write leaves previous content readable (interrupted-write regression)', async () => {
    const backend = makeFakeBackend();
    const vault = new TauriVault(VAULT_ID, backend.invoke);
    const path = workspacePath('suite/interrupted.txt');
    // Ensure parent exists via the fake backend's memory instance.
    await backend.memory.createDirectory(workspacePath('suite'));
    await vault.write(path, new TextEncoder().encode('before'));
    backend.failNextWrite();
    await expect(
      vault.write(path, new TextEncoder().encode('after')),
    ).rejects.toMatchObject({
      code: 'IO',
    });
    const bytes = await vault.read(path);
    expect(new TextDecoder().decode(bytes)).toBe('before');
  });

  it('reopen after external delete surfaces NOT_FOUND (deleted-file regression)', async () => {
    const backend = makeFakeBackend();
    const vault = new TauriVault(VAULT_ID, backend.invoke);
    const path = workspacePath('suite/gone.txt');
    await backend.memory.createDirectory(workspacePath('suite'));
    await vault.write(path, new Uint8Array([1, 2, 3]));
    await vault.remove(path);
    const reopened = new TauriVault(VAULT_ID, backend.invoke);
    await expect(reopened.stat(path)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(reopened.read(path)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('rename/delete conflicts surface CONFLICT', async () => {
    const backend = makeFakeBackend();
    const vault = new TauriVault(VAULT_ID, backend.invoke);
    await backend.memory.createDirectory(workspacePath('suite'));
    await vault.write(workspacePath('suite/a.txt'), new Uint8Array([1]));
    await vault.write(workspacePath('suite/b.txt'), new Uint8Array([2]));
    await expect(
      vault.move(workspacePath('suite/a.txt'), workspacePath('suite/b.txt')),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await vault.createDirectory(workspacePath('suite/dir'));
    await vault.write(workspacePath('suite/dir/f.txt'), new Uint8Array([3]));
    await expect(
      vault.remove(workspacePath('suite/dir')),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('returns null when the host picker is cancelled (cancelled-picker regression)', async () => {
    vi.resetModules();
    vi.doMock('@tauri-apps/api/core', () => ({
      invoke: vi
        .fn()
        .mockRejectedValue({ code: 'CANCELLED', message: 'user cancelled' }),
    }));
    const fresh = await import('./mobile-vault.js');
    try {
      // pickDirectory CANCELLED must resolve to null, not throw.
      await expect(fresh.mobileVaults.pickDirectory(false)).resolves.toBeNull();
    } finally {
      vi.doUnmock('@tauri-apps/api/core');
      vi.resetModules();
    }
  });

  it('adapter openVault resolves null on picker cancel', async () => {
    const bridge = {
      listRecent: vi.fn().mockResolvedValue([]),
      pickDirectory: vi.fn().mockResolvedValue(null),
      createVault: vi.fn(),
      markOpened: vi.fn(),
      forget: vi.fn(),
    };
    const controller = {
      openVault: vi.fn(),
      listDocuments: vi.fn().mockReturnValue([]),
    };
    const adapter = createNativeVaultAdapter(controller, bridge);
    await expect(adapter.openVault()).resolves.toBeNull();
    expect(controller.openVault).not.toHaveBeenCalled();
  });
});

it('binary conditional publication preserves external bytes on conflict', async () => {
  const backend = makeFakeBackend();
  const vault = new TauriVault(VAULT_ID, backend.invoke);
  const path = workspacePath('drawing.ink');
  const base = new Uint8Array([0, 1, 255]);
  await vault.write(path, base);
  const next = new Uint8Array([255, 254, 0]);
  await vault.writeIfUnchanged(path, next, checksumOf(base));
  expect(await vault.read(path)).toEqual(next);
  await expect(vault.writeIfUnchanged(path, base, checksumOf(base))).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(await vault.read(path)).toEqual(next);
});
