/**
 * Tests for the deterministic in-memory vault provider.
 *
 * The provider runs the full portable contract suite (sensitive + insensitive
 * modes, reopen, failure injection) plus focused tests for rollback behavior
 * that the suite cannot observe directly (failed createDirectory/remove/move
 * must leave the tree exactly unchanged).
 */

import { describe, expect, it } from 'vitest';
import type { WorkspacePath } from '../paths.js';
import { joinPath, ROOT_PATH, workspacePath } from '../paths.js';
import { VaultError } from '../errors.js';
import { ensureDirectory } from './helpers.js';
import {
  createMemoryVaultState,
  MemoryVault,
  type VaultFailureInjector,
} from './memory.js';
import type { VaultOperation } from './contract.js';
import { registerVaultContractSuite } from '../testing/contract-suite-vitest.js';

function makeFailureInjector(): { injector: VaultFailureInjector; failNextWrite: () => void } {
  let failNext = false;
  return {
    injector: (operation: VaultOperation, path: WorkspacePath) => {
      if (operation === 'write' && failNext) {
        failNext = false;
        return new VaultError('IO', 'injected write failure', { path });
      }
      return null;
    },
    failNextWrite: () => {
      failNext = true;
    },
  };
}

describe('MemoryVault contract suite (sensitive, reopen, failure injection)', () => {
  const state = createMemoryVaultState();
  const failure = makeFailureInjector();
  const provider = new MemoryVault(state, { fail: failure.injector });
  registerVaultContractSuite('MemoryVault (sensitive)', {
    provider,
    reopen: () => new MemoryVault(state),
    failureInjection: {
      failNextWrite: failure.failNextWrite,
      clearFailures: () => {
        // The injector is one-shot; nothing to clear.
      },
    },
  });
});

describe('MemoryVault contract suite (insensitive)', () => {
  const state = createMemoryVaultState();
  const provider = new MemoryVault(state, { caseSensitivity: 'insensitive' });
  registerVaultContractSuite('MemoryVault (insensitive)', {
    provider,
    reopen: () => new MemoryVault(state, { caseSensitivity: 'insensitive' }),
  });
});

describe('MemoryVault rollback semantics', () => {
  it('a failed createDirectory leaves no entry behind', async () => {
    const state = createMemoryVaultState();
    let failNext = true;
    const vault = new MemoryVault(state, {
      fail: (operation, path) =>
        operation === 'createDirectory' && failNext
          ? ((failNext = false), new VaultError('IO', 'injected', { path }))
          : null,
    });
    await expect(vault.createDirectory(workspacePath('dir'))).rejects.toMatchObject({
      code: 'IO',
    });
    const entries = await vault.list(ROOT_PATH);
    expect(entries).toEqual([]);
  });

  it('a failed remove leaves the file readable', async () => {
    const state = createMemoryVaultState();
    let failNext = true;
    const vault = new MemoryVault(state, {
      fail: (operation, path) =>
        operation === 'remove' && failNext
          ? ((failNext = false), new VaultError('IO', 'injected', { path }))
          : null,
    });
    await vault.write(workspacePath('f.bin'), new TextEncoder().encode('keep me'));
    await expect(vault.remove(workspacePath('f.bin'))).rejects.toMatchObject({ code: 'IO' });
    const bytes = await vault.read(workspacePath('f.bin'));
    expect(new TextDecoder().decode(bytes)).toBe('keep me');
  });

  it('a failed move leaves both sides unchanged', async () => {
    const state = createMemoryVaultState();
    let failNext = true;
    const vault = new MemoryVault(state, {
      fail: (operation, path) =>
        operation === 'move' && failNext
          ? ((failNext = false), new VaultError('IO', 'injected', { path }))
          : null,
    });
    await vault.write(workspacePath('from.bin'), new TextEncoder().encode('x'));
    await expect(
      vault.move(workspacePath('from.bin'), workspacePath('to.bin')),
    ).rejects.toMatchObject({ code: 'IO' });
    // Source still present, target absent.
    await expect(vault.stat(workspacePath('from.bin'))).resolves.toMatchObject({ kind: 'file' });
    await expect(vault.stat(workspacePath('to.bin'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Tree still usable after the failure.
    await vault.move(workspacePath('from.bin'), workspacePath('to.bin'));
    await expect(vault.stat(workspacePath('to.bin'))).resolves.toMatchObject({ kind: 'file' });
  });

  it('writes return copies so callers cannot mutate vault state', async () => {
    const vault = new MemoryVault();
    await vault.write(workspacePath('f.bin'), new Uint8Array([1, 2, 3]));
    const read = await vault.read(workspacePath('f.bin'));
    read[0] = 99;
    const again = await vault.read(workspacePath('f.bin'));
    expect(Array.from(again)).toEqual([1, 2, 3]);
  });

  it('case-insensitive mode preserves the first-written spelling and folds lookups', async () => {
    const vault = new MemoryVault(undefined, { caseSensitivity: 'insensitive' });
    await vault.write(workspacePath('File.txt'), new TextEncoder().encode('x'));
    const entries = await vault.list(ROOT_PATH);
    expect(entries.map((e) => e.name)).toEqual(['File.txt']);
    await expect(vault.stat(workspacePath('file.txt'))).resolves.toMatchObject({ kind: 'file' });
    // Overwriting through a differently-cased spelling updates the entry
    // under its original key.
    await vault.write(workspacePath('FILE.TXT'), new TextEncoder().encode('y'));
    const entriesAfter = await vault.list(ROOT_PATH);
    expect(entriesAfter.map((e) => e.name)).toEqual(['File.txt']);
    expect(Array.from(await vault.read(workspacePath('file.txt')))).toEqual([121]);
  });

  it('reopen over a shared state sees prior data (no process restart needed)', async () => {
    const state = createMemoryVaultState();
    const first = new MemoryVault(state);
    await ensureDirectory(first, workspacePath('notes'));
    await first.write(joinPath(workspacePath('notes'), 'a.txt'), new TextEncoder().encode('hello'));
    const second = new MemoryVault(state);
    const bytes = await second.read(joinPath(workspacePath('notes'), 'a.txt'));
    expect(new TextDecoder().decode(bytes)).toBe('hello');
    const entries = await second.list(workspacePath('notes'));
    expect(entries.map((e) => e.name)).toEqual(['a.txt']);
  });

  it('deterministic listing order is independent of insertion order', async () => {
    const vault = new MemoryVault();
    for (const name of ['b.txt', 'a.txt', 'c.txt', 'A.txt']) {
      await vault.write(workspacePath(name), new TextEncoder().encode('x'));
    }
    const entries = await vault.list(ROOT_PATH);
    expect(entries.map((e) => e.name)).toEqual(['A.txt', 'a.txt', 'b.txt', 'c.txt']);
  });

  it('capabilities declare the reference semantics', () => {
    const vault = new MemoryVault();
    expect(vault.capabilities).toEqual({
      caseSensitivity: 'sensitive',
      nameNormalization: 'none',
      atomicReplace: true,
      durableFlush: false,
      supportsMove: true,
      supportsReopen: true,
    });
  });
});
