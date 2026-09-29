// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  VaultSyncSettingsView,
  vaultSyncErrorCopy,
} from './VaultSyncSettingsView.jsx';
import {
  AccountError,
  type AccountSnapshot,
} from '@froglight/foundation/account';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const PRO_CUSTOMER = {
  appUserId: 'uid-1',
  activeEntitlementIds: ['pro'],
  entitlements: {},
};

const FREE_CUSTOMER = {
  appUserId: 'uid-1',
  activeEntitlementIds: [],
  entitlements: {},
};

function fakeAccount(
  user: { id: string; email: string | null } | null,
  entitlements: readonly string[] = [],
) {
  const listeners = new Set<(snapshot: never) => void>();
  return {
    snapshot: (): AccountSnapshot => ({
      ready: true,
      loading: false,
      user,
      error: null,
    }),
    subscribe: (listener: (snapshot: never) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    restore: async () => undefined,
    createAccount: async () => ({ id: 'uid-1', email: null }),
    signIn: async () => ({ id: 'uid-1', email: null }),
    signOut: async () => undefined,
    refreshToken: async () => ({
      token: null,
      expiresAt: null,
      entitlements: [...entitlements],
    }),
  };
}

function fakePurchases(customer: typeof PRO_CUSTOMER | null) {
  const listeners = new Set<(snapshot: never) => void>();
  return {
    snapshot: () => ({ ready: true, loading: false, customer, error: null }),
    subscribe: (listener: (snapshot: never) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh: async () => undefined,
    offerings: async () => [],
    purchase: async () => ({ status: 'cancelled', customer }) as never,
    restore: async () => ({ status: 'cancelled', customer }) as never,
    handleNativeEvent: () => undefined,
  };
}

interface SyncSnapshotOverrides {
  readonly enabled?: boolean;
  readonly phase?: string;
  readonly binding?: {
    cloudVaultId: string;
    localVaultId: string;
    name: string;
    baseCorrupt?: boolean;
  } | null;
  readonly activeLocalVaultId?: string | null;
  readonly pendingChanges?: number;
  readonly lastSyncedAt?: string | null;
  readonly lastRevision?: number | null;
  readonly deferredPaths?: readonly string[];
  readonly conflicts?: readonly {
    id: string;
    path: string;
    kind: 'edit-edit';
    conflictPath: string | null;
    kept: 'local' | 'remote';
    detectedAt: string;
    recoveredAt: string | null;
  }[];
  readonly error?: { code: string; message: string } | null;
}

function fakeSync(overrides: SyncSnapshotOverrides = {}) {
  const calls: string[] = [];
  const snapshot = () => ({
    enabled: overrides.enabled ?? true,
    phase: overrides.phase ?? 'idle',
    binding:
      overrides.binding !== undefined
        ? overrides.binding
        : {
            cloudVaultId: 'cloud-1',
            localVaultId: 'local-1',
            name: 'University',
          },
    activeLocalVaultId: overrides.activeLocalVaultId ?? 'local-1',
    pendingChanges: overrides.pendingChanges ?? 0,
    lastSyncedAt: overrides.lastSyncedAt ?? '2026-09-09T00:00:00.000Z',
    lastRevision: overrides.lastRevision ?? 3,
    deferredPaths: overrides.deferredPaths ?? [],
    conflicts: overrides.conflicts ?? [],
    error: overrides.error ?? null,
  });
  const listeners = new Set<(snapshot: never) => void>();
  return {
    calls,
    service: {
      snapshot,
      subscribe: (listener: (snapshot: never) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      restore: async () => undefined,
      listRemoteVaults: async () => [],
      enable: async () => {
        calls.push('enable');
      },
      disable: async () => {
        calls.push('disable');
      },
      reconcile: async () => {
        calls.push('reconcile');
      },
      prepareConflictRecovery: async (id: string) => {
        calls.push(`prepareConflictRecovery:${id}`);
        return {
          conflictId: id,
          fileName: 'member.conflict.json',
          bytes: new TextEncoder().encode('{"status":"doing"}'),
        };
      },
      acknowledgeConflict: async (id: string) => {
        calls.push(`acknowledgeConflict:${id}`);
      },
      repairCorruptBinding: async () => {
        calls.push('repairCorruptBinding');
      },
      attachRemoteVault: async () => undefined,
      ensureProEntitlement: async () => {
        calls.push('ensureProEntitlement');
        return true;
      },
      setActiveLocalVault: () => undefined,
      suspend: () => undefined,
    },
  };
}

function baseProps(overrides: {
  account?: ReturnType<typeof fakeAccount>;
  purchases?: ReturnType<typeof fakePurchases>;
  sync?: ReturnType<typeof fakeSync>;
  identityCalls?: string[];
  current?: { id: string; name: string } | null;
}) {
  // Stable instances across renders (like the runtime probes): resolvers
  // are called on every render, so creating fakes inside them would
  // resubscribe the snapshot hooks in a loop.
  const account =
    overrides.account ?? fakeAccount({ id: 'uid-1', email: 'a@b.c' });
  const purchases = overrides.purchases ?? fakePurchases(PRO_CUSTOMER);
  const sync = overrides.sync ?? fakeSync();
  const identityCalls = overrides.identityCalls ?? [];
  const current =
    overrides.current !== undefined
      ? overrides.current
      : { id: 'local-1', name: 'University' };
  return {
    resolveAccount: () => account as never,
    resolvePurchases: () => purchases as never,
    resolveSync: () => sync.service as never,
    resolveIdentity: () =>
      ({
        ensureAccountIdentity: async () => {
          identityCalls.push('ensureAccountIdentity');
        },
        signOut: async () => undefined,
        snapshot: () => ({ identifiedUid: null, pending: false, error: null }),
        subscribe: () => () => undefined,
      }) as never,
    resolveCurrentVault: () => current,
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
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  });
}

describe('VaultSyncSettingsView', () => {
  it('renders the unavailable state without a service', async () => {
    const mounted = mount(
      createElement(VaultSyncSettingsView, {
        ...baseProps({}),
        resolveSync: () => null,
      }),
    );
    await settle();
    expect(mounted.textContent).toContain('isn’t available on this host');
  });

  it('asks signed-out users to sign in, never showing sync controls', async () => {
    const mounted = mount(
      createElement(
        VaultSyncSettingsView,
        baseProps({ account: fakeAccount(null) }),
      ),
    );
    await settle();
    expect(mounted.textContent).toContain('Sign in');
    expect(mounted.querySelector('[data-testid="sync-enable"]')).toBeNull();
  });

  it('shows the paywall path for signed-in Free users', async () => {
    const mounted = mount(
      createElement(
        VaultSyncSettingsView,
        baseProps({ purchases: fakePurchases(FREE_CUSTOMER) }),
      ),
    );
    await settle();
    expect(mounted.textContent).toContain('needs Froglight Pro');
  });

  it('unlocks sync from the server claim with no native purchase provider (iPhone purchase → web)', async () => {
    const mounted = mount(
      createElement(
        VaultSyncSettingsView,
        baseProps({
          account: fakeAccount({ id: 'uid-1', email: 'f@g.com' }, ['pro']),
          purchases: fakePurchases(null),
        }),
      ),
    );
    await settle();
    expect(mounted.textContent).not.toContain('needs Froglight Pro');
    expect(
      mounted.querySelector('[data-testid="sync-state"]'),
    ).not.toBeNull();
  });

  it('still gates sync when neither client nor server is Pro', async () => {
    const mounted = mount(
      createElement(
        VaultSyncSettingsView,
        baseProps({
          account: fakeAccount({ id: 'uid-1', email: 'f@g.com' }, []),
          purchases: fakePurchases(null),
        }),
      ),
    );
    await settle();
    expect(mounted.textContent).toContain('needs Froglight Pro');
  });

  it('reports Up to date separately from local save', async () => {
    const mounted = mount(createElement(VaultSyncSettingsView, baseProps({})));
    await settle();
    expect(
      (mounted.querySelector('[data-testid="sync-phase"]') as HTMLElement)
        .textContent,
    ).toBe('Up to date');
    // local save is never conflated with cloud sync.
    expect(mounted.textContent).toContain('Saved locally, always');
  });

  it('renders Activating for the entitlement propagation delay', async () => {
    const sync = fakeSync({
      phase: 'waiting-for-entitlement',
      error: { code: 'ENTITLEMENT_PENDING', message: 'activating' },
    });
    const mounted = mount(
      createElement(VaultSyncSettingsView, baseProps({ sync })),
    );
    await settle();
    expect(
      (mounted.querySelector('[data-testid="sync-phase"]') as HTMLElement)
        .textContent,
    ).toBe('Activating cloud sync…');
    expect(mounted.textContent).toContain('activating on the server');
  });

  it('renders Offline distinctly from save failure', async () => {
    const sync = fakeSync({
      phase: 'error',
      error: { code: 'NETWORK', message: 'offline' },
    });
    const mounted = mount(
      createElement(VaultSyncSettingsView, baseProps({ sync })),
    );
    await settle();
    expect(
      (mounted.querySelector('[data-testid="sync-phase"]') as HTMLElement)
        .textContent,
    ).toBe('Offline — changes saved locally');
  });

  it('enabling binds identity first, then enables and waits for the claim', async () => {
    const sync = fakeSync({
      binding: null,
      enabled: false,
      lastSyncedAt: null,
      lastRevision: null,
    });
    const identityCalls: string[] = [];
    const mounted = mount(
      createElement(
        VaultSyncSettingsView,
        baseProps({
          sync,
          identityCalls,
          current: { id: 'local-9', name: 'New' },
        }),
      ),
    );
    await settle();
    const button = mounted.querySelector(
      '[data-testid="sync-enable"]',
    ) as HTMLButtonElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 8; i += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    });
    expect(identityCalls).toEqual(['ensureAccountIdentity']);
    expect(sync.calls).toEqual(['enable', 'ensureProEntitlement']);
  });

  it('disabling never claims to delete the cloud copy', async () => {
    const mounted = mount(createElement(VaultSyncSettingsView, baseProps({})));
    await settle();
    expect(mounted.textContent).toContain('the cloud copy is kept');
    const disable = mounted.querySelector(
      '[data-testid="sync-disable"]',
    ) as HTMLButtonElement;
    await act(async () => {
      disable.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 8; i += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    });
  });

  it('offers an explicit repair action for a corrupt sync base', async () => {
    const sync = fakeSync({
      phase: 'error',
      binding: {
        cloudVaultId: 'cloud-1',
        localVaultId: 'local-1',
        name: 'University',
        baseCorrupt: true,
      },
      error: { code: 'CORRUPT_SYNC_METADATA', message: 'corrupt' },
    });
    const mounted = mount(
      createElement(VaultSyncSettingsView, baseProps({ sync })),
    );
    await settle();
    // The generic Sync now action is replaced by the explicit repair path.
    expect(mounted.querySelector('[data-testid="sync-now"]')).toBeNull();
    const repair = mounted.querySelector(
      '[data-testid="sync-repair"]',
    ) as HTMLButtonElement;
    expect(repair).not.toBeNull();
    expect(mounted.textContent).toContain('repair it from the verified cloud');
    await act(async () => {
      repair.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 8; i += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    });
    expect(sync.calls).toContain('repairCorruptBinding');
  });

  it('requires hidden conflict recovery before deliberate acknowledgement', async () => {
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:conflict-recovery'),
      revokeObjectURL: vi.fn(),
    });
    const sync = fakeSync({
      conflicts: [
        {
          id: '.froglight/properties/member.conflict-a-b-c.json',
          path: '.froglight/properties/member.json',
          kind: 'edit-edit',
          conflictPath: '.froglight/properties/member.conflict-a-b-c.json',
          kept: 'local',
          detectedAt: '2026-09-23T10:00:00.000Z',
          recoveredAt: null,
        },
      ],
    });
    const mounted = mount(
      createElement(VaultSyncSettingsView, baseProps({ sync })),
    );
    await settle();
    const acknowledge = mounted.querySelector(
      '[data-testid^="sync-conflict-ack-"]',
    ) as HTMLButtonElement;
    expect(acknowledge.disabled).toBe(true);
    const prepare = mounted.querySelector(
      '[data-testid^="sync-conflict-recover-"]',
    ) as HTMLButtonElement;
    await act(async () => {
      prepare.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 8; i += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    });
    expect(sync.calls).toContain(
      'prepareConflictRecovery:.froglight/properties/member.conflict-a-b-c.json',
    );
    expect(
      mounted.querySelector('a[download="member.conflict.json"]'),
    ).not.toBeNull();
    expect(acknowledge.disabled).toBe(false);
    await act(async () => {
      acknowledge.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 8; i += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    });
    expect(sync.calls).toContain(
      'acknowledgeConflict:.froglight/properties/member.conflict-a-b-c.json',
    );
  });

  it('names sync failures without leaking provider wording', () => {
    expect(vaultSyncErrorCopy('ENTITLEMENT_PENDING')).toContain(
      'nothing to fix',
    );
    expect(vaultSyncErrorCopy('NETWORK')).toContain('saved locally');
    expect(vaultSyncErrorCopy('PRO_REQUIRED')).toContain('Pro is required');
    expect(vaultSyncErrorCopy('FUTURE_CODE')).toContain('local files are safe');
    expect(vaultSyncErrorCopy('CORRUPT_SYNC_METADATA')).toContain(
      'cloud sync is paused',
    );
    expect(vaultSyncErrorCopy('CORRUPT_SYNC_METADATA')).not.toContain(
      'Firebase',
    );
    expect(vaultSyncErrorCopy('REMATERIALIZE_REQUIRED')).toContain(
      'download the cloud vault again',
    );
    expect(vaultSyncErrorCopy('PERMISSION_DENIED')).not.toContain('Firebase');
  });

  it('renders a disabled binding as Off and re-enables the same relationship', async () => {
    const sync = fakeSync({
      enabled: false,
      binding: {
        cloudVaultId: 'cloud-1',
        localVaultId: 'local-1',
        name: 'University',
      },
    });
    const identityCalls: string[] = [];
    const mounted = mount(
      createElement(VaultSyncSettingsView, baseProps({ sync, identityCalls })),
    );
    await settle();
    // A remembered but disabled binding is Off — not "On / Up to date".
    expect(
      (mounted.querySelector('[data-testid="sync-state"]') as HTMLElement)
        .textContent,
    ).toBe('Off');
    expect(
      (mounted.querySelector('[data-testid="sync-phase"]') as HTMLElement)
        .textContent,
    ).toBe('Off');
    expect(mounted.querySelector('[data-testid="sync-enable"]')).not.toBeNull();
    expect(mounted.querySelector('[data-testid="sync-now"]')).toBeNull();
    expect(mounted.querySelector('[data-testid="sync-disable"]')).toBeNull();
    // Disabling never claims to delete the cloud copy.
    expect(mounted.textContent).toContain('the cloud copy is kept');

    const button = mounted.querySelector(
      '[data-testid="sync-enable"]',
    ) as HTMLButtonElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 8; i += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    });
    expect(identityCalls).toEqual(['ensureAccountIdentity']);
    // Re-enabling uses the existing service.enable binding path; it never
    // creates a new cloud vault or calls attachRemoteVault().
    expect(sync.calls).toEqual(['enable', 'ensureProEntitlement']);
  });

  it('keeps a disabled corrupt binding Off without offering repair', async () => {
    const sync = fakeSync({
      enabled: false,
      phase: 'error',
      binding: {
        cloudVaultId: 'cloud-1',
        localVaultId: 'local-1',
        name: 'University',
        baseCorrupt: true,
      },
      error: { code: 'CORRUPT_SYNC_METADATA', message: 'corrupt' },
    });
    const mounted = mount(
      createElement(VaultSyncSettingsView, baseProps({ sync })),
    );
    await settle();
    // Disabling is authoritative: the repair workflow stays dormant until
    // sync is explicitly re-enabled.
    expect(
      (mounted.querySelector('[data-testid="sync-phase"]') as HTMLElement)
        .textContent,
    ).toBe('Off');
    expect(mounted.querySelector('[data-testid="sync-repair"]')).toBeNull();
    expect(mounted.querySelector('[data-testid="sync-now"]')).toBeNull();
    expect(mounted.querySelector('[data-testid="sync-enable"]')).not.toBeNull();
  });

  it('renders an enabled corrupt binding with the repair workflow', async () => {
    const sync = fakeSync({
      enabled: true,
      phase: 'error',
      binding: {
        cloudVaultId: 'cloud-1',
        localVaultId: 'local-1',
        name: 'University',
        baseCorrupt: true,
      },
      error: { code: 'CORRUPT_SYNC_METADATA', message: 'corrupt' },
    });
    const mounted = mount(
      createElement(VaultSyncSettingsView, baseProps({ sync })),
    );
    await settle();
    expect(
      (mounted.querySelector('[data-testid="sync-phase"]') as HTMLElement)
        .textContent,
    ).toBe('Paused — damaged sync history');
    expect(mounted.querySelector('[data-testid="sync-repair"]')).not.toBeNull();
    expect(
      mounted.querySelector('[data-testid="sync-disable"]'),
    ).not.toBeNull();
  });

  it('renders the unavailable state for unconfigured accounts', async () => {
    const unconfigured = fakeAccount(null);
    unconfigured.snapshot = (): AccountSnapshot => ({
      ready: true,
      loading: false,
      user: null,
      error: new AccountError('NOT_CONFIGURED', 'not configured'),
    });
    const mounted = mount(
      createElement(
        VaultSyncSettingsView,
        baseProps({ account: unconfigured }),
      ),
    );
    await settle();
    expect(mounted.textContent).toContain('isn’t set up in this build');
    expect(mounted.querySelector('[data-testid="sync-enable"]')).toBeNull();
  });

  it('a disabled binding never appears as paused/on/up-to-date', async () => {
    const sync = fakeSync({
      enabled: false,
      phase: 'idle',
      binding: {
        cloudVaultId: 'cloud-1',
        localVaultId: 'local-1',
        name: 'University',
      },
      activeLocalVaultId: 'local-2',
    });
    const mounted = mount(
      createElement(
        VaultSyncSettingsView,
        baseProps({ sync, current: { id: 'local-1', name: 'University' } }),
      ),
    );
    await settle();
    expect(
      (mounted.querySelector('[data-testid="sync-phase"]') as HTMLElement)
        .textContent,
    ).toBe('Off');
    expect(
      (mounted.querySelector('[data-testid="sync-state"]') as HTMLElement)
        .textContent,
    ).toBe('Off');
    // Disabled is not parked, even though the selection disagrees.
    expect(mounted.querySelector('[data-testid="sync-parked"]')).toBeNull();
  });

  it('bound elsewhere distinguishes enabled vs disabled copy', async () => {
    const onElsewhere = fakeSync({
      enabled: true,
      binding: {
        cloudVaultId: 'cloud-a',
        localVaultId: 'local-a',
        name: 'Vault A',
      },
      activeLocalVaultId: 'local-a',
    });
    const mountedOn = mount(
      createElement(
        VaultSyncSettingsView,
        baseProps({
          sync: onElsewhere,
          current: { id: 'local-b', name: 'Vault B' },
        }),
      ),
    );
    await settle();
    expect(
      (mountedOn.querySelector('[data-testid="sync-state"]') as HTMLElement)
        .textContent,
    ).toContain('On for');
    expect(
      mountedOn.querySelector('[data-testid="sync-elsewhere"]')?.textContent,
    ).toContain('Sync is on for');
    act(() => root?.unmount());
    host?.remove();
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const offElsewhere = fakeSync({
      enabled: false,
      binding: {
        cloudVaultId: 'cloud-a',
        localVaultId: 'local-a',
        name: 'Vault A',
      },
      activeLocalVaultId: 'local-a',
    });
    act(() => {
      root!.render(
        createElement(
          VaultSyncSettingsView,
          baseProps({
            sync: offElsewhere,
            current: { id: 'local-b', name: 'Vault B' },
          }),
        ),
      );
    });
    await settle();
    expect(
      (host.querySelector('[data-testid="sync-state"]') as HTMLElement)
        .textContent,
    ).toContain('Off for');
    expect(
      host.querySelector('[data-testid="sync-elsewhere"]')?.textContent,
    ).toContain('Sync is off for');
    expect(
      (host.querySelector('[data-testid="sync-phase"]') as HTMLElement)
        .textContent,
    ).toBe('Off');
  });
});
