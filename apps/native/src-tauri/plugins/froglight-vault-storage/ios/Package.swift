// swift-tools-version:5.3
import PackageDescription

let package = Package(
    name: "froglight-vault-storage",
    platforms: [.iOS(.v14)],
    products: [
        .library(name: "froglight-vault-storage", type: .static, targets: ["froglight-vault-storage"]),
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api"),
    ],
    targets: [
        .target(
            name: "froglight-vault-storage",
            dependencies: [.byName(name: "Tauri")],
            path: "Sources"
        ),
    ]
)
