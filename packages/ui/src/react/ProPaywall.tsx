/**
 * Froglight Pro paywall.
 *
 * Froglight-owned presentation over the platform-neutral `PurchaseService`:
 * plans render from RevenueCat offerings with localized store prices
 * (authoritative, never hardcoded); the Apple sheet stays native. Covers
 * loading, unavailable hosts, plan choice, purchase, cancellation (a
 * quiet note, never an error), failure with recovery, restore, and the
 * active-Pro state with no purchase CTA.
 */

import { useEffect, useState } from 'react';
import {
  hasFroglightPro,
  type PurchaseOffering,
  type PurchasePackage,
  type PurchaseService,
} from '@froglight/foundation/purchases';
import { Button } from './Button.jsx';
import { PurchasePackageCard } from './PurchasePackageCard.jsx';
import { usePurchaseSnapshot } from './usePurchases.jsx';
import styles from './ProPaywall.module.css';

export interface ProPaywallProps {
  /** Host-owned service, or null on hosts without a provider (web today). */
  readonly service: PurchaseService | null;
  /** The Pro settings section already provides this heading. */
  readonly showTitle?: boolean;
  /**
   * Platform-independent Pro state from the trusted server claim
   * (`useServerPro`). Covers purchases made on another device: the web
   * host has no native purchase provider, so a server Pro account must
   * still render the Pro success state (and unlock sync) instead of the
   * unavailable paywall. Combined as `clientPro || serverIsPro`.
   */
  readonly serverIsPro?: boolean;
  /** True while the server claim is being read; renders checking copy. */
  readonly serverLoading?: boolean;
  /**
   * Account-bound purchase gate. When provided, every
   * purchase/restore awaits it first so a signed-in user never subscribes
   * under an unrelated anonymous RevenueCat identity (the Firebase UID
   * becomes the App User ID before any paid work). Omitted keeps the
   * anonymous local-Pro flow. The sync section always provides it; the
   * Pro section provides it whenever the identity coordinator is active.
   */
  readonly ensureAccountIdentity?: () => Promise<void>;
}

type Phase = 'loading' | 'ready' | 'purchasing' | 'restoring';

interface Notice {
  readonly kind: 'error' | 'info';
  readonly text: string;
}

/**
 * User-facing copy for stable purchase codes. Names the problem and the
 * recovery; never leaks native/SDK wording.
 */
export function purchaseErrorCopy(code: string): string {
  switch (code) {
    case 'NETWORK':
    case 'STORE_UNAVAILABLE':
      return "Couldn't reach the store. Check your connection and try again.";
    case 'PRODUCT_UNAVAILABLE':
    case 'INVALID_OFFERING':
    case 'INVALID_PACKAGE':
      return "Those plans aren't available right now. Try again in a moment.";
    case 'PURCHASE_NOT_ALLOWED':
      return "Purchases aren't allowed on this device right now (store restrictions or parental controls).";
    case 'RECEIPT_INVALID':
      return "The store couldn't verify that purchase. Try restoring purchases.";
    case 'NOT_CONFIGURED':
    case 'CONFIGURATION':
      return "Purchases aren't set up in this build yet.";
    case 'UNSUPPORTED':
      return "Purchases aren't available on this host yet.";
    default:
      return 'Something went wrong. Try again.';
  }
}

function planName(pkg: PurchasePackage): string {
  switch (pkg.kind) {
    case 'monthly':
      return 'Monthly';
    case 'annual':
      return 'Annual';
    case 'weekly':
      return 'Weekly';
    case 'lifetime':
      return 'Lifetime';
    case 'twoMonth':
      return 'Every 2 months';
    case 'threeMonth':
      return 'Every 3 months';
    case 'sixMonth':
      return 'Every 6 months';
    case 'custom':
      return pkg.product.title;
  }
}

/** Annual plan id when its per-month price provably beats monthly. */
function bestValuePackageId(offering: PurchaseOffering): string | null {
  const monthly = offering.packages.find((pkg) => pkg.kind === 'monthly');
  const annual = offering.packages.find((pkg) => pkg.kind === 'annual');
  if (monthly === undefined || annual === undefined) return null;
  const monthlyMicros = monthly.product.price.amountMicros;
  const annualMicros = annual.product.price.amountMicros;
  if (
    monthlyMicros === undefined ||
    annualMicros === undefined ||
    monthlyMicros <= 0 ||
    annualMicros <= 0
  ) {
    return null;
  }
  return annualMicros / 12 < monthlyMicros ? annual.id : null;
}

/** Prefer the `default` offering; fall back to the first with packages. */
function chooseOffering(
  offerings: readonly PurchaseOffering[],
): PurchaseOffering | null {
  if (offerings.length === 0) return null;
  const fallback = offerings.find((offering) => offering.packages.length > 0);
  return (
    offerings.find((offering) => offering.id === 'default') ?? fallback ?? null
  );
}

function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === 'string') return code;
  }
  return 'UNKNOWN';
}

export function ProPaywall(props: ProPaywallProps): React.ReactElement {
  const {
    service,
    ensureAccountIdentity,
    showTitle = true,
    serverIsPro = false,
    serverLoading = false,
  } = props;
  const { snapshot, reload } = usePurchaseSnapshot(service);
  const [offerings, setOfferings] = useState<
    readonly PurchaseOffering[] | null
  >(null);
  const [offeringsError, setOfferingsError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [notice, setNotice] = useState<Notice | null>(null);

  /**
   * Run paid store work behind the account identity gate when one is
   * provided. An identity failure (signed out mid-flow) reports as a
   * sign-in note and never reaches the store — the user never purchases
   * Pro under the wrong identity.
   */
  const withIdentity = async (
    work: () => Promise<void>,
    donePhase: Phase,
  ): Promise<void> => {
    if (ensureAccountIdentity !== undefined) {
      try {
        await ensureAccountIdentity();
      } catch {
        setNotice({
          kind: 'error',
          text: 'Sign in to buy Froglight Pro with cloud sync.',
        });
        setPhase(donePhase);
        return;
      }
    }
    await work();
  };

  // Load offerings once the customer state seeds; refresh() runs in the
  // snapshot hook on mount, so offerings follow it.
  useEffect(() => {
    if (service === null || !snapshot.ready) return;
    let cancelled = false;
    void service
      .offerings()
      .then((loaded) => {
        if (cancelled) return;
        setOfferings(loaded);
        setOfferingsError(null);
        const offering = chooseOffering(loaded);
        if (offering !== null) {
          setSelectedId((current) => {
            if (
              current !== null &&
              offering.packages.some((pkg) => pkg.id === current)
            ) {
              return current;
            }
            const best = bestValuePackageId(offering);
            return (
              best ??
              offering.packages.find((pkg) => pkg.kind === 'annual')?.id ??
              offering.packages[0]?.id ??
              null
            );
          });
        }
        setPhase((current) => (current === 'loading' ? 'ready' : current));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setOfferingsError(purchaseErrorCopy(errorCodeOf(error)));
        setPhase((current) => (current === 'loading' ? 'ready' : current));
      });
    return () => {
      cancelled = true;
    };
  }, [service, snapshot.ready]);

  if (service === null) {
    if (serverLoading) {
      return (
        <div
          className={styles['paywall']}
          data-fl-component="pro-paywall"
          data-state="loading"
          aria-busy="true"
        >
          <div className={styles['paywall-header']}>
            {showTitle && (
              <h3 className={styles['paywall-title']}>Froglight Pro</h3>
            )}
            <p className={styles['paywall-lede']}>
              Checking your subscription status…
            </p>
          </div>
        </div>
      );
    }
    if (serverIsPro) {
      return (
        <div
          className={styles['paywall']}
          data-fl-component="pro-paywall"
          data-state="pro"
        >
          <div className={styles['paywall-success']}>
            <p className={styles['paywall-success-title']}>
              {showTitle ? 'You have Froglight Pro' : 'Cloud sync included'}
            </p>
            <p className={styles['paywall-success-detail']}>
              Active on your account — cloud vault sync is included on this
              device too. Your subscription is managed through the store you
              purchased from.
            </p>
          </div>
        </div>
      );
    }
    return (
      <div
        className={styles['paywall']}
        data-fl-component="pro-paywall"
        data-state="unavailable"
      >
        <div className={styles['paywall-header']}>
          {showTitle && (
            <h3 className={styles['paywall-title']}>Froglight Pro</h3>
          )}
          <p className={styles['paywall-lede']}>
            Subscriptions aren&apos;t available on this host yet. Froglight Pro
            keeps selected vaults in sync across your devices.
          </p>
        </div>
      </div>
    );
  }

  const isPro = hasFroglightPro(snapshot.customer) || serverIsPro;

  if (isPro) {
    return (
      <div
        className={styles['paywall']}
        data-fl-component="pro-paywall"
        data-state="pro"
      >
        <div className={styles['paywall-success']}>
          <p className={styles['paywall-success-title']}>
            {showTitle ? 'You have Froglight Pro' : 'Cloud sync included'}
          </p>
          <p className={styles['paywall-success-detail']}>
            Cloud vault sync is included with your subscription. Your
            subscription is managed through the store you purchased from.
          </p>
        </div>
        <div className={styles['paywall-actions']}>
          <Button
            type="button"
            variant="ghost"
            className={styles['paywall-restore-action']}
            disabled={phase === 'restoring'}
            onClick={() => {
              setPhase('restoring');
              setNotice(null);
              void withIdentity(async () => {
                await service
                  .restore()
                  .catch((error: unknown) => {
                    setNotice({
                      kind: 'error',
                      text: purchaseErrorCopy(errorCodeOf(error)),
                    });
                  })
                  .finally(() => {
                    setPhase('ready');
                  });
              }, 'ready');
            }}
          >
            {phase === 'restoring' ? 'Restoring…' : 'Restore purchases'}
          </Button>
        </div>
        {notice !== null ? (
          <p
            role={notice.kind === 'error' ? 'alert' : 'status'}
            data-kind={notice.kind}
            className={styles['paywall-notice']}
          >
            {notice.text}
          </p>
        ) : null}
      </div>
    );
  }

  const busy = phase === 'loading' || snapshot.loading;
  const offering = offerings === null ? null : chooseOffering(offerings);
  const bestId = offering === null ? null : bestValuePackageId(offering);

  return (
    <div
      className={styles['paywall']}
      data-fl-component="pro-paywall"
      data-state={offeringsError !== null ? 'error' : 'free'}
      aria-busy={busy}
    >
      <div className={styles['paywall-header']}>
        {showTitle && (
          <h3 className={styles['paywall-title']}>Froglight Pro</h3>
        )}
        <p className={styles['paywall-lede']}>
          One subscription that keeps your vaults in sync across your devices —
          included now, not later.
        </p>
      </div>
      <ul className={styles['paywall-benefits']}>
        <li>Sync selected vaults across your devices</li>
        <li>Your vaults stay on this device and work fully offline</li>
        <li>Support independent, local-first software</li>
      </ul>
      {offeringsError !== null ? (
        <div className={styles['paywall-retry-row']}>
          <p
            role="alert"
            className={styles['paywall-notice']}
            data-kind="error"
          >
            {offeringsError}
          </p>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setOfferingsError(null);
              setPhase('loading');
              void reload().then(() => {
                // The offerings effect reruns after the snapshot settles;
                // force a direct reload too so retry never dead-ends.
                service
                  .offerings()
                  .then((loaded) => {
                    setOfferings(loaded);
                    setPhase('ready');
                  })
                  .catch((error: unknown) => {
                    setOfferingsError(purchaseErrorCopy(errorCodeOf(error)));
                    setPhase('ready');
                  });
              });
            }}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {offering !== null && offering.packages.length > 0 ? (
        <div
          role="radiogroup"
          aria-label="Subscription plans"
          className={styles['paywall-plans']}
        >
          {offering.packages.map((pkg) => (
            <PurchasePackageCard
              key={pkg.id}
              pkg={pkg}
              name={planName(pkg)}
              badge={pkg.id === bestId ? 'Best value' : null}
              selected={pkg.id === selectedId}
              disabled={phase === 'purchasing' || phase === 'restoring'}
              onSelect={setSelectedId}
            />
          ))}
        </div>
      ) : null}
      {offeringsError === null &&
      (offering === null || offering.packages.length === 0) &&
      !busy ? (
        <p role="status" className={styles['paywall-notice']} data-kind="info">
          No plans are available right now. Try again in a moment.
        </p>
      ) : null}
      <div className={styles['paywall-actions']}>
        <Button
          type="button"
          variant="primary"
          className={styles['paywall-primary-action']}
          disabled={
            selectedId === null ||
            phase === 'purchasing' ||
            phase === 'restoring' ||
            busy
          }
          onClick={() => {
            if (selectedId === null || offering === null) return;
            setPhase('purchasing');
            setNotice(null);
            void withIdentity(async () => {
              await service
                .purchase(offering.id, selectedId)
                .then((result) => {
                  if (result.status === 'cancelled') {
                    setNotice({
                      kind: 'info',
                      text: 'Purchase cancelled — no charge was made.',
                    });
                  }
                  // Success needs no notice: the snapshot flips to Pro and
                  // this paywall swaps to the success panel.
                })
                .catch((error: unknown) => {
                  setNotice({
                    kind: 'error',
                    text: purchaseErrorCopy(errorCodeOf(error)),
                  });
                })
                .finally(() => {
                  setPhase('ready');
                });
            }, 'ready');
          }}
        >
          {phase === 'purchasing' ? 'Purchasing…' : 'Continue'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className={styles['paywall-restore-action']}
          disabled={phase === 'purchasing' || phase === 'restoring' || busy}
          onClick={() => {
            setPhase('restoring');
            setNotice(null);
            void withIdentity(async () => {
              await service
                .restore()
                .catch((error: unknown) => {
                  setNotice({
                    kind: 'error',
                    text: purchaseErrorCopy(errorCodeOf(error)),
                  });
                })
                .finally(() => {
                  setPhase('ready');
                });
            }, 'ready');
          }}
        >
          {phase === 'restoring' ? 'Restoring…' : 'Restore purchases'}
        </Button>
      </div>
      {notice !== null ? (
        <p
          role={notice.kind === 'error' ? 'alert' : 'status'}
          data-kind={notice.kind}
          className={styles['paywall-notice']}
        >
          {notice.text}
        </p>
      ) : null}
      <p className={styles['paywall-muted']}>
        Billed through the App Store. Cancel anytime in your store
        subscriptions.
      </p>
    </div>
  );
}
