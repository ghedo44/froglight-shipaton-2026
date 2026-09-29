// RevenueCat client seam — iOS side.
//
// Every command funnels through `RevenueCatClient` so plugin behavior is
// testable without performing purchases: production uses
// `RevenueCatSDKClient`, unit tests inject `FakeRevenueCatClient` (see
// `Tests/`). The SDK remains an implementation provider, never the
// architecture — the plugin only sees DTOs from `Models.swift`.
import Foundation
import RevenueCat

/// Stable wire codes shared with Rust (`src/error.rs`) and foundation
/// (`packages/foundation/src/purchases/errors.ts`). Swift rejects with
/// `"CODE human message"`; Rust trusts the leading token only when it is
/// one of these codes and degrades anything else to `UNKNOWN`.
enum FroglightPurchaseWireCode {
    static let notConfigured = "NOT_CONFIGURED"
    static let network = "NETWORK"
    static let storeUnavailable = "STORE_UNAVAILABLE"
    static let productUnavailable = "PRODUCT_UNAVAILABLE"
    static let purchaseNotAllowed = "PURCHASE_NOT_ALLOWED"
    static let invalidOffering = "INVALID_OFFERING"
    static let invalidPackage = "INVALID_PACKAGE"
    static let receiptInvalid = "RECEIPT_INVALID"
    static let configuration = "CONFIGURATION"
    static let unknown = "UNKNOWN"
    /// Sentinel for user cancellation. Never rejected: callers translate
    /// it into `PurchaseOutcomeDTO(cancelled: true)` instead of an error.
    static let cancelled = "CANCELLED"
}

/// Commerce operations behind the plugin commands. DTOs in, DTOs out —
/// no RevenueCat type crosses this protocol, so fakes stay trivial.
/// Lifecycle (`isConfigured` / `configure` / `attachDelegate`) is part of
/// the protocol so the plugin never downcasts to the SDK client.
protocol RevenueCatClient: AnyObject {
    var isConfigured: Bool { get }
    func configure(apiKey: String) throws
    func attachDelegate(_ delegate: PurchasesDelegate)
    func getCustomerInfo() async throws -> CustomerInfoDTO
    func getOfferings() async throws -> [PurchaseOfferingDTO]
    func purchasePackage(offeringId: String, packageId: String) async throws -> PurchaseOutcomeDTO
    func restorePurchases() async throws -> CustomerInfoDTO
    func logIn(appUserId: String) async throws -> CustomerInfoDTO
    func logOut() async throws -> CustomerInfoDTO
}

/// Map a thrown SDK/transport error to a stable wire code (or the
/// `CANCELLED` sentinel). The `as?` casts always compile; unknown and
/// future errors degrade to `UNKNOWN` with the message preserved.
func froglightPurchaseErrorCode(for error: Error) -> String {
    if let code = error as? ErrorCode {
        switch code {
        case .purchaseCancelledError:
            return FroglightPurchaseWireCode.cancelled
        case .networkError:
            return FroglightPurchaseWireCode.network
        case .storeProblemError:
            return FroglightPurchaseWireCode.storeUnavailable
        case .purchaseNotAllowedError:
            return FroglightPurchaseWireCode.purchaseNotAllowed
        case .purchaseInvalidError:
            return FroglightPurchaseWireCode.invalidPackage
        case .productNotAvailableForPurchaseError:
            return FroglightPurchaseWireCode.productUnavailable
        case .productAlreadyPurchasedError,
            .receiptAlreadyInUseError,
            .invalidReceiptError,
            .missingReceiptFileError:
            return FroglightPurchaseWireCode.receiptInvalid
        case .invalidCredentialsError,
            .operationAlreadyInProgressForProductError,
            .configurationError,
            .unsupportedError:
            return FroglightPurchaseWireCode.configuration
        @unknown default:
            return FroglightPurchaseWireCode.unknown
        }
    }
    let nsError = error as NSError
    if nsError.domain == NSURLErrorDomain {
        return FroglightPurchaseWireCode.network
    }
    if nsError.domain == "SKErrorDomain" {
        return FroglightPurchaseWireCode.storeUnavailable
    }
    // Legacy cancellation signal (pre-4.x SDKs threw instead of returning
    // `userCancelled`): RevenueCat's cancelled code in its error domain.
    if nsError.domain.contains("RevenueCat") || nsError.domain.contains("RCPurchases"),
        nsError.code == ErrorCode.purchaseCancelledError.rawValue
    {
        return FroglightPurchaseWireCode.cancelled
    }
    return FroglightPurchaseWireCode.unknown
}

/// Prefix an error message with its wire code for the Rust boundary.
func froglightWireMessage(code: String, _ error: Error) -> String {
    let detail = (error as NSError).localizedDescription
    return detail.isEmpty ? code : "\(code) \(detail)"
}

// MARK: - SDK translation (the only place RevenueCat types are touched)

/// Translate SDK `CustomerInfo` into the Froglight DTO.
///
/// `currentAppUserId` must be the **current** RevenueCat identity
/// (`Purchases.shared.appUserID` in production, `purchases.appUserID` in
/// the delegate). Never derive it from `customerInfo.originalAppUserId`:
/// after `logIn(firebaseUid)`, that value remains the pre-login anonymous ID,
/// while the current ID is the Firebase UID. The caller owns reading the
/// current ID so this function stays pure and unit-testable without the
/// SDK singleton.
func froglightCustomerDTO(
    from customerInfo: CustomerInfo,
    currentAppUserId: String,
) -> CustomerInfoDTO {
    var entitlements: [String: PurchaseEntitlementDTO] = [:]
    for (identifier, entitlement) in customerInfo.entitlements.all {
        entitlements[identifier] = PurchaseEntitlementDTO(
            active: entitlement.isActive,
            productId: entitlement.productIdentifier,
            expirationDate: froglightISO8601String(entitlement.expirationDate),
            willRenew: entitlement.willRenew
        )
    }
    // Derive active ids from the authoritative map (never trust a
    // companion list that could disagree with `isActive`).
    var activeIds: [String] = []
    for (identifier, entitlement) in customerInfo.entitlements.all where entitlement.isActive {
        activeIds.append(identifier)
    }
    return CustomerInfoDTO(
        appUserId: currentAppUserId,
        activeEntitlementIds: activeIds.sorted(),
        entitlements: entitlements
    )
}

func froglightPeriodDTO(unit: SubscriptionPeriod.Unit?, value: Int?) -> PurchasePeriodDTO? {
    guard let unit = unit, let value = value else { return nil }
    switch (unit, value) {
    case (.week, 1): return .week
    case (.month, 1): return .month
    case (.month, 2): return .twoMonths
    case (.month, 3): return .threeMonths
    case (.month, 6): return .sixMonths
    case (.year, 1): return .year
    default: return nil
    }
}

func froglightMicros(from price: Decimal) -> Int64? {
    // 10^6 as Decimal without floating-point detours.
    let scaled = price * 1_000_000
    var rounded = Decimal()
    var copy = scaled
    NSDecimalRound(&rounded, &copy, 0, .plain)
    let number = NSDecimalNumber(decimal: rounded)
    if number == NSDecimalNumber.notANumber { return nil }
    return number.int64Value
}

func froglightPackageKindDTO(from packageType: PackageType) -> PurchasePackageKindDTO {
    switch packageType {
    case .unknown:
        // An identifier the SDK does not recognize: bucket as custom
        // rather than guessing a billing cadence.
        return .custom
    case .weekly: return .weekly
    case .monthly: return .monthly
    case .twoMonth: return .twoMonth
    case .threeMonth: return .threeMonth
    case .sixMonth: return .sixMonth
    case .annual: return .annual
    case .lifetime: return .lifetime
    case .custom: return .custom
    @unknown default: return .custom
    }
}

func froglightProductDTO(from product: StoreProduct) -> PurchaseProductDTO {
    PurchaseProductDTO(
        id: product.productIdentifier,
        title: product.localizedTitle,
        description: product.localizedDescription,
        price: PurchasePriceDTO(
            formatted: product.localizedPriceString,
            currencyCode: product.currencyCode,
            amountMicros: froglightMicros(from: product.price)
        ),
        period: froglightPeriodDTO(
            unit: product.subscriptionPeriod?.unit,
            value: product.subscriptionPeriod?.value
        )
    )
}

/// Present the StoreKit sheet from the main actor. `MainActor.run` only
/// accepts a synchronous closure, so the async SDK purchase call lives in
/// this `@MainActor` helper instead.
@MainActor
func froglightPurchaseOnMainActor(package: Package) async throws -> PurchaseResultData {
    try await Purchases.shared.purchase(package: package)
}

func froglightPackageDTO(from package: Package) -> PurchasePackageDTO {
    PurchasePackageDTO(
        id: package.identifier,
        kind: froglightPackageKindDTO(from: package.packageType),
        product: froglightProductDTO(from: package.storeProduct)
    )
}

func froglightOfferingDTO(from offering: Offering) -> PurchaseOfferingDTO {
    PurchaseOfferingDTO(
        id: offering.identifier,
        packages: offering.availablePackages.map(froglightPackageDTO(from:))
    )
}

// MARK: - Production client

/// RevenueCat SDK implementation. Configured exactly once via
/// `configure(apiKey:)` — canonically at runtime through the Tauri
/// `configure` IPC command with `VITE_FROGLIGHT_REVENUECAT_PUBLIC_KEY`,
/// with a `tauri.conf.json` `apiKey` as a legacy setup-time fallback;
/// every command guards on `isConfigured` so an unconfigured backend
/// reports `NOT_CONFIGURED` instead of throwing SDK configuration errors
/// at the webview.
final class RevenueCatSDKClient: RevenueCatClient {
    private var configured = false

    var isConfigured: Bool { configured }

    /// Configure RevenueCat exactly once with the public SDK key.
    /// Anonymous (`appUserID = nil`): RevenueCat owns its anonymous
    /// identifier persistence — never generate per-launch ids here.
    func configure(apiKey: String) throws {
        guard !configured else {
            throw FroglightPurchaseConfigError.alreadyConfigured
        }
        #if DEBUG
            Purchases.logLevel = .debug
        #endif
        Purchases.configure(withAPIKey: apiKey)
        configured = true
    }

    func attachDelegate(_ delegate: PurchasesDelegate) {
        Purchases.shared.delegate = delegate
    }

    private func requireConfigured() throws {
        guard configured else {
            throw FroglightPurchaseConfigError.missingApiKey
        }
    }

    func getCustomerInfo() async throws -> CustomerInfoDTO {
        try requireConfigured()
        do {
            let info = try await Purchases.shared.customerInfo()
            return froglightCustomerDTO(
                from: info,
                currentAppUserId: Purchases.shared.appUserID,
            )
        } catch {
            throw froglightWireError(for: error, fallback: FroglightPurchaseWireCode.unknown)
        }
    }

    func getOfferings() async throws -> [PurchaseOfferingDTO] {
        try requireConfigured()
        do {
            let offerings = try await Purchases.shared.offerings()
            return offerings.all.values
                .map(froglightOfferingDTO(from:))
                .sorted { $0.id < $1.id }
        } catch {
            throw froglightWireError(for: error, fallback: FroglightPurchaseWireCode.unknown)
        }
    }

    func purchasePackage(offeringId: String, packageId: String) async throws -> PurchaseOutcomeDTO {
        try requireConfigured()
        guard !offeringId.isEmpty else {
            throw froglightCodedError(
                code: FroglightPurchaseWireCode.invalidOffering, message: "offering id must not be empty")
        }
        guard !packageId.isEmpty else {
            throw froglightCodedError(
                code: FroglightPurchaseWireCode.invalidPackage, message: "package id must not be empty")
        }
        do {
            let offerings = try await Purchases.shared.offerings()
            // Exact identifier match only: falling back to `current` here
            // would hide RevenueCat dashboard misconfiguration.
            guard let offering = offerings.all[offeringId] else {
                throw froglightCodedError(
                    code: FroglightPurchaseWireCode.invalidOffering,
                    message: "unknown offering \(offeringId)")
            }
            guard let package = offering.availablePackages.first(where: { $0.identifier == packageId })
            else {
                throw froglightCodedError(
                    code: FroglightPurchaseWireCode.invalidPackage,
                    message: "unknown package \(packageId) in offering \(offeringId)")
            }
            // The StoreKit sheet must present from the main actor.
            let result = try await froglightPurchaseOnMainActor(package: package)
            if result.userCancelled {
                let current = try? await Purchases.shared.customerInfo()
                let currentId = Purchases.shared.appUserID
                return PurchaseOutcomeDTO(
                    cancelled: true,
                    customer: current.map {
                        froglightCustomerDTO(from: $0, currentAppUserId: currentId)
                    },
                )
            }
            return PurchaseOutcomeDTO(
                cancelled: false,
                customer: froglightCustomerDTO(
                    from: result.customerInfo,
                    currentAppUserId: Purchases.shared.appUserID,
                ),
            )
        } catch let wire as FroglightWireError {
            throw wire
        } catch {
            let code = froglightPurchaseErrorCode(for: error)
            if code == FroglightPurchaseWireCode.cancelled {
                let current = try? await Purchases.shared.customerInfo()
                let currentId = Purchases.shared.appUserID
                return PurchaseOutcomeDTO(
                    cancelled: true,
                    customer: current.map {
                        froglightCustomerDTO(from: $0, currentAppUserId: currentId)
                    },
                )
            }
            throw froglightWireError(for: error, fallback: FroglightPurchaseWireCode.unknown)
        }
    }

    func restorePurchases() async throws -> CustomerInfoDTO {
        try requireConfigured()
        do {
            let info = try await Purchases.shared.restorePurchases()
            return froglightCustomerDTO(
                from: info,
                currentAppUserId: Purchases.shared.appUserID,
            )
        } catch {
            throw froglightWireError(for: error, fallback: FroglightPurchaseWireCode.unknown)
        }
    }

    func logIn(appUserId: String) async throws -> CustomerInfoDTO {
        try requireConfigured()
        guard !appUserId.isEmpty else {
            throw froglightCodedError(
                code: FroglightPurchaseWireCode.configuration, message: "app user id must not be empty")
        }
        do {
            let result = try await Purchases.shared.logIn(appUserId)
            return froglightCustomerDTO(
                from: result.customerInfo,
                currentAppUserId: Purchases.shared.appUserID,
            )
        } catch {
            throw froglightWireError(for: error, fallback: FroglightPurchaseWireCode.unknown)
        }
    }

    func logOut() async throws -> CustomerInfoDTO {
        try requireConfigured()
        do {
            let info = try await Purchases.shared.logOut()
            return froglightCustomerDTO(
                from: info,
                currentAppUserId: Purchases.shared.appUserID,
            )
        } catch {
            throw froglightWireError(for: error, fallback: FroglightPurchaseWireCode.unknown)
        }
    }
}

enum FroglightPurchaseConfigError: Error {
    case missingApiKey
    case alreadyConfigured
}

/// Carrier for an already-coded wire failure (validation before SDK calls).
struct FroglightWireError: Error {
    var code: String
    var message: String
}

func froglightCodedError(code: String, message: String) -> FroglightWireError {
    FroglightWireError(code: code, message: message)
}

/// Wrap an SDK/transport throw into a wire-coded error for `invoke.reject`.
func froglightWireError(for error: Error, fallback: String) -> FroglightWireError {
    if let wire = error as? FroglightWireError { return wire }
    let code = froglightPurchaseErrorCode(for: error)
    let resolved = code == FroglightPurchaseWireCode.cancelled ? fallback : code
    return FroglightWireError(code: resolved, message: froglightWireMessage(code: resolved, error))
}
