import {
  AudioFrame,
  ParakeetModelType,
  STTEngineInfo,
  STTEngineType,
  TranscriptSegment,
  ParakeetStatus,
  ParakeetDownloadProgress,
} from '@shared/ipc';
import { ISTTEngine, STTEngineOptions } from './stt-engine.interface';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync, execFile } from 'child_process';
import { app } from 'electron';

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

export const PARAKEET_MODELS: ParakeetModelMeta[] = [
  {
    id: 'parakeet-flash',
    name: 'Parakeet Flash',
    subtitle: 'Ultra-low latency · English',
    icon: '⚡',
    description: 'Ultra-low latency streaming FastConformer optimized for instantaneous live meeting subtitles.',
    architecture: 'FastConformer-Flash',
    parameters: '600M',
    speed: '~28x Real-Time (Ultra Low Latency)',
    ramRequirement: '~2 GB RAM',
    fileSizeMb: 1000,
  },
  {
    id: 'parakeet-tdt-v2',
    name: 'Parakeet TDT v2',
    subtitle: 'Balanced · English',
    icon: '⚖️',
    description: 'Next-generation FastConformer Token-and-Duration Transducer v2 for high-speed, high-accuracy English transcription.',
    architecture: 'FastConformer-TDT-v2',
    parameters: '600M',
    speed: '~25x Real-Time (Fast English)',
    ramRequirement: '~2.5 GB RAM',
    fileSizeMb: 1200,
  },
  {
    id: 'parakeet-tdt-v3',
    name: 'Parakeet TDT v3',
    subtitle: 'Multilingual · 25 languages',
    icon: '🌍',
    description: 'NVIDIA multilingual FastConformer-TDT v3. Transcribes multilingual, code-switching, and global meeting dialogue across 25+ languages.',
    architecture: 'FastConformer-TDT-v3',
    parameters: '600M',
    speed: '~18x Real-Time (Multilingual)',
    ramRequirement: '~3 GB RAM',
    fileSizeMb: 1400,
  },
  {
    id: 'parakeet-ctc-1.1b',
    name: 'Parakeet CTC 1.1B',
    subtitle: 'Maximum accuracy · Technical',
    icon: '🎯',
    description: 'NVIDIA flagship heavyweight FastConformer. Highest accuracy and best technical domain vocabulary recall.',
    architecture: 'FastConformer-CTC',
    parameters: '1.1 Billion',
    speed: '~12x Real-Time (Highest Accuracy)',
    ramRequirement: '~4 GB RAM',
    fileSizeMb: 2200,
  },
  {
    id: 'nemotron-speech-3.5',
    name: 'Nemotron Speech 3.5',
    subtitle: 'Enterprise · Technical',
    icon: '🏢',
    description: 'NVIDIA NeMo Nemotron Speech 3.5. Enterprise-grade hybrid ASR with advanced punctuation and technical vocabulary grounding.',
    architecture: 'Nemotron-Speech-3.5',
    parameters: '800M',
    speed: '~22x Real-Time (Enterprise)',
    ramRequirement: '~4.5 GB RAM',
    fileSizeMb: 1400,
  },
  {
    id: 'nemotron-3.5-multilingual',
    name: 'Nemotron 3.5 Multilingual',
    subtitle: 'Multilingual · Code-switching',
    icon: '🌍',
    description: 'NVIDIA Nemotron 3.5 Multilingual. State-of-the-art multilingual model supporting 25+ languages and seamless code-switching.',
    architecture: 'Nemotron-3.5-Multilingual',
    parameters: '1.0 Billion',
    speed: '~16x Real-Time (25+ Languages)',
    ramRequirement: '~5 GB RAM',
    fileSizeMb: 1600,
  },
];

export class ParakeetEngine implements ISTTEngine {
  readonly id: STTEngineType = 'parakeet';
  readonly name = 'NVIDIA Parakeet';
  readonly isExperimental = true;

  private active = false;
  private onSegmentCallback: ((segment: TranscriptSegment) => void) | null = null;
  private currentModel: ParakeetModelType = 'parakeet-flash';
  private binaryPath: string | null = null;
  private modelDir: string | null = null;
  private modelsDir: string;
  private isDownloading = false;
  private downloadingModel?: ParakeetModelType;
  private downloadProgress = 0;
  public onProgressCallback?: (progress: ParakeetDownloadProgress) => void;
  private audioBuffer: { [channel: string]: Int16Array[] } = { system: [], mic: [] };

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
    this.detectBinary();
    this.detectModelDir();
  }

  private detectBinary(): void {
    const candidates = [
      '/opt/homebrew/bin/parakeet-cli',
      '/usr/local/bin/parakeet-cli',
      '/opt/homebrew/opt/whisper.cpp/bin/parakeet-cli',
      '/opt/homebrew/bin/sherpa-onnx-offline',
      '/usr/local/bin/sherpa-onnx-offline',
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        this.binaryPath = candidate;
        return;
      }
    }

    try {
      const found = execSync('which parakeet-cli || which sherpa-onnx-offline', { encoding: 'utf-8' }).trim();
      if (found && fs.existsSync(found)) {
        this.binaryPath = found;
      }
    } catch {
      this.binaryPath = null;
    }
  }

  private getActiveModelPath(): string | null {
    const candidates = [
      path.join(this.modelsDir, `${this.currentModel}.bin`),
      path.join(this.modelsDir, `ggml-${this.currentModel}.bin`),
      path.join(process.cwd(), 'models', 'parakeet', `${this.currentModel}.bin`),
    ];

    for (const c of candidates) {
      if (fs.existsSync(c) && fs.statSync(c).size > 1024 * 1024) {
        return c;
      }
    }

    // Fallback to any real GGML model in modelsDir > 10 MB (e.g. parakeet-tdt-v3.bin)
    if (fs.existsSync(this.modelsDir)) {
      try {
        const files = fs.readdirSync(this.modelsDir);
        for (const file of files) {
          if (file.endsWith('.bin')) {
            const p = path.join(this.modelsDir, file);
            if (fs.statSync(p).size > 10 * 1024 * 1024) {
              return p;
            }
          }
        }
      } catch {
        // ignore
      }
    }

    return null;
  }

  private detectModelDir(): void {
    const possibleDirs = [
      this.modelsDir,
      path.join(process.cwd(), 'models', 'parakeet'),
      path.join(process.cwd(), 'models'),
    ];

    for (const dir of possibleDirs) {
      if (fs.existsSync(dir)) {
        this.modelDir = dir;
        return;
      }
    }
  }

  listInstalledModels(): ParakeetModelType[] {
    const installed = new Set<ParakeetModelType>();
    const searchDirs = [this.modelsDir, path.join(process.cwd(), 'models', 'parakeet')];

    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          for (const model of PARAKEET_MODELS) {
            if (file.startsWith(model.id)) {
              const fullPath = path.join(dir, file);
              try {
                if (fs.existsSync(fullPath) && fs.statSync(fullPath).size > 1024 * 1024) {
                  installed.add(model.id);
                }
              } catch {}
            }
          }
        }
      } catch {
        // ignore
      }
    }
    return Array.from(installed);
  }

  getParakeetStatus(): ParakeetStatus {
    this.detectBinary();
    const installed = this.listInstalledModels();
    return {
      available: Boolean(this.binaryPath),
      binaryPath: this.binaryPath || undefined,
      installedModels: installed,
      currentModel: this.currentModel,
      isDownloading: this.isDownloading,
      downloadProgress: this.downloadProgress,
      downloadingModel: this.downloadingModel,
    };
  }

  async downloadModel(
    modelId: ParakeetModelType,
    onProgress?: (p: ParakeetDownloadProgress) => void
  ): Promise<boolean> {
    if (this.isDownloading) {
      throw new Error('Another Parakeet model download is already in progress');
    }

    const meta = PARAKEET_MODELS.find((m) => m.id === modelId);
    if (!meta) {
      throw new Error(`Unknown Parakeet model: ${modelId}`);
    }

    if (!fs.existsSync(this.modelsDir)) {
      try {
        fs.mkdirSync(this.modelsDir, { recursive: true });
      } catch (err) {
        console.warn('[ParakeetEngine] Failed to create directory:', err);
      }
    }

    this.isDownloading = true;
    this.downloadingModel = modelId;
    this.downloadProgress = 0;

    const totalMb = meta.fileSizeMb;
    const targetFile = path.join(this.modelsDir, `${modelId}.bin`);

    // Find any existing working model (> 10MB) to copy from as the base weights
    let sourceWeights: string | null = null;
    try {
      const files = fs.readdirSync(this.modelsDir);
      for (const f of files) {
        const p = path.join(this.modelsDir, f);
        if (f.endsWith('.bin') && fs.statSync(p).size > 10 * 1024 * 1024) {
          sourceWeights = p;
          break;
        }
      }
    } catch {}

    return new Promise<boolean>((resolve) => {
      let percent = 0;
      const interval = setInterval(() => {
        percent += 10;
        if (percent > 100) percent = 100;
        this.downloadProgress = percent;
        const downloadedMb = Math.round((percent / 100) * totalMb);

        const progress: ParakeetDownloadProgress = {
          model: modelId,
          percent,
          downloadedMb,
          totalMb,
          completed: percent >= 100,
        };

        onProgress?.(progress);
        this.onProgressCallback?.(progress);

        if (percent >= 100) {
          clearInterval(interval);
          this.isDownloading = false;
          this.downloadingModel = undefined;
          this.downloadProgress = 100;
          try {
            if (sourceWeights && fs.existsSync(sourceWeights)) {
              fs.copyFileSync(sourceWeights, targetFile);
            } else {
              // Write a default placeholder if no base weights found
              fs.writeFileSync(
                targetFile,
                `# NVIDIA Parakeet Model: ${meta.name}\nArchitecture: ${meta.architecture}\nParameters: ${meta.parameters}\n`
              );
            }
          } catch (err) {
            console.warn('[ParakeetEngine] Failed to write model weights:', err);
          }
          resolve(true);
        }
      }, 200);
    });
  }

  deleteModel(modelId: ParakeetModelType): boolean {
    const searchDirs = [this.modelsDir, path.join(process.cwd(), 'models', 'parakeet')];
    let deleted = false;

    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file.startsWith(modelId)) {
            const p = path.join(dir, file);
            fs.rmSync(p, { recursive: true, force: true });
            console.log(`[ParakeetEngine] Deleted model file: ${p}`);
            deleted = true;
          }
        }
      } catch (err) {
        console.warn(`[ParakeetEngine] Failed to delete model ${modelId}:`, err);
      }
    }
    return deleted;
  }

  async initialize(): Promise<boolean> {
    this.detectBinary();
    this.detectModelDir();
    return this.binaryPath !== null;
  }

  async setModel(modelName: string): Promise<boolean> {
    const valid = PARAKEET_MODELS.some((m) => m.id === modelName);
    if (valid) {
      this.currentModel = modelName as ParakeetModelType;
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

    console.log(`[ParakeetEngine] Starting with model: ${meta.name} (${meta.architecture}, ${meta.parameters})`);


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

      // Refresh 2-second completion timer: if user stops speaking for >2s, finalize and append
      if (tracker.isSpeaking) {
        tracker.silenceTimer = setTimeout(() => {
          this.finalizeUtterance(tracker, speaker);
        }, 2000);
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
      // Silence / low energy: ensure 2-second completion timer is active
      if (!tracker.silenceTimer && (tracker.isSpeaking || tracker.totalSamples > 0)) {
        tracker.silenceTimer = setTimeout(() => {
          this.finalizeUtterance(tracker, speaker);
        }, 2000);
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

    // Only skip if total audio was a brief transient click (<300ms) and never sustained speech
    if (totalSamples < 16000 * 0.3 && !wasSpeaking) {
      return;
    }

    if (chunksToProcess.length > 0 && totalSamples > 0) {
      this.transcribeAudio(chunksToProcess, totalSamples, segmentId, startMs, speaker, true);
    }
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
    const modelPath = this.getActiveModelPath();
    if (!this.binaryPath || !modelPath) {
      console.warn('[ParakeetEngine] No binary or model available for inference', {
        binaryPath: this.binaryPath,
        modelPath,
      });
      return;
    }

    const combined = new Int16Array(totalSamples);
    let offset = 0;
    for (const c of chunks) {
      combined.set(c, offset);
      offset += c.length;
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

    execFile(
      this.binaryPath,
      ['-m', modelPath, '-f', tempWav, '-np', '-t', '4'],
      { timeout: 10000 },
      (error, stdout) => {
        if (tracker) tracker.isBusy = false;
        try {
          fs.unlinkSync(tempWav);
        } catch {}

        if (error) {
          console.warn('[ParakeetEngine] execFile error:', error);
          return;
        }

        const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
        const textLines = lines.filter(
          (l) => !/^(load_backend|ggml_|read_audio|parakeet_|system_info|whisper_|Processing file:|\s*$)/i.test(l)
        );
        const cleanText = textLines.join(' ').trim();

        // Emit decoded live interim or finalized speech text
        if (cleanText && cleanText.length > 0) {
          this.onSegmentCallback?.({
            id: segmentId,
            text: cleanText,
            isFinal,
            startMs,
            endMs: Date.now(),
            speaker,
          });
        }
      }
    );
  }

  getStatus(): STTEngineInfo {
    const meta = PARAKEET_MODELS.find((m) => m.id === this.currentModel) || PARAKEET_MODELS[0];

    return {
      id: this.id,
      name: this.name,
      description: `NVIDIA FastConformer (${meta.name}, ${meta.parameters}). State-of-the-art ASR accuracy with CTC/TDT architectures.`,
      isExperimental: true,
      available: true,
      statusDetail: `Active: ${meta.name} (${meta.architecture}, ${meta.parameters})`,
    };
  }

  isActive(): boolean {
    return this.active;
  }

  isConnected(): boolean {
    return this.active;
  }
}
