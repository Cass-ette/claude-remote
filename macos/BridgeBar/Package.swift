// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "BridgeBar",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "BridgeBar"),
        .testTarget(name: "BridgeBarTests", dependencies: ["BridgeBar"]),
    ]
)
