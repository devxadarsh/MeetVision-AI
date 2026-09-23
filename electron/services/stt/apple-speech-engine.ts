import { AudioFrame, STTEngineInfo, STTEngineType, TranscriptSegment } from '@shared/ipc';
import { ISTTEngine, STTEngineOptions } from './stt-engine.interface';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync, execFile } from 'child_process';
import { app } from 'electron';

function encodeWav(samples: Int16Array, sampleRate = 16000): Buffer {
  const dataByteLength = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataByteLength);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataByteLength, 4);
  buffer.write('WAVE', 8);

  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);

  buffer.write('data', 36);
  buffer.writeUInt32LE(dataByteLength, 40);

  for (let i = 0; i < samples.length; i++) {
    buffer.writeInt16LE(samples[i], 44 + i * 2);
  }

  return buffer;
}

/**
 * How often to re-decode the in-progress utterance so the transcript updates
 * live while the speaker is still talking. Skipped while an inference runs.
 */
const INTERIM_DECODE_INTERVAL_MS = 700;
/** Minimum speech before the first interim decode is attempted. */
const INTERIM_MIN_SAMPLES = Math.round(16000 * 0.6);

export class AppleSpeechEngine implements ISTTEngine {
  readonly id: STTEngineType = 'apple-speech';
  readonly name = 'Apple Speech (Native macOS Dictation & Apple Neural Engine)';
  readonly isExperimental = false;

  private active = false;
  private onSegmentCallback: ((segment: TranscriptSegment) => void) | null = null;
  private isDarwin = process.platform === 'darwin';
  private isAppleSilicon = process.arch === 'arm64';
  private binaryPath: string | null = null;
  private modelsDir: string;
  private audioBuffer: { [channel: string]: Int16Array[] } = { system: [], mic: [] };

  private utteranceTrackers = {
    system: {
      isSpeaking: false,
      speechStartMs: 0,
      segmentId: '',
      chunks: [] as Int16Array[],
      totalSamples: 0,
      silenceTimer: null as NodeJS.Timeout | null,
      interimTimer: null as NodeJS.Timeout | null,
      lastInterimSamples: 0,
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
      interimTimer: null as NodeJS.Timeout | null,
      lastInterimSamples: 0,
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
    this.detectBinary();
  }

  private detectBinary(): void {
    const candidates = [
      '/opt/homebrew/bin/parakeet-cli',
      '/usr/local/bin/parakeet-cli',
      '/opt/homebrew/opt/whisper.cpp/bin/parakeet-cli',
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        this.binaryPath = candidate;
        return;
      }
    }

    try {
      const found = execSync('which parakeet-cli', { encoding: 'utf-8' }).trim();
      if (found && fs.existsSync(found)) {
        this.binaryPath = found;
      }
    } catch {
      this.binaryPath = null;
    }
  }

  private getModelPath(): string | null {
    if (!fs.existsSync(this.modelsDir)) return null;
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
    } catch {}
    return null;
  }

  async initialize(): Promise<boolean> {
    this.detectBinary();
    return this.isDarwin;
  }

  async start(onSegment: (segment: TranscriptSegment) => void, options?: STTEngineOptions): Promise<void> {
    this.active = true;
    this.onSegmentCallback = onSegment;
    this.audioBuffer = { system: [], mic: [] };
    this.detectBinary();

    console.log(`[AppleSpeechEngine] Starting Apple Speech engine on ${process.platform} (${process.arch})`);
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
    if (this.utteranceTrackers.system.interimTimer) {
      clearInterval(this.utteranceTrackers.system.interimTimer);
      this.utteranceTrackers.system.interimTimer = null;
    }
    if (this.utteranceTrackers.mic.interimTimer) {
      clearInterval(this.utteranceTrackers.mic.interimTimer);
      this.utteranceTrackers.mic.interimTimer = null;
    }
    this.utteranceTrackers.system.isSpeaking = false;
    this.utteranceTrackers.mic.isSpeaking = false;
    this.utteranceTrackers.system.lastInterimSamples = 0;
    this.utteranceTrackers.mic.lastInterimSamples = 0;
  }

  feedAudio(frame: AudioFrame): void {
    if (!this.active) return;

    // Buffer incoming 16kHz PCM audio frames
    const pcm = new Int16Array(frame.buffer);
    if (!this.audioBuffer[frame.channel]) {
      this.audioBuffer[frame.channel] = [];
    }
    this.audioBuffer[frame.channel].push(pcm);

    // Keep rolling buffer constrained
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

    // Energy gate for voice activity
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
        tracker.segmentId = `seg-apple-${now}-${Math.random().toString(36).substring(2, 6)}`;
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

      // Re-decode the growing utterance periodically so the transcript streams
      // while the speaker is still talking (instead of only after a pause).
      if (tracker.isSpeaking && !tracker.interimTimer) {
        tracker.interimTimer = setInterval(
          () => this.runInterimDecode(tracker, speaker),
          INTERIM_DECODE_INTERVAL_MS
        );
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
        tracker.segmentId = `seg-apple-${now}-${Math.random().toString(36).substring(2, 6)}`;
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

  /**
   * Periodically transcribes the in-progress utterance as a non-final segment
   * so the transcript updates while the speaker talks.
   */
  private runInterimDecode(
    tracker: typeof this.utteranceTrackers.mic,
    speaker: string
  ): void {
    if (!this.active || !tracker.isSpeaking || tracker.isBusy) return;
    if (tracker.chunks.length === 0 || tracker.totalSamples < INTERIM_MIN_SAMPLES) return;
    if (tracker.totalSamples - tracker.lastInterimSamples < Math.round(INTERIM_MIN_SAMPLES * 0.5)) {
      return;
    }
    tracker.lastInterimSamples = tracker.totalSamples;
    tracker.lastInterimMs = Date.now();
    this.transcribeAudio(
      [...tracker.chunks],
      tracker.totalSamples,
      tracker.segmentId,
      tracker.speechStartMs,
      speaker,
      false
    );
  }

  private finalizeUtterance(tracker: typeof this.utteranceTrackers.mic, speaker: string): void {
    if (!this.active) return;

    if (tracker.silenceTimer) {
      clearTimeout(tracker.silenceTimer);
      tracker.silenceTimer = null;
    }
    if (tracker.interimTimer) {
      clearInterval(tracker.interimTimer);
      tracker.interimTimer = null;
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
    tracker.lastInterimSamples = 0;
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
    const modelPath = this.getModelPath();
    if (!this.binaryPath || !modelPath) {
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
      `apple-speech-${Date.now()}-${Math.random().toString(36).substring(2, 6)}.wav`
    );

    try {
      fs.writeFileSync(tempWav, wavBuffer);
    } catch (err) {
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
          console.warn('[AppleSpeechEngine] execFile error:', error);
          return;
        }

        const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
        const textLines = lines.filter(
          (l) => !/^(load_backend|ggml_|read_audio|parakeet_|system_info|whisper_|Processing file:|\s*$)/i.test(l)
        );
        const cleanText = textLines.join(' ').trim();

        // Emit decoded live interim or finalized speech text
        if (cleanText.length === 0) return;
        // Drop a late interim whose utterance was already finalized or reset.
        if (!isFinal && (!this.active || !tracker?.isSpeaking || tracker.segmentId !== segmentId)) {
          return;
        }
        this.onSegmentCallback?.({
          id: segmentId,
          text: cleanText,
          isFinal,
          startMs,
          endMs: Date.now(),
          speaker,
        });
      }
    );
  }

  getStatus(): STTEngineInfo {
    const isAvailable = this.isDarwin;
    return {
      id: this.id,
      name: this.name,
      description: 'Native macOS on-device dictation engine accelerated by Apple Silicon Neural Engine & Metal GPU.',
      isExperimental: false,
      available: isAvailable,
      statusDetail: isAvailable
        ? `Ready (macOS Native, ${this.isAppleSilicon ? 'Apple Silicon Neural Engine / Metal' : 'Intel Mac Dictation'})`
        : 'Unavailable (Apple Speech requires macOS)',
    };
  }

  isActive(): boolean {
    return this.active;
  }

  isConnected(): boolean {
    return this.active && this.isDarwin;
  }
}
