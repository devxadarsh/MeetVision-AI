/**
 * Platform-aware STT model catalog.
 *
 * The Parakeet model ids are stable product ids. The bytes behind them are NOT:
 * macOS runs Core ML weights through a bundled FluidAudio helper, Windows runs
 * INT8 ONNX weights through sherpa-onnx. This module is the single source of
 * truth for both the Electron main process (download + inference) and the
 * Angular settings UI (cards, sizes).
 *
 * This file must stay free of Node built-ins: it is imported by the renderer.
 *
 * macOS entries were derived from FluidAudio 0.16.1 `ModelNames.swift` and
 * `AsrModels.swift`, so the file allowlists match exactly what the loader
 * requires. FluidAudio ships v2/v3 through `AsrModels`, and Unified / Nemotron
 * streaming through their own managers — hence the per-artifact `engine`.
 * Core ML repos are multi-variant, so each artifact pins one variant's files
 * rather than pulling the whole repo.
 */
import type { ParakeetModelType } from './ipc';

export type SttPlatform = 'darwin-arm64' | 'darwin-x64' | 'win32-x64' | 'win32-ia32';

export const STT_PLATFORMS: readonly SttPlatform[] = [
  'darwin-arm64',
  'darwin-x64',
  'win32-x64',
  'win32-ia32',
];

export type SttRuntimeKind = 'coreml' | 'sherpa-onnx' | 'ggml';

/** FluidAudio entry point the helper must use for this artifact. */
export type SttCoreMlEngine =
  | 'asr-models-v2'
  | 'asr-models-v3'
  | 'unified-batch'
  | 'nemotron-streaming'
  | 'nemotron-multilingual';

export interface SttArtifactFile {
  /** Path relative to the HF repo root, and to the local model directory. */
  path: string;
  bytes: number;
}

export interface SttModelArtifact {
  runtime: SttRuntimeKind;
  /** Hugging Face repo id, e.g. `FluidInference/parakeet-tdt-0.6b-v2-coreml`. */
  repo: string;
  /** Git revision used in the resolve URL. */
  revision: string;
  license: string;
  /** Repo requires accepting terms / an HF token. */
  gated: boolean;
  /** Explicit download allowlist (one variant, not the whole repo). */
  files: SttArtifactFile[];
  /** Marker file that must exist for the install to count as complete. */
  sentinel: string;
  /** FluidAudio entry point, required for Core ML artifacts. */
  engine?: SttCoreMlEngine;
  /**
   * Repo-relative subdirectory that FluidAudio must be given as the model root.
   * Some repos nest one variant under `<lang>/<tier>ms/`; FluidAudio expects the
   * variant's own directory (it reads `metadata.json` from the passed path).
   */
  modelRoot?: string;
  /** Caveats surfaced in logs and the settings UI. */
  notes?: string[];
  /** False when the artifact has not been validated on real hardware yet. */
  verified: boolean;
}

export interface SttModelCatalogEntry {
  id: ParakeetModelType;
  name: string;
  subtitle: string;
  icon: string;
  description: string;
  architecture: string;
  parameters: string;
  speed: string;
  ramRequirement: string;
  artifacts: Partial<Record<SttPlatform, SttModelArtifact>>;
}

const REVISION = 'main';

/** Resolve the host platform key. Returns null for unsupported targets. */
export function resolveSttPlatform(platform: string, arch: string): SttPlatform | null {
  if (platform === 'darwin') {
    if (arch === 'arm64') return 'darwin-arm64';
    if (arch === 'x64') return 'darwin-x64';
    return null;
  }
  if (platform === 'win32') {
    if (arch === 'x64') return 'win32-x64';
    if (arch === 'ia32') return 'win32-ia32';
    return null;
  }
  return null;
}

export function getCatalogEntry(id: ParakeetModelType): SttModelCatalogEntry | undefined {
  return STT_MODEL_CATALOG.find((entry) => entry.id === id);
}

export function getModelArtifact(
  id: ParakeetModelType,
  platform: SttPlatform
): SttModelArtifact | undefined {
  return getCatalogEntry(id)?.artifacts[platform];
}

export function artifactTotalBytes(artifact: SttModelArtifact): number {
  return artifact.files.reduce((sum, file) => sum + file.bytes, 0);
}

/** Direct raw download URL for one file inside a HF repo. */
export function artifactFileUrl(artifact: SttModelArtifact, filePath: string): string {
  return `https://huggingface.co/${artifact.repo}/resolve/${artifact.revision}/${filePath}`;
}

export function formatModelBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function f(path: string, bytes: number): SttArtifactFile {
  return { path, bytes };
}

/**
 * A compiled Core ML bundle is a directory of small metadata files plus one
 * large weight blob. All five members are required by Core ML.
 */
function bundle(dir: string, weightBytes: number): SttArtifactFile[] {
  return [
    f(`${dir}/coremldata.bin`, 0),
    f(`${dir}/metadata.json`, 0),
    f(`${dir}/model.mil`, 0),
    f(`${dir}/analytics/coremldata.bin`, 0),
    f(`${dir}/weights/weight.bin`, weightBytes),
  ];
}

function bundleNoMetadata(dir: string, weightBytes: number): SttArtifactFile[] {
  return [
    f(`${dir}/coremldata.bin`, 0),
    f(`${dir}/model.mil`, 0),
    f(`${dir}/analytics/coremldata.bin`, 0),
    f(`${dir}/weights/weight.bin`, weightBytes),
  ];
}

/** Both macOS targets run the same Core ML weights. */
function forDarwin(artifact: SttModelArtifact): Partial<Record<SttPlatform, SttModelArtifact>> {
  return { 'darwin-arm64': artifact, 'darwin-x64': artifact };
}

/** Both Windows targets run the same ONNX weights. */
function forWindows(artifact: SttModelArtifact): Partial<Record<SttPlatform, SttModelArtifact>> {
  return { 'win32-x64': artifact, 'win32-ia32': artifact };
}

const WIN_IA32_NOTE = 'Requires a 32-bit sherpa-onnx binary; availability not yet verified.';

function onnxTransducer(repo: string, encoder: number, decoder: number, joiner: number, tokens: number, notes?: string[]): SttModelArtifact {
  return {
    runtime: 'sherpa-onnx',
    repo,
    revision: REVISION,
    license: 'cc-by-4.0',
    gated: false,
    files: [
      f('encoder.int8.onnx', encoder),
      f('decoder.int8.onnx', decoder),
      f('joiner.int8.onnx', joiner),
      f('tokens.txt', tokens),
    ],
    sentinel: 'encoder.int8.onnx',
    notes,
    verified: false,
  };
}

export const STT_MODEL_CATALOG: SttModelCatalogEntry[] = [
  {
    id: 'parakeet-flash',
    name: 'Parakeet Flash',
    subtitle: 'Ultra-low latency · English',
    icon: '⚡',
    description:
      'Parakeet Unified EN 0.6B. A single checkpoint serves streaming and offline English transcription, tuned for instantaneous live meeting subtitles.',
    architecture: 'FastConformer-Unified-RNNT',
    parameters: '600M',
    speed: 'Lowest latency (streaming, 2.08 s chunk context)',
    ramRequirement: '~1.5 GB RAM',
    artifacts: {
      ...forDarwin({
        runtime: 'coreml',
        repo: 'FluidInference/parakeet-unified-en-0.6b-coreml',
        revision: REVISION,
        license: 'cc-by-4.0',
        gated: false,
        engine: 'unified-batch',
        files: [
          ...bundleNoMetadata('parakeet_unified_encoder_int8.mlmodelc', 595.05e6),
          ...bundleNoMetadata('parakeet_unified_decoder.mlmodelc', 14.43e6),
          ...bundleNoMetadata('parakeet_unified_joint_decision_single_step.mlmodelc', 3.45e6),
          f('vocab.json', 0.02e6),
          f('metadata.json', 0),
        ],
        sentinel: 'parakeet_unified_encoder_int8.mlmodelc/weights/weight.bin',
        notes: [
          'Repo also ships fp16 encoders (~1.19 GB) and streaming-encoder tiers (70_13_13 / 70_2_2 / 70_7_1 / 70_7_7); this allowlist pins the int8 offline encoder used by FluidAudio UnifiedAsrManager (~613 MB).',
          'FluidAudio computes mel features in Swift for this model, so no preprocessor bundle is downloaded.',
          'Utterance-level batch inference (15 s window) is used, not the streaming manager.',
          'Verified end-to-end on darwin-arm64 against real 16 kHz speech. The same weights load on Intel Macs (CPU/GPU, no ANE) but were not run there.',
        ],
        verified: true,
      }),
      ...forWindows(
        onnxTransducer(
          'csukuangfj2/sherpa-onnx-nemo-parakeet-unified-en-0.6b-int8-streaming-1120ms',
          654.05e6,
          7.26e6,
          1.74e6,
          0.01e6
        )
      ),
    },
  },
  {
    id: 'parakeet-tdt-v2',
    name: 'Parakeet TDT v2',
    subtitle: 'Balanced · English',
    icon: '⚖️',
    description:
      'Parakeet TDT 0.6B v2. Token-and-Duration Transducer for fast, high-accuracy English transcription.',
    architecture: 'FastConformer-TDT-v2',
    parameters: '600M',
    speed: '~190x real-time (batch) on M-series',
    ramRequirement: '~1.5 GB RAM',
    artifacts: {
      ...forDarwin({
        runtime: 'coreml',
        repo: 'FluidInference/parakeet-tdt-0.6b-v2-coreml',
        revision: REVISION,
        license: 'cc-by-4.0',
        gated: false,
        engine: 'asr-models-v2',
        files: [
          ...bundle('Preprocessor.mlmodelc', 0.30e6),
          ...bundle('Encoder.mlmodelc', 445.19e6),
          ...bundle('Decoder.mlmodelc', 14.43e6),
          ...bundle('JointDecision.mlmodelc', 3.45e6),
          f('parakeet_vocab.json', 0.02e6),
        ],
        sentinel: 'Encoder.mlmodelc/weights/weight.bin',
        notes: [
          'Repo also contains unused fp16/4-bit alternates (ParakeetEncoder, Melspectrogram, RNNTJoint); the allowlist pins exactly the four bundles FluidAudio 0.16.1 requires for .v2.',
          'Verified end-to-end on darwin-arm64 against real 16 kHz speech. The same weights load on Intel Macs (CPU/GPU, no ANE) but were not run there.',
        ],
        verified: true,
      }),
      ...forWindows(onnxTransducer('csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8', 652.18e6, 7.26e6, 1.74e6, 0.01e6)),
    },
  },
  {
    id: 'parakeet-tdt-v3',
    name: 'Parakeet TDT v3',
    subtitle: 'Multilingual · 25 languages',
    icon: '🌍',
    description:
      'Parakeet TDT 0.6B v3. Multilingual FastConformer for code-switching and global meeting dialogue across 25+ European languages.',
    architecture: 'FastConformer-TDT-v3',
    parameters: '600M',
    speed: '~18x Real-Time (Multilingual)',
    ramRequirement: '~2 GB RAM',
    artifacts: {
      ...forDarwin({
        runtime: 'coreml',
        repo: 'FluidInference/parakeet-tdt-0.6b-v3-coreml',
        revision: REVISION,
        license: 'cc-by-4.0',
        gated: false,
        engine: 'asr-models-v3',
        files: [
          ...bundle('Preprocessor.mlmodelc', 0.49e6),
          ...bundle('Encoder.mlmodelc', 445.19e6),
          ...bundle('Decoder.mlmodelc', 23.60e6),
          ...bundle('JointDecisionv3.mlmodelc', 12.64e6),
          f('parakeet_vocab.json', 0.15e6),
        ],
        sentinel: 'Encoder.mlmodelc/weights/weight.bin',
        notes: [
          'FluidAudio 0.16.1 requires JointDecisionv3.mlmodelc for .v3, and this pins the default .int8 encoder (Encoder.mlmodelc).',
          'FluidAudio documents a right-context token-corruption bug in the 6-bit-LUT Encoder.mlmodelc (issue #760) and ships an opt-in rebuild, Encoder_v2.mlmodelc (~594 MB). Switching to .int8V2 means adding that file and passing encoderPrecision: .int8V2.',
          'Previously this id was mapped to parakeet-tdt_ctc-110m-en.nemo, which was the wrong model.',
          'Verified end-to-end on darwin-arm64 against real 16 kHz speech. The same weights load on Intel Macs (CPU/GPU, no ANE) but were not run there.',
        ],
        verified: true,
      }),
      ...forWindows(onnxTransducer('csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8', 652.18e6, 11.85e6, 6.36e6, 0.09e6)),
    },
  },
  {
    id: 'parakeet-ctc-1.1b',
    name: 'Parakeet 1.1B',
    subtitle: 'Maximum accuracy · Technical',
    icon: '🎯',
    description:
      'NVIDIA flagship FastConformer heavyweight for maximum accuracy and best technical-domain vocabulary recall. Available on Windows only: no FluidAudio-compatible Core ML conversion of the 1.1B model exists.',
    architecture: 'FastConformer-CTC-1.1B',
    parameters: '1.1B',
    speed: '~12x Real-Time (Highest Accuracy)',
    ramRequirement: '~3 GB RAM',
    artifacts: {
      ...forWindows({
        runtime: 'sherpa-onnx',
        repo: 'runanywhere/sherpa-onnx-nemo-parakeet-ctc-1.1b-int8',
        revision: REVISION,
        license: 'cc-by-4.0',
        gated: false,
        files: [f('model.int8.onnx', 1110.01e6), f('tokens.txt', 0.01e6)],
        sentinel: 'model.int8.onnx',
        notes: ['Community ONNX conversion of the original CTC 1.1B.'],
        verified: false,
      }),
    },
  },
  {
    id: 'nemotron-speech-3.5',
    name: 'Nemotron Speech 3.5',
    subtitle: 'Streaming · English',
    icon: '🏢',
    description:
      'NVIDIA Nemotron Speech Streaming EN 0.6B. Streaming RNNT with low-latency partial results and punctuation for live meeting captions.',
    architecture: 'Nemotron-Speech-Streaming-RNNT',
    parameters: '600M',
    speed: 'Streaming, 1120 ms chunk tier',
    ramRequirement: '~1.5 GB RAM',
    artifacts: {
      // Apple-Silicon-only: FluidAudio's StreamingNemotronAsrManager throws
      // unsupportedPlatform on Intel, so no darwin-x64 artifact is offered.
      'darwin-arm64': {
        runtime: 'coreml',
        repo: 'FluidInference/nemotron-speech-streaming-en-0.6b-coreml',
        revision: REVISION,
        license: 'other',
        gated: false,
        engine: 'nemotron-streaming',
        modelRoot: 'nemotron_coreml_1120ms',
        files: [
          ...bundleNoMetadata('nemotron_coreml_1120ms/preprocessor.mlmodelc', 0.59e6),
          ...bundleNoMetadata('nemotron_coreml_1120ms/encoder/encoder_int8.mlmodelc', 589.40e6),
          ...bundleNoMetadata('nemotron_coreml_1120ms/decoder.mlmodelc', 14.43e6),
          ...bundleNoMetadata('nemotron_coreml_1120ms/joint.mlmodelc', 3.45e6),
          ...bundleNoMetadata('nemotron_coreml_1120ms/decoder_joint.mlmodelc', 17.88e6),
          f('nemotron_coreml_1120ms/tokenizer.json', 0.02e6),
          f('nemotron_coreml_1120ms/metadata.json', 0.01e6),
        ],
        sentinel: 'nemotron_coreml_1120ms/encoder/encoder_int8.mlmodelc/weights/weight.bin',
        notes: [
          'Repo also ships 560ms and 2240ms tiers; this allowlist pins nemotron_coreml_1120ms (~626 MB).',
          'FluidAudio loads the encoder from the `encoder/` subdirectory and treats decoder_joint as optional.',
          'Apple Silicon only: FluidAudio rejects this engine on Intel Macs, so it is not offered for darwin-x64.',
          'Verified end-to-end on darwin-arm64 against real 16 kHz speech.',
        ],
        verified: true,
      },
      ...forWindows(
        onnxTransducer(
          'csukuangfj/sherpa-onnx-nemotron-speech-streaming-en-0.6b-int8-2026-01-14',
          652.92e6,
          7.26e6,
          1.74e6,
          0.01e6
        )
      ),
    },
  },
  {
    id: 'nemotron-3.5-multilingual',
    name: 'Nemotron 3.5 Multilingual',
    subtitle: 'Multilingual · Code-switching',
    icon: '🌍',
    description:
      'NVIDIA Nemotron 3.5 ASR Streaming Multilingual 0.6B. Streaming RNNT across multiple languages with seamless code-switching.',
    architecture: 'Nemotron-3.5-Streaming-RNNT',
    parameters: '600M',
    speed: 'Streaming, 1120 ms chunk tier',
    ramRequirement: '~2 GB RAM',
    artifacts: {
      // Apple-Silicon-only: FluidAudio's multilingual streaming manager throws
      // unsupportedPlatform on Intel, so no darwin-x64 artifact is offered.
      'darwin-arm64': {
        runtime: 'coreml',
        repo: 'FluidInference/Nemotron-3.5-ASR-Streaming-Multilingual-0.6b-CoreML',
        revision: REVISION,
        license: 'other',
        gated: false,
        engine: 'nemotron-multilingual',
        modelRoot: 'multilingual/1120ms',
        files: [
          ...bundleNoMetadata('multilingual/1120ms/preprocessor.mlmodelc', 0.59e6),
          ...bundleNoMetadata('multilingual/1120ms/encoder.mlmodelc', 564.65e6),
          ...bundleNoMetadata('multilingual/1120ms/decoder.mlmodelc', 29.87e6),
          ...bundleNoMetadata('multilingual/1120ms/joint.mlmodelc', 18.91e6),
          ...bundleNoMetadata('multilingual/1120ms/decoder_joint.mlmodelc', 48.78e6),
          f('multilingual/1120ms/tokenizer.json', 0.28e6),
          f('multilingual/1120ms/metadata.json', 0.01e6),
        ],
        sentinel: 'multilingual/1120ms/encoder.mlmodelc/weights/weight.bin',
        notes: [
          'Repo is organised as <language>/<tier>ms/; this allowlist pins the `multilingual` bundle at 1120ms (~663 MB).',
          'FluidAudio reads `metadata.json` (prompt_dictionary, lang_tag_token_ids) from the model root, so the app passes `--model-root multilingual/1120ms`.',
          'Apple Silicon only: FluidAudio rejects this engine on Intel Macs, so it is not offered for darwin-x64.',
          'Previously this id was mapped to canary-1b.nemo, which was the wrong model.',
          'Verified end-to-end on darwin-arm64 against real 16 kHz speech.',
        ],
        verified: true,
      },
      ...forWindows(
        onnxTransducer(
          'csukuangfj2/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-1120ms-int8-2026-06-11',
          657.60e6,
          14.98e6,
          9.50e6,
          0.13e6
        )
      ),
    },
  },
];

/** Per-platform caveats that apply to every Windows artifact. */
for (const entry of STT_MODEL_CATALOG) {
  const ia32 = entry.artifacts['win32-ia32'];
  if (ia32) {
    ia32.notes = [...(ia32.notes ?? []), WIN_IA32_NOTE];
  }
}

export const STT_MODEL_IDS: readonly ParakeetModelType[] = STT_MODEL_CATALOG.map((entry) => entry.id);

export function isParakeetModelType(value: string): value is ParakeetModelType {
  return STT_MODEL_IDS.includes(value as ParakeetModelType);
}