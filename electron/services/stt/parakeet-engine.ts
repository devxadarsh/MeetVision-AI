import {
  AudioFrame,
  ParakeetModelType,
  STTEngineInfo,
  STTEngineType,
  TranscriptSegment,
  ParakeetStatus,
  ParakeetDownloadProgress,
} from '@shared/ipc';
import {
  STT_MODEL_CATALOG,
  artifactFileUrl,
  artifactTotalBytes,
  getCatalogEntry,
  getModelArtifact,
  isParakeetModelType,
  resolveSttPlatform,
} from '@shared/stt-model-catalog';
import type { SttModelArtifact, SttPlatform } from '@shared/stt-model-catalog';
import { ISTTEngine, STTEngineOptions } from './stt-engine.interface';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import { app } from 'electron';
import type { SttRuntime } from './runtimes/stt-runtime.interface';
import { CoreMlRuntime } from './runtimes/coreml-runtime';
import { GgmlRuntime } from './runtimes/ggml-runtime';
import { SherpaOnnxRuntime } from './runtimes/sherpa-onnx-runtime';

function encodeWav(samples: Int16Array, sampleRate = 16000): Buffer {
  const dataByteLength = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataByteLength);

  // RIFF identifier
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataByteLength, 4);
  buffer.write('WAVE', 8);

  // "fmt " chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // 16 bits

  // "data" chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataByteLength, 40);

  for (let i = 0; i < samples.length; i++) {
    buffer.writeInt16LE(samples[i], 44 + i * 2);
  }

  return buffer;
}

export interface ParakeetModelMeta {
  id: ParakeetModelType;
  name: string;
  subtitle: string;
  icon: string;
  description: string;
  architecture: string;
  parameters: string;
  speed: string;
  ramRequirement: string;
  fileSizeMb: number;
}

function currentPlatform(): SttPlatform | null {
  return resolveSttPlatform(process.platform, process.arch);
}

/**
 * UI-facing model metadata. Sizes are derived from the artifact resolved for
 * the host platform, so they no longer drift from what is actually downloaded.
 */
export const PARAKEET_MODELS: ParakeetModelMeta[] = STT_MODEL_CATALOG.map((entry) => {
  const platform = currentPlatform();
  const artifact = platform ? entry.artifacts[platform] : undefined;
  return {
    id: entry.id,
    name: entry.name,
    subtitle: entry.subtitle,
    icon: entry.icon,
    description: entry.description,
    architecture: entry.architecture,
    parameters: entry.parameters,
    speed: entry.speed,
    ramRequirement: entry.ramRequirement,
    fileSizeMb: artifact ? Math.round(artifactTotalBytes(artifact) / (1024 * 1024)) : 0,
  };
});

const DOWNLOAD_TIMEOUT_MS = 30000;
/**
 * Per-utterance timeout. A warm helper run completes in well under a second, but
 * the very first call for a model compiles its Core ML graphs and pulls several
 * hundred MB through the caches — measured at ~32 s on an M-series Mac. A short
 * timeout kills that process before it can print anything, which surfaces as
 * "Command failed" with empty stderr. `warmUpRuntime()` normally pays that cost
 * at start-up so real utterances stay on the fast path.
 */
const INFERENCE_TIMEOUT_MS = 120000;
/** Warm-up is a deliberate cold load, so it gets a longer budget. */
const WARMUP_TIMEOUT_MS = 180000;

/**
 * FluidAudio rejects audio shorter than ASRConstants.minimumAudioDurationSeconds
 * (0.3 s at 16 kHz) with `invalidAudioData`. Shorter utterances are padded up to
 * this length with silence so brief words ("yes", "no") are not dropped. The
 * margin above 0.3 s absorbs any resampling rounding inside FluidAudio.
 */
const MIN_INFERENCE_SAMPLES = Math.round(16000 * 0.35);
/** Utterances shorter than this are transient blips, not speech. */
const MIN_USEFUL_SAMPLES = Math.round(16000 * 0.3);

export class ParakeetEngine implements ISTTEngine {
  readonly id: STTEngineType = 'parakeet';
  readonly name = 'NVIDIA Parakeet';
  readonly isExperimental = true;

  private active = false;
  private onSegmentCallback: ((segment: TranscriptSegment) => void) | null = null;
  private currentModel: ParakeetModelType = 'parakeet-flash';
  private modelsDir: string;
  private isDownloading = false;
  private downloadingModel?: ParakeetModelType;
  private downloadProgress = 0;
  /** Controls how an in-flight request abort should be interpreted. */
  private downloadIntent: 'downloading' | 'pausing' | 'cancelling' = 'downloading';
  /** The active ClientRequest — set during download so pause/cancel can destroy it. */
  private activeRequest: import('http').ClientRequest | null = null;
  public onProgressCallback?: (progress: ParakeetDownloadProgress) => void;
  private audioBuffer: { [channel: string]: Int16Array[] } = { system: [], mic: [] };

  private readonly coreMlRuntime = new CoreMlRuntime();
  private readonly sherpaRuntime = new SherpaOnnxRuntime();
  private readonly ggmlRuntime = new GgmlRuntime();

  /**
   * Serializes inference calls. Each helper invocation loads several hundred MB
   * of Core ML weights, so running the mic and system tracks concurrently would
   * double peak memory and contend for the Neural Engine.
   */
  private inferenceQueue: Promise<void> = Promise.resolve();

  // Real-time audio utterance tracking for Metal GPU inference
  private utteranceTrackers = {
    system: {
      isSpeaking: false,
      speechStartMs: 0,
      segmentId: '',
      chunks: [] as Int16Array[],
      totalSamples: 0,
      silenceTimer: null as NodeJS.Timeout | null,
      lastInterimMs: 0,
      isBusy: false,
    },
    mic: {
      isSpeaking: false,
      speechStartMs: 0,
      segmentId: '',
      chunks: [] as Int16Array[],
      totalSamples: 0,
      silenceTimer: null as NodeJS.Timeout | null,
      lastInterimMs: 0,
      isBusy: false,
    },
  };

  constructor() {
    try {
      this.modelsDir = path.join(app.getPath('userData'), 'models', 'parakeet');
    } catch {
      this.modelsDir = path.join(process.cwd(), 'models', 'parakeet');
    }
    if (!fs.existsSync(this.modelsDir)) {
      try {
        fs.mkdirSync(this.modelsDir, { recursive: true });
      } catch {
        // ignore
      }
    }
    if (!fs.existsSync(this.modelsDir)) {
      this.modelsDir = path.join(process.cwd(), 'models', 'parakeet');
      try {
        fs.mkdirSync(this.modelsDir, { recursive: true });
      } catch {
        // ignore
      }
    }
  }

  /** Runtime that would serve the given model id on this platform. */
  private runtimeForArtifact(artifact: SttModelArtifact): SttRuntime {
    switch (artifact.runtime) {
      case 'coreml':
        return this.coreMlRuntime;
      case 'sherpa-onnx':
        return this.sherpaRuntime;
      default:
        return this.ggmlRuntime;
    }
  }

  private resolveArtifact(modelId: ParakeetModelType = this.currentModel): SttModelArtifact | null {
    const platform = currentPlatform();
    if (!platform) return null;
    return getModelArtifact(modelId, platform) ?? null;
  }

  /**
   * The runtime that will actually serve the current model. When the platform
   * runtime (Core ML / sherpa-onnx) is missing but legacy ggml weights and the
   * ggml binary are present, inference falls back to ggml instead of failing.
   */
  private resolveEffectiveRuntime(): {
    artifact: SttModelArtifact | null;
    runtime: SttRuntime;
    usingLegacy: boolean;
    legacyFile: string | null;
  } {
    const artifact = this.resolveArtifact();
    const preferred = artifact ? this.runtimeForArtifact(artifact) : this.ggmlRuntime;
    const legacyFile = this.legacyModelFile(this.currentModel);

    if (!preferred.isAvailable() && this.ggmlRuntime.isAvailable() && legacyFile) {
      return { artifact, runtime: this.ggmlRuntime, usingLegacy: true, legacyFile };
    }
    return { artifact, runtime: preferred, usingLegacy: false, legacyFile };
  }

  /** Absolute directory holding the artifact files for a model. */
  private modelDirFor(modelId: ParakeetModelType): string {
    return path.join(this.modelsDir, modelId);
  }

  /** Legacy single-file GGML weights, kept for back-compat with old installs. */
  private legacyModelFile(modelId: ParakeetModelType): string | null {
    const candidates = [
      path.join(this.modelsDir, `${modelId}.bin`),
      path.join(this.modelsDir, `ggml-${modelId}.bin`),
      path.join(process.cwd(), 'models', 'parakeet', `${modelId}.bin`),
    ];
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).size > 1024 * 1024) {
          return candidate;
        }
      } catch {
        // ignore
      }
    }
    return null;
  }

  /** True when every required file for the model exists on disk. */
  private isArtifactInstalled(modelId: ParakeetModelType, artifact: SttModelArtifact): boolean {
    const dir = this.modelDirFor(modelId);
    if (!fs.existsSync(dir)) return false;
    for (const file of artifact.files) {
      const target = path.join(dir, file.path);
      try {
        if (!fs.existsSync(target)) return false;
        // Nested Core ML metadata files are legitimately tiny; only the sentinel must be non-empty.
        if (file.path === artifact.sentinel && fs.statSync(target).size < 1024) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  listInstalledModels(): ParakeetModelType[] {
    const installed: ParakeetModelType[] = [];
    for (const entry of STT_MODEL_CATALOG) {
      const artifact = this.resolveArtifact(entry.id);
      if (artifact && this.isArtifactInstalled(entry.id, artifact)) {
        installed.push(entry.id);
        continue;
      }
      // Legacy GGML single-file install
      if (this.legacyModelFile(entry.id)) {
        installed.push(entry.id);
      }
    }
    return installed;
  }

  getParakeetStatus(): ParakeetStatus {
    const platform = currentPlatform();
    const { artifact, runtime, usingLegacy } = this.resolveEffectiveRuntime();
    const runtimeBinary = runtime.resolveBinary();
    const runtimeAvailable = runtime.isAvailable();
    const installed = this.listInstalledModels();

    let runtimeDetail: string;
    if (!platform) {
      runtimeDetail = `Unsupported platform ${process.platform}/${process.arch}.`;
    } else if (!artifact) {
      runtimeDetail = `No artifact is mapped for ${this.currentModel} on ${platform}.`;
    } else if (!runtimeAvailable) {
      runtimeDetail = `${runtime.displayName} is not installed, so ${artifact.runtime} weights cannot run yet.`;
    } else if (usingLegacy) {
      runtimeDetail = `${runtime.displayName} fallback is active. Run "npm run build:native" for ${artifact.runtime} acceleration.`;
    } else {
      runtimeDetail = `Running ${runtime.displayName} with ${artifact.repo}.`;
    }

    return {
      available: runtimeAvailable,
      binaryPath: runtimeBinary || undefined,
      installedModels: installed,
      currentModel: this.currentModel,
      isDownloading: this.isDownloading,
      downloadProgress: this.downloadProgress,
      downloadingModel: this.downloadingModel,
      platform: platform ?? `${process.platform}-${process.arch}`,
      runtime: usingLegacy ? runtime.kind : artifact?.runtime ?? runtime.kind,
      runtimeName: runtime.displayName,
      runtimeAvailable,
      runtimeDetail,
      currentModelInstalled: installed.includes(this.currentModel),
      currentModelBytes: artifact ? artifactTotalBytes(artifact) : 0,
      currentModelNotes: artifact?.notes,
    };
  }

  async downloadModel(
    modelId: ParakeetModelType,
    onProgress?: (p: ParakeetDownloadProgress) => void
  ): Promise<boolean> {
    if (this.isDownloading) {
      throw new Error('Another Parakeet model download is already in progress');
    }

    const entry = getCatalogEntry(modelId);
    if (!entry) {
      throw new Error(`Unknown Parakeet model: ${modelId}`);
    }

    const artifact = this.resolveArtifact(modelId);
    if (!artifact) {
      throw new Error(
        `No downloadable artifact is mapped for ${entry.name} on ${process.platform}/${process.arch}.`
      );
    }

    const modelDir = this.modelDirFor(modelId);
    if (!fs.existsSync(modelDir)) {
      fs.mkdirSync(modelDir, { recursive: true });
    }

    this.isDownloading = true;
    this.downloadingModel = modelId;
    this.downloadProgress = 0;
    this.downloadIntent = 'downloading';

    const totalBytes = artifactTotalBytes(artifact) || 1;
    const totalMb = Math.round(totalBytes / (1024 * 1024));
    let receivedBytes = 0;

    const emitProgress = (
      bytes: number,
      completed: boolean,
      error?: string,
      paused?: boolean,
      cancelled?: boolean
    ) => {
      const percent = Math.min(100, Math.round((bytes / totalBytes) * 100));
      const progress: ParakeetDownloadProgress = {
        model: modelId,
        percent: completed ? 100 : percent,
        downloadedMb: Math.round(bytes / (1024 * 1024)),
        totalMb,
        completed,
        error,
        paused,
        cancelled,
      };
      onProgress?.(progress);
      this.onProgressCallback?.(progress);
      this.downloadProgress = progress.percent;
    };

    const cleanup = (err?: Error) => {
      this.activeRequest = null;
      if (this.downloadIntent === 'pausing') {
        this.isDownloading = false;
        this.downloadingModel = undefined;
        console.log(`[ParakeetEngine] Download of ${modelId} paused.`);
        emitProgress(receivedBytes, false, undefined, true, false);
        return;
      }
      if (this.downloadIntent === 'cancelling') {
        this.isDownloading = false;
        this.downloadingModel = undefined;
        this.downloadProgress = 0;
        this.discardPartialDownloads(modelDir);
        console.log(`[ParakeetEngine] Download of ${modelId} cancelled.`);
        emitProgress(0, false, undefined, false, true);
        return;
      }
      this.isDownloading = false;
      this.downloadingModel = undefined;
      if (err) {
        console.error('[ParakeetEngine] Download error:', err.message);
        emitProgress(receivedBytes, false, err.message);
      }
    };

    try {
      for (const file of artifact.files) {
        if (this.downloadIntent !== 'downloading') break;
        const target = path.join(modelDir, file.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });

        // A file that is already complete (or marked in the manifest) is skipped.
        // A target file only ever appears after its `.part` is fully written and
        // renamed, so any non-empty target is complete. The size comparison is a
        // guard against truncated leftovers from older builds, and is only
        // meaningful for large files: declared sizes for small files are rounded
        // to 2 dp of a megabyte and can overstate the real size.
        const existing = this.fileSizeSafe(target);
        const isComplete =
          existing > 0 && (file.bytes < 1e6 || existing >= file.bytes * 0.99);
        if (isComplete) {
          receivedBytes += existing;
          emitProgress(receivedBytes, false);
          continue;
        }

        const downloaded = await this.downloadFile(artifact, file.path, target, totalBytes, () => receivedBytes, (v) => {
          receivedBytes = v;
          emitProgress(receivedBytes, false);
        });
        if (downloaded === null) {
          // Aborted by pause/cancel.
          cleanup();
          return false;
        }
        receivedBytes += downloaded;
        emitProgress(receivedBytes, false);
      }

      if (this.downloadIntent !== 'downloading') {
        cleanup();
        return false;
      }

      this.activeRequest = null;
      this.isDownloading = false;
      this.downloadingModel = undefined;
      this.downloadProgress = 100;
      emitProgress(totalBytes, true);
      console.log(`[ParakeetEngine] ${artifact.repo} installed to ${modelDir}`);
      return true;
    } catch (err) {
      cleanup(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  private fileSizeSafe(filePath: string): number {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  }

  private discardPartialDownloads(dir: string): void {
    const walk = (current: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.part')) {
          try {
            fs.unlinkSync(full);
          } catch {
            // ignore
          }
        }
      }
    };
    walk(dir);
  }

  /**
   * Stream one artifact file to disk with `.part` resume support.
   * Resolves with the bytes written, or null when pause/cancel aborted the run.
   */
  private downloadFile(
    artifact: SttModelArtifact,
    filePath: string,
    target: string,
    totalBytes: number,
    getReceived: () => number,
    setReceived: (value: number) => void
  ): Promise<number | null> {
    const urlStr = artifactFileUrl(artifact, filePath);
    const partFile = `${target}.part`;

    return new Promise<number | null>((resolve, reject) => {
      const resumeFrom = this.fileSizeSafe(partFile);
      let baseReceived = getReceived();
      let aborted = false;

      const doRequest = (currentUrl: string, redirectCount = 0): void => {
        if (this.downloadIntent !== 'downloading') {
          aborted = true;
          resolve(null);
          return;
        }
        if (redirectCount > 10) {
          reject(new Error('Too many redirects'));
          return;
        }

        let parsed: URL;
        try {
          parsed = new URL(currentUrl);
        } catch {
          reject(new Error(`Invalid download URL: ${currentUrl}`));
          return;
        }
        const transport: typeof https | typeof http = parsed.protocol === 'https:' ? https : http;
        const headers: Record<string, string> = {
          'User-Agent': 'MeetVisionAI/1.0 (Electron)',
        };
        if (resumeFrom > 0) {
          headers['Range'] = `bytes=${resumeFrom}-`;
        }

        const req = transport.get(
          {
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            headers,
            timeout: DOWNLOAD_TIMEOUT_MS,
          },
          (res) => {
            const { statusCode, headers: resHeaders } = res;

            if (statusCode === 301 || statusCode === 302 || statusCode === 307 || statusCode === 308) {
              const location = resHeaders.location;
              if (!location) {
                reject(new Error(`Redirect with no Location header (HTTP ${statusCode})`));
                return;
              }
              res.resume();
              // Hugging Face answers /resolve/ with a *relative* Location
              // (`/api/resolve-cache/...`), so resolve it against the current
              // absolute URL instead of parsing it standalone.
              let nextUrl: string;
              try {
                nextUrl = new URL(location, parsed).toString();
              } catch {
                reject(new Error(`Invalid redirect target: ${location}`));
                return;
              }
              doRequest(nextUrl, redirectCount + 1);
              return;
            }

            if (statusCode !== 200 && statusCode !== 206) {
              res.resume();
              if (statusCode === 401 || statusCode === 403) {
                reject(
                  new Error(
                    `This model requires a Hugging Face account and acceptance of the model license. ` +
                      `Accept the terms on huggingface.co (${artifact.repo}) and retry.`
                  )
                );
                return;
              }
              reject(new Error(`HTTP ${statusCode} while downloading ${filePath}`));
              return;
            }

            let restartFromZero = false;
            if (statusCode === 200 && resumeFrom > 0) {
              restartFromZero = true;
              baseReceived -= resumeFrom;
            }

            const flags = statusCode === 206 && !restartFromZero ? 'a' : 'w';
            const fileStream = fs.createWriteStream(partFile, { flags });
            let fileBytes = restartFromZero ? 0 : resumeFrom;
            let lastEmit = 0;

            res.on('data', (chunk: Buffer) => {
              if (this.downloadIntent !== 'downloading') return;
              fileBytes += chunk.length;
              const now = Date.now();
              if (now - lastEmit > 120) {
                lastEmit = now;
                setReceived(Math.min(totalBytes - 1, baseReceived + fileBytes));
              }
            });

            res.on('error', (err) => {
              fileStream.destroy();
              if (aborted) resolve(null);
              else reject(err);
            });

            fileStream.on('error', (err) => {
              if (aborted) resolve(null);
              else reject(err);
            });

            fileStream.on('finish', () => {
              if (this.downloadIntent !== 'downloading') {
                aborted = true;
                resolve(null);
                return;
              }
              if (restartFromZero) {
                try {
                  fs.unlinkSync(target);
                } catch {
                  // ignore
                }
              }
              try {
                if (fs.existsSync(target)) fs.unlinkSync(target);
                fs.renameSync(partFile, target);
              } catch (renameErr) {
                reject(renameErr instanceof Error ? renameErr : new Error(String(renameErr)));
                return;
              }
              resolve(fileBytes);
            });

            res.pipe(fileStream);
          }
        );

        this.activeRequest = req;

        req.on('timeout', () => {
          req.destroy(new Error('Connection timed out'));
        });

        req.on('error', (err) => {
          if (this.downloadIntent !== 'downloading') {
            aborted = true;
            resolve(null);
          } else {
            reject(err);
          }
        });
      };

      doRequest(urlStr);
    });
  }

  /**
   * Pauses the currently active model download.
   * Preserves `.part` files so the download can be resumed later.
   */
  pauseDownload(): boolean {
    if (!this.isDownloading) {
      return false;
    }
    this.downloadIntent = 'pausing';
    if (this.activeRequest) {
      try {
        this.activeRequest.destroy();
      } catch {
        // ignore
      }
      this.activeRequest = null;
    }
    return true;
  }

  /**
   * Cancels the currently active download (or cleans up partial files).
   */
  cancelDownload(modelId?: ParakeetModelType): boolean {
    const targetModel = modelId || this.downloadingModel;
    if (this.isDownloading) {
      this.downloadIntent = 'cancelling';
      if (this.activeRequest) {
        try {
          this.activeRequest.destroy();
        } catch {
          // ignore
        }
        this.activeRequest = null;
      }
      return true;
    }

    if (targetModel) {
      this.discardPartialDownloads(this.modelDirFor(targetModel));
      this.downloadProgress = 0;
      this.downloadingModel = undefined;
      const artifact = this.resolveArtifact(targetModel);
      const progress: ParakeetDownloadProgress = {
        model: targetModel,
        percent: 0,
        downloadedMb: 0,
        totalMb: artifact ? Math.round(artifactTotalBytes(artifact) / (1024 * 1024)) : 0,
        completed: false,
        cancelled: true,
      };
      this.onProgressCallback?.(progress);
      return true;
    }

    return false;
  }

  /**
   * Returns the absolute path to reveal for this modelId (the model directory,
   * or the legacy single-file weights), or null when nothing is installed.
   */
  revealModelInFolder(modelId: ParakeetModelType): string | null {
    const dir = this.modelDirFor(modelId);
    if (fs.existsSync(dir)) return dir;
    return this.legacyModelFile(modelId) ?? (fs.existsSync(this.modelsDir) ? this.modelsDir : null);
  }

  deleteModel(modelId: ParakeetModelType): boolean {
    let deleted = false;

    const dir = this.modelDirFor(modelId);
    if (fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`[ParakeetEngine] Deleted model directory: ${dir}`);
        deleted = true;
      } catch (err) {
        console.warn(`[ParakeetEngine] Failed to delete ${dir}:`, err);
      }
    }

    // Legacy flat files (e.g. parakeet-flash.bin, parakeet-flash.nemo)
    for (const searchDir of [this.modelsDir, path.join(process.cwd(), 'models', 'parakeet')]) {
      if (!fs.existsSync(searchDir)) continue;
      try {
        for (const file of fs.readdirSync(searchDir)) {
          if (!file.startsWith(modelId)) continue;
          const full = path.join(searchDir, file);
          if (fs.statSync(full).isDirectory()) continue;
          fs.rmSync(full, { force: true });
          console.log(`[ParakeetEngine] Deleted legacy model file: ${full}`);
          deleted = true;
        }
      } catch (err) {
        console.warn(`[ParakeetEngine] Failed to clean ${searchDir}:`, err);
      }
    }

    return deleted;
  }

  async initialize(): Promise<boolean> {
    return Boolean(this.getParakeetStatus().runtimeAvailable);
  }

  async setModel(modelName: string): Promise<boolean> {
    if (isParakeetModelType(modelName)) {
      this.currentModel = modelName;
      console.log(`[ParakeetEngine] Switched model to: ${this.currentModel}`);
      return true;
    }
    return false;
  }

  getCurrentModel(): ParakeetModelType {
    return this.currentModel;
  }

  getCurrentModelDisplayName(): string {
    const meta = PARAKEET_MODELS.find((m) => m.id === this.currentModel);
    return meta ? meta.name : this.currentModel;
  }

  async start(onSegment: (segment: TranscriptSegment) => void, options?: STTEngineOptions): Promise<void> {
    this.active = true;
    this.onSegmentCallback = onSegment;
    this.audioBuffer = { system: [], mic: [] };

    const meta = PARAKEET_MODELS.find((m) => m.id === this.currentModel) || PARAKEET_MODELS[0];
    const { artifact, runtime, usingLegacy } = this.resolveEffectiveRuntime();

    console.log(
      `[ParakeetEngine] Starting ${meta?.name} (${meta?.parameters}) via ${runtime.displayName}` +
        (artifact ? ` · ${artifact.repo}` : '') +
        (usingLegacy ? ' (legacy fallback)' : '')
    );

    if (!runtime.isAvailable()) {
      console.warn(
        `[ParakeetEngine] ${runtime.displayName} is not installed; transcription will be unavailable until it is.`
      );
    } else if (!this.getParakeetStatus().currentModelInstalled) {
      console.warn(`[ParakeetEngine] ${meta?.name} weights are not installed yet.`);
    } else {
      this.warmUpRuntime();
    }
  }

  /**
   * Loads the current model once in the background so its Core ML graphs are
   * compiled and the weights are in the page cache. Without this the first
   * utterance after a start or model switch pays the full cold load (~32 s).
   * The helper is a one-shot process, so this warms the on-disk and OS caches
   * rather than keeping a model resident. Output is discarded.
   */
  private warmUpRuntime(): void {
    const { artifact, runtime, usingLegacy, legacyFile } = this.resolveEffectiveRuntime();
    if (!runtime.isAvailable()) return;
    if (!usingLegacy && artifact && !this.isArtifactInstalled(this.currentModel, artifact)) return;

    const activeModel = this.currentModel;
    const warmupWav = path.join(os.tmpdir(), `parakeet-warmup-${Date.now()}.wav`);

    try {
      // Silence that still meets FluidAudio's 0.3 s minimum duration.
      fs.writeFileSync(warmupWav, encodeWav(new Int16Array(MIN_INFERENCE_SAMPLES), 16000));
    } catch (err) {
      console.warn('[ParakeetEngine] Warm-up skipped (could not write temp wav):', err);
      return;
    }

    const request = {
      modelDir: this.modelDirFor(activeModel),
      wavPath: warmupWav,
      timeoutMs: WARMUP_TIMEOUT_MS,
      modelFile: legacyFile,
      coreMlEngine: artifact?.engine,
      modelRoot: artifact?.modelRoot,
    };

    console.log(
      `[ParakeetEngine] Warming up ${activeModel} (first load compiles Core ML graphs and can take ~30s)...`
    );

    this.enqueueInference(() => runtime.transcribe(request))
      .then(() => {
        console.log(`[ParakeetEngine] ${activeModel} runtime warm.`);
      })
      .catch((error) => {
        const execError = error as Error & { stderr?: string };
        console.warn(
          '[ParakeetEngine] Warm-up failed:',
          execError.message,
          execError.stderr ? `\n  stderr: ${execError.stderr.trim()}` : ''
        );
      })
      .finally(() => {
        try {
          fs.unlinkSync(warmupWav);
        } catch {
          // ignore
        }
      });
  }

  async stop(): Promise<void> {
    this.active = false;
    this.onSegmentCallback = null;
    this.audioBuffer = { system: [], mic: [] };
    if (this.utteranceTrackers.system.silenceTimer) {
      clearTimeout(this.utteranceTrackers.system.silenceTimer);
      this.utteranceTrackers.system.silenceTimer = null;
    }
    if (this.utteranceTrackers.mic.silenceTimer) {
      clearTimeout(this.utteranceTrackers.mic.silenceTimer);
      this.utteranceTrackers.mic.silenceTimer = null;
    }
    this.utteranceTrackers.system.isSpeaking = false;
    this.utteranceTrackers.mic.isSpeaking = false;
  }

  feedAudio(frame: AudioFrame): void {
    if (!this.active) return;

    // Buffer incoming 16kHz PCM audio frames
    const pcm = new Int16Array(frame.buffer);
    if (!this.audioBuffer[frame.channel]) {
      this.audioBuffer[frame.channel] = [];
    }
    this.audioBuffer[frame.channel].push(pcm);

    // Keep rolling buffer limited to avoid unbounded memory
    if (this.audioBuffer[frame.channel].length > 40) {
      this.audioBuffer[frame.channel].shift();
    }

    // Measure speech energy (RMS)
    let sumSq = 0;
    const len = pcm.length;
    for (let i = 0; i < len; i++) {
      const s = pcm[i] / 32768.0;
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / len);

    // Energy gate for voice activity (sensitive to soft speech)
    const isVoice = rms >= 0.002;
    const tracker = this.utteranceTrackers[frame.channel] || this.utteranceTrackers.mic;
    const now = Date.now();
    const speaker = frame.channel === 'mic' ? 'You' : 'Other';

    if (isVoice) {
      // Clear any pending silence timer
      if (tracker.silenceTimer) {
        clearTimeout(tracker.silenceTimer);
        tracker.silenceTimer = null;
      }

      tracker.chunks.push(pcm);
      tracker.totalSamples += pcm.length;

      // Only consider speaking after at least 250ms of sustained speech energy
      if (!tracker.isSpeaking && tracker.totalSamples >= 16000 * 0.25) {
        tracker.isSpeaking = true;
        tracker.speechStartMs = now - Math.round((tracker.totalSamples / 16000) * 1000);
        tracker.segmentId = `seg-${now}-${Math.random().toString(36).substring(2, 6)}`;
        tracker.lastInterimMs = now;
        // Immediate interim notification so UI displays listening state right away
        this.onSegmentCallback?.({
          id: tracker.segmentId,
          text: 'Listening...',
          isFinal: false,
          startMs: tracker.speechStartMs,
          endMs: now,
          speaker,
        });
      }

      // Refresh completion timer: if the speaker stops for >3s, finalize and append
      if (tracker.isSpeaking) {
        tracker.silenceTimer = setTimeout(() => {
          this.finalizeUtterance(tracker, speaker);
        }, 3000);
      }

      // Only flush if continuous uninterrupted speech runs for 15s without any natural pause
      if (tracker.isSpeaking && tracker.totalSamples >= 16000 * 15.0) {
        const chunksToProcess = [...tracker.chunks];
        const totalSamples = tracker.totalSamples;
        const segmentId = tracker.segmentId;
        const startMs = tracker.speechStartMs;

        // Retain 500ms acoustic overlap so word boundaries are never cut in half
        const overlapSamples = 16000 * 0.5;
        const tailChunks: Int16Array[] = [];
        let accumulated = 0;
        for (let i = tracker.chunks.length - 1; i >= 0; i--) {
          tailChunks.unshift(tracker.chunks[i]);
          accumulated += tracker.chunks[i].length;
          if (accumulated >= overlapSamples) break;
        }

        tracker.speechStartMs = now - Math.round((accumulated / 16000) * 1000);
        tracker.segmentId = `seg-${now}-${Math.random().toString(36).substring(2, 6)}`;
        tracker.chunks = tailChunks;
        tracker.totalSamples = accumulated;

        this.transcribeAudio(chunksToProcess, totalSamples, segmentId, startMs, speaker, true);
      }
    } else {
      // Silence / low energy: ensure completion timer is active
      if (!tracker.silenceTimer && (tracker.isSpeaking || tracker.totalSamples > 0)) {
        tracker.silenceTimer = setTimeout(() => {
          this.finalizeUtterance(tracker, speaker);
        }, 3000);
      }
    }
  }

  private finalizeUtterance(tracker: typeof this.utteranceTrackers.mic, speaker: string): void {
    if (!this.active) return;

    if (tracker.silenceTimer) {
      clearTimeout(tracker.silenceTimer);
      tracker.silenceTimer = null;
    }

    const chunksToProcess = tracker.chunks;
    const totalSamples = tracker.totalSamples;
    const segmentId = tracker.segmentId;
    const startMs = tracker.speechStartMs;
    const wasSpeaking = tracker.isSpeaking;

    // Reset tracker for next utterance
    tracker.isSpeaking = false;
    tracker.chunks = [];
    tracker.totalSamples = 0;
    tracker.lastInterimMs = 0;

    // Skip brief transients that never sustained speech. Real short words are
    // kept and padded up to FluidAudio's minimum in `transcribeAudio`.
    if (totalSamples < MIN_USEFUL_SAMPLES && !wasSpeaking) {
      return;
    }

    if (chunksToProcess.length > 0 && totalSamples > 0) {
      this.transcribeAudio(chunksToProcess, totalSamples, segmentId, startMs, speaker, true);
    }
  }

  /**
   * Runs `task` after any in-flight inference finishes. Failures never break the
   * chain, so a single bad utterance cannot stall later transcriptions.
   */
  private enqueueInference<T>(task: () => Promise<T>): Promise<T> {
    const run = this.inferenceQueue.then(task, task);
    this.inferenceQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private transcribeAudio(
    chunks: Int16Array[],
    totalSamples: number,
    segmentId: string,
    startMs: number,
    speaker: string,
    isFinal = true
  ): void {
    const tracker = this.utteranceTrackers[speaker === 'You' ? 'mic' : 'system'];
    const { artifact, runtime: activeRuntime, usingLegacy, legacyFile } = this.resolveEffectiveRuntime();

    if (!activeRuntime.isAvailable()) {
      console.warn(`[ParakeetEngine] No runtime available for ${this.currentModel}`, {
        platform: currentPlatform(),
        runtime: activeRuntime.kind,
        runtimeBinary: activeRuntime.resolveBinary(),
      });
      return;
    }

    // A non-legacy runtime needs its artifact files on disk.
    if (!usingLegacy && artifact && !this.isArtifactInstalled(this.currentModel, artifact)) {
      console.warn(`[ParakeetEngine] Model files for ${this.currentModel} are not installed yet.`);
      return;
    }
    if (usingLegacy && !legacyFile) {
      return;
    }

    const sampled = new Int16Array(totalSamples);
    let offset = 0;
    for (const c of chunks) {
      sampled.set(c, offset);
      offset += c.length;
    }

    // FluidAudio throws invalidAudioData below 0.3 s, so pad short utterances
    // with silence rather than losing the word entirely.
    let combined = sampled;
    if (combined.length < MIN_INFERENCE_SAMPLES) {
      const padded = new Int16Array(MIN_INFERENCE_SAMPLES);
      padded.set(combined);
      combined = padded;
    }

    const wavBuffer = encodeWav(combined, 16000);
    const tempWav = path.join(
      os.tmpdir(),
      `parakeet-${Date.now()}-${Math.random().toString(36).substring(2, 6)}.wav`
    );

    try {
      fs.writeFileSync(tempWav, wavBuffer);
    } catch (err) {
      console.warn('[ParakeetEngine] Failed to write temp wav:', err);
      return;
    }

    if (tracker) tracker.isBusy = true;

    // Snapshot everything the inference needs *now*. The task below runs only
    // once the queue drains, and the user may have switched models by then —
    // reading `this.currentModel` inside the closure would pair one model's
    // directory with another model's engine.
    const activeModel = this.currentModel;
    const inferenceRequest = {
      modelDir: this.modelDirFor(activeModel),
      wavPath: tempWav,
      timeoutMs: INFERENCE_TIMEOUT_MS,
      modelFile: legacyFile,
      coreMlEngine: artifact?.engine,
      modelRoot: artifact?.modelRoot,
    };

    this.enqueueInference(() => activeRuntime.transcribe(inferenceRequest))
      .then((text) => {
        if (tracker) tracker.isBusy = false;
        const cleanText = (text || '').trim();
        if (cleanText.length > 0) {
          this.onSegmentCallback?.({
            id: segmentId,
            text: cleanText,
            isFinal,
            startMs,
            endMs: Date.now(),
            speaker,
          });
        }
      })
      .catch((error) => {
        if (tracker) tracker.isBusy = false;
        // execFile surfaces the child's stderr on the error object; the Core ML
        // helper writes its real diagnosis there, not in `message`.
        const execError = error as Error & { stderr?: string; stdout?: string };
        const stderr = (execError.stderr || '').trim();
        const stdout = (execError.stdout || '').trim();
        console.warn(
          '[ParakeetEngine] Inference error:',
          execError.message,
          stderr ? `\n  stderr: ${stderr}` : '',
          stdout ? `\n  stdout: ${stdout}` : ''
        );
      })
      .finally(() => {
        try {
          fs.unlinkSync(tempWav);
        } catch {
          // ignore
        }
      });
  }

  getStatus(): STTEngineInfo {
    const meta = PARAKEET_MODELS.find((m) => m.id === this.currentModel) || PARAKEET_MODELS[0];
    const { runtime } = this.resolveEffectiveRuntime();

    return {
      id: this.id,
      name: this.name,
      description: `NVIDIA FastConformer (${meta.name}, ${meta.parameters}). ${runtime.displayName}.`,
      isExperimental: true,
      available: runtime.isAvailable(),
      statusDetail: `Active: ${meta.name} (${meta.architecture}) via ${runtime.displayName}`,
    };
  }

  isActive(): boolean {
    return this.active;
  }

  isConnected(): boolean {
    return this.active;
  }
}