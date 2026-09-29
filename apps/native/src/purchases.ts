/**
 * Native purchases host adapter.
 *
 * Thin `apps/native` bridge over the shared `froglight.purchases`
 * capability: raw Tauri command names live only in this module (never in
 * the shared foundation contract community plugins consume), while
 * CustomerInfo updates arrive over the standard Tauri plugin event
 * channel — low frequency, so no direct-eval fast path. Bootstrap seeds
 * through `get_customer_info` after subscribing, so a load-time update
 * that fired before the listener existed is recovered as state.
 */

import { addPluginListener, invoke } from '@tauri-apps/api/core';
import {
  createPurchaseHost,
  type PurchaseCustomerState,
  type PurchaseHost,
  type PurchaseOffering,
  type PurchaseService,
  type PurchaseTransport,
  type PurchaseTransportPurchaseResult,
} from '@froglight/foundation/purchases';

/**
 * Trusted-side invoke names. The `plugin:<name>|<command>` shape is the
 * Tauri convention; the Rust function names are pinned in
 * `src/commands.rs` — rename in both places at once.
 */
export const PURCHASES_CONFIGURE_COMMAND =
  'plugin:froglight-purchases|configure';
export const PURCHASES_GET_CUSTOMER_INFO_COMMAND =
  'plugin:froglight-purchases|get_customer_info';
export const PURCHASES_GET_OFFERINGS_COMMAND =
  'plugin:froglight-purchases|get_offerings';
export const PURCHASES_PURCHASE_PACKAGE_COMMAND =
  'plugin:froglight-purchases|purchase_package';
export const PURCHASES_RESTORE_PURCHASES_COMMAND =
  'plugin:froglight-purchases|restore_purchases';
export const PURCHASES_LOG_IN_COMMAND = 'plugin:froglight-purchases|log_in';
export const PURCHASES_LOG_OUT_COMMAND = 'plugin:froglight-purchases|log_out';

/** Mobile plugin name the customer-info event is emitted under. */
export const PURCHASES_PLUGIN_NAME = 'froglight-purchases';

/**
 * Customer-info update event. Shared contract with the Swift plugin
 * (`froglightCustomerInfoEvent` in `FroglightPurchasesPlugin.swift`) —
 * change in both places at once.
 */
export const PURCHASES_CUSTOMER_EVENT = 'customer-info-updated';

export type NativePurchaseInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

export type NativePurchaseUnlisten = () => void;

export type NativePurchaseListen = (
  event: string,
  handler: (payload: unknown) => void,
) => Promise<NativePurchaseUnlisten> | NativePurchaseUnlisten;

function defaultListen(
  event: string,
  handler: (payload: unknown) => void,
): Promise<NativePurchaseUnlisten> {
  return addPluginListener<unknown>(PURCHASES_PLUGIN_NAME, event, handler).then(
    (listener) => () => {
      void listener.unregister().catch(() => undefined);
    },
  );
}

/**
 * Tauri-invoke transport for the purchase store. Raw payloads pass
 * through unvalidated here on purpose: the store (`PurchaseStore`)
 * validates every native payload at its DTO boundary, so there is exactly
 * one place that decides what malformed means.
 */
export function createNativePurchaseTransport(
  call: NativePurchaseInvoke = invoke,
): PurchaseTransport {
  return {
    async getCustomerInfo(): Promise<PurchaseCustomerState> {
      const raw = await call(PURCHASES_GET_CUSTOMER_INFO_COMMAND);
      return raw as PurchaseCustomerState;
    },
    async getOfferings(): Promise<readonly PurchaseOffering[]> {
      const raw = await call(PURCHASES_GET_OFFERINGS_COMMAND);
      return raw as readonly PurchaseOffering[];
    },
    async purchasePackage(
      offeringId: string,
      packageId: string,
    ): Promise<PurchaseTransportPurchaseResult> {
      // Tauri maps camelCase args to the Rust snake_case parameters.
      const raw = await call(PURCHASES_PURCHASE_PACKAGE_COMMAND, {
        offeringId,
        packageId,
      });
      return raw as PurchaseTransportPurchaseResult;
    },
    async restorePurchases(): Promise<PurchaseCustomerState> {
      const raw = await call(PURCHASES_RESTORE_PURCHASES_COMMAND);
      return raw as PurchaseCustomerState;
    },
    async logIn(appUserId: string): Promise<PurchaseCustomerState> {
      const raw = await call(PURCHASES_LOG_IN_COMMAND, { appUserId });
      return raw as PurchaseCustomerState;
    },
    async logOut(): Promise<PurchaseCustomerState> {
      const raw = await call(PURCHASES_LOG_OUT_COMMAND);
      return raw as PurchaseCustomerState;
    },
  };
}

/** Host object for the native shell: capability definition + service. */
export function createNativePurchases(
  call: NativePurchaseInvoke = invoke,
): PurchaseHost {
  return createPurchaseHost({
    transport: createNativePurchaseTransport(call),
  });
}

/**
 * Bootstrap ordering:
 *
 * ```text
 * create PurchaseService → subscribe to customer-info events →
 * configure RevenueCat → refresh() (get_customer_info) → receive updates
 * ```
 *
 * Subscribe before seeding so a delegate update that lands between the
 * two is applied in order instead of racing the seed. Returns an
 * unsubscriber for the native event channel.
 *
 * The public SDK key is optional: when present and non-blank it is
 * forwarded once to the native `configure` command (canonical source:
 * `VITE_FROGLIGHT_REVENUECAT_PUBLIC_KEY` from `apps/native/.env`, via
 * `main.ts`). A missing or rejected key keeps the existing best-effort
 * behavior — the store seeds unready and later delegate updates still
 * apply.
 */
export async function seedPurchasesFromNative(
  service: PurchaseService,
  options: {
    readonly apiKey?: string;
    readonly call?: NativePurchaseInvoke;
    readonly listen?: NativePurchaseListen;
  } = {},
): Promise<NativePurchaseUnlisten> {
  const call = options.call ?? invoke;
  const listen = options.listen ?? defaultListen;
  // Best-effort event channel: a failed `addPluginListener` (missing
  // `register_listener` permission, unsupported host, transient IPC
  // failure) must never block `configure` + initial `refresh`. The store
  // still seeds through `get_customer_info`; later delegate updates apply
  // only if the channel is live.
  let stop: NativePurchaseUnlisten = () => {};
  try {
    stop = await listen(PURCHASES_CUSTOMER_EVENT, (payload) => {
      service.handleNativeEvent('customerInfo', payload);
    });
  } catch {
    // Listener unavailable — continue with configure + refresh below.
  }
  const apiKey = options.apiKey?.trim();
  if (apiKey) {
    try {
      await call(PURCHASES_CONFIGURE_COMMAND, { apiKey });
    } catch {
      // Best-effort: a failed runtime configure (unsupported host,
      // rejected key, transient IPC failure) never breaks boot; the
      // refresh below reports the backend state as usual.
    }
  }
  try {
    await service.refresh();
  } catch {
    // Seeding is best-effort: an unconfigured backend (no public SDK key
    // in `VITE_FROGLIGHT_REVENUECAT_PUBLIC_KEY`) or a transient IPC failure
    // leaves the store unready with a snapshot error instead of breaking
    // boot. The event channel stays live for later updates.
  }
  return stop;
}
