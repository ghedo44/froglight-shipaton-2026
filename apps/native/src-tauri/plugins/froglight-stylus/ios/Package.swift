// swift-tools-version:5.3
import PackageDescription

let package = Package(
    name: "froglight-stylus",
    platforms: [.iOS(.v14)],
    products: [
        .library(name: "froglight-stylus", type: .static, targets: ["froglight-stylus"]),
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api"),
    ],
    targets: [
        .target(
            name: "froglight-stylus",
            dependencies: [.byName(name: "Tauri")],
            path: "Sources"
        ),
    ]
)
