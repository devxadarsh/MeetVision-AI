// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "parakeet-coreml",
    platforms: [
        // FluidAudio 0.16.x requires macOS 14. This raises the helper's minimum
        // above the project's stated macOS 13+ target; the Electron shell can
        // still run on macOS 13 and simply report the Core ML runtime as absent.
        .macOS(.v14)
    ],
    dependencies: [
        // `traits: []` opts out of FluidAudio's optional inverse-text-normalization
        // engine (NemoTextProcessing). We only need ASR, and dropping the engine
        // avoids an extra binary-artifact download at build time.
        // Requires Swift 6.2+.
        .package(
            url: "https://github.com/FluidInference/FluidAudio.git",
            from: "0.12.4",
            traits: []
        )
    ],
    targets: [
        .executableTarget(
            name: "parakeet-coreml",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio")
            ],
            path: "Sources/parakeet-coreml"
        )
    ]
)