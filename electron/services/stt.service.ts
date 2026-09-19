import { TranscriptSegment } from '@shared/ipc';

export interface SttOptions {
  apiKey?: string;
  language?: 'en' | 'hi' | 'multi';
  diarize?: boolean;
}

export interface ISttService {
  start(onSegment: (segment: TranscriptSegment) => void, options?: SttOptions): Promise<void>;
  stop(): Promise<void>;
  feedAudio(chunk: ArrayBuffer): void;
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
  private providerName = 'Deepgram Streaming';
  private sessionStartTime = 0;
  private simTimer: NodeJS.Timeout | null = null;
  private simIndex = 0;
  private retryCount = 0;
  private maxRetries = 4;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor() {
    if (!process.env.DEEPGRAM_API_KEY) {
      this.providerName = 'Local Meeting STT Simulator';
    }
  }

  getProviderName(): string {
    return this.providerName;
  }

  isActive(): boolean {
    return this.active;
  }

  isConnected(): boolean {
    return this.connected || (this.active && !this.ws);
  }

  async start(onSegment: (segment: TranscriptSegment) => void, options: SttOptions = {}): Promise<void> {
    if (this.active) return;
    this.active = true;
    this.onSegmentCallback = onSegment;
    this.sessionStartTime = Date.now();
    this.retryCount = 0;

    const apiKey = options.apiKey || process.env.DEEPGRAM_API_KEY;
    if (apiKey) {
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
    this.onSegmentCallback = null;
  }

  feedAudio(chunk: ArrayBuffer): void {
    if (!this.active) return;

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(chunk);
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
            // Exponential backoff with jitter
            const delay = Math.min(15000, 1000 * Math.pow(2, this.retryCount - 1) + Math.random() * 500);
            console.log(`[SttService] WebSocket disconnected. Retry ${this.retryCount}/${this.maxRetries} in ${Math.round(delay)}ms...`);
            this.reconnectTimer = setTimeout(() => {
              if (this.active) this.connectDeepgram(apiKey);
            }, delay);
          } else {
            console.warn('[SttService] Max retries reached, failing over to local meeting simulation.');
            this.providerName = 'Local Meeting STT (Fallback Mode)';
            this.startSimulationStream();
          }
        }
      };
    } catch (err) {
      console.warn('[SttService] WebSocket initialization failed, falling back to simulator:', err);
      this.providerName = 'Local Meeting STT (Simulation Mode)';
      this.startSimulationStream();
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
          speaker: 'Speaker 1',
        };
        this.onSegmentCallback(segment);
      }

      if (!isFinal) {
        // Stream next interim token in 250-450ms
        this.simTimer = setTimeout(streamNextToken, 250 + Math.random() * 200);
      } else {
        // Pause between sentences (3-5s), then stream next sentence
        this.simTimer = setTimeout(() => {
          if (this.active) {
            this.startSimulationStream();
          }
        }, 3000 + Math.random() * 2000);
      }
    };

    // Begin streaming tokens for this sentence
    this.simTimer = setTimeout(streamNextToken, 800);
  }
}
