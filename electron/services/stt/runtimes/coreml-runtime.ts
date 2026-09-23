import { SttRuntime, SttTranscriptionRequest } from './stt-runtime.interface';
import { execCapture, resolveBundledBinary } from './runtime-utils';

/**
 * Core ML runtime for macOS. Spawns the bundled FluidAudio-based helper, which
 * loads `.mlmodelc` / `.mlpackage` weights from a local directory and runs
 * inference on the Apple Neural Engine / GPU.
 *
 * CLI contract (implemented by electron/native/parakeet-coreml):
 *   parakeet-coreml --model-dir <dir> --wav <file.wav> --engine <engine>
 *
 * The transcript is wrapped in markers because Core ML's E5RT runtime prints its
 * own diagnostics to stdout, sometimes without a trailing newline, which would
 * otherwise be concatenated onto the transcript.
 * Keep the markers in sync with main.swift.
 */
const TRANSCRIPT_START = '<<<MEETVISION_TRANSCRIPT>>>';
const TRANSCRIPT_END = '<<<END_MEETVISION_TRANSCRIPT>>>';

/** Extract the marked transcript, falling back to noise-stripped stdout. */
export function extractCoreMlTranscript(stdout: string): string {
  const start = stdout.indexOf(TRANSCRIPT_START);
  if (start !== -1) {
    const contentStart = start + TRANSCRIPT_START.length;
    const end = stdout.indexOf(TRANSCRIPT_END, contentStart);
    return (end === -1 ? stdout.slice(contentStart) : stdout.slice(contentStart, end)).trim();
  }
  // Older helper build without markers: drop Core ML runtime chatter.
  return stdout
    .split('\n')
    .filter((line) => !/^E5RT\b/.test(line.trim()) && !/^CoreML\b/.test(line.trim()))
    .join('\n')
    .trim();
}

export class CoreMlRuntime implements SttRuntime {
  readonly kind = 'coreml' as const;
  readonly displayName = 'Core ML (FluidAudio, Apple Neural Engine)';

  private cached: string | null | undefined;

  resolveBinary(): string | null {
    if (this.cached === undefined) {
      this.cached = resolveBundledBinary(['parakeet-coreml']);
    }
    return this.cached;
  }

  isAvailable(): boolean {
    return this.resolveBinary() !== null;
  }

  async transcribe(request: SttTranscriptionRequest): Promise<string> {
    const binary = this.resolveBinary();
    if (!binary) return '';
    const args = ['--model-dir', request.modelDir, '--wav', request.wavPath];
    if (request.coreMlEngine) {
      args.push('--engine', request.coreMlEngine);
    }
    if (request.modelRoot) {
      args.push('--model-root', request.modelRoot);
    }
    const { stdout } = await execCapture(binary, args, request.timeoutMs);
    return extractCoreMlTranscript(stdout);
  }
}