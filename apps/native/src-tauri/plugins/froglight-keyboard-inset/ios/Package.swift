// swift-tools-version:5.3
import PackageDescription

let package = Package(
    name: "froglight-keyboard-inset",
    platforms: [.iOS(.v14)],
    products: [
        .library(name: "froglight-keyboard-inset", type: .static, targets: ["froglight-keyboard-inset"]),
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api"),
    ],
    targets: [
        .target(
            name: "froglight-keyboard-inset",
            dependencies: [.byName(name: "Tauri")],
            path: "Sources"
        ),
    ]
)
