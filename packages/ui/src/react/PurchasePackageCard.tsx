/**
 * Purchase package card.
 *
 * One selectable plan: localized store price (authoritative, never
 * hardcoded), derived per-month hint, and a caller-supplied badge. The
 * card is a radio in its group — selection is presentation state owned by
 * the paywall, never entitlement state.
 */

import type { PurchasePackage } from '@froglight/foundation/purchases';
import styles from './PurchasePackageCard.module.css';

export interface PurchasePackageCardProps {
  readonly pkg: PurchasePackage;
  /** Human plan name ("Monthly", "Annual"). Never a price. */
  readonly name: string;
  /** Derived badge ("Best value") or null. Never hardcoded prices. */
  readonly badge?: string | null;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onSelect: (packageId: string) => void;
}

/** Per-month hint derived from store micros; null when underivable. */
export function perMonthHint(pkg: PurchasePackage): string | null {
  const micros = pkg.product.price.amountMicros;
  const code = pkg.product.price.currencyCode;
  if (
    micros === undefined ||
    !Number.isFinite(micros) ||
    micros <= 0 ||
    code === null
  ) {
    return null;
  }
  const months =
    pkg.kind === 'annual' ? 12 : pkg.kind === 'monthly' ? 1 : null;
  if (months === null) return null;
  try {
    return `${new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
    }).format(micros / months / 1_000_000)}/mo`;
  } catch {
    return null;
  }
}

export function PurchasePackageCard(
  props: PurchasePackageCardProps,
): React.ReactElement {
  const { pkg, name, badge, selected, disabled, onSelect } = props;
  const hint = perMonthHint(pkg);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={`${name}, ${pkg.product.price.formatted}`}
      data-fl-component="purchase-package-card"
      data-selected={String(selected)}
      data-disabled={String(disabled)}
      className={styles['package-card']}
      disabled={disabled}
      onClick={() => onSelect(pkg.id)}
    >
      <span className={styles['package-card-header']}>
        <span className={styles['package-card-name']}>{name}</span>
        {badge !== undefined && badge !== null ? (
          <span className={styles['package-card-badge']}>{badge}</span>
        ) : null}
      </span>
      <span className={styles['package-card-price']}>
        {pkg.product.price.formatted}
      </span>
      {hint !== null ? (
        <span className={styles['package-card-per-month']}>{hint}</span>
      ) : null}
      {pkg.product.description !== '' ? (
        <span className={styles['package-card-description']}>
          {pkg.product.description}
        </span>
      ) : null}
    </button>
  );
}
