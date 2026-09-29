/**
 * Host/runtime lifecycle for the sync plugin split.
 *
 * ```text
 * startup with bootstrap vault → token available, attachment active
 * closeVault() → token STILL available, attachment null, cloud discovery works
 * open vault → same service instance, new vault attaches, auto-sync resumes
 * replace vault → same service, old detached, new attached
 * close again → service survives, attachment disappears
 * ```
 *
 * The service object must not be recreated on workspace transitions.
 * Uses real runtime slot replacement (most shared layer, inherited by
 * both native and web host compositions).
 */

import { describe, expect, it } from 'vitest';
import { Runtime, definePlugin } from '@froglight/runtime';
import {
  AccountStore,
  type AccountTransport,
  type AccountUser,
} from '../account/index.js';
import { createAccountHost } from '../account/plugin.js';
import { vaultSyncToken, vaultToken } from '../tokens.js';
import { memoryVaultPlugin } from '../plugins/memory-vault.js';
import { MemorySyncRemote } from '../index.js';
import { VaultSyncStore, createMemorySyncStorage } from './service.js';
import type { VaultSyncAttachInput } from './contract.js';
import { asObservableVault, withObservableVault } from './mutations.js';

const UID = 'uid-lifecycle';

function createFakeAccount(): {
  store: AccountStore;
  transport: AccountTransport;
  signInAs(uid: string): void;
} {
  let user: AccountUser | null = null;
  const listeners = new Set<(next: AccountUser | null) => void>();
  const transport: AccountTransport = {
    async currentUser() {
      return user === null ? null : { ...user };
    },
    async createAccount(email: string) {
      const created: AccountUser = { id: `uid-${email}`, email };
      user = created;
      for (const l of [...listeners]) l({ ...created });
      return { ...created };
    },
    async signIn(email: string) {
      const signedIn: AccountUser = { id: `uid-${email}`, email };
      user = signedIn;
      for (const l of [...listeners]) l({ ...signedIn });
      return { ...signedIn };
    },
    async signOut() {
      user = null;
      for (const l of [...listeners]) l(null);
    },
    async refreshToken() {
      return { token: 'token', expiresAt: null, entitlements: [] };
    },
    onAuthChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    store: new AccountStore({ transport }),
    transport,
    signInAs: (uid) => {
      user = { id: uid, email: `${uid}@example.com` };
      for (const l of [...listeners]) l(user === null ? null : { ...user });
    },
  };
}

function tokenProbe(
  onChange: (count: number) => void,
): ReturnType<typeof definePlugin> {
  let count = 0;
  return definePlugin({
    id: `test.sync-probe.${Math.random().toString(36).slice(2)}`,
    requirements: { requires: [vaultSyncToken] },
    activate: (ctx) => {
      ctx.require(vaultSyncToken);
      count += 1;
      onChange(count);
      ctx.effect(() => () => {
        count -= 1;
        onChange(count);
      });
    },
  });
}

describe('sync plugin split lifecycle', () => {
  it('startup → close → open → replace → close keeps the same service', async () => {
    const runtime = new Runtime();
    const account = createFakeAccount();
    account.signInAs(UID);
    const accountHost = createAccountHost({
      transport: account.transport,
      service: account.store,
    });
    const service = new VaultSyncStore({
      remote: new MemorySyncRemote(),
      account: account.store,
      storage: createMemorySyncStorage(),
    });
    const { createVaultSyncHost } = await import('./plugin.js');
    const syncHost = createVaultSyncHost({ service });

    // Startup with bootstrap vault.
    await runtime.registerSlot({
      id: 'vault',
      plugin: withObservableVault(memoryVaultPlugin),
      config: {},
    });
    await runtime.registerSlot({
      id: 'account',
      plugin: accountHost.definition,
    });
    await runtime.registerSlot({
      id: 'vault-sync',
      plugin: syncHost.definition,
    });
    await runtime.registerSlot({
      id: 'vault-sync-attachment',
      plugin: syncHost.attachment,
    });
    let tokenCount = -1;
    await runtime.registerSlot({
      id: 'probe',
      plugin: tokenProbe((count) => {
        tokenCount = count;
      }),
    });
    expect(tokenCount).toBe(1);

    const slotState = (id: string): string | undefined =>
      runtime.inspect().slots.find((s) => s.id === id)?.state;

    expect(slotState('vault-sync')).toBe('active');
    expect(slotState('vault-sync-attachment')).toBe('active');

    // closeVault(): token STILL available, attachment gone, discovery works.
    await runtime.removeSlot('vault-sync-attachment');
    await runtime.removeSlot('vault');
    expect(tokenCount).toBe(1);
    expect(slotState('vault-sync')).toBe('active');
    expect(slotState('vault-sync-attachment')).toBeUndefined();
    await expect(service.listRemoteVaults()).resolves.toEqual([]);

    // Open vault: same service, new attachment, auto-sync wiring resumes.
    await runtime.registerSlot({
      id: 'vault',
      plugin: withObservableVault(memoryVaultPlugin),
      config: {},
    });
    await runtime.registerSlot({
      id: 'vault-sync-attachment',
      plugin: syncHost.attachment,
    });
    expect(tokenCount).toBe(1);
    expect(slotState('vault-sync-attachment')).toBe('active');

    // Replace vault: same service, old detached, new attached.
    await runtime.removeSlot('vault-sync-attachment');
    await runtime.removeSlot('vault');
    // Token survives the gap between remove and re-add.
    expect(tokenCount).toBe(1);
    await runtime.registerSlot({
      id: 'vault',
      plugin: withObservableVault(memoryVaultPlugin),
      config: {},
    });
    await runtime.registerSlot({
      id: 'vault-sync-attachment',
      plugin: syncHost.attachment,
    });
    expect(tokenCount).toBe(1);

    // Close again: service survives, attachment disappears.
    await runtime.removeSlot('vault-sync-attachment');
    await runtime.removeSlot('vault');
    expect(tokenCount).toBe(1);
    expect(slotState('vault-sync')).toBe('active');

    await runtime.dispose();
    service.dispose();
  });

  it('attaches each replica identity together with its own provider vault', async () => {
    class RecordingStore extends VaultSyncStore {
      readonly attaches: Array<{
        localVaultId: string;
        vault: unknown;
      }> = [];
      detaches = 0;
      override attach(input: VaultSyncAttachInput): void {
        super.attach(input);
        this.attaches.push({
          localVaultId: input.localVaultId,
          vault: input.vault,
        });
      }
      override detach(): void {
        this.detaches += 1;
        super.detach();
      }
    }
    const runtime = new Runtime();
    const account = createFakeAccount();
    account.signInAs(UID);
    const accountHost = createAccountHost({
      transport: account.transport,
      service: account.store,
    });
    const service = new RecordingStore({
      remote: new MemorySyncRemote(),
      account: account.store,
      storage: createMemorySyncStorage(),
    });
    const { createVaultSyncHost } = await import('./plugin.js');
    const syncHost = createVaultSyncHost({ service });

    const captureVault = async (): Promise<unknown> => {
      let captured: unknown = null;
      await runtime.registerSlot({
        id: `vault-probe-${Math.random().toString(36).slice(2)}`,
        plugin: definePlugin({
          id: `test.vault-probe.${Math.random().toString(36).slice(2)}`,
          requirements: { requires: [vaultToken] },
          activate: (ctx) => {
            captured = asObservableVault(ctx.require(vaultToken));
          },
        }),
      });
      return captured;
    };

    await runtime.registerSlot({
      id: 'vault',
      plugin: withObservableVault(memoryVaultPlugin),
      config: { localVaultId: 'local-a' },
    });
    await runtime.registerSlot({
      id: 'account',
      plugin: accountHost.definition,
    });
    await runtime.registerSlot({
      id: 'vault-sync',
      plugin: syncHost.definition,
    });
    await runtime.registerSlot({
      id: 'vault-sync-attachment',
      plugin: syncHost.attachment,
    });
    const vaultA = await captureVault();
    // Atomic pair: the identity and the physical vault came from the same
    // provider activation.
    expect(service.attaches).toHaveLength(1);
    expect(service.attaches[0]?.localVaultId).toBe('local-a');
    expect(service.attaches[0]?.vault).toBe(vaultA);

    // Replace with vault B: the old attachment detaches and the new one
    // activates with B's identity and B's vault — never A's identity.
    await runtime.removeSlot('vault-sync-attachment');
    await runtime.removeSlot('vault');
    expect(service.detaches).toBeGreaterThanOrEqual(1);
    await runtime.registerSlot({
      id: 'vault',
      plugin: withObservableVault(memoryVaultPlugin),
      config: { localVaultId: 'local-b' },
    });
    await runtime.registerSlot({
      id: 'vault-sync-attachment',
      plugin: syncHost.attachment,
    });
    const vaultB = await captureVault();
    expect(service.attaches).toHaveLength(2);
    expect(service.attaches[1]?.localVaultId).toBe('local-b');
    expect(service.attaches[1]?.vault).toBe(vaultB);
    expect(vaultB).not.toBe(vaultA);

    // Remove the workspace: detach; the host-lifetime service survives
    // and keeps providing vaultSyncToken.
    await runtime.removeSlot('vault-sync-attachment');
    await runtime.removeSlot('vault');
    expect(service.detaches).toBeGreaterThanOrEqual(2);
    let tokenCount = 0;
    await runtime.registerSlot({
      id: 'survivor-probe',
      plugin: definePlugin({
        id: 'test.sync-survivor-probe',
        requirements: { requires: [vaultSyncToken] },
        activate: (ctx) => {
          if (ctx.require(vaultSyncToken) === service) tokenCount += 1;
        },
      }),
    });
    expect(tokenCount).toBe(1);
    await runtime.dispose();
    service.dispose();
  });

  it('attachment requires an observable vault (fails loudly otherwise)', async () => {
    const runtime = new Runtime();
    const account = createFakeAccount();
    account.signInAs(UID);
    const accountHost = createAccountHost({
      transport: account.transport,
      service: account.store,
    });
    const service = new VaultSyncStore({
      remote: new MemorySyncRemote(),
      account: account.store,
      storage: createMemorySyncStorage(),
    });
    const { createVaultSyncHost } = await import('./plugin.js');
    const syncHost = createVaultSyncHost({ service });
    // Deliberately skip withObservableVault: attachment must fail loudly
    // (activation failure recorded on the slot), not silently wrap a
    // disconnected facade.
    await runtime.registerSlot({
      id: 'vault',
      plugin: memoryVaultPlugin,
      config: {},
    });
    await runtime.registerSlot({
      id: 'account',
      plugin: accountHost.definition,
    });
    await runtime.registerSlot({
      id: 'vault-sync',
      plugin: syncHost.definition,
    });
    const attachmentSlot = await runtime.registerSlot({
      id: 'vault-sync-attachment',
      plugin: syncHost.attachment,
    });
    expect(attachmentSlot.failure?.message ?? '').toMatch(/observable vault/);
    await runtime.dispose();
    service.dispose();
  });
});
