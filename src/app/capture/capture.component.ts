import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  OnDestroy,
  inject,
  signal,
} from '@angular/core';
import { IpcService } from '../core/ipc.service';
import { TranscriptionMode } from '@shared/ipc';

interface ChannelVadState {
  hangoverCounter: number;
  lastRms: number;
  isSpeechActive: boolean;
}

@Component({
  selector: 'app-capture',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './capture.component.html',
  styleUrl: './capture.component.scss',
})
export class CaptureComponent implements OnInit, OnDestroy {
  private readonly ipcService = inject(IpcService);

  readonly isCapturing = signal(false);
  readonly sourceName = signal('System Loopback / Mic');
  readonly audioLevel = signal(0);
  readonly errorMessage = signal<string | null>(null);
  readonly transcriptionMode = signal<TranscriptionMode>('other-only');
  readonly meetingAudioActive = signal(false);
  readonly micAudioActive = signal(false);

  // VAD parameters (Energy-based Voice Activity Detection)
  // Dynamic threshold: adjustable between 0.002 (high sensitivity) to 0.025 (high noise cut)
  private vadThreshold = 0.006;
  // Hangover of 5 frames (~1250ms) preserves word endings and intra-sentence pauses
  private readonly HANGOVER_FRAMES = 5;

  // Voice Equalizer & Bandpass Filter Parameters
  private voiceFilterEnabled = true;
  private voiceLowCutHz = 120;
  private voiceHighCutHz = 4000;

  private systemVad: ChannelVadState = { hangoverCounter: 0, lastRms: 0, isSpeechActive: false };
  private micVad: ChannelVadState = { hangoverCounter: 0, lastRms: 0, isSpeechActive: false };

  // Meeting / System loopback audio pipeline
  private systemAudioContext?: AudioContext;
  private systemMediaStream?: MediaStream;
  private systemProcessor?: ScriptProcessorNode;
  private systemHighpass?: BiquadFilterNode;
  private systemLowpass?: BiquadFilterNode;

  // Microphone audio pipeline (used only in 'everyone' mode)
  private micAudioContext?: AudioContext;
  private micMediaStream?: MediaStream;
  private micProcessor?: ScriptProcessorNode;
  private micHighpass?: BiquadFilterNode;
  private micLowpass?: BiquadFilterNode;

  private simInterval?: ReturnType<typeof setInterval>;
  private unsubscribeMode?: () => void;
  private unsubscribeSettings?: () => void;

  async ngOnInit(): Promise<void> {
    try {
      const mode = await this.ipcService.getTranscriptionMode();
      this.transcriptionMode.set(mode);
    } catch {
      // ignore
    }

    try {
      const settings = await this.ipcService.getSettings();
      this.applyFilterSettings(settings);
    } catch {
      // ignore
    }

    this.unsubscribeMode = this.ipcService.onTranscriptionModeChanged((mode) => {
      console.log(`[CaptureComponent] Runtime mode switch to: ${mode}`);
      this.transcriptionMode.set(mode);
      this.syncStreamsForMode();
    });

    this.unsubscribeSettings = this.ipcService.onSettingsChanged((settings) => {
      this.applyFilterSettings(settings);
    });

    // Attempt automatic audio capture on init
    this.startCapture().catch((err) => {
      console.log('[CaptureComponent] Autostart capture waiting for user gesture or permissions:', err);
    });
  }

  private applyFilterSettings(settings: import('@shared/ipc').AppSettings): void {
    this.voiceFilterEnabled = settings.voiceFilterEnabled !== false;
    this.voiceLowCutHz = typeof settings.voiceLowCutHz === 'number' ? settings.voiceLowCutHz : 120;
    this.voiceHighCutHz = typeof settings.voiceHighCutHz === 'number' ? settings.voiceHighCutHz : 4000;
    this.vadThreshold = typeof settings.vadSensitivity === 'number' ? settings.vadSensitivity : 0.006;

    const lowCut = this.voiceFilterEnabled ? this.voiceLowCutHz : 20;
    const highCut = this.voiceFilterEnabled ? this.voiceHighCutHz : 8000;

    if (this.systemHighpass && this.systemAudioContext) {
      this.systemHighpass.frequency.setTargetAtTime(lowCut, this.systemAudioContext.currentTime, 0.05);
    }
    if (this.systemLowpass && this.systemAudioContext) {
      this.systemLowpass.frequency.setTargetAtTime(highCut, this.systemAudioContext.currentTime, 0.05);
    }
    if (this.micHighpass && this.micAudioContext) {
      this.micHighpass.frequency.setTargetAtTime(lowCut, this.micAudioContext.currentTime, 0.05);
    }
    if (this.micLowpass && this.micAudioContext) {
      this.micLowpass.frequency.setTargetAtTime(highCut, this.micAudioContext.currentTime, 0.05);
    }
  }

  ngOnDestroy(): void {
    if (this.unsubscribeMode) {
      this.unsubscribeMode();
    }
    if (this.unsubscribeSettings) {
      this.unsubscribeSettings();
    }
    this.stopCapture();
  }

  async toggleCapture(): Promise<void> {
    if (this.isCapturing()) {
      this.stopCapture();
    } else {
      await this.startCapture();
    }
  }

  async startCapture(): Promise<void> {
    this.errorMessage.set(null);

    try {
      await this.setupSystemAudio();

      if (this.transcriptionMode() === 'everyone') {
        await this.setupMicAudio();
      }

      this.isCapturing.set(true);
      this.updateSourceName();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.errorMessage.set(`Audio capture error: ${msg}`);
      this.startSimulationAudioStream();
    }
  }

  private async setupSystemAudio(): Promise<void> {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices) {
      throw new Error('navigator.mediaDevices is not available in this environment');
    }

    const settings = await this.ipcService.getSettings();
    let stream: MediaStream | null = null;

    // If specific device ID configured for meeting audio
    if (settings.meetingAudioDeviceId) {
      try {
        stream = await mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: settings.meetingAudioDeviceId },
            sampleRate: 16000,
            channelCount: 1,
            echoCancellation: false,
            noiseSuppression: false,
          },
        });
      } catch (err) {
        console.warn('[CaptureComponent] Failed getting meeting device by ID, falling back:', err);
      }
    }

    // Attempt getDisplayMedia for loopback audio
    if (!stream && typeof mediaDevices.getDisplayMedia === 'function') {
      try {
        stream = await mediaDevices.getDisplayMedia({
          audio: true,
          video: true,
        });
        if (!stream.getAudioTracks() || stream.getAudioTracks().length === 0) {
          stream.getTracks().forEach((t) => t.stop());
          stream = null;
        }
      } catch {
        // Fallback to getUserMedia (e.g. BlackHole or default device)
      }
    }

    if (!stream) {
      stream = await mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
        },
      });
    }

    this.systemMediaStream = stream;
    this.meetingAudioActive.set(true);

    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.onended = () => {
        console.warn('[CaptureComponent] System audio track ended. Reconnecting...');
        if (this.isCapturing()) {
          this.reconnectSystemAudio();
        }
      };
    }

    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.systemAudioContext = new AudioCtx({ sampleRate: 16000 });

    const source = this.systemAudioContext.createMediaStreamSource(stream);
    this.systemProcessor = this.systemAudioContext.createScriptProcessor(4096, 1, 1);

    this.systemProcessor.onaudioprocess = (e) => {
      if (!this.isCapturing()) return;
      this.processPcmChunk(e.inputBuffer.getChannelData(0), 'system', this.systemVad);
    };

    // Voice frequency equalizer bandpass: low-cut (highpass) + high-cut (lowpass)
    const lowCut = this.voiceFilterEnabled ? this.voiceLowCutHz : 20;
    const highCut = this.voiceFilterEnabled ? this.voiceHighCutHz : 8000;

    const hp = this.systemAudioContext.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = lowCut;

    const lp = this.systemAudioContext.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = highCut;

    this.systemHighpass = hp;
    this.systemLowpass = lp;

    source.connect(hp);
    hp.connect(lp);
    lp.connect(this.systemProcessor);
    this.systemProcessor.connect(this.systemAudioContext.destination);
  }

  private async setupMicAudio(): Promise<void> {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices) return;

    const settings = await this.ipcService.getSettings();
    let stream: MediaStream | null = null;

    try {
      const audioConstraint: MediaTrackConstraints = {
        sampleRate: 16000,
        channelCount: 1,
        echoCancellation: settings.echoCancellation !== false,
        noiseSuppression: settings.noiseSuppression !== false,
        autoGainControl: settings.autoGainControl !== false,
      };

      if (settings.micAudioDeviceId) {
        audioConstraint.deviceId = { exact: settings.micAudioDeviceId };
      }

      stream = await mediaDevices.getUserMedia({ audio: audioConstraint });
    } catch (err) {
      console.warn('[CaptureComponent] Failed getting microphone audio stream:', err);
      return;
    }

    this.micMediaStream = stream;
    this.micAudioActive.set(true);

    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.onended = () => {
        console.warn('[CaptureComponent] Mic audio track ended. Reconnecting...');
        if (this.isCapturing() && this.transcriptionMode() === 'everyone') {
          setTimeout(() => this.setupMicAudio(), 1500);
        }
      };
    }

    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.micAudioContext = new AudioCtx({ sampleRate: 16000 });

    const source = this.micAudioContext.createMediaStreamSource(stream);
    this.micProcessor = this.micAudioContext.createScriptProcessor(4096, 1, 1);

    this.micProcessor.onaudioprocess = (e) => {
      if (!this.isCapturing() || this.transcriptionMode() !== 'everyone') return;
      this.processPcmChunk(e.inputBuffer.getChannelData(0), 'mic', this.micVad);
    };

    // Voice frequency equalizer bandpass: low-cut (highpass) + high-cut (lowpass)
    const lowCut = this.voiceFilterEnabled ? this.voiceLowCutHz : 20;
    const highCut = this.voiceFilterEnabled ? this.voiceHighCutHz : 8000;

    const hp = this.micAudioContext.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = lowCut;

    const lp = this.micAudioContext.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = highCut;

    this.micHighpass = hp;
    this.micLowpass = lp;

    source.connect(hp);
    hp.connect(lp);
    lp.connect(this.micProcessor);
    this.micProcessor.connect(this.micAudioContext.destination);
  }

  private syncStreamsForMode(): void {
    if (!this.isCapturing()) return;

    if (this.transcriptionMode() === 'everyone') {
      if (!this.micAudioActive()) {
        this.setupMicAudio().catch((err) => {
          console.warn('[CaptureComponent] Failed starting mic for Everyone mode:', err);
        });
      }
    } else {
      // In 'other-only' mode, shut down mic pipeline completely
      this.stopMicAudio();
    }
    this.updateSourceName();
  }

  private updateSourceName(): void {
    if (this.transcriptionMode() === 'everyone') {
      this.sourceName.set('Dual Audio: Meeting Audio + Microphone (Everyone)');
    } else {
      this.sourceName.set('Meeting Audio (Other Participant Only)');
    }
  }

  private processPcmChunk(
    channelData: Float32Array,
    channel: 'system' | 'mic',
    vadState: ChannelVadState
  ): void {
    const len = channelData.length;
    const pcm16 = new Int16Array(len);
    let sumSquares = 0;

    for (let i = 0; i < len; i++) {
      const s = Math.max(-1, Math.min(1, channelData[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      sumSquares += s * s;
    }

    const rms = Math.sqrt(sumSquares / len);
    vadState.lastRms = rms;

    // Update energy meter for UI
    const normalizedLevel = Math.min(1, rms * 8);
    this.audioLevel.set(normalizedLevel);
    this.ipcService.sendAudioLevel(normalizedLevel);

    // Voice Activity Detection (VAD) Evaluation with dynamic threshold
    if (rms >= this.vadThreshold) {
      vadState.hangoverCounter = this.HANGOVER_FRAMES;
      vadState.isSpeechActive = true;
    } else if (vadState.hangoverCounter > 0) {
      vadState.hangoverCounter--;
      vadState.isSpeechActive = true;
    } else {
      vadState.isSpeechActive = false;
    }

    // Gate: ONLY forward speech chunks to transcription!
    // Silence does NOT get sent to Whisper or Deepgram.
    if (vadState.isSpeechActive) {
      this.ipcService.sendAudioChunk({
        channel,
        buffer: pcm16.buffer,
      });
    }
  }

  private stopMicAudio(): void {
    this.micAudioActive.set(false);
    if (this.micProcessor) {
      this.micProcessor.disconnect();
      this.micProcessor = undefined;
    }
    if (this.micAudioContext) {
      this.micAudioContext.close();
      this.micAudioContext = undefined;
    }
    if (this.micMediaStream) {
      this.micMediaStream.getTracks().forEach((t) => t.stop());
      this.micMediaStream = undefined;
    }
    this.micVad = { hangoverCounter: 0, lastRms: 0, isSpeechActive: false };
  }

  private reconnectSystemAudio(): void {
    if (this.systemProcessor) {
      this.systemProcessor.disconnect();
      this.systemProcessor = undefined;
    }
    if (this.systemAudioContext) {
      this.systemAudioContext.close();
      this.systemAudioContext = undefined;
    }
    if (this.systemMediaStream) {
      this.systemMediaStream.getTracks().forEach((t) => t.stop());
      this.systemMediaStream = undefined;
    }
    this.meetingAudioActive.set(false);

    setTimeout(() => {
      if (this.isCapturing()) {
        this.setupSystemAudio().catch((err) => {
          console.warn('[CaptureComponent] System audio reconnect failed:', err);
        });
      }
    }, 1500);
  }

  stopCapture(): void {
    this.isCapturing.set(false);
    this.meetingAudioActive.set(false);
    this.audioLevel.set(0);

    if (this.systemProcessor) {
      this.systemProcessor.disconnect();
      this.systemProcessor = undefined;
    }
    if (this.systemAudioContext) {
      this.systemAudioContext.close();
      this.systemAudioContext = undefined;
    }
    if (this.systemMediaStream) {
      this.systemMediaStream.getTracks().forEach((t) => t.stop());
      this.systemMediaStream = undefined;
    }
    this.systemVad = { hangoverCounter: 0, lastRms: 0, isSpeechActive: false };

    this.stopMicAudio();

    if (this.simInterval) {
      clearInterval(this.simInterval);
      this.simInterval = undefined;
    }
  }

  private startSimulationAudioStream(): void {
    this.isCapturing.set(true);
    this.sourceName.set('Simulated Audio Stream');

    this.simInterval = setInterval(() => {
      if (!this.isCapturing()) return;
      this.simulateAudioBurst();
    }, 1200);
  }

  simulateAudioBurst(): void {
    const samples = 4096;
    const pcm16 = new Int16Array(samples);
    const freq = 440;
    const level = 0.3 + Math.random() * 0.4;

    for (let i = 0; i < samples; i++) {
      const t = i / 16000;
      pcm16[i] = Math.sin(2 * Math.PI * freq * t) * level * 0x7fff;
    }

    this.audioLevel.set(level);
    this.ipcService.sendAudioLevel(level);
    this.ipcService.sendAudioChunk({
      channel: 'system',
      buffer: pcm16.buffer,
    });

    setTimeout(() => {
      if (this.isCapturing()) {
        this.audioLevel.set(0.05);
        this.ipcService.sendAudioLevel(0.05);
      }
    }, 300);
  }
}
