/**
 * Tests for the native filesystem vault provider.
 *
 * The provider runs the full portable contract suite over a real temporary
 * directory (reopen + failure injection), plus the lifecycle proof:
 * a composed workspace over the native vault survives a full runtime
 * restart and a runtime provider swap with sessions closed and canonical
 * content preserved on real disk.
 */

import { describe, expect, it, afterAll } from 'vitest';
import { rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginDefinition } from '@froglight/runtime';
import {
  VaultError,
  workspacePath,
  type WorkspacePath,
  type VaultOperation,
} from '@froglight/foundation';
import {
  composeWorkspace,
  replaceVaultProvider,
  registerVaultContractSuite,
  testNoteKindId,
  testNoteModel,
  requireValue,
  type TestDocModel,
} from '@froglight/foundation/testing';
import { NativeFsVault, nativeFsVaultPlugin } from './index.js';

/** One-shot write failure injector matching the contract suite shape. */
function makeFailureInjector(): {
  failNextWrite: () => void;
  injector: (operation: VaultOperation, path: WorkspacePath) => Error | null;
} {
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

/** A fresh temporary directory per suite block, removed after the run. */
async function makeRoot(label: string): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(join(tmpdir(), `froglight-${label}-`));
}

// Suite vault is created synchronously at module load so the contract
// suite can capture the provider reference during describe registration
// (vitest runs describe callbacks synchronously, before any beforeAll).
const suiteRoot = mkdtempSync(join(tmpdir(), 'froglight-suite-'));
const suiteFailure = makeFailureInjector();
const suiteProvider = await NativeFsVault.create({ root: suiteRoot, fail: suiteFailure.injector });

describe('NativeFsVault contract suite (real temp directory)', () => {
  registerVaultContractSuite('NativeFsVault (sensitive probe)', {
    provider: suiteProvider,
    reopen: () => NativeFsVault.create({ root: suiteRoot }),
    failureInjection: {
      failNextWrite: suiteFailure.failNextWrite,
      clearFailures: () => {
        // The injector is one-shot; nothing to clear.
      },
    },
  });

  it('declares honest POSIX capabilities', () => {
    const caps = suiteProvider.capabilities;
    expect(caps.nameNormalization).toBe('none');
    expect(caps.atomicReplace).toBe(true);
    expect(caps.durableFlush).toBe(true);
    expect(caps.supportsMove).toBe(true);
    expect(caps.supportsReopen).toBe(true);
    expect(['sensitive', 'insensitive', 'unknown']).toContain(caps.caseSensitivity);
  });

  it('rejects symlink escapes and symlink leaves with UNSUPPORTED', async () => {
    const { symlink, writeFile } = await import('node:fs/promises');
    // A symlink INSIDE the root pointing OUTSIDE it must not be traversed.
    await writeFile(join(suiteRoot, 'host-secret.txt'), 'secret');
    await symlink(join(suiteRoot, 'host-secret.txt'), join(suiteRoot, 'link.txt'));
    await expect(suiteProvider.read(workspacePath('link.txt'))).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    // A symlinked DIRECTORY as an intermediate segment must be rejected too.
    await symlink(suiteRoot, join(suiteRoot, 'loop'));
    await expect(suiteProvider.stat(workspacePath('loop/host-secret.txt'))).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    // Listings never expose symlink entries.
    const entries = await suiteProvider.list(workspacePath(''));
    expect(entries.find((e) => e.name === 'link.txt' || e.name === 'loop')).toBeUndefined();
  });

  afterAll(async () => {
    await rm(suiteRoot, { recursive: true, force: true });
  });
});

describe('NativeFsVault capabilities', () => {
  it('declared caseSensitivity is honored', async () => {
    const root = await makeRoot('case');
    try {
      const sensitive = await NativeFsVault.create({ root, caseSensitivity: 'sensitive' });
      await sensitive.write(workspacePath('File.txt'), new TextEncoder().encode('x'));
      await expect(sensitive.stat(workspacePath('file.txt'))).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });

      const insensitive = await NativeFsVault.create({ root, caseSensitivity: 'insensitive' });
      const stat = await insensitive.stat(workspacePath('file.txt'));
      expect(stat.kind).toBe('file');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('create requires a non-empty root', async () => {
    await expect(NativeFsVault.create({ root: '' })).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
  });
});

describe('workspace over the native vault', () => {
  // `PluginDefinition` is contravariant in its config type, so a plugin
  // with required config fields is registered through the erased default.
  const vaultPlugin = nativeFsVaultPlugin as PluginDefinition;

  it('a workspace persists across a full runtime restart over the same directory', async () => {
    const root = await makeRoot('restart');
    try {
      const first = await composeWorkspace({
        vaultPlugin,
        vaultConfig: { root },
        workspaceConfig: { workspaceId: 'ws-native-restart' },
      });
      const ws1 = requireValue(first.getWorkspace(), 'workspace');
      const created = await ws1.createDocument({
        kindId: testNoteKindId,
        path: workspacePath('notes/persist.md'),
        initialModel: testNoteModel('Native', 'persisted on disk'),
      });
      await first.dispose();

      // Restart: a brand-new runtime and provider over the same directory.
      const second = await composeWorkspace({
        vaultPlugin,
        vaultConfig: { root },
        workspaceConfig: { workspaceId: 'ws-native-restart' },
      });
      const ws2 = requireValue(second.getWorkspace(), 'workspace');
      expect(ws2.workspaceId).toBe('ws-native-restart');
      expect(ws2.findByResourcePath(workspacePath('notes/persist.md'))).toEqual(created);
      const session = await ws2.openDocument(created.documentId);
      const model = session.model as TestDocModel;
      expect(model.title).toBe('Native');
      expect(model.text).toBe('persisted on disk');
      await session.save();
      expect(session.state).toBe('open');
      await second.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('provider swap over a real directory disposes consumers and preserves content', async () => {
    const root = await makeRoot('swap');
    try {
      const composed = await composeWorkspace({
        vaultPlugin,
        vaultConfig: { root },
        workspaceConfig: { workspaceId: 'ws-native-swap' },
      });
      const initial = requireValue(composed.getWorkspace(), 'workspace');
      const firstRef = requireValue(initial.listDocuments()[0], 'document ref');
      const session = await initial.openDocument(firstRef.documentId);
      expect(session.state).toBe('open');

      await replaceVaultProvider(composed, vaultPlugin, { root });

      const workspace = requireValue(composed.getWorkspace(), 'workspace');
      expect(workspace.workspaceId).toBe('ws-native-swap');
      // The old session was closed by the swap.
      expect(session.state).toBe('closed');
      // Canonical content survived on real disk and is readable.
      const ref = workspace.findByResourcePath(workspacePath('test-notes/note-1.md'));
      const openRef = requireValue(ref, 'document ref');
      const reopened = await workspace.openDocument(openRef.documentId);
      expect((reopened.model as { title: string }).title).toBe('Note 1');
      await composed.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('sequential swaps over a real directory keep the system consistent', async () => {
    const root = await makeRoot('seqswap');
    try {
      const composed = await composeWorkspace({
        vaultPlugin,
        vaultConfig: { root },
        workspaceConfig: { workspaceId: 'ws-native-seq' },
      });
      for (let i = 0; i < 3; i++) {
        await replaceVaultProvider(composed, vaultPlugin, { root });
        const workspace = requireValue(composed.getWorkspace(), 'workspace');
        expect(workspace.workspaceId).toBe('ws-native-seq');
        expect(workspace.listDocuments()).toHaveLength(1);
      }
      await composed.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
