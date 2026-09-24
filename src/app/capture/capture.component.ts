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
  readonly transcriptionMode = signal<TranscriptionMode>('everyone');
  readonly meetingAudioActive = signal(false);
  readonly micAudioActive = signal(false);
  readonly systemAudioError = signal<string | null>(null);

  // VAD parameters (Energy-based Voice Activity Detection)
  // Dynamic threshold: adjustable between 0.002 (high sensitivity) to 0.025 (high noise cut)
  private vadThreshold = 0.0035;
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
    this.systemAudioError.set(null);

    try {
      // System (loopback) audio is a separate concern from the microphone. If it
      // is unavailable we still allow Everyone mode to capture the mic, but we
      // never substitute the microphone for system audio.
      try {
        await this.setupSystemAudio();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.systemAudioError.set(msg);
        this.meetingAudioActive.set(false);
        console.warn('[CaptureComponent] System audio unavailable:', msg);
      }

      if (this.transcriptionMode() === 'everyone') {
        await this.setupMicAudio();
      }

      this.isCapturing.set(true);
      this.updateSourceName();

      if (this.transcriptionMode() === 'other-only' && !this.meetingAudioActive()) {
        this.errorMessage.set(
          this.systemAudioError() || 'No system audio (loopback) device available for Other-only mode.'
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.errorMessage.set(`Audio capture error: ${msg}`);
      console.error('[CaptureComponent] Audio capture initialization failed:', msg);
    }
  }

  /**
   * Resolves the device used for system/meeting audio. Only the explicitly
   * configured device or a detected virtual loopback device (BlackHole,
   * Soundflower, VB-Cable, Stereo Mix, ...) qualifies — the default microphone
   * is deliberately excluded so the user's own voice is only captured on the
   * dedicated mic channel in Everyone mode.
   */
  private async resolveMeetingDeviceId(): Promise<string | undefined> {
    try {
      const settings = await this.ipcService.getSettings();
      if (settings.meetingAudioDeviceId) return settings.meetingAudioDeviceId;

      const devices = await navigator.mediaDevices.enumerateDevices();
      const patterns = [
        /blackhole/i,
        /loopback/i,
        /soundflower/i,
        /vb-?cable/i,
        /virtual/i,
        /aggregate/i,
        /(system|meeting|display|monitor)\s*audio/i,
        /stereo mix/i,
        /what u hear/i,
      ];
      const match = devices
        .filter((d) => d.kind === 'audioinput' && d.label)
        .find((d) => patterns.some((re) => re.test(d.label)));
      return match?.deviceId;
    } catch {
      return undefined;
    }
  }

  private async setupSystemAudio(): Promise<void> {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices) {
      throw new Error('navigator.mediaDevices is not available in this environment');
    }

    let stream: MediaStream | null = null;

    // 1) Explicitly configured (or auto-detected) loopback device.
    const deviceId = await this.resolveMeetingDeviceId();
    if (deviceId) {
      try {
        stream = await mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: deviceId },
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

    // 2) OS-level loopback via getDisplayMedia (Windows & macOS ScreenCaptureKit).
    if (!stream && typeof mediaDevices.getDisplayMedia === 'function') {
      try {
        const display = await mediaDevices.getDisplayMedia({
          audio: true,
          video: true,
        });
        if (display.getAudioTracks() && display.getAudioTracks().length > 0) {
          stream = display;
          // Stop unused video tracks so they don't consume CPU or GPU resources
          display.getVideoTracks().forEach((t) => t.stop());
        } else {
          display.getTracks().forEach((t) => t.stop());
        }
      } catch (err) {
        console.warn('[CaptureComponent] OS-level loopback getDisplayMedia unavailable:', err);
      }
    }

    if (!stream) {
      // Never fall back to the default microphone as "system" audio.
      throw new Error(
        'No system audio (loopback) stream available. On macOS, ensure Screen & System Audio Recording permission is granted. On Windows, verify Stereo Mix / audio permissions, or select a loopback device in Settings.'
      );
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
      if (!this.isCapturing()) return;
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
      // Retry the loopback device in case it was unavailable at start-up.
      if (!this.meetingAudioActive()) {
        this.setupSystemAudio()
          .then(() => {
            this.systemAudioError.set(null);
            this.errorMessage.set(null);
          })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            this.systemAudioError.set(msg);
            this.meetingAudioActive.set(false);
          });
      }
    }
    this.updateSourceName();
  }

  private updateSourceName(): void {
    if (!this.meetingAudioActive()) {
      this.sourceName.set(
        this.transcriptionMode() === 'everyone'
          ? 'Microphone only (no system loopback device)'
          : 'System loopback required (none selected)'
      );
      return;
    }
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
    // In other-only mode, completely discard any microphone audio
    if (this.transcriptionMode() === 'other-only' && channel === 'mic') {
      return;
    }

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
    // Silence does NOT get sent to on-device STT engines.
    if (vadState.isSpeechActive) {
      this.ipcService.sendAudioChunk({
        channel,
        buffer: pcm16.buffer,
        sampleRate: 16000,
        rmsVolume: rms,
        timestamp: Date.now(),
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
        this.setupSystemAudio()
          .then(() => this.systemAudioError.set(null))
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            this.systemAudioError.set(msg);
            this.meetingAudioActive.set(false);
            console.warn('[CaptureComponent] System audio reconnect failed:', msg);
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
  }
}
