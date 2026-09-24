import AVFoundation
import CoreML
import Foundation
import FluidAudio

// parakeet-coreml
//
// Minimal CLI shim so the Electron main process can run Core ML ASR weights
// through FluidAudio. Contract expected by `CoreMlRuntime`:
//
//   parakeet-coreml --model-dir <dir> --wav <file.wav> [--engine <engine>]
//
// Transcript is written to stdout; diagnostics go to stderr; non-zero exit on
// failure. The Electron app owns downloading, so the helper never touches the
// network.
//
// Engines map 1:1 to `SttCoreMlEngine` in shared/stt-model-catalog.ts.

private enum Engine: String {
    case asrModelsV2 = "asr-models-v2"
    case asrModelsV3 = "asr-models-v3"
    case unifiedBatch = "unified-batch"
    case nemotronStreaming = "nemotron-streaming"
    case nemotronMultilingual = "nemotron-multilingual"
}

private struct Arguments {
    var modelDir = ""
    var modelRoot = ""
    var wavPath = ""
    var engine: Engine = .asrModelsV3
}

private func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("parakeet-coreml: \(message)\n".utf8))
    exit(1)
}

private func parseArguments() -> Arguments {
    var parsed = Arguments()
    var iterator = CommandLine.arguments.dropFirst().makeIterator()

    while let arg = iterator.next() {
        switch arg {
        case "--model-dir":
            guard let value = iterator.next() else { fail("--model-dir requires a value") }
            parsed.modelDir = value
        case "--model-root":
            guard let value = iterator.next() else { fail("--model-root requires a value") }
            parsed.modelRoot = value
        case "--wav":
            guard let value = iterator.next() else { fail("--wav requires a value") }
            parsed.wavPath = value
        case "--engine":
            guard let value = iterator.next() else { fail("--engine requires a value") }
            guard let engine = Engine(rawValue: value) else {
                fail("unknown --engine '\(value)'")
            }
            parsed.engine = engine
        case "-h", "--help":
            print("usage: parakeet-coreml --model-dir <dir> --wav <file.wav> [--engine <engine>] [--model-root <subdir>]")
            print("engines: \(Engine.asrModelsV2.rawValue), \(Engine.asrModelsV3.rawValue), " +
                "\(Engine.unifiedBatch.rawValue), \(Engine.nemotronStreaming.rawValue), " +
                "\(Engine.nemotronMultilingual.rawValue)")
            exit(0)
        default:
            fail("unknown argument: \(arg)")
        }
    }

    if parsed.modelDir.isEmpty { fail("missing --model-dir") }
    if parsed.wavPath.isEmpty { fail("missing --wav") }
    return parsed
}

private func makePcmBuffer(samples: [Float], sampleRate: Double = 16000) throws -> AVAudioPCMBuffer {
    guard
        let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: sampleRate,
            channels: 1,
            interleaved: false
        )
    else {
        throw NSError(domain: "parakeet-coreml", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "could not create 16 kHz mono float32 format"
        ])
    }
    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)) else {
        throw NSError(domain: "parakeet-coreml", code: 2, userInfo: [
            NSLocalizedDescriptionKey: "could not allocate PCM buffer"
        ])
    }
    buffer.frameLength = AVAudioFrameCount(samples.count)
    guard let channel = buffer.floatChannelData?[0] else {
        throw NSError(domain: "parakeet-coreml", code: 3, userInfo: [
            NSLocalizedDescriptionKey: "PCM buffer has no channel data"
        ])
    }
    samples.withUnsafeBufferPointer { source in
        guard let base = source.baseAddress else { return }
        channel.update(from: base, count: samples.count)
    }
    return buffer
}

private func transcribe(
    engine: Engine,
    modelDirectory: URL,
    wavURL: URL
) async throws -> String {
    let samples = try AudioConverter().resampleAudioFile(wavURL)

    switch engine {
    case .asrModelsV2, .asrModelsV3:
        let version: AsrModelVersion = engine == .asrModelsV2 ? .v2 : .v3
        let models = try AsrModels.loadLocal(from: modelDirectory, version: version)
        let manager = AsrManager(config: .default)
        try await manager.loadModels(models)
        var decoderState = try TdtDecoderState(decoderLayers: version.decoderLayers)
        let result = try await manager.transcribe(samples, decoderState: &decoderState)
        return result.text

    case .unifiedBatch:
        let manager = UnifiedAsrManager()
        try await manager.loadModels(from: modelDirectory)
        return try await manager.transcribe(samples)

    case .nemotronStreaming:
        let manager = StreamingNemotronAsrManager()
        try await manager.loadModels(from: modelDirectory)
        _ = try await manager.process(audioBuffer: try makePcmBuffer(samples: samples))
        return try await manager.finish()

    case .nemotronMultilingual:
        let manager = StreamingNemotronMultilingualAsrManager()
        try await manager.loadModels(from: modelDirectory)
        _ = try await manager.process(samples: samples)
        return try await manager.finish()
    }
}

private let arguments = parseArguments()

// The Electron downloader is the only writer of model files. Refuse any
// implicit network fetch so a missing/incompatible bundle fails loudly instead
// of silently re-downloading a different variant.
ModelHub.offlineMode = true

do {
    let modelDirectory = URL(fileURLWithPath: arguments.modelDir, isDirectory: true)
    guard FileManager.default.fileExists(atPath: modelDirectory.path) else {
        fail("model directory does not exist: \(modelDirectory.path)")
    }

    // Some repos nest one variant under a subdirectory, and FluidAudio expects
    // that variant's own directory (it reads metadata.json from the given path).
    let resolvedRoot = arguments.modelRoot.isEmpty
        ? modelDirectory
        : modelDirectory.appendingPathComponent(arguments.modelRoot, isDirectory: true)
    guard FileManager.default.fileExists(atPath: resolvedRoot.path) else {
        fail("model root does not exist: \(resolvedRoot.path) (--model-root \(arguments.modelRoot))")
    }

    let wavURL = URL(fileURLWithPath: arguments.wavPath)
    guard FileManager.default.fileExists(atPath: wavURL.path) else {
        fail("wav file does not exist: \(wavURL.path)")
    }

    let text = try await transcribe(
        engine: arguments.engine,
        modelDirectory: resolvedRoot,
        wavURL: wavURL
    )
    // Core ML's E5RT runtime writes its own diagnostics to stdout without a
    // trailing newline (e.g. "E5RT ... zero shape error."), which would be
    // concatenated onto the transcript. Delimit the payload so the caller can
    // extract it regardless of surrounding noise.
    // Must stay in sync with coreml-runtime.ts.
    print("<<<MEETVISION_TRANSCRIPT>>>\(text)<<<END_MEETVISION_TRANSCRIPT>>>")
} catch {
    fail("\(error)")
}