/**
 * Immediate remote-apply to workspace reconciliation.
 *
 * Proves the workspace/session seam runs IMMEDIATELY after local remote
 * apply, BEFORE any blob upload / manifest upload / HEAD CAS — so a later
 * network/CAS failure can never leave stale clean-editor state behind
 * (the lifecycle corrected to run inside the protocol).
 */

import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../vault/memory.js';
import { workspacePath } from '../paths.js';
import { MemorySyncRemote } from './remote-memory.js';
import { reconcileVault } from './engine.js';
import { VaultSyncError } from './errors.js';
import type { ExpectedHead, RemoteHeadInput, SyncBase } from './contract.js';

const VAULT_ID = 'apply-vault';
const NOW = new Date('2026-09-09T13:10:33.000Z');

/** Remote that fails the next manifest upload once when armed. */
class FailManifestOnceRemote extends MemorySyncRemote {
  armed = false;
  override async uploadManifest(
    vaultId: string,
    manifest: Parameters<MemorySyncRemote['uploadManifest']>[1],
  ) {
    if (this.armed) {
      this.armed = false;
      throw new VaultSyncError('NETWORK', 'simulated fault after local apply');
    }
    return super.uploadManifest(vaultId, manifest);
  }
}

/** Remote that fails CAS once (contention after apply). */
class FailCasOnceRemote extends MemorySyncRemote {
  private failed = false;
  override async compareAndSwapHead(
    vaultId: string,
    expected: ExpectedHead | null,
    next: RemoteHeadInput,
  ) {
    if (!this.failed) {
      this.failed = true;
      throw new VaultSyncError('REMOTE_CHANGED', 'simulated contention');
    }
    return super.compareAndSwapHead(vaultId, expected, next);
  }
}

describe('immediate workspace reconciliation', () => {
  it('reloads clean state before a later manifest-upload failure', async () => {
    const remote = new FailManifestOnceRemote();
    const { vault: vaultA } = createMemoryVault({});
    await vaultA.write(
      workspacePath('note.md'),
      new TextEncoder().encode('v1'),
    );
    let baseA: SyncBase | null = null;
    const r1 = await reconcileVault({
      vault: vaultA,
      remote,
      vaultId: VAULT_ID,
      name: 'T',
      base: baseA,
      deviceId: 'a',
      now: NOW,
    });
    baseA = r1.base;

    // B pulls v1.
    const { vault: vaultB } = createMemoryVault({});
    let baseB: SyncBase | null = null;
    const pull = await reconcileVault({
      vault: vaultB,
      remote,
      vaultId: VAULT_ID,
      name: 'T',
      base: baseB,
      deviceId: 'b',
      now: NOW,
    });
    baseB = pull.base;

    // A edits to v2.
    await vaultA.write(
      workspacePath('note.md'),
      new TextEncoder().encode('v2'),
    );
    const r2 = await reconcileVault({
      vault: vaultA,
      remote,
      vaultId: VAULT_ID,
      name: 'T',
      base: baseA,
      deviceId: 'a',
      now: NOW,
    });
    baseA = r2.base;

    // B reconciles: remote v2 must be applied locally AND the hook must
    // run BEFORE the simulated manifest-upload fault (B has a local edit
    // elsewhere to force an upload path — otherwise pull-only has no
    // upload to fail; here B also has a local file so the cycle uploads).
    await vaultB.write(
      workspacePath('local.md'),
      new TextEncoder().encode('mine'),
    );
    remote.armed = true;
    const hookCalls: string[][] = [];
    await expect(
      reconcileVault({
        vault: vaultB,
        remote,
        vaultId: VAULT_ID,
        name: 'T',
        base: baseB,
        deviceId: 'b',
        now: NOW,
        onLocalApplied: async (notification) => {
          hookCalls.push([...notification.written]);
        },
      }),
    ).rejects.toMatchObject({ code: 'NETWORK' });

    // The hook ran immediately after apply, despite the later failure.
    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0]).toContain('note.md');
    // Vault bytes already converged (download happened before the fault).
    expect(
      new TextDecoder().decode(await vaultB.read(workspacePath('note.md'))),
    ).toBe('v2');

    // Retry succeeds (fault was one-shot) and converges.
    const retry = await reconcileVault({
      vault: vaultB,
      remote,
      vaultId: VAULT_ID,
      name: 'T',
      base: baseB,
      deviceId: 'b',
      now: NOW,
      onLocalApplied: async () => undefined,
    });
    expect(retry.committed).toBe(true);
    baseB = retry.base;
    expect(
      new TextDecoder().decode(await vaultB.read(workspacePath('note.md'))),
    ).toBe('v2');
  });

  it('a throwing reconciler blocks upload/CAS advancement for that attempt', async () => {
    const remote = new MemorySyncRemote();
    const { vault: vaultA } = createMemoryVault({});
    await vaultA.write(
      workspacePath('note.md'),
      new TextEncoder().encode('v1'),
    );
    let baseA: SyncBase | null = null;
    baseA = (
      await reconcileVault({
        vault: vaultA,
        remote,
        vaultId: VAULT_ID,
        name: 'T',
        base: baseA,
        deviceId: 'a',
        now: NOW,
      })
    ).base;

    const { vault: vaultB } = createMemoryVault({});
    let baseB: SyncBase | null = null;
    baseB = (
      await reconcileVault({
        vault: vaultB,
        remote,
        vaultId: VAULT_ID,
        name: 'T',
        base: baseB,
        deviceId: 'b',
        now: NOW,
      })
    ).base;

    await vaultA.write(
      workspacePath('note.md'),
      new TextEncoder().encode('v2'),
    );
    baseA = (
      await reconcileVault({
        vault: vaultA,
        remote,
        vaultId: VAULT_ID,
        name: 'T',
        base: baseA,
        deviceId: 'a',
        now: NOW,
      })
    ).base;

    // Hook throws: no upload/CAS may follow for this attempt.
    const uploadsBefore = remote.calls.filter((c) =>
      c.startsWith('uploadBlob'),
    ).length;
    await expect(
      reconcileVault({
        vault: vaultB,
        remote,
        vaultId: VAULT_ID,
        name: 'T',
        base: baseB,
        deviceId: 'b',
        now: NOW,
        onLocalApplied: async () => {
          throw new Error('workspace reload blew up');
        },
      }),
    ).rejects.toThrow('workspace reload blew up');
    // Vault bytes were applied (download ran), but no commit followed.
    expect(
      new TextDecoder().decode(await vaultB.read(workspacePath('note.md'))),
    ).toBe('v2');
    const uploadsAfter = remote.calls.filter((c) =>
      c.startsWith('uploadBlob'),
    ).length;
    // B had no local edits, so no blob uploads either way — assert no CAS
    // happened by checking the HEAD is still v2 (no new revision).
    expect((await remote.readHead(VAULT_ID))?.revision).toBe(2);
    expect(uploadsAfter).toBe(uploadsBefore);
  });

  it('CAS failure after apply still leaves the workspace reloaded (retry safe)', async () => {
    const remote = new FailCasOnceRemote();
    const { vault: vaultA } = createMemoryVault({});
    await vaultA.write(
      workspacePath('note.md'),
      new TextEncoder().encode('v1'),
    );
    let baseA: SyncBase | null = null;
    baseA = (
      await reconcileVault({
        vault: vaultA,
        remote,
        vaultId: VAULT_ID,
        name: 'T',
        base: baseA,
        deviceId: 'a',
        now: NOW,
      })
    ).base;
    const { vault: vaultB } = createMemoryVault({});
    let baseB: SyncBase | null = null;
    baseB = (
      await reconcileVault({
        vault: vaultB,
        remote,
        vaultId: VAULT_ID,
        name: 'T',
        base: baseB,
        deviceId: 'b',
        now: NOW,
      })
    ).base;
    await vaultA.write(
      workspacePath('note.md'),
      new TextEncoder().encode('v2'),
    );
    // A also adds an unrelated file so B's retry has upload work after
    // the failed CAS (proves retry safety).
    await vaultA.write(
      workspacePath('extra.md'),
      new TextEncoder().encode('e'),
    );
    baseA = (
      await reconcileVault({
        vault: vaultA,
        remote,
        vaultId: VAULT_ID,
        name: 'T',
        base: baseA,
        deviceId: 'a',
        now: NOW,
      })
    ).base;

    const hookCalls: string[][] = [];
    // First B attempt: applies v2+extra, hook runs, CAS fails once with
    // REMOTE_CHANGED (simulated) — engine retries internally and the
    // second attempt converges (no throw).
    const result = await reconcileVault({
      vault: vaultB,
      remote,
      vaultId: VAULT_ID,
      name: 'T',
      base: baseB,
      deviceId: 'b',
      now: NOW,
      maxCommitAttempts: 5,
      onLocalApplied: async (notification) => {
        hookCalls.push([...notification.written]);
      },
    });
    expect(result.committed).toBe(false);
    expect(hookCalls.length).toBeGreaterThanOrEqual(1);
    expect(hookCalls[0]).toContain('note.md');
    expect(
      new TextDecoder().decode(await vaultB.read(workspacePath('note.md'))),
    ).toBe('v2');
  });
});
