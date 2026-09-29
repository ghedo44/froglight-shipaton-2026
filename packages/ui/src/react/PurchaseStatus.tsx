/**
 * Purchase status row.
 *
 * One glanceable line: Pro (with product and renewal detail) or Free.
 * Reads entitlement state through the shared policy helper — never a
 * scattered id check. No actions here; purchase and restore live in the
 * paywall below so this row stays a status, not a second CTA.
 */

import {
  hasFroglightPro,
  type PurchaseCustomerState,
} from '@froglight/foundation/purchases';
import styles from './PurchaseStatus.module.css';

export interface PurchaseStatusProps {
  readonly customer: PurchaseCustomerState | null;
  readonly ready: boolean;
  /**
   * Platform-independent Pro state from the trusted server claim
   * (`useServerPro`). True when the account holds Pro on any device —
   * for example purchased on iPhone and now signed in on web, where the
   * native purchase provider is absent. Client state stays primary for
   * product/renewal detail; the server flag only upgrades Free to Pro.
   */
  readonly serverIsPro?: boolean;
  /** True while the server claim is being read; renders checking copy. */
  readonly serverLoading?: boolean;
}

function proDetail(customer: PurchaseCustomerState): string | null {
  const info = customer.entitlements['pro'];
  if (info === undefined || info.productId === null) return null;
  const parts = [info.productId];
  if (info.expirationDate !== null) {
    const date = new Date(info.expirationDate);
    if (!Number.isNaN(date.getTime())) {
      const renewal =
        info.willRenew === true ? 'renews' : info.willRenew === false ? 'expires' : 'ends';
      parts.push(
        `${renewal} ${date.toLocaleDateString(undefined, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        })}`,
      );
    }
  }
  return parts.join(' · ');
}

export function PurchaseStatus(
  props: PurchaseStatusProps,
): React.ReactElement {
  const { customer, ready, serverIsPro = false, serverLoading = false } = props;
  const clientIsPro = hasFroglightPro(customer);
  if (!clientIsPro && serverLoading && customer === null) {
    return (
      <div
        className={styles['purchase-status']}
        data-fl-component="purchase-status"
        data-state="unknown"
      >
        <span className={styles['purchase-status-dot']} aria-hidden="true" />
        <span className={styles['purchase-status-texts']}>
          <span className={styles['purchase-status-title']}>
            Checking subscription…
          </span>
          <span className={styles['purchase-status-subtitle']}>
            Reading your Pro status from your account.
          </span>
        </span>
      </div>
    );
  }
  if (!ready || (customer === null && !serverIsPro)) {
    return (
      <div
        className={styles['purchase-status']}
        data-fl-component="purchase-status"
        data-state="unknown"
      >
        <span className={styles['purchase-status-dot']} aria-hidden="true" />
        <span className={styles['purchase-status-texts']}>
          <span className={styles['purchase-status-title']}>
            Subscription status unavailable
          </span>
          <span className={styles['purchase-status-subtitle']}>
            Connect to load your subscription state.
          </span>
        </span>
      </div>
    );
  }
  if (clientIsPro) {
    const detail = customer === null ? null : proDetail(customer);
    return (
      <div
        className={styles['purchase-status']}
        data-fl-component="purchase-status"
        data-state="pro"
      >
        <span className={styles['purchase-status-dot']} aria-hidden="true" />
        <span className={styles['purchase-status-texts']}>
          <span className={styles['purchase-status-title']}>Froglight Pro</span>
          {detail !== null ? (
            <span className={styles['purchase-status-subtitle']}>{detail}</span>
          ) : null}
        </span>
      </div>
    );
  }
  if (serverIsPro) {
    return (
      <div
        className={styles['purchase-status']}
        data-fl-component="purchase-status"
        data-state="pro"
      >
        <span className={styles['purchase-status-dot']} aria-hidden="true" />
        <span className={styles['purchase-status-texts']}>
          <span className={styles['purchase-status-title']}>Froglight Pro</span>
          <span className={styles['purchase-status-subtitle']}>
            Active on your account — includes cloud sync on all devices.
          </span>
        </span>
      </div>
    );
  }
  return (
    <div
      className={styles['purchase-status']}
      data-fl-component="purchase-status"
      data-state="free"
    >
      <span className={styles['purchase-status-dot']} aria-hidden="true" />
      <span className={styles['purchase-status-texts']}>
        <span className={styles['purchase-status-title']}>Froglight Free</span>
        <span className={styles['purchase-status-subtitle']}>
          Upgrade below to unlock Pro.
        </span>
      </span>
    </div>
  );
}
