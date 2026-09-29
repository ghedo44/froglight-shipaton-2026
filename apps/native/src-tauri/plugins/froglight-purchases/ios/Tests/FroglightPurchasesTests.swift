// Froglight purchases — unit tests.
//
// No RevenueCat servers, no StoreKit purchases, no credentials: the fake
// client stands in for every SDK round-trip, and error-mapping tests use
// synthetic `NSError` fixtures. Run in Xcode (or the iOS CI workflow);
// Linux `cargo` builds never compile this target.
import Foundation
import RevenueCat
@testable import froglight_purchases
import XCTest

// MARK: - Fake (mirrors `RevenueCatClient` without touching the SDK)

final class FakeRevenueCatClient: RevenueCatClient {
    var isConfigured = true

    func configure(apiKey: String) throws {}

    func attachDelegate(_ delegate: PurchasesDelegate) {}

    var customer = CustomerInfoDTO(
        appUserId: "anon-test-user",
        activeEntitlementIds: [],
        entitlements: [
            "pro": PurchaseEntitlementDTO(
                active: false, productId: nil, expirationDate: nil, willRenew: nil),
        ]
    )
    var offerings: [PurchaseOfferingDTO] = [
        PurchaseOfferingDTO(
            id: "default",
            packages: [
                PurchasePackageDTO(
                    id: "$rc_monthly",
                    kind: .monthly,
                    product: PurchaseProductDTO(
                        id: "froglight_pro_monthly",
                        title: "Froglight Pro Monthly",
                        description: "Monthly subscription",
                        price: PurchasePriceDTO(
                            formatted: "$4.99", currencyCode: "USD", amountMicros: 4_990_000),
                        period: .month)),
                PurchasePackageDTO(
                    id: "$rc_annual",
                    kind: .annual,
                    product: PurchaseProductDTO(
                        id: "froglight_pro_annual",
                        title: "Froglight Pro Annual",
                        description: "Annual subscription",
                        price: PurchasePriceDTO(
                            formatted: "$49.99", currencyCode: "USD", amountMicros: 49_990_000),
                        period: .year)),
            ])
    ]
    var purchaseOutcome: PurchaseOutcomeDTO?
    var thrown: Error?

    private func maybeThrow() throws {
        if let thrown = thrown { throw thrown }
    }

    func getCustomerInfo() async throws -> CustomerInfoDTO {
        try maybeThrow()
        return customer
    }

    func getOfferings() async throws -> [PurchaseOfferingDTO] {
        try maybeThrow()
        return offerings
    }

    func purchasePackage(offeringId: String, packageId: String) async throws -> PurchaseOutcomeDTO {
        try maybeThrow()
        if let outcome = purchaseOutcome { return outcome }
        guard offerings.contains(where: { $0.id == offeringId }),
            offerings.flatMap({ $0.packages }).contains(where: { $0.id == packageId })
        else {
            throw FroglightWireError(code: FroglightPurchaseWireCode.invalidPackage, message: "unknown package")
        }
        var upgraded = customer
        upgraded.activeEntitlementIds = ["pro"]
        upgraded.entitlements["pro"] = PurchaseEntitlementDTO(
            active: true,
            productId: "froglight_pro_annual",
            expirationDate: "2027-09-30T00:00:00.000Z",
            willRenew: true)
        customer = upgraded
        return PurchaseOutcomeDTO(cancelled: false, customer: upgraded)
    }

    func restorePurchases() async throws -> CustomerInfoDTO {
        try maybeThrow()
        return customer
    }

    func logIn(appUserId: String) async throws -> CustomerInfoDTO {
        try maybeThrow()
        var next = customer
        next.appUserId = appUserId
        customer = next
        return next
    }

    func logOut() async throws -> CustomerInfoDTO {
        try maybeThrow()
        return customer
    }
}

// MARK: - DTO contract

final class PurchaseMappingTests: XCTestCase {
    func testCustomerDTOUsesCamelCaseKeys() throws {
        let customer = CustomerInfoDTO(
            appUserId: "anon-1",
            activeEntitlementIds: ["pro"],
            entitlements: [
                "pro": PurchaseEntitlementDTO(
                    active: true,
                    productId: "froglight_pro_annual",
                    expirationDate: "2027-09-30T00:00:00.000Z",
                    willRenew: true),
            ])
        let dictionary = customer.froglightDictionary
        XCTAssertEqual(dictionary["appUserId"] as? String, "anon-1")
        XCTAssertEqual(dictionary["activeEntitlementIds"] as? [String], ["pro"])
        let entitlements = try XCTUnwrap(dictionary["entitlements"] as? [String: Any])
        let pro = try XCTUnwrap(entitlements["pro"] as? [String: Any])
        XCTAssertEqual(pro["productId"] as? String, "froglight_pro_annual")
        XCTAssertEqual(pro["expirationDate"] as? String, "2027-09-30T00:00:00.000Z")
        XCTAssertEqual(pro["willRenew"] as? Bool, true)
    }

    func testOfferingDTOEncodesKindsAndPeriods() throws {
        let fake = FakeRevenueCatClient()
        let data = try JSONEncoder().encode(fake.offerings)
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        XCTAssertEqual(json.count, 1)
        let packages = try XCTUnwrap(json[0]["packages"] as? [[String: Any]])
        XCTAssertEqual(packages.count, 2)
        let kinds = Set(packages.compactMap { $0["kind"] as? String })
        XCTAssertEqual(kinds, ["monthly", "annual"])
        let periods = Set(
            packages.compactMap { ($0["product"] as? [String: Any])?["period"] as? String })
        XCTAssertEqual(periods, ["month", "year"])
    }

    func testOutcomeModelsCancellationExplicitly() {
        let outcome = PurchaseOutcomeDTO(cancelled: true, customer: nil)
        let dictionary = outcome.froglightDictionary
        XCTAssertEqual(dictionary["cancelled"] as? Bool, true)
        XCTAssertTrue(dictionary["customer"] is NSNull)
    }

    func testExpirationEncoding() {
        XCTAssertNil(froglightISO8601String(nil))
        let date = Date(timeIntervalSince1970: 1_820_000_000)
        let encoded = try? XCTUnwrap(froglightISO8601String(date))
        XCTAssertNotNil(encoded)
    }
}

// MARK: - Client seam behavior (no SDK)

final class FakeClientTests: XCTestCase {
    func testPurchaseSuccessActivatesEntitlement() async throws {
        let fake = FakeRevenueCatClient()
        XCTAssertTrue(fake.customer.activeEntitlementIds.isEmpty)
        let outcome = try await fake.purchasePackage(offeringId: "default", packageId: "$rc_annual")
        XCTAssertFalse(outcome.cancelled)
        XCTAssertEqual(outcome.customer?.activeEntitlementIds, ["pro"])
    }

    func testPurchaseRejectsUnknownIdentifiers() async {
        let fake = FakeRevenueCatClient()
        do {
            _ = try await fake.purchasePackage(offeringId: "default", packageId: "$rc_nope")
            XCTFail("unknown package must throw")
        } catch let wire as FroglightWireError {
            XCTAssertEqual(wire.code, FroglightPurchaseWireCode.invalidPackage)
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    func testCancellationPreservesPriorState() async throws {
        let fake = FakeRevenueCatClient()
        fake.purchaseOutcome = PurchaseOutcomeDTO(cancelled: true, customer: fake.customer)
        let outcome = try await fake.purchasePackage(offeringId: "default", packageId: "$rc_monthly")
        XCTAssertTrue(outcome.cancelled)
        XCTAssertTrue(fake.customer.activeEntitlementIds.isEmpty)
    }

    func testRestoreReturnsAuthoritativeState() async throws {
        let fake = FakeRevenueCatClient()
        let restored = try await fake.restorePurchases()
        XCTAssertEqual(restored.appUserId, "anon-test-user")
    }

    func testLogInAssociatesStableIdentity() async throws {
        let fake = FakeRevenueCatClient()
        let next = try await fake.logIn(appUserId: "froglight-account-uuid-1")
        XCTAssertEqual(next.appUserId, "froglight-account-uuid-1")
    }

    /// Regression: after `Purchases.logIn(firebaseUid)` the
    /// reported `PurchaseCustomerState.appUserId` must equal the Firebase
    /// UID, never the pre-login anonymous `originalAppUserId`.
    ///
    /// Production guarantees this because `froglightCustomerDTO(from:)`
    /// takes an explicit `currentAppUserId` (`Purchases.shared.appUserID`
    /// / `purchases.appUserID`) instead of reading
    /// `customerInfo.originalAppUserId`. This fake-level test pins the
    /// contract end to end: identify with a Firebase UID → that UID is
    /// reported as the active account ID.
    func testLogInReportsFirebaseUidAsCurrentAppUserId() async throws {
        let fake = FakeRevenueCatClient()
        XCTAssertEqual(fake.customer.appUserId, "anon-test-user")
        let firebaseUid = "abc123"
        let next = try await fake.logIn(appUserId: firebaseUid)
        XCTAssertEqual(next.appUserId, firebaseUid)
        XCTAssertEqual(fake.customer.appUserId, firebaseUid)
    }
}

// MARK: - Error mapping (synthetic fixtures, no SDK)

final class PurchaseErrorMappingTests: XCTestCase {
    func testNetworkAndStoreDomainsMap() {
        let network = NSError(domain: NSURLErrorDomain, code: NSURLErrorNotConnectedToInternet)
        XCTAssertEqual(
            froglightPurchaseErrorCode(for: network), FroglightPurchaseWireCode.network)
        let store = NSError(domain: "SKErrorDomain", code: 0)
        XCTAssertEqual(
            froglightPurchaseErrorCode(for: store), FroglightPurchaseWireCode.storeUnavailable)
    }

    func testUnknownErrorsDegrade() {
        let weird = NSError(domain: "SomeFutureDomain", code: 9999)
        XCTAssertEqual(
            froglightPurchaseErrorCode(for: weird), FroglightPurchaseWireCode.unknown)
    }

    func testWireMessagePrefixesCode() {
        let error = NSError(
            domain: "SomeFutureDomain", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "boom"])
        let message = froglightWireMessage(code: FroglightPurchaseWireCode.unknown, error)
        XCTAssertTrue(message.hasPrefix("UNKNOWN "))
        XCTAssertTrue(message.contains("boom"))
    }
}
