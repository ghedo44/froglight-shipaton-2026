// Froglight purchase DTOs — iOS side.
//
// Platform-neutral shapes shared with the Rust models (`src/models.rs`)
// and the foundation contract (`packages/foundation/src/purchases/`).
// This file is intentionally RevenueCat-free so DTO coding stays
// unit-testable without the SDK: translation from SDK types lives in
// `RevenueCatClient.swift`, and the plugin only moves these DTOs.
import Foundation

/// Localized price. `formatted` is authoritative (never hardcoded in UI);
/// `amountMicros` is best-effort and omitted when the store reports none.
struct PurchasePriceDTO: Codable, Equatable {
    var formatted: String
    var currencyCode: String?
    var amountMicros: Int64?
}

/// Subscription period, or nil for one-time/unknown — never guessed.
enum PurchasePeriodDTO: String, Codable {
    case week
    case month
    case twoMonths
    case threeMonths
    case sixMonths
    case year
}

struct PurchaseProductDTO: Codable, Equatable {
    var id: String
    var title: String
    var description: String
    var price: PurchasePriceDTO
    var period: PurchasePeriodDTO?
}

enum PurchasePackageKindDTO: String, Codable {
    case weekly
    case monthly
    case twoMonth
    case threeMonth
    case sixMonth
    case annual
    case lifetime
    case custom
}

struct PurchasePackageDTO: Codable, Equatable {
    var id: String
    var kind: PurchasePackageKindDTO
    var product: PurchaseProductDTO
}

struct PurchaseOfferingDTO: Codable, Equatable {
    var id: String
    var packages: [PurchasePackageDTO]
}

struct PurchaseEntitlementDTO: Codable, Equatable {
    var active: Bool
    var productId: String?
    var expirationDate: String?
    var willRenew: Bool?
}

struct CustomerInfoDTO: Codable, Equatable {
    var appUserId: String
    var activeEntitlementIds: [String]
    var entitlements: [String: PurchaseEntitlementDTO]
}

/// Purchase outcome. Cancellation is a first-class value, never an error:
/// `cancelled` carries the previous customer state (or nil when none was
/// available) so the paywall stays usable without an error message.
struct PurchaseOutcomeDTO: Codable, Equatable {
    var cancelled: Bool
    var customer: CustomerInfoDTO?
}

private let froglightISO8601: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
}()

/// Canonical expiration encoding shared by every entitlement translation.
func froglightISO8601String(_ date: Date?) -> String? {
    guard let date = date else { return nil }
    return froglightISO8601.string(from: date)
}

extension Encodable {
    /// Dictionary form for `Invoke.resolve` / `trigger(data:)`. Uses JSON
    /// as the canonical bridge so key casing (`currencyCode`,
    /// `appUserId`) matches the Rust camelCase contract exactly.
    var froglightDictionary: [String: Any] {
        guard let data = try? JSONEncoder().encode(self),
            let object = try? JSONSerialization.jsonObject(with: data),
            let dictionary = object as? [String: Any]
        else {
            return [:]
        }
        return dictionary
    }
}
