import { describe, expect, it } from 'vitest';
import {
  AccountStore,
  type AccountTransport,
  type AccountUser,
} from '../account/index.js';
import { workspacePath } from '../paths.js';
import { createMemoryVault } from '../vault/memory.js';
import { ensureDirectory } from '../vault/helpers.js';
import type {
  StoredSyncState,
  VaultSyncConflictSummary,
  VaultSyncStorage,
} from './contract.js';
import { MemorySyncRemote } from './remote-memory.js';
import { VaultSyncStore, createMemorySyncStorage } from './service.js';
import { ObservableVaultService } from './mutations.js';

const UID = 'uid-conflict-owner';
const LOCAL_VAULT_ID = 'local-conflict-vault';
const CLOUD_VAULT_ID = 'cloud-conflict-vault';
const CONFLICT_PATH =
  '.froglight/properties/member.conflict-aaaaaa-bbbbbb-cccccc.json';
const CONFLICT_BYTES = new TextEncoder().encode(
  '{"format":"froglight.properties","version":1,"owner":"member","values":{"status":"doing"},"relations":[]}',
);

function accountFor(uid: string): AccountStore {
  let user: AccountUser | null = { id: uid, email: `${uid}@example.com` };
  const listeners = new Set<(next: AccountUser | null) => void>();
  const transport: AccountTransport = {
    currentUser: async () => user,
    createAccount: async () => {
      throw new Error('unused');
    },
    signIn: async () => {
      throw new Error('unused');
    },
    signOut: async () => {
      user = null;
      for (const listener of listeners) listener(null);
    },
    refreshToken: async () => ({
      token: 'token',
      expiresAt: null,
      entitlements: [],
    }),
    onAuthChange: (listener) => {
      listeners.add(listener);
      listener(user);
      return () => listeners.delete(listener);
    },
  };
  return new AccountStore({ transport });
}

function summary(recoveredAt: string | null = null): VaultSyncConflictSummary {
  return {
    id: CONFLICT_PATH,
    path: '.froglight/properties/member.json',
    kind: 'edit-edit',
    conflictPath: CONFLICT_PATH,
    kept: 'local',
    detectedAt: '2026-09-23T10:00:00.000Z',
    recoveredAt,
  };
}

function storedState(): StoredSyncState {
  return {
    version: 1,
    deviceId: 'device-conflict',
    accounts: {
      [UID]: {
        activeLocalVaultId: LOCAL_VAULT_ID,
        bindings: {
          [LOCAL_VAULT_ID]: {
            cloudVaultId: CLOUD_VAULT_ID,
            localVaultId: LOCAL_VAULT_ID,
            name: 'Conflict vault',
            deviceId: 'device-conflict',
            base: null,
            lastSyncedAt: null,
            lastRevision: null,
            enabled: false,
            conflicts: [summary()],
          },
        },
      },
    },
  };
}

async function createHarness(storage: VaultSyncStorage) {
  const { vault } = createMemoryVault();
  await ensureDirectory(vault, workspacePath('.froglight/properties'));
  await vault.write(workspacePath(CONFLICT_PATH), CONFLICT_BYTES);
  const observable = new ObservableVaultService(vault);
  const account = accountFor(UID);
  const service = new VaultSyncStore({
    account,
    remote: new MemorySyncRemote(),
    storage,
    debounceMs: 100_000,
  });
  await service.restore();
  service.attach({ localVaultId: LOCAL_VAULT_ID, vault: observable });
  return { service, vault, observable, account };
}

describe('durable sync conflict recovery', () => {
  it('captures a real same-field sidecar conflict and keeps it through clean sync and reopen', async () => {
    const remote = new MemorySyncRemote();
    const storageA = createMemorySyncStorage();
    const storageB = createMemorySyncStorage();
    const { vault: vaultA } = createMemoryVault();
    const { vault: vaultB } = createMemoryVault();
    const observableA = new ObservableVaultService(vaultA);
    const observableB = new ObservableVaultService(vaultB);
    const serviceA = new VaultSyncStore({
      account: accountFor(UID),
      remote,
      storage: storageA,
      debounceMs: 100_000,
    });
    const serviceB = new VaultSyncStore({
      account: accountFor(UID),
      remote,
      storage: storageB,
      debounceMs: 100_000,
    });
    await serviceA.restore();
    await serviceB.restore();
    serviceA.attach({ localVaultId: 'local-a', vault: observableA });
    serviceB.attach({ localVaultId: 'local-b', vault: observableB });
    await ensureDirectory(vaultA, workspacePath('.froglight/properties'));
    const propertyPath = workspacePath(
      '.froglight/properties/real-member.json',
    );
    const propertyBytes = (status: string) =>
      new TextEncoder().encode(
        JSON.stringify({
          format: 'froglight.properties',
          version: 1,
          owner: 'real-member',
          values: { status },
          relations: [],
        }),
      );
    await observableA.write(propertyPath, propertyBytes('todo'));
    await serviceA.enable({ localVaultId: 'local-a', name: 'Shared' });
    await serviceA.reconcile();
    const cloudVaultId = serviceA.snapshot().binding?.cloudVaultId;
    if (cloudVaultId === undefined) throw new Error('expected cloud binding');
    await serviceB.attachRemoteVault(cloudVaultId, 'local-b');
    await serviceB.reconcile();

    await observableA.write(propertyPath, propertyBytes('doing'));
    await observableB.write(propertyPath, propertyBytes('done'));
    await serviceA.reconcile();
    await serviceB.reconcile();
    const conflict = serviceB.snapshot().conflicts[0];
    expect(conflict).toMatchObject({
      path: '.froglight/properties/real-member.json',
      kind: 'edit-edit',
      recoveredAt: null,
    });
    expect(conflict?.conflictPath).toContain(
      '.froglight/properties/real-member.conflict-',
    );

    await serviceB.reconcile();
    expect(serviceB.snapshot().conflicts).toEqual([conflict]);
    serviceB.dispose();

    const reopened = new VaultSyncStore({
      account: accountFor(UID),
      remote,
      storage: storageB,
      debounceMs: 100_000,
    });
    await reopened.restore();
    reopened.attach({
      localVaultId: 'local-b',
      vault: new ObservableVaultService(vaultB),
    });
    expect(reopened.snapshot().conflicts).toEqual([conflict]);
    reopened.dispose();
    serviceA.dispose();
  });

  it('offers exact hidden-copy bytes, survives reopen, and acknowledges without deleting', async () => {
    const storage = createMemorySyncStorage(storedState());
    const first = await createHarness(storage);

    expect(first.service.snapshot().conflicts).toEqual([summary()]);
    const recovery = await first.service.prepareConflictRecovery(CONFLICT_PATH);
    expect(recovery.fileName).toBe('member.conflict-aaaaaa-bbbbbb-cccccc.json');
    expect(recovery.bytes).toEqual(CONFLICT_BYTES);
    expect(
      (await storage.load())?.accounts[UID]?.bindings[LOCAL_VAULT_ID]
        ?.conflicts?.[0]?.recoveredAt,
    ).not.toBeNull();
    first.service.dispose();

    const second = await createHarness(storage);
    expect(second.service.snapshot().conflicts).toHaveLength(1);
    expect(second.service.snapshot().conflicts[0]?.recoveredAt).not.toBeNull();
    await second.service.acknowledgeConflict(CONFLICT_PATH);
    expect(second.service.snapshot().conflicts).toEqual([]);
    expect(await second.vault.read(workspacePath(CONFLICT_PATH))).toEqual(
      CONFLICT_BYTES,
    );
    second.service.dispose();
  });

  it('refuses acknowledgement before hidden-copy recovery', async () => {
    const harness = await createHarness(createMemorySyncStorage(storedState()));
    await expect(
      harness.service.acknowledgeConflict(CONFLICT_PATH),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(harness.service.snapshot().conflicts).toHaveLength(1);
    harness.service.dispose();
  });

  it('does not expose one account conflict after sign-out', async () => {
    const harness = await createHarness(createMemorySyncStorage(storedState()));
    expect(harness.service.snapshot().conflicts).toHaveLength(1);
    await harness.account.signOut();
    expect(harness.service.snapshot().conflicts).toEqual([]);
    await expect(
      harness.service.prepareConflictRecovery(CONFLICT_PATH),
    ).rejects.toMatchObject({ code: 'NOT_AUTHENTICATED' });
    harness.service.dispose();
  });

  it('retains unresolved summaries through a later clean reconcile', async () => {
    const storage = createMemorySyncStorage(storedState());
    const harness = await createHarness(storage);
    await harness.service.enable({
      localVaultId: LOCAL_VAULT_ID,
      name: 'Conflict vault',
    });
    await harness.service.reconcile();
    expect(harness.service.snapshot().conflicts).toEqual([summary()]);
    expect(
      (await storage.load())?.accounts[UID]?.bindings[LOCAL_VAULT_ID]
        ?.conflicts,
    ).toEqual([summary()]);
    harness.service.dispose();
  });
});
