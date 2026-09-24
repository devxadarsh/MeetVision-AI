import { SttRuntime, SttTranscriptionRequest } from './stt-runtime.interface';
import { cleanTranscriptLines, execCapture, resolveBundledBinary } from './runtime-utils';

/**
 * Legacy ggml runtime (whisper.cpp's `parakeet-cli`). Reads single-file GGML
 * `.bin` weights. Kept as a fallback so existing installs keep working when the
 * Core ML helper / sherpa-onnx binary is not present.
 */
export class GgmlRuntime implements SttRuntime {
  readonly kind = 'ggml' as const;
  readonly displayName = 'ggml parakeet-cli';

  private cached: string | null | undefined;

  resolveBinary(): string | null {
    if (this.cached === undefined) {
      this.cached = resolveBundledBinary(['parakeet-cli']);
    }
    return this.cached;
  }

  isAvailable(): boolean {
    return this.resolveBinary() !== null;
  }

  async transcribe(request: SttTranscriptionRequest): Promise<string> {
    const binary = this.resolveBinary();
    const modelFile = request.modelFile;
    if (!binary || !modelFile) {
      return '';
    }
    const { stdout } = await execCapture(
      binary,
      ['-m', modelFile, '-f', request.wavPath, '-np', '-t', '4'],
      request.timeoutMs
    );
    return cleanTranscriptLines(stdout);
  }
}