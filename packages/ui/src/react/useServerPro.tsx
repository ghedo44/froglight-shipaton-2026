/**
 * Server-issued Pro entitlement for React.
 *
 * Platform-independent Pro state: the trusted `revenueCatEntitlements`
 * custom claim on the Firebase ID token (maintained by the RevenueCat
 * Firebase Extension). A purchase made on iPhone propagates to this
 * claim, so the web host — which has no native purchase provider and
 * resolves `froglight.purchases` to null — still reports Pro after
 * sign-in. Client `PurchaseService` state stays UI-only and is combined
 * by callers (`clientPro || serverPro`); backend authorization never
 * reads client state (see `VaultSyncStore`).
 *
 * Trusted React UI only: components receive the host-owned
 * `AccountService` through the shell resolver. No Firebase, Auth, or
 * DOM-storage types enter the presentation layer; failures degrade to
 * Free (never a throw) so an expired session or offline token read
 * keeps local vaults usable.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  hasServerEntitlement,
  type AccountService,
} from '@froglight/foundation/account';
import { FROGLIGHT_PRO_ENTITLEMENT } from '@froglight/foundation/purchases';
import { useAccountSnapshot } from './useAccount.jsx';

export interface ServerProState {
  /** True when the trusted server claim carries the Pro entitlement. */
  readonly isPro: boolean;
  /** True while the claim is being read (cached, then one force refresh). */
  readonly loading: boolean;
  /** Force-refresh the ID token and re-read the claim. Never throws. */
  readonly refresh: () => Promise<void>;
}

/**
 * Live server Pro state for one account service instance. Subscribes to
 * the account snapshot (sign-in/out re-seeds), reads the cached token
 * first, and — when the cached claim reports Free for a signed-in user —
 * performs one force refresh so a just-propagated extension claim (for
 * example a purchase made on iPhone) becomes visible without waiting up
 * to an hour for the SDK cache to expire. A `null` service (unconfigured
 * host) yields Free with no loading.
 */
export function useServerPro(
  account: AccountService | null,
): ServerProState {
  const { snapshot: accountSnapshot } = useAccountSnapshot(account);
  const userId = accountSnapshot.user?.id ?? null;
  const [isPro, setIsPro] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (account === null || userId === null) {
      setIsPro(false);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const cached = await account.refreshToken(false);
        if (cancelled) return;
        if (hasServerEntitlement(cached, FROGLIGHT_PRO_ENTITLEMENT)) {
          setIsPro(true);
          setLoading(false);
          return;
        }
      } catch {
        if (cancelled) return;
        // A failed cached read is not a failed entitlement: fall through
        // to the force refresh below (offline keeps the previous value
        // until the refresh also fails).
      }
      if (cancelled) return;
      try {
        const fresh = await account.refreshToken(true);
        if (cancelled) return;
        setIsPro(
          hasServerEntitlement(fresh, FROGLIGHT_PRO_ENTITLEMENT),
        );
      } catch {
        if (cancelled) return;
        // Transient/auth failures degrade to Free (never a throw): sync
        // surfaces its own activating/error states on demand.
        setIsPro(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account, userId]);

  const refresh = useCallback(async () => {
    if (account === null) return;
    const liveUid = account.snapshot().user?.id ?? null;
    if (liveUid === null) {
      setIsPro(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const state = await account.refreshToken(true);
      setIsPro(hasServerEntitlement(state, FROGLIGHT_PRO_ENTITLEMENT));
    } catch {
      // Keep the previous value on transient failure; the caller renders
      // from the last known claim rather than flickering to Free.
    } finally {
      setLoading(false);
    }
  }, [account]);

  if (account === null) {
    return { isPro: false, loading: false, refresh };
  }
  return { isPro, loading, refresh };
}
