// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteVaultInfo } from '@froglight/foundation';
import { CloudVaultsView } from './CloudVaultsView.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const REMOTES: readonly RemoteVaultInfo[] = [
  {
    cloudVaultId: 'cloud-a',
    name: 'Research',
    revision: 4,
    updatedAt: '2026-09-09T12:00:00.000Z',
  },
  {
    cloudVaultId: 'cloud-b',
    name: 'Course notes',
    revision: 2,
    updatedAt: null,
  },
];

function fakeAccount(user: { id: string; email: string | null } | null) {
  return {
    snapshot: () => ({ ready: true, loading: false, user, error: null }),
    subscribe: () => () => undefined,
    restore: async () => undefined,
    createAccount: async () => ({ id: 'uid-1', email: null }),
    signIn: async () => ({ id: 'uid-1', email: null }),
    signOut: async () => undefined,
    refreshToken: async () => ({
      token: null,
      expiresAt: null,
      entitlements: [],
    }),
  };
}

function fakeSync(
  options: {
    readonly remotes?: readonly RemoteVaultInfo[];
    readonly boundCloudId?: string | null;
    readonly boundCloudIds?: readonly string[];
    readonly corruptCloudIds?: readonly string[];
    readonly failList?: boolean;
    readonly failFinalize?: unknown;
    readonly materialize?: (
      cloudVaultId: string,
      localId: string,
      vault: unknown,
    ) => Promise<unknown>;
  } = {},
) {
  const calls: string[] = [];
  const remotes = options.remotes ?? REMOTES;
  return {
    calls,
    service: {
      snapshot: () => ({
        enabled: true,
        phase: 'idle',
        bindings: [
          ...(options.boundCloudIds ?? []),
          ...(options.boundCloudId === undefined ||
          options.boundCloudId === null
            ? []
            : [options.boundCloudId]),
        ].map((cloudVaultId) => ({
          cloudVaultId,
          localVaultId: 'local-1',
          name: 'Research',
          ...(options.corruptCloudIds?.includes(cloudVaultId)
            ? { baseCorrupt: true }
            : {}),
        })),
        binding:
          options.boundCloudId === undefined || options.boundCloudId === null
            ? null
            : {
                cloudVaultId: options.boundCloudId,
                localVaultId: 'local-1',
                name: 'Research',
              },
        activeLocalVaultId: 'local-1',
        pendingChanges: 0,
        lastSyncedAt: null,
        lastRevision: null,
        deferredPaths: [],
        conflicts: [],
        error: null,
      }),
      subscribe: () => () => undefined,
      restore: async () => undefined,
      listRemoteVaults: async () => {
        calls.push('listRemoteVaults');
        if (options.failList === true) throw new Error('network down');
        return remotes;
      },
      enable: async () => undefined,
      disable: async () => undefined,
      reconcile: async () => undefined,
      attachRemoteVault: async (cloudVaultId: string) => {
        calls.push(`attachRemoteVault:${cloudVaultId}`);
      },
      ...(options.materialize === undefined
        ? {}
        : {
            materializeRemoteVault: async (
              cloudVaultId: string,
              localId: string,
              vault: unknown,
            ) => {
              calls.push(`materializeRemoteVault:${cloudVaultId}:${localId}`);
              const base = await options.materialize?.(
                cloudVaultId,
                localId,
                vault,
              );
              // Transactional flow returns an identity-bound prepared
              // handle; tests that do not provide one get a minimal stub.
              if (
                base !== null &&
                typeof base === 'object' &&
                (base as Record<string, unknown>).kind ===
                  'prepared-remote-vault'
              ) {
                return base;
              }
              return {
                kind: 'prepared-remote-vault',
                cloudVaultId,
                localVaultId: localId,
                name: 'Research',
                base: (base as {
                  manifest?: unknown;
                  hash?: string;
                }) ?? {
                  manifest: { vaultId: cloudVaultId },
                  hash: 'sha256:stub',
                },
                owner: { uid: 'uid-1', identityGeneration: 0 },
              };
            },
            finalizeMaterializedVault: async (prepared: unknown) => {
              const record = prepared as {
                cloudVaultId: string;
                localVaultId: string;
              };
              calls.push(
                `finalizeMaterializedVault:${record.cloudVaultId}:${record.localVaultId}`,
              );
              if (options.failFinalize !== undefined) {
                throw options.failFinalize instanceof Error
                  ? options.failFinalize
                  : new Error('finalize failed');
              }
            },
          }),
      ensureProEntitlement: async () => true,
      setActiveLocalVault: (localId: string | null) => {
        calls.push(`setActiveLocalVault:${localId}`);
      },
      suspend: () => undefined,
    },
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(node: React.ReactElement): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
});

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  });
}

describe('CloudVaultsView', () => {
  it('renders nothing while signed out', () => {
    const account = fakeAccount(null);
    const sync = fakeSync();
    const mounted = mount(
      createElement(CloudVaultsView, {
        vaults: {} as never,
        onOpen: () => undefined,
        resolveAccount: () => account as never,
        resolveSync: () => sync.service as never,
      }),
    );
    expect(mounted.textContent).toBe('');
    expect(sync.calls).not.toContain('listRemoteVaults');
  });

  it('lists cloud vaults with Download & Open actions', async () => {
    const account = fakeAccount({ id: 'uid-1', email: 'a@b.c' });
    const sync = fakeSync({ boundCloudId: null });
    const mounted = mount(
      createElement(CloudVaultsView, {
        vaults: {} as never,
        onOpen: () => undefined,
        resolveAccount: () => account as never,
        resolveSync: () => sync.service as never,
      }),
    );
    await settle();
    expect(mounted.textContent).toContain('Research');
    expect(mounted.textContent).toContain('Course notes');
    expect(
      mounted.querySelector('[data-testid="cloud-vault-download-cloud-a"]'),
    ).not.toBeNull();
  });

  it('omits cloud copies represented by local rows, including disabled replicas', async () => {
    const account = fakeAccount({ id: 'uid-1', email: 'a@b.c' });
    const sync = fakeSync({ boundCloudId: 'cloud-a' });
    const mounted = mount(
      createElement(CloudVaultsView, {
        vaults: {} as never,
        onOpen: () => undefined,
        resolveAccount: () => account as never,
        resolveSync: () => sync.service as never,
        excludeCloudIds: ['cloud-a'],
      }),
    );
    await settle();
    expect(
      mounted.querySelector('[data-testid="cloud-vault-row-cloud-a"]'),
    ).toBeNull();
    expect(
      mounted.querySelector('[data-testid="cloud-vault-download-cloud-b"]'),
    ).not.toBeNull();
  });

  it('marks the vault already bound on this device', async () => {
    const account = fakeAccount({ id: 'uid-1', email: 'a@b.c' });
    const sync = fakeSync({ boundCloudId: 'cloud-a' });
    const mounted = mount(
      createElement(CloudVaultsView, {
        vaults: {} as never,
        onOpen: () => undefined,
        resolveAccount: () => account as never,
        resolveSync: () => sync.service as never,
      }),
    );
    await settle();
    expect(
      mounted.querySelector('[data-testid="cloud-vault-bound-cloud-a"]'),
    ).not.toBeNull();
    expect(
      mounted.querySelector('[data-testid="cloud-vault-download-cloud-a"]'),
    ).toBeNull();
    // The other vault still offers a download.
    expect(
      mounted.querySelector('[data-testid="cloud-vault-download-cloud-b"]'),
    ).not.toBeNull();
  });

  it('offers re-download when a bound vault’s sync history is corrupt', async () => {
    const account = fakeAccount({ id: 'uid-1', email: 'a@b.c' });
    const sync = fakeSync({
      boundCloudIds: ['cloud-a'],
      corruptCloudIds: ['cloud-a'],
    });
    const mounted = mount(
      createElement(CloudVaultsView, {
        vaults: {} as never,
        onOpen: () => undefined,
        resolveAccount: () => account as never,
        resolveSync: () => sync.service as never,
      }),
    );
    await settle();
    // Not reported as healthy-bound: the verified re-materialization path
    // (Download & Open) is offered again to repair the corrupt binding.
    expect(
      mounted.querySelector('[data-testid="cloud-vault-bound-cloud-a"]'),
    ).toBeNull();
    expect(
      mounted.querySelector('[data-testid="cloud-vault-corrupt-cloud-a"]'),
    ).not.toBeNull();
    expect(
      mounted.querySelector('[data-testid="cloud-vault-download-cloud-a"]'),
    ).not.toBeNull();
  });

  it('downloads through the host adapter then binds the cloud id', async () => {
    const account = fakeAccount({ id: 'uid-1', email: 'a@b.c' });
    const sync = fakeSync({ boundCloudId: null });
    const created = {
      id: 'local-new',
      name: 'Research',
      activate: vi.fn(async () => undefined),
    };
    const vaults = {
      chooseCreateLocation: vi.fn(async () => ({
        create: vi.fn(async () => created),
      })),
    };
    const onOpen = vi.fn();
    const mounted = mount(
      createElement(CloudVaultsView, {
        vaults: vaults as never,
        onOpen,
        resolveAccount: () => account as never,
        resolveSync: () => sync.service as never,
      }),
    );
    await settle();
    const button = mounted.querySelector(
      '[data-testid="cloud-vault-download-cloud-a"]',
    ) as HTMLButtonElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 12; i += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    });
    // A normal local vault first, then the cloud binding — editors never
    // touch Storage objects directly.
    expect(created.activate).toHaveBeenCalledTimes(1);
    expect(sync.calls).toContain('attachRemoteVault:cloud-a');
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('recognizes vaults bound under another local vault (multi-binding)', async () => {
    const account = fakeAccount({ id: 'uid-1', email: 'a@b.c' });
    // cloud-a is bound, but NOT as the active binding (multi-vault: the
    // snapshot binding is for another vault).
    const sync = fakeSync({
      boundCloudId: 'cloud-other',
      boundCloudIds: ['cloud-a'],
    });
    const mounted = mount(
      createElement(CloudVaultsView, {
        vaults: {} as never,
        onOpen: () => undefined,
        resolveAccount: () => account as never,
        resolveSync: () => sync.service as never,
      }),
    );
    await settle();
    expect(
      mounted.querySelector('[data-testid="cloud-vault-bound-cloud-a"]'),
    ).not.toBeNull();
    expect(
      mounted.querySelector('[data-testid="cloud-vault-download-cloud-a"]'),
    ).toBeNull();
  });

  it('materializes through the empty store before opening (Download & Open)', async () => {
    const account = fakeAccount({ id: 'uid-1', email: 'a@b.c' });
    const order: string[] = [];
    const sync = fakeSync({
      boundCloudId: null,
      materialize: async (cloudVaultId, localId) => {
        // Bytes land in the store BEFORE the operation resolves: the
        // launcher opens a complete replica, never an empty shell.
        order.push(`bytes:${cloudVaultId}:${localId}`);
        return { manifest: { vaultId: cloudVaultId }, hash: 'sha256:stub' };
      },
    });
    const opened: string[] = [];
    const discarded: string[] = [];
    const vaults = {
      createEmptyVaultStore: vi.fn(async (name: string) => ({
        id: 'local-new',
        vault: { name },
        activate: vi.fn(async () => {
          // Activation must observe bytes already materialized.
          expect(order).toEqual(['bytes:cloud-a:local-new']);
          const choice = {
            id: 'local-new',
            name,
            activate: async () => undefined,
          };
          opened.push(choice.id);
          return choice;
        }),
        discard: vi.fn(async () => {
          discarded.push('discard');
        }),
      })),
      chooseCreateLocation: vi.fn(),
    };
    const onOpen = vi.fn();
    const mounted = mount(
      createElement(CloudVaultsView, {
        vaults: vaults as never,
        onOpen,
        resolveAccount: () => account as never,
        resolveSync: () => sync.service as never,
      }),
    );
    await settle();
    const button = mounted.querySelector(
      '[data-testid="cloud-vault-download-cloud-a"]',
    ) as HTMLButtonElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 12; i += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    });
    expect(sync.calls).toContain('materializeRemoteVault:cloud-a:local-new');
    expect(sync.calls).toContain('finalizeMaterializedVault:cloud-a:local-new');
    expect(sync.calls).not.toContain('attachRemoteVault:cloud-a');
    expect(vaults.chooseCreateLocation).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(opened).toEqual(['local-new']);
    expect(discarded).toEqual([]);
    expect(
      mounted.querySelector('[data-testid="cloud-vaults-notice"]'),
    ).toBeNull();
  });

  it('reports materialize failures without opening a broken replica', async () => {
    const account = fakeAccount({ id: 'uid-1', email: 'a@b.c' });
    const sync = fakeSync({
      boundCloudId: null,
      materialize: async () => {
        throw new Error('network down');
      },
    });
    const onOpen = vi.fn();
    const discarded: string[] = [];
    const vaults = {
      createEmptyVaultStore: vi.fn(async () => ({
        id: 'local-new',
        vault: {},
        activate: vi.fn(async () => {
          throw new Error('must never activate a broken replica');
        }),
        discard: vi.fn(async () => {
          discarded.push('discard');
        }),
      })),
    };
    const mounted = mount(
      createElement(CloudVaultsView, {
        vaults: vaults as never,
        onOpen,
        resolveAccount: () => account as never,
        resolveSync: () => sync.service as never,
      }),
    );
    await settle();
    const button = mounted.querySelector(
      '[data-testid="cloud-vault-download-cloud-a"]',
    ) as HTMLButtonElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 12; i += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    });
    expect(onOpen).not.toHaveBeenCalled();
    expect(discarded).toEqual(['discard']);
    expect(sync.calls).not.toContain(
      'finalizeMaterializedVault:cloud-a:local-new',
    );
    expect(
      mounted.querySelector('[data-testid="cloud-vaults-notice"]'),
    ).not.toBeNull();
  });

  it('discards staging without activating when preparation fails', async () => {
    const account = fakeAccount({ id: 'uid-1', email: 'a@b.c' });
    const sync = fakeSync({
      boundCloudId: null,
      materialize: async () => {
        throw new Error('network down');
      },
    });
    const activate = vi.fn(async () => {
      throw new Error('must never activate a broken replica');
    });
    const discard = vi.fn(async () => undefined);
    const finalizeSpy = vi.fn();
    const vaults = {
      createEmptyVaultStore: vi.fn(async () => ({
        id: 'local-new',
        vault: {},
        activate,
        discard,
      })),
    };
    const onOpen = vi.fn();
    const mounted = mount(
      createElement(CloudVaultsView, {
        vaults: vaults as never,
        onOpen,
        resolveAccount: () => account as never,
        resolveSync: () => sync.service as never,
      }),
    );
    await settle();
    const button = mounted.querySelector(
      '[data-testid="cloud-vault-download-cloud-a"]',
    ) as HTMLButtonElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 12; i += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    });
    // Prepare failure: discard called, activate/finalize never run.
    expect(discard).toHaveBeenCalledTimes(1);
    expect(activate).not.toHaveBeenCalled();
    expect(finalizeSpy).not.toHaveBeenCalled();
    expect(sync.calls).not.toContain(
      'finalizeMaterializedVault:cloud-a:local-new',
    );
    expect(onOpen).not.toHaveBeenCalled();
    expect(
      mounted.querySelector('[data-testid="cloud-vaults-notice"]'),
    ).not.toBeNull();
  });

  it('discards staging without finalizing when activation is cancelled', async () => {
    const account = fakeAccount({ id: 'uid-1', email: 'a@b.c' });
    const sync = fakeSync({
      boundCloudId: null,
      materialize: async (cloudVaultId) => ({
        manifest: { vaultId: cloudVaultId },
        hash: 'sha256:stub',
      }),
    });
    const discard = vi.fn(async () => undefined);
    const vaults = {
      createEmptyVaultStore: vi.fn(async () => ({
        id: 'local-new',
        vault: {},
        // Activation cancelled (null): unbound temporary, bind nothing.
        activate: vi.fn(async () => null),
        discard,
      })),
    };
    const onOpen = vi.fn();
    const mounted = mount(
      createElement(CloudVaultsView, {
        vaults: vaults as never,
        onOpen,
        resolveAccount: () => account as never,
        resolveSync: () => sync.service as never,
      }),
    );
    await settle();
    const button = mounted.querySelector(
      '[data-testid="cloud-vault-download-cloud-a"]',
    ) as HTMLButtonElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 12; i += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    });
    expect(discard).toHaveBeenCalledTimes(1);
    expect(sync.calls).not.toContain(
      'finalizeMaterializedVault:cloud-a:local-new',
    );
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('discards staging without finalizing when activation throws', async () => {
    const account = fakeAccount({ id: 'uid-1', email: 'a@b.c' });
    const sync = fakeSync({
      boundCloudId: null,
      materialize: async (cloudVaultId) => ({
        manifest: { vaultId: cloudVaultId },
        hash: 'sha256:stub',
      }),
    });
    const discard = vi.fn(async () => undefined);
    const vaults = {
      createEmptyVaultStore: vi.fn(async () => ({
        id: 'local-new',
        vault: {},
        activate: vi.fn(async () => {
          throw new Error('permission denied');
        }),
        discard,
      })),
    };
    const onOpen = vi.fn();
    const mounted = mount(
      createElement(CloudVaultsView, {
        vaults: vaults as never,
        onOpen,
        resolveAccount: () => account as never,
        resolveSync: () => sync.service as never,
      }),
    );
    await settle();
    const button = mounted.querySelector(
      '[data-testid="cloud-vault-download-cloud-a"]',
    ) as HTMLButtonElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 12; i += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    });
    expect(discard).toHaveBeenCalledTimes(1);
    expect(sync.calls).not.toContain(
      'finalizeMaterializedVault:cloud-a:local-new',
    );
    expect(onOpen).not.toHaveBeenCalled();
    expect(
      mounted.querySelector('[data-testid="cloud-vaults-notice"]'),
    ).not.toBeNull();
  });

  it('never destructively discards after activation when finalization fails', async () => {
    const account = fakeAccount({ id: 'uid-1', email: 'a@b.c' });
    const sync = fakeSync({
      boundCloudId: null,
      materialize: async (cloudVaultId) => ({
        manifest: { vaultId: cloudVaultId },
        hash: 'sha256:stub',
      }),
      failFinalize: new Error('disk full'),
    });
    const discard = vi.fn(async () => undefined);
    const createdChoice = {
      id: 'local-new',
      name: 'Research',
      activate: async () => undefined,
    };
    const vaults = {
      createEmptyVaultStore: vi.fn(async () => ({
        id: 'local-new',
        vault: {},
        activate: vi.fn(async () => createdChoice),
        discard,
      })),
    };
    const onOpen = vi.fn();
    const mounted = mount(
      createElement(CloudVaultsView, {
        vaults: vaults as never,
        onOpen,
        resolveAccount: () => account as never,
        resolveSync: () => sync.service as never,
      }),
    );
    await settle();
    const button = mounted.querySelector(
      '[data-testid="cloud-vault-download-cloud-a"]',
    ) as HTMLButtonElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 12; i += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    });
    // Finalize was attempted (and failed) AFTER activation succeeded.
    expect(sync.calls).toContain('finalizeMaterializedVault:cloud-a:local-new');
    // The opened vault is NOT destructively discarded: discard is never
    // invoked once ownership transferred, yet the vault stays available
    // and the metadata error surfaces.
    expect(discard).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(createdChoice);
    const notice = mounted.querySelector('[data-testid="cloud-vaults-notice"]');
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toContain('opened locally');
  });

  it('runs prepare → activate → finalize → onOpen in exactly that order', async () => {
    const account = fakeAccount({ id: 'uid-1', email: 'a@b.c' });
    const order: string[] = [];
    const sync = fakeSync({
      boundCloudId: null,
      materialize: async (cloudVaultId, localId) => {
        order.push(`prepare:${cloudVaultId}:${localId}`);
        return { manifest: { vaultId: cloudVaultId }, hash: 'sha256:stub' };
      },
    });
    const service = sync.service as unknown as {
      finalizeMaterializedVault: (prepared: unknown) => Promise<void>;
    };
    const origFinalize = service.finalizeMaterializedVault.bind(service);
    service.finalizeMaterializedVault = async (prepared: unknown) => {
      const record = prepared as {
        cloudVaultId: string;
        localVaultId: string;
      };
      order.push(`finalize:${record.cloudVaultId}:${record.localVaultId}`);
      return origFinalize(prepared);
    };
    const onOpen = vi.fn(() => {
      order.push('onOpen');
    });
    const vaults = {
      createEmptyVaultStore: vi.fn(async () => ({
        id: 'local-new',
        vault: {},
        activate: vi.fn(async () => {
          order.push('activate:local-new');
          return {
            id: 'local-new',
            name: 'x',
            activate: async () => undefined,
          };
        }),
        discard: vi.fn(async () => undefined),
      })),
    };
    const mounted = mount(
      createElement(CloudVaultsView, {
        vaults: vaults as never,
        onOpen,
        resolveAccount: () => account as never,
        resolveSync: () => sync.service as never,
      }),
    );
    await settle();
    const button = mounted.querySelector(
      '[data-testid="cloud-vault-download-cloud-a"]',
    ) as HTMLButtonElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 12; i += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    });
    expect(order).toEqual([
      'prepare:cloud-a:local-new',
      'activate:local-new',
      'finalize:cloud-a:local-new',
      'onOpen',
    ]);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('reports list failures with a retry', async () => {
    const account = fakeAccount({ id: 'uid-1', email: 'a@b.c' });
    const sync = fakeSync({ failList: true });
    const mounted = mount(
      createElement(CloudVaultsView, {
        vaults: {} as never,
        onOpen: () => undefined,
        resolveAccount: () => account as never,
        resolveSync: () => sync.service as never,
      }),
    );
    await settle();
    expect(
      mounted.querySelector('[data-testid="cloud-vaults-error"]'),
    ).not.toBeNull();
  });
});
