// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { PurchaseCustomerState } from '@froglight/foundation/purchases';
import type { WorkspaceSettingsValue } from '../workspace-settings.js';
import { ProSettingsView } from './ProSettingsView.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const FREE_CUSTOMER: PurchaseCustomerState = {
  appUserId: 'anon-test-user',
  activeEntitlementIds: [],
  entitlements: {
    pro: {
      active: false,
      productId: null,
      expirationDate: null,
      willRenew: null,
    },
  },
};

const PRO_CUSTOMER: PurchaseCustomerState = {
  appUserId: 'anon-test-user',
  activeEntitlementIds: ['pro'],
  entitlements: {
    pro: {
      active: true,
      productId: 'froglight_pro_annual',
      expirationDate: '2027-09-30T00:00:00.000Z',
      willRenew: true,
    },
  },
};

const OFFERINGS = [
  {
    id: 'default',
    packages: [
      {
        id: '$rc_monthly',
        kind: 'monthly' as const,
        product: {
          id: 'froglight_pro_monthly',
          title: 'Froglight Pro Monthly',
          description: 'Billed every month.',
          price: {
            formatted: '$4.99',
            currencyCode: 'USD',
            amountMicros: 4990000,
          },
          period: 'month' as const,
        },
      },
    ],
  },
];

interface StubSettings {
  readonly values: Record<string, WorkspaceSettingsValue>;
  get(key: string, defaultValue: string): string;
  set(key: string, value: string): void;
  onChange(listener: (key: string, value: WorkspaceSettingsValue) => void): {
    dispose(): void;
  };
}

function stubSettings(
  initial: Record<string, WorkspaceSettingsValue> = {},
): StubSettings {
  const values: Record<string, WorkspaceSettingsValue> = { ...initial };
  const listeners = new Set<
    (key: string, value: WorkspaceSettingsValue) => void
  >();
  return {
    values,
    get(_key: string, defaultValue: string): string {
      const value = values[_key];
      return typeof value === 'string' ? value : defaultValue;
    },
    set(key: string, value: string): void {
      values[key] = value;
      for (const listener of [...listeners]) listener(key, value);
    },
    onChange(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
}

function fakeService(customer: PurchaseCustomerState | null) {
  const listeners = new Set<(snapshot: never) => void>();
  return {
    snapshot: () => ({
      ready: customer !== null,
      loading: false,
      customer,
      error: null,
    }),
    subscribe: (listener: (snapshot: never) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh: async () => undefined,
    offerings: async () => OFFERINGS,
    purchase: async () => {
      throw { code: 'UNKNOWN', message: 'unused' };
    },
    restore: async () => {
      throw { code: 'UNKNOWN', message: 'unused' };
    },
    handleNativeEvent: () => undefined,
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

/**
 * the Pro tab is sync-led status + subscription only. The App
 * accent picker lives in Appearance, so no accent nodes may render here
 * in any purchase state.
 */
function accentNodes(mounted: ParentNode): Element[] {
  return [
    ...mounted.querySelectorAll(
      '[data-fl-component="accent-picker"], [data-fl-component="accent-option"]',
    ),
  ];
}

describe('ProSettingsView', () => {
  it('composes status and the paywall with zero accent nodes for free users', async () => {
    const settings = stubSettings();
    const service = fakeService(FREE_CUSTOMER);
    const mounted = mount(
      createElement(ProSettingsView, {
        settings: settings as never,
        resolvePurchases: () => service as never,
      }),
    );
    await settle();
    expect(mounted.textContent).toContain('Froglight Pro');
    expect(mounted.textContent).toContain('Froglight Free');
    expect(mounted.textContent).toContain('$4.99');
    expect(mounted.querySelectorAll('h2')).toHaveLength(1);
    expect(accentNodes(mounted)).toHaveLength(0);
  });

  it('shows the success panel with zero accent nodes for Pro', async () => {
    const settings = stubSettings();
    const service = fakeService(PRO_CUSTOMER);
    const mounted = mount(
      createElement(ProSettingsView, {
        settings: settings as never,
        resolvePurchases: () => service as never,
      }),
    );
    await settle();
    expect(mounted.textContent).toContain('Cloud sync included');
    expect(accentNodes(mounted)).toHaveLength(0);
  });

  it('renders honestly without a provider and still no accent nodes', async () => {
    const settings = stubSettings();
    const mounted = mount(
      createElement(ProSettingsView, {
        settings: settings as never,
        resolvePurchases: () => null,
      }),
    );
    await settle();
    expect(mounted.textContent).toContain("aren't available on this host yet");
    expect(accentNodes(mounted)).toHaveLength(0);
  });

  it('reports Pro from the server claim with no native purchase provider (iPhone purchase → web)', async () => {
    const settings = stubSettings();
    const account = {
      snapshot: () => ({
        ready: true,
        loading: false,
        user: { id: 'uid-1', email: 'f@g.com' },
        error: null,
      }),
      subscribe: () => () => undefined,
      restore: async () => undefined,
      createAccount: async () => ({ id: 'uid-1', email: null }),
      signIn: async () => ({ id: 'uid-1', email: null }),
      signOut: async () => undefined,
      refreshToken: async () => ({
        token: 'token',
        expiresAt: null,
        entitlements: ['pro'],
      }),
    };
    const mounted = mount(
      createElement(ProSettingsView, {
        settings: settings as never,
        resolvePurchases: () => null,
        resolveAccount: () => account as never,
      }),
    );
    await settle();
    expect(mounted.textContent).toContain('Cloud sync included');
    expect(mounted.textContent).not.toContain(
      "aren't available on this host yet",
    );
    expect(accentNodes(mounted)).toHaveLength(0);
  });
});
