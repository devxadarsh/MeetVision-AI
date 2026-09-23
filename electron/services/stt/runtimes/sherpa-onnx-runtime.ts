import * as fs from 'fs';
import * as path from 'path';
import { SttRuntime, SttTranscriptionRequest } from './stt-runtime.interface';
import { cleanTranscriptLines, execCapture, resolveBundledBinary } from './runtime-utils';

/**
 * ONNX runtime for Windows. Spawns the bundled sherpa-onnx offline (or
 * stream) executable against INT8 ONNX weights.
 *
 * Transducer repos ship `encoder/decoder/joiner.int8.onnx`; CTC repos ship a
 * single `model.int8.onnx`. Both are detected from the model directory.
 */
export class SherpaOnnxRuntime implements SttRuntime {
  readonly kind = 'sherpa-onnx' as const;
  readonly displayName = 'sherpa-onnx (INT8 ONNX)';

  private cached: string | null | undefined;

  resolveBinary(): string | null {
    if (this.cached === undefined) {
      this.cached = resolveBundledBinary([
        'sherpa-onnx-offline',
        'sherpa-onnx-offline-encoder',
        'sherpa-onnx',
      ]);
    }
    return this.cached;
  }

  isAvailable(): boolean {
    return this.resolveBinary() !== null;
  }

  async transcribe(request: SttTranscriptionRequest): Promise<string> {
    const binary = this.resolveBinary();
    if (!binary) return '';

    const dir = request.modelDir;
    const tokens = path.join(dir, 'tokens.txt');
    const encoder = path.join(dir, 'encoder.int8.onnx');
    const decoder = path.join(dir, 'decoder.int8.onnx');
    const joiner = path.join(dir, 'joiner.int8.onnx');
    const single = path.join(dir, 'model.int8.onnx');

    const args: string[] = [];
    if (fs.existsSync(single)) {
      args.push(`--model=${single}`);
    } else {
      args.push(`--encoder=${encoder}`, `--decoder=${decoder}`, `--joiner=${joiner}`);
    }
    if (fs.existsSync(tokens)) {
      args.push(`--tokens=${tokens}`);
    }
    args.push('--num-threads=4', request.wavPath);

    const { stdout, stderr } = await execCapture(binary, args, request.timeoutMs);
    // sherpa-onnx writes logs to stderr and results to stdout.
    return cleanTranscriptLines(stdout) || cleanTranscriptLines(stderr);
  }
}