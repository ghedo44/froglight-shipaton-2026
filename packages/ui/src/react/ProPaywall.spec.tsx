// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  PurchaseCustomerState,
  PurchaseOffering,
  PurchaseResult,
  PurchaseService,
  PurchaseSnapshot,
} from '@froglight/foundation/purchases';
import { ProPaywall } from './ProPaywall.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const FREE_CUSTOMER: PurchaseCustomerState = {
  appUserId: 'anon-test-user',
  activeEntitlementIds: [],
  entitlements: {
    pro: { active: false, productId: null, expirationDate: null, willRenew: null },
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

const OFFERINGS: readonly PurchaseOffering[] = [
  {
    id: 'default',
    packages: [
      {
        id: '$rc_monthly',
        kind: 'monthly',
        product: {
          id: 'froglight_pro_monthly',
          title: 'Froglight Pro Monthly',
          description: 'Billed every month.',
          price: { formatted: '$4.99', currencyCode: 'USD', amountMicros: 4990000 },
          period: 'month',
        },
      },
      {
        id: '$rc_annual',
        kind: 'annual',
        product: {
          id: 'froglight_pro_annual',
          title: 'Froglight Pro Annual',
          description: 'Billed once a year.',
          price: { formatted: '$49.99', currencyCode: 'USD', amountMicros: 49990000 },
          period: 'year',
        },
      },
    ],
  },
];

/** Controllable stand-in for the host-owned service (never the store). */
class FakePurchaseService implements PurchaseService {
  customer: PurchaseCustomerState | null;
  offeringsData: readonly PurchaseOffering[] = OFFERINGS;
  purchaseImpl: (offeringId: string, packageId: string) => Promise<PurchaseResult> =
    async (_offeringId, _packageId) => {
      void _offeringId;
      void _packageId;
      this.customer = structuredClone(PRO_CUSTOMER);
      this.emit();
      return { status: 'purchased', customer: structuredClone(PRO_CUSTOMER) };
    };
  restoreImpl: () => Promise<PurchaseResult> = async () => {
    this.customer = structuredClone(PRO_CUSTOMER);
    this.emit();
    return { status: 'purchased', customer: structuredClone(PRO_CUSTOMER) };
  };
  offeringsImpl: () => Promise<readonly PurchaseOffering[]> = async () =>
    this.offeringsData;
  readonly purchaseCalls: Array<{ offeringId: string; packageId: string }> = [];
  restoreCalls = 0;
  private readonly listeners = new Set<(snapshot: PurchaseSnapshot) => void>();

  constructor(customer: PurchaseCustomerState | null) {
    this.customer = customer === null ? null : structuredClone(customer);
  }

  snapshot(): PurchaseSnapshot {
    return {
      ready: this.customer !== null,
      loading: false,
      customer:
        this.customer === null ? null : structuredClone(this.customer),
      error: null,
    };
  }

  subscribe(listener: (snapshot: PurchaseSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(): void {
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) listener(snapshot);
  }

  async refresh(): Promise<void> {
    this.emit();
  }

  async offerings(): Promise<readonly PurchaseOffering[]> {
    return this.offeringsImpl();
  }

  async purchase(offeringId: string, packageId: string): Promise<PurchaseResult> {
    this.purchaseCalls.push({ offeringId, packageId });
    return this.purchaseImpl(offeringId, packageId);
  }

  async restore(): Promise<PurchaseResult> {
    this.restoreCalls += 1;
    return this.restoreImpl();
  }

  handleNativeEvent(): void {
    // Events arrive through emit() in these specs.
  }
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
  vi.restoreAllMocks();
});

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

function paywall(service: PurchaseService | null): HTMLElement {
  return mount(createElement(ProPaywall, { service }));
}

function buttonByName(mounted: ParentNode, name: string): HTMLButtonElement {
  const button = [...mounted.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (button === undefined) throw new Error(`no button named ${name}`);
  return button as HTMLButtonElement;
}

async function clickButton(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    for (let i = 0; i < 8; i += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  });
}

describe('ProPaywall', () => {
  it('shows free plans with localized store prices', async () => {
    const mounted = paywall(new FakePurchaseService(FREE_CUSTOMER));
    await flush();
    const text = mounted.textContent ?? '';
    expect(text).toContain('$4.99');
    expect(text).toContain('$49.99');
    expect(text).toContain('Monthly');
    expect(text).toContain('Annual');
    expect(buttonByName(mounted, 'Continue')).toBeDefined();
    expect(buttonByName(mounted, 'Restore purchases')).toBeDefined();
  });

  it('purchases the tapped plan with its semantic identifiers', async () => {
    const service = new FakePurchaseService(FREE_CUSTOMER);
    const mounted = paywall(service);
    await flush();
    const monthly = mounted.querySelector(
      '[data-fl-component="purchase-package-card"][aria-label^="Monthly"]',
    ) as HTMLButtonElement;
    expect(monthly).not.toBeNull();
    await clickButton(monthly);
    expect(monthly.getAttribute('aria-checked')).toBe('true');
    await clickButton(buttonByName(mounted, 'Continue'));
    expect(service.purchaseCalls).toEqual([
      { offeringId: 'default', packageId: '$rc_monthly' },
    ]);
  });

  it('swaps to the Pro state after a successful purchase', async () => {
    const mounted = paywall(new FakePurchaseService(FREE_CUSTOMER));
    await flush();
    await clickButton(buttonByName(mounted, 'Continue'));
    await flush();
    expect(mounted.textContent).toContain('You have Froglight Pro');
    expect(
      [...mounted.querySelectorAll('button')].some(
        (candidate) => candidate.textContent?.trim() === 'Continue',
      ),
    ).toBe(false);
  });

  it('keeps the paywall usable after cancellation', async () => {
    const service = new FakePurchaseService(FREE_CUSTOMER);
    service.purchaseImpl = async () => ({
      status: 'cancelled',
      customer: structuredClone(FREE_CUSTOMER),
    });
    const mounted = paywall(service);
    await flush();
    await clickButton(buttonByName(mounted, 'Continue'));
    await flush();
    const text = mounted.textContent ?? '';
    expect(text).toContain('no charge was made');
    // No error styling for a user decision; the paywall stays actionable.
    expect(mounted.querySelector('[role="alert"]')).toBeNull();
    expect(buttonByName(mounted, 'Continue').disabled).toBe(false);
  });

  it('names the failure and allows retry', async () => {
    const service = new FakePurchaseService(FREE_CUSTOMER);
    let attempts = 0;
    service.purchaseImpl = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw { code: 'PRODUCT_UNAVAILABLE', message: 'gone' };
      }
      service.customer = structuredClone(PRO_CUSTOMER);
      service.emit();
      return { status: 'purchased', customer: structuredClone(PRO_CUSTOMER) };
    };
    const mounted = paywall(service);
    await flush();
    await clickButton(buttonByName(mounted, 'Continue'));
    await flush();
    expect(mounted.querySelector('[role="alert"]')).not.toBeNull();
    expect(mounted.textContent).toContain("aren't available right now");
    await clickButton(buttonByName(mounted, 'Continue'));
    await flush();
    expect(mounted.textContent).toContain('You have Froglight Pro');
    expect(service.purchaseCalls).toHaveLength(2);
  });

  it('restores server state into Pro', async () => {
    const service = new FakePurchaseService(FREE_CUSTOMER);
    const mounted = paywall(service);
    await flush();
    await clickButton(buttonByName(mounted, 'Restore purchases'));
    await flush();
    expect(service.restoreCalls).toBe(1);
    expect(mounted.textContent).toContain('You have Froglight Pro');
  });

  it('shows no purchase CTA to an existing Pro customer', async () => {
    const mounted = paywall(new FakePurchaseService(PRO_CUSTOMER));
    await flush();
    const labels = [...mounted.querySelectorAll('button')].map((candidate) =>
      candidate.textContent?.trim(),
    );
    expect(labels).not.toContain('Continue');
    expect(mounted.textContent).toContain('You have Froglight Pro');
    expect(mounted.textContent).not.toContain('$4.99');
  });

  it('leads with sync included now, never the roadmap or accents', async () => {
    const mounted = paywall(new FakePurchaseService(FREE_CUSTOMER));
    await flush();
    const text = mounted.textContent ?? '';
    expect(text.toLowerCase()).toContain('sync');
    expect(text).toContain('included now');
    expect(text.toLowerCase()).not.toContain('roadmap');
    expect(text.toLowerCase()).not.toContain('when it ships');
    expect(text.toLowerCase()).not.toContain('accent');
  });

  it('names sync in the Pro success panel, not accents', async () => {
    const mounted = paywall(new FakePurchaseService(PRO_CUSTOMER));
    await flush();
    const text = mounted.textContent ?? '';
    expect(text).toContain('You have Froglight Pro');
    expect(text.toLowerCase()).toContain('sync');
    expect(text).not.toContain('Pro accents are unlocked');
    expect(text.toLowerCase()).not.toContain('accent');
  });

  it('renders honestly without a provider', async () => {
    const mounted = paywall(null);
    await flush();
    expect(mounted.textContent).toContain("aren't available on this host yet");
    expect(mounted.textContent?.toLowerCase()).toContain('sync');
    expect(mounted.textContent?.toLowerCase()).not.toContain('roadmap');
    expect(mounted.querySelector('button')).toBeNull();
  });

  it('reports Pro from the server claim with no native provider (iPhone purchase → web)', async () => {
    const mounted = mount(
      createElement(ProPaywall, { service: null, serverIsPro: true }),
    );
    await flush();
    expect(mounted.textContent).toContain('You have Froglight Pro');
    expect(mounted.textContent).not.toContain(
      "aren't available on this host yet",
    );
    expect(mounted.querySelector('button')).toBeNull();
  });

  it('shows checking copy while the server claim loads', async () => {
    const mounted = mount(
      createElement(ProPaywall, { service: null, serverLoading: true }),
    );
    await flush();
    expect(mounted.textContent).toContain('Checking your subscription');
  });

  it('treats a server Pro account as Pro even with a free native customer', async () => {
    const mounted = mount(
      createElement(ProPaywall, {
        service: new FakePurchaseService(FREE_CUSTOMER),
        serverIsPro: true,
      }),
    );
    await flush();
    expect(mounted.textContent).toContain('You have Froglight Pro');
  });

  it('binds the account identity before an account-bound purchase', async () => {
    const service = new FakePurchaseService(FREE_CUSTOMER);
    const order: string[] = [];
    const mounted = mount(
      createElement(ProPaywall, {
        service,
        ensureAccountIdentity: async () => {
          order.push('identify');
        },
      }),
    );
    await flush();
    const original = service.purchaseImpl;
    service.purchaseImpl = async (offeringId, packageId) => {
      order.push('purchase');
      return original(offeringId, packageId);
    };
    await clickButton(buttonByName(mounted, 'Continue'));
    await flush();
    // The store purchase never runs under an unrelated anonymous identity:
    // identify(uid) lands first.
    expect(order).toEqual(['identify', 'purchase']);
    expect(service.purchaseCalls).toHaveLength(1);
  });

  it('never reaches the store when the identity gate fails', async () => {
    const service = new FakePurchaseService(FREE_CUSTOMER);
    const mounted = mount(
      createElement(ProPaywall, {
        service,
        ensureAccountIdentity: async () => {
          throw { code: 'UNAUTHENTICATED', message: 'signed out' };
        },
      }),
    );
    await flush();
    await clickButton(buttonByName(mounted, 'Continue'));
    await flush();
    expect(service.purchaseCalls).toHaveLength(0);
    expect(mounted.textContent).toContain('Sign in to buy Froglight Pro');
  });
});
