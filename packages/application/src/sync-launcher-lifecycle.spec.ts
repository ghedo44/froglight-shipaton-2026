/**
 * Real launcher → Download & Open → workspace activation → sync binding
 * lifecycle (lifetime-split + replica-identity hardening).
 *
 * Exercises the actual runtime/provider lifecycle (never a no-op mock):
 *
 * ```text
 * create application runtime (createApp, memory vault bootstrap)
 * install account + host-lifetime sync service + workspace attachment
 * close bootstrap vault / enter launcher
 * assert vaultSyncToken still exists
 * seed a cloud vault
 * staging backing store S ← materialize cloud C into S (verified bytes)
 * assert downloaded files exist in S
 * activate S through the REAL controller/runtime vault replacement path
 *   (provider config carries localVaultId = prepared.localVaultId)
 *   → old attachment disposes, new attachment calls
 *     service.attach({ localVaultId, vault: observable(S) }) automatically
 * finalize prepared transaction (identity unchanged → SUCCESS)
 * assert workspace sees S, sync sees S, ids/binding correct,
 *   downloaded bytes ARE the workspace bytes, and further local writes
 *   sync normally — with NO manual service.attach() repair in the test
 *   (the host shell reports selection afterward, exactly like
 *   production `setActiveVault`).
 * ```
 */

import { describe, expect, it } from 'vitest';
import { createApp, createWorkbenchController } from './index.js';
import { AccountStore, createAccountHost } from '@froglight/foundation/account';
import { definePlugin as defineProbePlugin } from '@froglight/runtime';
import {
  InMemorySearchService,
  MemorySyncRemote,
  ObservableVaultService,
  VaultSyncStore,
  asObservableVault,
  createMemorySyncStorage,
  createMemoryVault,
  createVaultSyncHost,
  memoryVaultPlugin,
  vaultSyncToken,
  workspacePath,
  type VaultSyncService,
  type WorkspaceService,
} from '@froglight/foundation';
import { MockMarkdownEditorProvider } from '@froglight/foundation/testing';

const UID_A = 'uid-launcher-a';

describe('launcher Download & Open lifecycle (real runtime)', () => {
  it('launcher keeps vaultSyncToken; activation composes the exact prepared store', async () => {
    // Account store signed in as A (fake transport with live session).
    let user: { id: string; email: string } | null = {
      id: UID_A,
      email: `${UID_A}@example.com`,
    };
    const listeners = new Set<(next: typeof user) => void>();
    const transport = {
      async currentUser() {
        return user === null ? null : { ...user };
      },
      async createAccount(email: string) {
        user = { id: `uid-${email}`, email };
        for (const l of [...listeners]) l(user === null ? null : { ...user });
        return { ...user! };
      },
      async signIn(email: string) {
        user = { id: `uid-${email}`, email };
        for (const l of [...listeners]) l(user === null ? null : { ...user });
        return { ...user! };
      },
      async signOut() {
        user = null;
        for (const l of [...listeners]) l(null);
      },
      async refreshToken() {
        return {
          token: 'token',
          expiresAt: null,
          entitlements: [] as string[],
        };
      },
      onAuthChange(listener: (next: typeof user) => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const accountStore = new AccountStore({ transport });
    await accountStore.restore().catch(() => undefined);
    // Production composition: the account host and the sync store must
    // share the EXACT AccountStore instance; `createVaultSyncHost`
    // enforces that identity at activation.
    const accountHost = createAccountHost({
      transport,
      service: accountStore,
    });

    const remote = new MemorySyncRemote();
    const syncService = new VaultSyncStore({
      remote,
      account: accountStore,
      storage: createMemorySyncStorage(),
      debounceMs: 3_600_000,
    });
    await syncService.restore();
    const syncHost = createVaultSyncHost({ service: syncService });

    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: new InMemorySearchService(),
      markdownEditorProvider: new MockMarkdownEditorProvider(),
      extraPlugins: [
        accountHost.definition,
        syncHost.definition,
        syncHost.attachment,
      ],
    });
    const controller = createWorkbenchController(app);

    // Bootstrap workspace active; sync token resolvable.
    expect(app.getWorkspace()).not.toBeNull();

    // Seed a cloud vault from a second replica (device seeding under A).
    const { vault: seederVault } = createMemoryVault({});
    const seederObs = new ObservableVaultService(seederVault);
    const seeder = new VaultSyncStore({
      remote,
      account: accountStore,
      storage: createMemorySyncStorage(),
      debounceMs: 3_600_000,
    });
    await seeder.restore();
    seeder.attach({ localVaultId: 'seeder-local', vault: seederObs });
    await seederObs.write(
      workspacePath('cloud-note.md'),
      new TextEncoder().encode('from-cloud'),
    );
    await seeder.enable({ localVaultId: 'seeder-local', name: 'Seeder' });
    await seeder.reconcile();
    const cloudId = seeder.snapshot().binding?.cloudVaultId as string;
    seeder.dispose();

    // Enter launcher: close the bootstrap vault. The host-lifetime sync
    // service must survive (vaultSyncToken still provided).
    await app.closeVault();
    expect(app.getWorkspace()).toBeNull();
    let launcherToken: VaultSyncService | null = null;
    await app.runtime.registerSlot({
      id: 'launcher-sync-probe',
      plugin: defineProbePlugin({
        id: 'test.launcher-sync-probe',
        requirements: { requires: [vaultSyncToken] },
        activate: (ctx) => {
          launcherToken = ctx.require(vaultSyncToken);
        },
      }),
    });
    expect(launcherToken).toBe(syncService);
    await app.runtime.removeSlot('launcher-sync-probe');
    // Launcher discovery works with no vault open.
    const listed = await syncService.listRemoteVaults();
    expect(listed.map((v) => v.cloudVaultId)).toContain(cloudId);
    expect(syncService.isCloudVaultBound(cloudId)).toBe(false);

    // Staging: create the EXACT backing store that will be activated.
    const { vault: staging, state: stagingState } = createMemoryVault({});
    const prepared = await syncService.materializeRemoteVault(
      cloudId,
      'downloaded-local',
      staging,
    );
    // Verified remote bytes exist in the staging store before activation.
    expect(
      new TextDecoder().decode(
        await staging.read(workspacePath('cloud-note.md')),
      ),
    ).toBe('from-cloud');
    expect(syncService.snapshot().binding).toBeNull();

    // Activate through the REAL host/controller/runtime replacement path.
    // The provider config carries the prepared identity, so the workspace
    // attachment wires `(localVaultId, observable(S))` with no manual
    // service.attach() and no setActiveLocalVault() repair.
    await controller.openVault(memoryVaultPlugin, {
      state: stagingState,
      localVaultId: prepared.localVaultId,
    });
    const workspace: WorkspaceService | null = app.getWorkspace();
    expect(workspace).not.toBeNull();

    // Finalize: identity unchanged (A/epoch) → SUCCESS despite the
    // operation/vault generation churn from activation.
    await syncService.finalizeMaterializedVault(prepared);
    expect(syncService.isCloudVaultBound(cloudId)).toBe(true);
    expect(syncService.snapshot().binding).toMatchObject({
      cloudVaultId: cloudId,
      localVaultId: 'downloaded-local',
    });
    // Presentation-state ownership: finalization
    // never writes the host-visible selection. The shell reports the
    // opened vault exactly as production `FroglightApp` calls
    // `ui.setActiveVault` on selection change.
    syncService.setActiveLocalVault('downloaded-local');
    expect(syncService.snapshot().activeLocalVaultId).toBe('downloaded-local');

    // Workspace sees S: the live vault bytes are the downloaded bytes.
    const liveVault = app.getVault();
    expect(liveVault).not.toBeNull();
    const liveObs = asObservableVault(liveVault!);
    expect(liveObs).not.toBeNull();
    expect(
      new TextDecoder().decode(
        await liveVault!.read(workspacePath('cloud-note.md')),
      ),
    ).toBe('from-cloud');
    // The live facade is over the exact same backing state as staging.
    expect(
      new TextDecoder().decode(
        await staging.read(workspacePath('cloud-note.md')),
      ),
    ).toBe(
      new TextDecoder().decode(
        await liveVault!.read(workspacePath('cloud-note.md')),
      ),
    );

    // Sync sees S and automatic reconciliation may begin: a raw write to
    // the shared state (through the non-observable staging handle) is
    // picked up by the attached replica on the next reconcile...
    await staging.write(
      workspacePath('staging-write.md'),
      new TextEncoder().encode('through-staging'),
    );
    await syncService.reconcile();
    expect(syncService.snapshot().lastRevision).toBeGreaterThanOrEqual(1);
    // ...and a write through the live observable facade also syncs.
    await liveObs!.write(
      workspacePath('local-note.md'),
      new TextEncoder().encode('local-first'),
    );
    await syncService.reconcile();
    const partition = remote;
    const head = await partition.readHead(cloudId);
    expect(head).not.toBeNull();
    const manifest = await partition.loadManifest(cloudId, head!.manifestHash);
    const paths = manifest.entries.map((entry) => entry.path).sort();
    expect(paths).toEqual(
      expect.arrayContaining([
        'cloud-note.md',
        'local-note.md',
        'staging-write.md',
      ]),
    );

    await app.dispose();
    syncService.dispose();
  });
});
