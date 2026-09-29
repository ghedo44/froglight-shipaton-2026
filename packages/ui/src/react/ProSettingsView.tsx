/**
 * Froglight Pro settings section (sync-led).
 *
 * Composes subscription status and the paywall with restore. Reads the
 * host-owned `PurchaseService` through a shell-provided resolver so the
 * section also renders honestly on hosts without a provider. The App
 * accent picker lives in Appearance; this tab is status + subscription
 * only and renders zero accent nodes.
 */

import type { AccountService } from '@froglight/foundation/account';
import type { PurchaseService } from '@froglight/foundation/purchases';
import type { AccountIdentityService } from '@froglight/foundation';
import type { WorkspaceSettingsService } from '../workspace-settings.js';
import { ProPaywall } from './ProPaywall.jsx';
import { PurchaseStatus } from './PurchaseStatus.jsx';
import { usePurchaseSnapshot } from './usePurchases.jsx';
import { useServerPro } from './useServerPro.jsx';
import sectionStyles from './SettingsView.module.css';
import styles from './ProSettingsView.module.css';

export interface ProSettingsViewProps {
  readonly settings: WorkspaceSettingsService;
  /**
   * Shell resolver for the host-owned service; null without a provider.
   * Must return a stable instance across renders (the probe does) — the
   * snapshot hooks subscribe per instance.
   */
  readonly resolvePurchases: () => PurchaseService | null;
  /**
   * Shell resolver for the host-owned account service; null without a
   * provider. Supplies the trusted server claim so Pro purchased on one
   * device (for example iPhone) renders as Pro on every signed-in host
   * (including web, which has no native purchase provider).
   */
  readonly resolveAccount?: () => AccountService | null;
  /**
   * Shell resolver for the account ↔ purchase coordinator; null when its
   * fiber is dormant (e.g. web without a purchase provider). When present,
   * purchases and restores bind the Firebase UID first.
   */
  readonly resolveIdentity?: () => AccountIdentityService | null;
}

export function ProSettingsView(
  props: ProSettingsViewProps,
): React.ReactElement {
  const { resolvePurchases, resolveAccount, resolveIdentity } = props;
  const service = resolvePurchases();
  const account = resolveAccount?.() ?? null;
  const identity = resolveIdentity?.() ?? null;
  const { snapshot } = usePurchaseSnapshot(service);
  const { isPro: serverIsPro, loading: serverLoading } = useServerPro(account);
  const customer = snapshot.customer;

  return (
    <div
      className={sectionStyles['settings-section']}
      data-fl-component="pro-settings"
    >
      <h2 className={sectionStyles['settings-section-title']}>Froglight Pro</h2>
      <p className={styles['pro-description']}>
        Bring your vaults with you. Pro adds cloud sync while your files stay
        available locally.
      </p>
      <div className={styles['pro-section']}>
        {(service !== null || serverIsPro || serverLoading) && (
          <div className={styles['pro-block']}>
            <PurchaseStatus
              customer={customer}
              ready={snapshot.ready || serverIsPro || serverLoading}
              serverIsPro={serverIsPro}
              serverLoading={serverLoading}
            />
          </div>
        )}
        <div className={styles['pro-block']}>
          <ProPaywall
            service={service}
            showTitle={false}
            serverIsPro={serverIsPro}
            serverLoading={serverLoading}
            ensureAccountIdentity={
              identity === null
                ? undefined
                : () => identity.ensureAccountIdentity()
            }
          />
        </div>
      </div>
    </div>
  );
}
