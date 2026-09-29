// Froglight purchases — iOS host.
//
// RevenueCat configuration happens exactly once (`configure`, canonically
// forwarded at runtime from the WebView via the Rust `configure` IPC
// command with the public SDK key from `VITE_FROGLIGHT_REVENUECAT_PUBLIC_KEY`,
// with a `tauri.conf.json` `apiKey` as a legacy setup-time fallback).
// Commands resolve semantic identifiers against current offerings, purchase through
// RevenueCat (StoreKit sheet presents natively), and return normalized
// Froglight DTOs. `PurchasesDelegate` customer-info updates fan out over
// the standard Tauri plugin event channel — low frequency, so no
// direct-eval fast path (that optimization exists for stylus/keyboard
// latency, not for purchase state).
//
// Never logged or serialized: receipts, credentials, private keys, the
// SDK key itself. Only the DTOs in `Models.swift` cross the bridge.
import RevenueCat
import Tauri
import WebKit

/// JS event for refreshed purchase state. Subscribe from the webview with
/// `addPluginListener('froglight-purchases', 'customer-info-updated', …)`.
/// Bootstrap still queries `getCustomerInfo` after subscribing so a
/// load-time update that fired first is recovered as state, never lost.
let froglightCustomerInfoEvent = "customer-info-updated"

final class ConfigureArgs: Decodable {
    var apiKey: String?
}

final class PurchasePackageArgs: Decodable {
    var offeringId: String?
    var packageId: String?
}

final class LogInArgs: Decodable {
    var appUserId: String?
}

final class FroglightPurchasesPlugin: Plugin {
    private var client: RevenueCatClient = RevenueCatSDKClient()

    #if DEBUG
        /// Test seam: swap the SDK client for a fake (unit tests only).
        func injectClientForTests(_ client: RevenueCatClient) {
            self.client = client
        }
    #endif

    public override func load(webview: WKWebView) {
        // Attach the delegate lazily on configure: setting it here would
        // read `Purchases.shared` before the SDK exists. Customer state is
        // always recoverable through `getCustomerInfo`, so nothing is lost
        // by waiting for the one-time configuration.
    }

    // MARK: - Commands

    /// One-time RevenueCat configuration (public SDK key only).
    @objc public func configure(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(ConfigureArgs.self)
        guard let key = args.apiKey?.trimmingCharacters(in: .whitespacesAndNewlines),
            !key.isEmpty
        else {
            invoke.reject("\(FroglightPurchaseWireCode.notConfigured) RevenueCat API key is missing")
            return
        }
        do {
            try client.configure(apiKey: key)
            client.attachDelegate(self)
            invoke.resolve()
        } catch FroglightPurchaseConfigError.alreadyConfigured {
            invoke.reject("\(FroglightPurchaseWireCode.configuration) RevenueCat is already configured")
        } catch {
            invoke.reject(froglightWireMessage(code: FroglightPurchaseWireCode.configuration, error))
        }
    }

    @objc public func getCustomerInfo(_ invoke: Invoke) throws {
        guard client.isConfigured else {
            invoke.reject("\(FroglightPurchaseWireCode.notConfigured) RevenueCat API key is not configured")
            return
        }
        Task {
            do {
                let customer = try await self.client.getCustomerInfo()
                invoke.resolve(customer)
            } catch let wire as FroglightWireError {
                invoke.reject("\(wire.code) \(wire.message)")
            } catch {
                invoke.reject(froglightWireMessage(code: FroglightPurchaseWireCode.unknown, error))
            }
        }
    }

    @objc public func getOfferings(_ invoke: Invoke) throws {
        guard client.isConfigured else {
            invoke.reject("\(FroglightPurchaseWireCode.notConfigured) RevenueCat API key is not configured")
            return
        }
        Task {
            do {
                // Resolved as the bare array: Rust `run_mobile_plugin`
                // deserializes it straight into `Vec<NativeOffering>`.
                let offerings = try await self.client.getOfferings()
                invoke.resolve(offerings)
            } catch let wire as FroglightWireError {
                invoke.reject("\(wire.code) \(wire.message)")
            } catch {
                invoke.reject(froglightWireMessage(code: FroglightPurchaseWireCode.unknown, error))
            }
        }
    }

    @objc public func purchasePackage(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(PurchasePackageArgs.self)
        guard client.isConfigured else {
            invoke.reject("\(FroglightPurchaseWireCode.notConfigured) RevenueCat API key is not configured")
            return
        }
        guard let offeringId = args.offeringId, !offeringId.isEmpty else {
            invoke.reject("\(FroglightPurchaseWireCode.invalidOffering) offering id must not be empty")
            return
        }
        guard let packageId = args.packageId, !packageId.isEmpty else {
            invoke.reject("\(FroglightPurchaseWireCode.invalidPackage) package id must not be empty")
            return
        }
        Task {
            do {
                let outcome = try await self.client.purchasePackage(
                    offeringId: offeringId, packageId: packageId)
                invoke.resolve(outcome)
            } catch let wire as FroglightWireError {
                invoke.reject("\(wire.code) \(wire.message)")
            } catch {
                invoke.reject(froglightWireMessage(code: FroglightPurchaseWireCode.unknown, error))
            }
        }
    }

    @objc public func restorePurchases(_ invoke: Invoke) throws {
        guard client.isConfigured else {
            invoke.reject("\(FroglightPurchaseWireCode.notConfigured) RevenueCat API key is not configured")
            return
        }
        Task {
            do {
                let customer = try await self.client.restorePurchases()
                invoke.resolve(customer)
            } catch let wire as FroglightWireError {
                invoke.reject("\(wire.code) \(wire.message)")
            } catch {
                invoke.reject(froglightWireMessage(code: FroglightPurchaseWireCode.unknown, error))
            }
        }
    }

    @objc public func logIn(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(LogInArgs.self)
        guard client.isConfigured else {
            invoke.reject("\(FroglightPurchaseWireCode.notConfigured) RevenueCat API key is not configured")
            return
        }
        guard let appUserId = args.appUserId, !appUserId.isEmpty else {
            invoke.reject("\(FroglightPurchaseWireCode.configuration) app user id must not be empty")
            return
        }
        Task {
            do {
                let customer = try await self.client.logIn(appUserId: appUserId)
                invoke.resolve(customer)
            } catch let wire as FroglightWireError {
                invoke.reject("\(wire.code) \(wire.message)")
            } catch {
                invoke.reject(froglightWireMessage(code: FroglightPurchaseWireCode.unknown, error))
            }
        }
    }

    @objc public func logOut(_ invoke: Invoke) throws {
        guard client.isConfigured else {
            invoke.reject("\(FroglightPurchaseWireCode.notConfigured) RevenueCat API key is not configured")
            return
        }
        Task {
            do {
                let customer = try await self.client.logOut()
                invoke.resolve(customer)
            } catch let wire as FroglightWireError {
                invoke.reject("\(wire.code) \(wire.message)")
            } catch {
                invoke.reject(froglightWireMessage(code: FroglightPurchaseWireCode.unknown, error))
            }
        }
    }

    // MARK: - Delegate fan-out

    private func emitCustomerInfo(_ customer: CustomerInfoDTO) {
        // `trigger` evaluates JS in the WebView: always hop to main.
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            // `trigger(data:)` takes a `JSObject` (`[String: JSValue]`), not
            // `[String: Any]`: coerce through Tauri's helper. JSON-sourced
            // values are always coercible; a nil result drops the event
            // instead of crashing the delegate fan-out.
            guard
                let data = JSTypes.coerceDictionaryToJSObject(
                    customer.froglightDictionary as NSDictionary)
            else {
                return
            }
            self.trigger(froglightCustomerInfoEvent, data: data)
        }
    }
}

extension FroglightPurchasesPlugin: PurchasesDelegate {
    func purchases(_ purchases: Purchases, receivedUpdated customerInfo: CustomerInfo) {
        emitCustomerInfo(
            froglightCustomerDTO(
                from: customerInfo,
                currentAppUserId: purchases.appUserID,
            ),
        )
    }
}

@_cdecl("init_plugin_froglight_purchases")
func initPluginFroglightPurchases() -> Plugin {
    return FroglightPurchasesPlugin()
}
