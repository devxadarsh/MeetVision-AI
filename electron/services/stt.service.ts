import {
  TranscriptSegment,
  AudioChunkPayload,
  TranscriptionMode,
  AudioFrame,
  STTEngineInfo,
  STTEngineType,
  AppSettings,
  ParakeetModelType,
} from '@shared/ipc';
import { ISTTEngine, STTEngineOptions } from './stt/stt-engine.interface';
import { AppleSpeechEngine } from './stt/apple-speech-engine';
import { ParakeetEngine } from './stt/parakeet-engine';
import { TranscriptManager } from './transcript-manager';

export interface SttOptions extends STTEngineOptions {
  provider?: STTEngineType;
  diarize?: boolean;
  parakeetModel?: ParakeetModelType;
}

export interface ISttService {
  start(onSegment: (segment: TranscriptSegment) => void, options?: SttOptions): Promise<void>;
  stop(): Promise<void>;
  feedAudio(chunk: AudioChunkPayload): void;
  getProviderName(): string;
  getModelName(): string;
  isActive(): boolean;
  isConnected(): boolean;
  getEngines(): STTEngineInfo[];
  setEngine(engineId: STTEngineType): Promise<void>;
  applySettings(settings: AppSettings): Promise<void>;
}

export class SttService implements ISttService {
  private active = false;
  private currentEngineId: STTEngineType = 'parakeet';
  private transcriptionMode: TranscriptionMode = 'everyone';
  private onSegmentCallback: ((segment: TranscriptSegment) => void) | null = null;
  private currentOptions: SttOptions = {};
  private transcriptUnsubscribe: (() => void) | null = null;

  readonly transcriptManager = new TranscriptManager();
  private engines: Map<STTEngineType, ISTTEngine> = new Map();
  private activeEngine: ISTTEngine;

  readonly appleSpeechEngine = new AppleSpeechEngine();
  readonly parakeetEngine = new ParakeetEngine();

  constructor() {
    this.engines.set('parakeet', this.parakeetEngine);
    this.engines.set('apple-speech', this.appleSpeechEngine);

    // Default to NVIDIA Parakeet
    this.currentEngineId = 'parakeet';
    this.activeEngine = this.parakeetEngine;
  }

  getEngines(): STTEngineInfo[] {
    return [
      this.parakeetEngine.getStatus(),
      this.appleSpeechEngine.getStatus(),
    ];
  }

  getProviderName(): string {
    switch (this.currentEngineId) {
      case 'apple-speech':
        return 'Apple Speech';
      case 'parakeet':
        return 'NVIDIA Parakeet';
      default:
        return this.activeEngine ? this.activeEngine.name : 'NVIDIA Parakeet';
    }
  }

  getModelName(): string {
    switch (this.currentEngineId) {
      case 'parakeet':
        return this.parakeetEngine.getCurrentModelDisplayName();
      case 'apple-speech':
        return 'macOS Neural Engine';
      default:
        return '';
    }
  }

  getCurrentProvider(): STTEngineType {
    return this.currentEngineId;
  }

  isActive(): boolean {
    return this.active;
  }

  isConnected(): boolean {
    return this.active && this.activeEngine ? this.activeEngine.isConnected() : false;
  }

  setTranscriptionMode(mode: TranscriptionMode): void {
    this.transcriptionMode = mode;
    console.log(`[SttService] Transcription mode set to: ${mode}`);
  }

  getTranscriptionMode(): TranscriptionMode {
    return this.transcriptionMode;
  }

  async setEngine(engineId: STTEngineType): Promise<void> {
    const normalizedId: STTEngineType = engineId === 'local-whisper' ? 'whisper' : engineId;
    if (this.currentEngineId === normalizedId) return;

    console.log(`[SttService] Switching STT engine from ${this.currentEngineId} to ${normalizedId}`);
    const wasActive = this.active;

    if (wasActive) {
      await this.stop();
    }

    const nextEngine = this.engines.get(normalizedId);
    if (!nextEngine) {
      console.warn(`[SttService] Unknown engine ${engineId}, defaulting to parakeet`);
      this.activeEngine = this.parakeetEngine;
      this.currentEngineId = 'parakeet';
    } else {
      this.activeEngine = nextEngine;
      this.currentEngineId = normalizedId;
    }

    if (wasActive && this.onSegmentCallback) {
      await this.start(this.onSegmentCallback, this.currentOptions);
    }
  }

  async start(onSegment: (segment: TranscriptSegment) => void, options: SttOptions = {}): Promise<void> {
    this.onSegmentCallback = onSegment;
    this.currentOptions = options;

    if (options.transcriptionMode) {
      this.transcriptionMode = options.transcriptionMode;
    }

    if (options.provider) {
      const selected = this.engines.get(options.provider);
      if (selected) {
        this.activeEngine = selected;
        this.currentEngineId = options.provider;
      }
    }

    if (options.parakeetModel) {
      await this.parakeetEngine.setModel(options.parakeetModel);
    }

    this.active = true;

    // Connect TranscriptManager to emit to the caller (main.ts handleTranscriptSegment)
    if (this.transcriptUnsubscribe) {
      this.transcriptUnsubscribe();
      this.transcriptUnsubscribe = null;
    }
    this.transcriptManager.clear();
    this.transcriptUnsubscribe = this.transcriptManager.subscribe((segment) => {
      onSegment(segment);
    });

    console.log(`[SttService] Starting active engine: ${this.activeEngine.name}`);
    await this.activeEngine.start((segment) => {
      this.transcriptManager.emit(segment);
    }, options);
  }

  async applySettings(settings: AppSettings): Promise<void> {
    const nextEngineId: STTEngineType = settings.sttProvider || this.currentEngineId;
    const providerChanged = this.currentEngineId !== nextEngineId;

    let modelChanged = false;
    if (settings.parakeetModel) {
      const prevP = this.parakeetEngine.getCurrentModel();
      await this.parakeetEngine.setModel(settings.parakeetModel);
      if (prevP !== settings.parakeetModel && nextEngineId === 'parakeet') {
        modelChanged = true;
      }
    }

    if (settings.transcriptionMode) {
      this.transcriptionMode = settings.transcriptionMode;
    }

    const wasActive = this.active;

    if (providerChanged) {
      console.log(`[SttService] Switching engine from ${this.currentEngineId} to ${nextEngineId}`);
      if (wasActive) {
        await this.stop();
      }
      const nextEngine = this.engines.get(nextEngineId);
      if (nextEngine) {
        this.activeEngine = nextEngine;
        this.currentEngineId = nextEngineId;
      }
      if (wasActive && this.onSegmentCallback) {
        await this.start(this.onSegmentCallback, {
          ...this.currentOptions,
          provider: nextEngineId,
          parakeetModel: settings.parakeetModel,
          transcriptionMode: settings.transcriptionMode,
        });
      }
    } else if (modelChanged && wasActive && this.onSegmentCallback) {
      console.log(`[SttService] Model changed for active engine ${this.currentEngineId}, restarting with new model`);
      await this.activeEngine.stop();
      await this.activeEngine.start((segment) => {
        this.transcriptManager.emit(segment);
      }, {
        ...this.currentOptions,
        parakeetModel: settings.parakeetModel,
        transcriptionMode: settings.transcriptionMode,
      });
    }
  }

  async stop(): Promise<void> {
    this.active = false;
    if (this.transcriptUnsubscribe) {
      this.transcriptUnsubscribe();
      this.transcriptUnsubscribe = null;
    }
    if (this.activeEngine) {
      await this.activeEngine.stop();
    }
    this.transcriptManager.clear();
  }

  feedAudio(chunk: AudioChunkPayload): void {
    if (!this.active || !this.activeEngine) return;

    let channel: 'system' | 'mic' = 'system';
    let buffer: ArrayBuffer;

    if ('channel' in chunk && 'buffer' in chunk) {
      channel = chunk.channel;
      buffer = chunk.buffer;
    } else {
      buffer = chunk as ArrayBuffer;
    }

    // In other-only mode, strictly ignore microphone audio
    if (this.transcriptionMode === 'other-only' && channel === 'mic') {
      return;
    }


    const frame: AudioFrame = {
      channel,
      buffer,
      sampleRate: 16000,
      timestamp: Date.now(),
    };

    this.activeEngine.feedAudio(frame);
  }

  setPromptPriming(enabled: boolean): void {
    if (this.activeEngine.setPromptPriming) {
      this.activeEngine.setPromptPriming(enabled);
    }
  }
}
