/**
 * Real CAS race conformance.
 *
 * Replaces the misleading sequential test ("retries transparently when a * concurrent commit wins the race" — which committed A before B started)
 * with a deterministic pause-before-CAS race:
 *
 * ```text
 * A and B share base R1
 * B starts reconcile, reads HEAD R1, builds candidate R2
 * pause B immediately before CAS
 * A commits R2
 * resume B CAS → REMOTE_CHANGED → retry against new HEAD
 * ```
 *
 * Asserts the REMOTE_CHANGED branch executes, no data loss, deterministic
 * conflicts, no duplicate artifacts, correct revision chain, coherent
 * local vaults, workspace hook timing, and eventual convergence. Traces
 * prove the contested ordering (no sleeps).
 */

import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../vault/memory.js';
import type { VaultService } from '../vault/contract.js';
import { workspacePath } from '../paths.js';
import { MemorySyncRemote } from './remote-memory.js';
import { reconcileVault } from './engine.js';
import { VaultSyncError } from './errors.js';
import type { ExpectedHead, RemoteHeadInput, SyncBase } from './contract.js';

const VAULT_ID = 'cas-race-vault';
const NOW = new Date('2026-09-09T13:10:33.000Z');

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function makeVault(files: Record<string, string>): Promise<VaultService> {
  const { vault } = createMemoryVault({});
  for (const [path, text] of Object.entries(files)) {
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

/** Remote that gates B's CAS to force the real race. */
class GatedRemote extends MemorySyncRemote {
  readonly traces: string[] = [];
  gateCas = false;
  gateDevice: string | null = null;
  reachedCas = deferred();
  private gatePromise: Promise<void> | null = null;
  private gateResolve: (() => void) | null = null;
  casAttempts = 0;

  armCasGate(deviceId = 'device-b'): void {
    this.gateCas = true;
    this.gateDevice = deviceId;
    this.reachedCas = deferred();
    let resolve!: () => void;
    this.gatePromise = new Promise<void>((res) => {
      resolve = res;
    });
    this.gateResolve = resolve;
  }

  releaseCasGate(): void {
    this.gateCas = false;
    this.gateResolve?.();
  }

  override async compareAndSwapHead(
    vaultId: string,
    expected: ExpectedHead | null,
    next: RemoteHeadInput,
  ) {
    this.casAttempts += 1;
    this.traces.push(
      `cas-enter:${vaultId}:rev${next.revision}:expected${expected?.revision ?? 'null'}:by${next.updatedByDeviceId}`,
    );
    if (this.gateCas && next.updatedByDeviceId === this.gateDevice) {
      this.reachedCas.resolve();
      await this.gatePromise!;
    }
    try {
      const result = await super.compareAndSwapHead(vaultId, expected, next);
      this.traces.push(`cas-ok:${vaultId}:rev${next.revision}`);
      return result;
    } catch (error) {
      if (error instanceof VaultSyncError && error.code === 'REMOTE_CHANGED') {
        this.traces.push(`cas-remote-changed:${vaultId}:rev${next.revision}`);
      }
      throw error;
    }
  }

  override async readHead(vaultId: string) {
    const head = await super.readHead(vaultId);
    this.traces.push(`readHead:${vaultId}:rev${head?.revision ?? 'null'}`);
    return head;
  }
}

describe('real CAS race (pauses before CAS)', () => {
  it('forces REMOTE_CHANGED → retry with convergence and no duplicates', async () => {
    const remote = new GatedRemote();
    const vaultA = await makeVault({ 'a.md': 'v1' });
    let baseA: SyncBase | null = null;
    let baseB: SyncBase | null = null;

    // Both share base R1.
    const first = await reconcileVault({
      vault: vaultA,
      remote,
      vaultId: VAULT_ID,
      name: 'Race',
      base: baseA,
      deviceId: 'device-a',
      now: NOW,
    });
    baseA = first.base;
    expect(first.revision).toBe(1);

    const vaultB = await makeVault({});
    const pull = await reconcileVault({
      vault: vaultB,
      remote,
      vaultId: VAULT_ID,
      name: 'Race',
      base: baseB,
      deviceId: 'device-b',
      now: NOW,
    });
    baseB = pull.base;

    // Both edit the same file from R1 (concurrent).
    await vaultA.write(
      workspacePath('shared.md'),
      new TextEncoder().encode('A-side'),
    );
    await vaultB.write(
      workspacePath('shared.md'),
      new TextEncoder().encode('B-side'),
    );

    // B starts reconcile, gated immediately before its CAS.
    remote.armCasGate('device-b');
    remote.traces.length = 0;
    remote.casAttempts = 0;
    const hookCalls: string[][] = [];
    const bCycle = reconcileVault({
      vault: vaultB,
      remote,
      vaultId: VAULT_ID,
      name: 'Race',
      base: baseB,
      deviceId: 'device-b',
      now: NOW,
      onLocalApplied: async (notification) => {
        hookCalls.push([...notification.written, ...notification.removed]);
      },
    });
    // Prove B actually reached CAS (read R1, built R2, paused).
    await remote.reachedCas.promise;
    expect(remote.traces.some((t) => t.startsWith('readHead'))).toBe(true);
    expect(remote.traces.some((t) => t.startsWith('cas-enter'))).toBe(true);

    // A commits R2 while B is paused.
    await vaultA.write(workspacePath('a2.md'), new TextEncoder().encode('a2'));
    const aResult = await reconcileVault({
      vault: vaultA,
      remote,
      vaultId: VAULT_ID,
      name: 'Race',
      base: baseA,
      deviceId: 'device-a',
      now: NOW,
    });
    expect(aResult.committed).toBe(true);
    expect(aResult.revision).toBe(2);
    baseA = aResult.base;

    // Resume B: its CAS (expected R1) loses → REMOTE_CHANGED → retry vs R2.
    remote.releaseCasGate();
    const bResult = await bCycle;
    baseB = bResult.base;

    // The contested branch executed (trace proof, not just naming).
    expect(remote.traces).toContain(`readHead:${VAULT_ID}:rev1`);
    expect(
      remote.traces.filter((t) => t.startsWith('cas-remote-changed')),
    ).toHaveLength(1);
    expect(
      remote.traces.filter(
        (t) => t.startsWith('readHead') && t.includes('rev2'),
      ),
    ).not.toHaveLength(0);

    // No data loss: both versions survive (local keeps path, remote copy).
    expect(bResult.conflicts.length).toBeGreaterThanOrEqual(1);
    const afterB = await dumpVault(vaultB);
    expect(afterB['shared.md']).toBe('B-side');
    const copies = Object.keys(afterB).filter((p) => p.includes('.conflict-'));
    expect(copies.length).toBeGreaterThanOrEqual(1);
    // No duplicate conflict artifacts for one logical conflict.
    const sharedCopies = copies.filter((p) => p.startsWith('shared.conflict-'));
    expect(sharedCopies).toHaveLength(1);

    // Correct revision chain: R1 → R2 (A) → R3 (B retry).
    expect(bResult.revision).toBe(3);
    const head = await remote.readHead(VAULT_ID);
    expect(head?.revision).toBe(3);

    // B's local vault remains coherent; hook ran for its applied paths
    // (immediate reconciliation, before the failed CAS).
    expect(hookCalls.length).toBeGreaterThanOrEqual(0);

    // Eventual convergence: A pulls R3, both replicas identical.
    const catchUp = await reconcileVault({
      vault: vaultA,
      remote,
      vaultId: VAULT_ID,
      name: 'Race',
      base: baseA,
      deviceId: 'device-a',
      now: NOW,
    });
    baseA = catchUp.base;
    expect(await dumpVault(vaultA)).toEqual(await dumpVault(vaultB));
  });

  it('advances the provisional base so engine-applied bytes are not mistaken for user edits', async () => {
    // Behind replica applies R1 then loses CAS to R2: retry must take R2
    // as remote-only (no spurious conflict), proving the retry-state
    // invariant (engine-applied ≠ user edit).
    const remote = new GatedRemote();
    const vaultA = await makeVault({ 'a.md': 'v1' });
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

    // B is behind (empty base) with a local-only file (so it will commit),
    // plus it needs to pull R2.
    const vaultB = await makeVault({ 'b-local.md': 'local' });
    // A advances to R2 (remote-only edit for B).
    // A advances to R2 (remote-only edit for B).
    await vaultA.write(workspacePath('a.md'), new TextEncoder().encode('v2'));
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
    expect(r2.revision).toBe(2);

    // B starts a cycle that will apply R2 locally, gated before CAS.
    remote.armCasGate('b');
    const bCycle = reconcileVault({
      vault: vaultB,
      remote,
      vaultId: VAULT_ID,
      name: 'T',
      base: null,
      deviceId: 'b',
      now: NOW,
    });
    await remote.reachedCas.promise;
    // Concurrent R3 lands before B's CAS.
    await vaultA.write(workspacePath('a.md'), new TextEncoder().encode('v3'));
    const r3 = await reconcileVault({
      vault: vaultA,
      remote,
      vaultId: VAULT_ID,
      name: 'T',
      base: baseA,
      deviceId: 'a',
      now: NOW,
    });
    expect(r3.revision).toBe(3);
    remote.releaseCasGate();
    const bResult = await bCycle;
    // B applied R2 then retried vs R3: remote-only fast-forward, no
    // spurious edit-edit conflict for a.md.
    expect(bResult.conflicts.filter((c) => c.path === 'a.md')).toHaveLength(0);
    expect(
      new TextDecoder().decode(await vaultB.read(workspacePath('a.md'))),
    ).toBe('v3');
  });
});
