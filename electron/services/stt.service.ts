import { TranscriptSegment, AudioChunkPayload, TranscriptionMode } from '@shared/ipc';
import { WhisperService } from './whisper.service';

export interface SttOptions {
  provider?: 'deepgram' | 'simulation' | 'local-whisper';
  apiKey?: string;
  language?: 'en' | 'hi' | 'multi';
  diarize?: boolean;
  transcriptionMode?: TranscriptionMode;
  whisperModel?: string;
}

export interface ISttService {
  start(onSegment: (segment: TranscriptSegment) => void, options?: SttOptions): Promise<void>;
  stop(): Promise<void>;
  feedAudio(chunk: AudioChunkPayload): void;
  getProviderName(): string;
  isActive(): boolean;
  isConnected(): boolean;
}

const SIMULATED_MEETING_TRANSCRIPTS = [
  "Good morning team, let's start today's architectural sync.",
  "First topic on the agenda: the payment service retry logic.",
  "How does the retry logic and exponential backoff work in the payment flow?",
  "We noticed some 504 gateway timeouts during the peak traffic spike yesterday.",
  "Right, we have three retries with jittered backoff, capping at four seconds.",
  "Next item: what's the rollout schedule and canary plan for the v2 migration?",
  "Phase one is already at 100 percent in staging, and ten percent canary goes live Tuesday.",
  "What is the fallback mechanism if the external KYC verification provider times out?",
  "We queue the verification in async background mode with a two minute SLA.",
  "Can you explain the difference in p99 database latency after the Redis caching update?",
  "The query latency dropped from 340 milliseconds down to 42 milliseconds on read replicas.",
  "Any questions on security or token storage before we wrap up?",
];

export class SttService implements ISttService {
  private active = false;
  private connected = false;
  private onSegmentCallback: ((segment: TranscriptSegment) => void) | null = null;
  private ws: WebSocket | null = null;
  private providerName = 'Local Whisper (Apple Silicon Metal)';
  private sessionStartTime = 0;
  private simTimer: NodeJS.Timeout | null = null;
  private simIndex = 0;
  private retryCount = 0;
  private maxRetries = 4;
  private reconnectTimer: NodeJS.Timeout | null = null;

  readonly whisperService = new WhisperService();
  private currentProvider: 'deepgram' | 'simulation' | 'local-whisper' = 'local-whisper';
  private transcriptionMode: TranscriptionMode = 'other-only';

  constructor() {
    // If whisper-cli is available, prefer local-whisper by default for free private transcription
    if (this.whisperService.getStatus().available) {
      this.providerName = 'Local Whisper (Apple Silicon Metal)';
      this.currentProvider = 'local-whisper';
    } else if (process.env.DEEPGRAM_API_KEY) {
      this.providerName = 'Deepgram Streaming';
      this.currentProvider = 'deepgram';
    } else {
      this.providerName = 'Local Meeting STT Simulator';
      this.currentProvider = 'simulation';
    }
  }

  getProviderName(): string {
    return this.providerName;
  }

  getCurrentProvider(): 'deepgram' | 'simulation' | 'local-whisper' {
    return this.currentProvider;
  }

  isActive(): boolean {
    return this.active;
  }

  isConnected(): boolean {
    if (this.currentProvider === 'local-whisper') {
      return this.active && this.whisperService.isActive();
    }
    return this.connected || (this.active && !this.ws);
  }

  setTranscriptionMode(mode: TranscriptionMode): void {
    this.transcriptionMode = mode;
    console.log(`[SttService] Transcription mode set to: ${mode}`);
  }

  getTranscriptionMode(): TranscriptionMode {
    return this.transcriptionMode;
  }

  async start(onSegment: (segment: TranscriptSegment) => void, options: SttOptions = {}): Promise<void> {
    if (this.active) return;
    this.active = true;
    this.onSegmentCallback = onSegment;
    this.sessionStartTime = Date.now();
    this.retryCount = 0;

    if (options.transcriptionMode) {
      this.transcriptionMode = options.transcriptionMode;
    }

    const provider = options.provider || (this.whisperService.getStatus().available ? 'local-whisper' : 'simulation');
    this.currentProvider = provider;

    if (provider === 'local-whisper') {
      this.providerName = 'Local Whisper (Apple Silicon Metal)';
      this.connected = true;
      await this.whisperService.start(onSegment, {
        model: options.whisperModel || 'base.en',
      });
      return;
    }

    const apiKey = options.apiKey || process.env.DEEPGRAM_API_KEY;
    if (provider === 'deepgram' && apiKey) {
      this.providerName = 'Deepgram WebSocket';
      this.connectDeepgram(apiKey, options);
    } else {
      this.providerName = 'Local Meeting STT (Simulation Mode)';
      this.connected = true;
      this.startSimulationStream();
    }
  }

  async stop(): Promise<void> {
    this.active = false;
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore on close
      }
      this.ws = null;
    }
    if (this.simTimer) {
      clearTimeout(this.simTimer);
      this.simTimer = null;
    }

    await this.whisperService.stop();
    this.onSegmentCallback = null;
  }

  feedAudio(chunk: AudioChunkPayload): void {
    if (!this.active) return;

    let channel: 'system' | 'mic' = 'system';
    let buffer: ArrayBuffer;

    if ('channel' in chunk && 'buffer' in chunk) {
      channel = chunk.channel;
      buffer = chunk.buffer;
    } else {
      buffer = chunk as ArrayBuffer;
    }

    // Mode A (Other Participant Only): Mute/ignore microphone channel completely!
    if (this.transcriptionMode === 'other-only' && channel === 'mic') {
      return;
    }

    if (this.currentProvider === 'local-whisper') {
      this.whisperService.feedPcmChunk(buffer, channel);
      return;
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(buffer);
      } catch (err) {
        console.warn('[SttService] Error sending audio chunk to WebSocket:', err);
      }
    }
  }

  private connectDeepgram(apiKey: string, options: SttOptions = {}): void {
    if (!this.active) return;

    const lang = options.language === 'hi' ? 'hi' : options.language === 'multi' ? 'multi' : 'en-US';
    const diarizeParam = options.diarize !== false ? '&diarize=true' : '';
    const langParam = options.language === 'multi' ? '&detect_language=true' : `&language=${lang}`;

    const url =
      `wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1&interim_results=true&punctuate=true&endpointing=300${diarizeParam}${langParam}`;

    try {
      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Token ${apiKey}`,
        },
      } as unknown as string[]);

      this.ws.onopen = () => {
        console.log('[SttService] Connected to Deepgram streaming WebSocket.');
        this.connected = true;
        this.retryCount = 0;
      };

      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data.toString());
          const alt = data?.channel?.alternatives?.[0];
          const transcript = alt?.transcript?.trim();
          const isFinal = Boolean(data?.is_final);

          if (transcript && this.onSegmentCallback) {
            const now = Date.now();
            const segment: TranscriptSegment = {
              id: `seg-${now}-${Math.random().toString(36).substring(2, 7)}`,
              text: transcript,
              isFinal,
              startMs: Math.round(data.start * 1000) || now - this.sessionStartTime,
              endMs: Math.round((data.start + data.duration) * 1000) || now - this.sessionStartTime + 500,
              speaker: alt?.words?.[0]?.speaker ? `Speaker ${alt.words[0].speaker}` : undefined,
            };
            this.onSegmentCallback(segment);
          }
        } catch (err) {
          console.warn('[SttService] Failed parsing Deepgram message:', err);
        }
      };

      this.ws.onerror = (err) => {
        console.warn('[SttService] Deepgram WebSocket error:', err);
      };

      this.ws.onclose = () => {
        this.connected = false;
        if (this.active) {
          this.retryCount++;
          if (this.retryCount <= this.maxRetries) {
            const delay = Math.min(15000, 1000 * Math.pow(2, this.retryCount - 1) + Math.random() * 500);
            console.log(`[SttService] WebSocket disconnected. Retry ${this.retryCount}/${this.maxRetries} in ${Math.round(delay)}ms...`);
            this.reconnectTimer = setTimeout(() => {
              if (this.active) this.connectDeepgram(apiKey);
            }, delay);
          } else {
            console.warn('[SttService] Max retries reached, failing over to local Whisper.');
            this.providerName = 'Local Whisper (Apple Silicon Metal)';
            this.currentProvider = 'local-whisper';
            this.whisperService.start(this.onSegmentCallback!);
          }
        }
      };
    } catch (err) {
      console.warn('[SttService] WebSocket initialization failed, falling back to local Whisper:', err);
      this.providerName = 'Local Whisper (Apple Silicon Metal)';
      this.currentProvider = 'local-whisper';
      this.whisperService.start(this.onSegmentCallback!);
    }
  }

  private startSimulationStream(): void {
    if (!this.active) return;
    this.connected = true;

    const fullSentence =
      SIMULATED_MEETING_TRANSCRIPTS[this.simIndex % SIMULATED_MEETING_TRANSCRIPTS.length];
    this.simIndex++;

    const words = fullSentence.split(' ');
    let currentWordIndex = 0;
    const segmentId = `sim-${Date.now()}`;
    const startMs = Date.now() - this.sessionStartTime;

    const streamNextToken = () => {
      if (!this.active) return;

      currentWordIndex = Math.min(words.length, currentWordIndex + Math.floor(Math.random() * 2) + 1);
      const partialText = words.slice(0, currentWordIndex).join(' ');
      const isFinal = currentWordIndex >= words.length;

      if (this.onSegmentCallback) {
        const segment: TranscriptSegment = {
          id: segmentId,
          text: partialText,
          isFinal,
          startMs,
          endMs: Date.now() - this.sessionStartTime,
          speaker: 'Other',
        };
        this.onSegmentCallback(segment);
      }

      if (!isFinal) {
        this.simTimer = setTimeout(streamNextToken, 250 + Math.random() * 200);
      } else {
        this.simTimer = setTimeout(() => {
          if (this.active) {
            this.startSimulationStream();
          }
        }, 3000 + Math.random() * 2000);
      }
    };

    this.simTimer = setTimeout(streamNextToken, 800);
  }
}
