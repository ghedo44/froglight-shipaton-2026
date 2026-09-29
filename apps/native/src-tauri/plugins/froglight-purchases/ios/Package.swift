// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "froglight-purchases",
    platforms: [
        // swift-rs invokes SwiftPM from the macOS build host even when the
        // final target is iOS. Match RevenueCat's minimum macOS baseline so
        // SwiftPM can resolve the dependency graph before cross-compiling.
        .macOS(.v10_15),
        .iOS(.v14),
    ],
    products: [
        .library(name: "froglight-purchases", type: .static, targets: ["froglight-purchases"]),
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api"),
        // Reviewed 2026-09-09: RevenueCat iOS SDK 5.x (SPM mirror). Pin the
        // exact release — never track `main` — and review the changelog
        // before bumping. Only the `RevenueCat` product is linked;
        // `RevenueCatUI` is deliberately excluded because React owns
        // paywall presentation).
        .package(url: "https://github.com/RevenueCat/purchases-ios-spm.git", exact: "5.87.1"),
    ],
    targets: [
        .target(
            name: "froglight-purchases",
            dependencies: [
                .byName(name: "Tauri"),
                .product(name: "RevenueCat", package: "purchases-ios-spm"),
            ],
            path: "Sources"
        ),
        .testTarget(
            name: "froglight-purchases-tests",
            dependencies: [.byName(name: "froglight-purchases")],
            path: "Tests"
        ),
    ]
)
