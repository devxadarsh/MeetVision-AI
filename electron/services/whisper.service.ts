import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { spawn, ChildProcess } from 'child_process';
import { TranscriptSegment, WhisperStatus, WhisperDownloadProgress } from '@shared/ipc';

export interface WhisperServiceOptions {
  model?: string;
  threads?: number;
  promptPriming?: boolean;
}

const MODEL_URLS: Record<string, string> = {
  'tiny.en': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin',
  'base.en': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
};

export class WhisperService {
  private binaryPath: string | null = null;
  private modelsDir: string;
  private active = false;
  private currentModel = 'base.en';
  private promptPriming = true;
  private onSegmentCallback: ((segment: TranscriptSegment) => void) | null = null;
  private isDownloading = false;
  private downloadProgress: WhisperDownloadProgress | null = null;

  // Audio chunk accumulation per channel (16kHz 16-bit mono PCM)
  private systemPcmChunks: Buffer[] = [];
  private micPcmChunks: Buffer[] = [];
  private systemPcmLength = 0;
  private micPcmLength = 0;

  // Queue to manage inference runs sequentially per channel
  private isProcessingSystem = false;
  private isProcessingMic = false;
  private activeProcesses: Set<ChildProcess> = new Set();

  // Target speech chunk size for real-time: ~1.5s = 24,000 samples = 48,000 bytes at 16kHz 16-bit
  private readonly TARGET_CHUNK_BYTES = 48000;
  // Minimum audio bytes to run inference: ~0.75s = 24,000 bytes
  private readonly MIN_CHUNK_BYTES = 24000;

  private hasLoggedNoModelWarning = false;
  public onProgressCallback?: (progress: WhisperDownloadProgress) => void;

  constructor() {
    this.modelsDir = path.join(app.getPath('userData'), 'models');
    if (!fs.existsSync(this.modelsDir)) {
      try {
        fs.mkdirSync(this.modelsDir, { recursive: true });
      } catch (err) {
        console.warn('[WhisperService] Failed creating models directory:', err);
      }
    }
    this.detectBinary();
  }

  detectBinary(): string | null {
    const candidatePaths = [
      '/opt/homebrew/bin/whisper-cli',
      '/usr/local/bin/whisper-cli',
      path.join(app.getAppPath(), 'electron', 'bin', 'whisper-cli'),
      path.join(process.resourcesPath || '', 'bin', 'whisper-cli'),
    ];

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        try {
          fs.accessSync(p, fs.constants.X_OK);
          this.binaryPath = p;
          return p;
        } catch {
          // not executable
        }
      }
    }

    this.binaryPath = null;
    return null;
  }

  getStatus(): WhisperStatus {
    this.detectBinary();
    const installed = this.listInstalledModels();
    const hasCurrent = installed.includes(this.currentModel);

    return {
      available: Boolean(this.binaryPath),
      binaryPath: this.binaryPath || undefined,
      gpuAcceleration: process.platform === 'darwin' ? 'Apple Silicon Metal (GPU)' : undefined,
      installedModels: installed,
      currentModel: hasCurrent ? this.currentModel : installed[0] || this.currentModel,
      isDownloading: this.isDownloading,
      downloadProgress: this.downloadProgress?.percent || 0,
      error: !this.binaryPath
        ? 'whisper-cli executable not detected. Install via "brew install whisper-cpp" or place in electron/bin'
        : undefined,
    };
  }

  listInstalledModels(): string[] {
    const searchDirs = [
      this.modelsDir,
      path.join(app.getAppPath(), 'models'),
    ];

    const modelsSet = new Set<string>();
    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const files = fs.readdirSync(dir);
        for (const f of files) {
          if (f.startsWith('ggml-') && f.endsWith('.bin')) {
            const name = f.replace(/^ggml-/, '').replace(/\.bin$/, '');
            modelsSet.add(name);
          }
        }
      } catch {
        // ignore
      }
    }
    return Array.from(modelsSet);
  }

  getModelFilePath(modelName: string): string {
    const filename = modelName.startsWith('ggml-') ? `${modelName}.bin` : `ggml-${modelName}.bin`;
    // Check workspace models dir first
    const appModelsPath = path.join(app.getAppPath(), 'models', filename);
    if (fs.existsSync(appModelsPath)) {
      return appModelsPath;
    }
    return path.join(this.modelsDir, filename);
  }

  async downloadModel(
    modelName: string,
    onProgress?: (progress: WhisperDownloadProgress) => void
  ): Promise<boolean> {
    if (this.isDownloading) {
      throw new Error('Another model download is already in progress');
    }

    const key = modelName.replace(/^ggml-/, '').replace(/\.bin$/, '');
    const url = MODEL_URLS[key] || MODEL_URLS['base.en'];
    if (!url) {
      throw new Error(`Unknown model: ${modelName}`);
    }

    const targetFile = this.getModelFilePath(key);
    const tempFile = `${targetFile}.tmp`;

    this.isDownloading = true;
    this.downloadProgress = {
      model: key,
      percent: 0,
      downloadedMb: 0,
      totalMb: 0,
      completed: false,
    };

    return new Promise<boolean>((resolve, reject) => {
      const startDownload = (downloadUrl: string) => {
        const client = downloadUrl.startsWith('https') ? https : http;

        const req = client.get(downloadUrl, (res) => {
          // Handle redirects (e.g. HuggingFace 302/307)
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            startDownload(res.headers.location);
            return;
          }

          if (res.statusCode !== 200) {
            this.isDownloading = false;
            const err = new Error(`Download failed with HTTP ${res.statusCode}`);
            if (this.downloadProgress) this.downloadProgress.error = err.message;
            onProgress?.(this.downloadProgress!);
            reject(err);
            return;
          }

          const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
          const totalMb = Math.round((totalBytes / 1024 / 1024) * 10) / 10;
          let downloadedBytes = 0;

          const fileStream = fs.createWriteStream(tempFile);

          res.on('data', (chunk: Buffer) => {
            downloadedBytes += chunk.length;
            fileStream.write(chunk);

            const percent = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
            const downloadedMb = Math.round((downloadedBytes / 1024 / 1024) * 10) / 10;

            this.downloadProgress = {
              model: key,
              percent,
              downloadedMb,
              totalMb,
              completed: false,
            };
            onProgress?.(this.downloadProgress);
            this.onProgressCallback?.(this.downloadProgress);
          });

          res.on('end', () => {
            fileStream.end(() => {
              try {
                if (fs.existsSync(targetFile)) {
                  fs.unlinkSync(targetFile);
                }
                fs.renameSync(tempFile, targetFile);

                this.isDownloading = false;
                this.currentModel = key;
                this.hasLoggedNoModelWarning = false;
                this.downloadProgress = {
                  model: key,
                  percent: 100,
                  downloadedMb: totalMb,
                  totalMb,
                  completed: true,
                };
                onProgress?.(this.downloadProgress);
                this.onProgressCallback?.(this.downloadProgress);
                resolve(true);
              } catch (err: unknown) {
                this.isDownloading = false;
                const error = err instanceof Error ? err : new Error(String(err));
                if (this.downloadProgress) this.downloadProgress.error = error.message;
                onProgress?.(this.downloadProgress!);
                reject(error);
              }
            });
          });

          res.on('error', (err) => {
            fileStream.close();
            try {
              if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            } catch {
              // ignore
            }
            this.isDownloading = false;
            if (this.downloadProgress) this.downloadProgress.error = err.message;
            onProgress?.(this.downloadProgress!);
            reject(err);
          });
        });

        req.on('error', (err) => {
          this.isDownloading = false;
          if (this.downloadProgress) this.downloadProgress.error = err.message;
          onProgress?.(this.downloadProgress!);
          reject(err);
        });
      };

      startDownload(url);
    });
  }

  autoDownloadDefaultModelIfNeeded(): void {
    const installed = this.listInstalledModels();
    if (installed.length === 0 && !this.isDownloading) {
      console.log(
        '[WhisperService] No models detected. Automatically initiating download of default model: tiny.en (~75 MB)...'
      );
      this.downloadModel('tiny.en')
        .then(() => {
          this.hasLoggedNoModelWarning = false;
          console.log(
            '[WhisperService] Default model tiny.en downloaded successfully. Local transcription active.'
          );
        })
        .catch((err) => {
          console.warn('[WhisperService] Auto-download of tiny.en failed:', err);
        });
    }
  }

  async start(
    onSegment: (segment: TranscriptSegment) => void,
    options: WhisperServiceOptions = {}
  ): Promise<void> {
    this.active = true;
    this.onSegmentCallback = onSegment;
    if (options.model) {
      this.currentModel = options.model;
    }
    if (typeof options.promptPriming === 'boolean') {
      this.promptPriming = options.promptPriming;
    }

    this.detectBinary();
    this.systemPcmChunks = [];
    this.micPcmChunks = [];
    this.systemPcmLength = 0;
    this.micPcmLength = 0;

    console.log('[WhisperService] Started local Whisper service. Current model:', this.currentModel);
    this.autoDownloadDefaultModelIfNeeded();
  }

  async stop(): Promise<void> {
    this.active = false;
    this.onSegmentCallback = null;
    this.systemPcmChunks = [];
    this.micPcmChunks = [];
    this.systemPcmLength = 0;
    this.micPcmLength = 0;

    for (const proc of this.activeProcesses) {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
    this.activeProcesses.clear();
    this.isProcessingSystem = false;
    this.isProcessingMic = false;
    console.log('[WhisperService] Stopped local Whisper service.');
  }

  isActive(): boolean {
    return this.active;
  }

  setPromptPriming(enabled: boolean): void {
    this.promptPriming = enabled;
  }

  feedPcmChunk(chunk: ArrayBuffer, channel: 'system' | 'mic'): void {
    if (!this.active) return;

    const buffer = Buffer.from(chunk);
    if (channel === 'system') {
      this.systemPcmChunks.push(buffer);
      this.systemPcmLength += buffer.length;

      if (this.systemPcmLength >= this.TARGET_CHUNK_BYTES && !this.isProcessingSystem) {
        this.processChannelAudio('system');
      }
    } else {
      this.micPcmChunks.push(buffer);
      this.micPcmLength += buffer.length;

      if (this.micPcmLength >= this.TARGET_CHUNK_BYTES && !this.isProcessingMic) {
        this.processChannelAudio('mic');
      }
    }
  }

  private async processChannelAudio(channel: 'system' | 'mic'): Promise<void> {
    if (!this.active || !this.binaryPath) return;

    let pcmBuffers: Buffer[];
    if (channel === 'system') {
      if (this.isProcessingSystem || this.systemPcmLength < this.MIN_CHUNK_BYTES) return;
      this.isProcessingSystem = true;
      pcmBuffers = this.systemPcmChunks;
      this.systemPcmChunks = [];
      this.systemPcmLength = 0;
    } else {
      if (this.isProcessingMic || this.micPcmLength < this.MIN_CHUNK_BYTES) return;
      this.isProcessingMic = true;
      pcmBuffers = this.micPcmChunks;
      this.micPcmChunks = [];
      this.micPcmLength = 0;
    }

    const pcmData = Buffer.concat(pcmBuffers);
    const wavBuffer = this.createWavBuffer(pcmData, 16000, 1, 16);
    const tempWavPath = path.join(
      app.getPath('temp'),
      `ql-whisper-${channel}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}.wav`
    );

    const speaker = channel === 'system' ? 'Other' : 'You';
    if (this.onSegmentCallback && this.active) {
      this.onSegmentCallback({
        id: `interim-${channel}`,
        text: 'Listening...',
        isFinal: false,
        startMs: Date.now() - 1000,
        endMs: Date.now(),
        speaker,
      });
    }

    try {
      await fs.promises.writeFile(tempWavPath, wavBuffer);
      const transcript = await this.runWhisperCli(tempWavPath);

      let cleanText = (transcript || '')
        .replace(/\[BLANK_AUDIO\]|\(silence\)|\[silence\]/gi, '')
        .trim();
      cleanText = cleanText.replace(/^["'\s]+|["'\s]+$/g, '').trim();

      if (
        cleanText.length > 0 &&
        cleanText !== 'Thank you.' &&
        cleanText !== 'Thanks for watching!' &&
        this.onSegmentCallback &&
        this.active
      ) {
        console.log(`[WhisperService] Transcribed (${channel} / ${speaker}): "${cleanText}"`);
        const now = Date.now();
        const segment: TranscriptSegment = {
          id: `wh-${now}-${Math.random().toString(36).substring(2, 6)}`,
          text: cleanText,
          isFinal: true,
          startMs: now - Math.round((pcmData.length / 32000) * 1000),
          endMs: now,
          speaker,
        };
        this.onSegmentCallback(segment);
      }
    } catch (err) {
      console.warn(`[WhisperService] Error during ${channel} inference:`, err);
    } finally {
      // Clean up temporary audio file
      try {
        if (fs.existsSync(tempWavPath)) {
          await fs.promises.unlink(tempWavPath);
        }
      } catch {
        // ignore unlink error
      }

      if (channel === 'system') {
        this.isProcessingSystem = false;
        // If more chunks arrived during inference, process immediately
        if (this.systemPcmLength >= this.TARGET_CHUNK_BYTES) {
          setImmediate(() => this.processChannelAudio('system'));
        }
      } else {
        this.isProcessingMic = false;
        if (this.micPcmLength >= this.TARGET_CHUNK_BYTES) {
          setImmediate(() => this.processChannelAudio('mic'));
        }
      }
    }
  }

  private runWhisperCli(wavFilePath: string): Promise<string> {
    return new Promise((resolve) => {
      if (!this.binaryPath) {
        resolve('');
        return;
      }

      const modelPath = this.getModelFilePath(this.currentModel);
      if (!fs.existsSync(modelPath)) {
        // Check if another installed model exists as fallback
        const installed = this.listInstalledModels();
        if (installed.length === 0) {
          if (this.isDownloading) {
            // Model is currently downloading in background, wait silently
            resolve('');
            return;
          }
          if (!this.hasLoggedNoModelWarning) {
            console.warn(
              '[WhisperService] No models installed. Downloading default model tiny.en, or select/download in Settings -> Audio & Transcription.'
            );
            this.hasLoggedNoModelWarning = true;
          }
          resolve('');
          return;
        }
      }

      const args = [
        '-m',
        fs.existsSync(modelPath) ? modelPath : this.getModelFilePath(this.listInstalledModels()[0]),
        '-f',
        wavFilePath,
        '--language',
        'en',
        '--no-timestamps',
        '-np', // no prints
        '-nt', // no timestamps
        '--threads',
        '4',
      ];

      if (this.promptPriming) {
        args.push(
          '--prompt',
          'Meeting discussion: engineering, architecture, technical questions, project updates.'
        );
      }

      const child = spawn(this.binaryPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.activeProcesses.add(child);
      let stdoutData = '';
      let stderrData = '';

      child.stdout.on('data', (data: Buffer) => {
        stdoutData += data.toString('utf-8');
      });

      child.stderr.on('data', (data: Buffer) => {
        stderrData += data.toString('utf-8');
      });

      const timeout = setTimeout(() => {
        if (this.activeProcesses.has(child)) {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
      }, 8000); // 8 second safeguard timeout

      child.on('close', (code) => {
        clearTimeout(timeout);
        this.activeProcesses.delete(child);

        if (code !== 0 && code !== null) {
          console.warn(`[WhisperService] whisper-cli exited with code ${code}. Stderr:`, stderrData.trim());
        }

        const lines = stdoutData
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);

        resolve(lines.join(' '));
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        this.activeProcesses.delete(child);
        console.warn('[WhisperService] Spawn error:', err);
        resolve('');
      });
    });
  }

  private createWavBuffer(
    pcmData: Buffer,
    sampleRate: number,
    channels: number,
    bitsPerSample: number
  ): Buffer {
    const byteRate = (sampleRate * channels * bitsPerSample) / 8;
    const blockAlign = (channels * bitsPerSample) / 8;
    const dataLength = pcmData.length;
    const header = Buffer.alloc(44);

    // RIFF identifier
    header.write('RIFF', 0);
    // File length minus 8 bytes
    header.writeUInt32LE(36 + dataLength, 4);
    // WAVE identifier
    header.write('WAVE', 8);
    // fmt subchunk identifier
    header.write('fmt ', 12);
    // Subchunk1Size (16 for PCM)
    header.writeUInt32LE(16, 16);
    // AudioFormat (1 for PCM)
    header.writeUInt16LE(1, 20);
    // NumChannels
    header.writeUInt16LE(channels, 22);
    // SampleRate
    header.writeUInt32LE(sampleRate, 24);
    // ByteRate
    header.writeUInt32LE(byteRate, 28);
    // BlockAlign
    header.writeUInt16LE(blockAlign, 32);
    // BitsPerSample
    header.writeUInt16LE(bitsPerSample, 34);
    // data subchunk identifier
    header.write('data', 36);
    // data chunk length
    header.writeUInt32LE(dataLength, 40);

    return Buffer.concat([header, pcmData]);
  }
}
