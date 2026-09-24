import type { SttRuntimeKind } from '@shared/stt-model-catalog';

export interface SttTranscriptionRequest {
  /** Local directory holding the resolved model artifact. */
  modelDir: string;
  /** 16 kHz mono PCM WAV file to transcribe. */
  wavPath: string;
  /** Hard timeout for one inference call. */
  timeoutMs: number;
  /** Explicit weight file, used by the legacy single-file ggml runtime. */
  modelFile?: string | null;
  /** FluidAudio entry point, used by the Core ML runtime. */
  coreMlEngine?: string;
  /** Subdirectory of `modelDir` that FluidAudio must treat as the model root. */
  modelRoot?: string;
}

export interface SttRuntime {
  readonly kind: SttRuntimeKind;
  readonly displayName: string;
  /** Absolute path to the runtime executable, or null when it is not present. */
  resolveBinary(): string | null;
  /** True when the executable backing this runtime is present. */
  isAvailable(): boolean;
  /** Run inference and return the decoded transcript text (may be empty). */
  transcribe(request: SttTranscriptionRequest): Promise<string>;
}