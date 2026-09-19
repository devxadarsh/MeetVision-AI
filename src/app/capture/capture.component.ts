import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  OnDestroy,
  inject,
  signal,
} from '@angular/core';
import { IpcService } from '../core/ipc.service';

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

  private audioContext?: AudioContext;
  private mediaStream?: MediaStream;
  private processor?: ScriptProcessorNode;
  private simInterval?: ReturnType<typeof setInterval>;

  ngOnInit(): void {
    // Attempt automatic audio capture on init
    this.startCapture().catch((err) => {
      console.log('[CaptureComponent] Autostart capture waiting for user gesture or permissions:', err);
    });
  }

  ngOnDestroy(): void {
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
      let stream: MediaStream;
      const mediaDevices = navigator.mediaDevices;
      if (!mediaDevices) {
        throw new Error('navigator.mediaDevices is not available in this environment');
      }

      // Try getDisplayMedia first for system loopback
      if (typeof mediaDevices.getDisplayMedia === 'function') {
        try {
          stream = await mediaDevices.getDisplayMedia({
            audio: true,
            video: true, // Chromium requires video requested to return system audio
          });
          if (!stream.getAudioTracks() || stream.getAudioTracks().length === 0) {
            stream.getTracks().forEach((t) => t.stop());
            throw new Error('No audio tracks returned from getDisplayMedia');
          }
          this.sourceName.set('System Loopback Audio');
        } catch {
          // Fallback to getUserMedia (microphone or loopback device like BlackHole)
          stream = await mediaDevices.getUserMedia({
            audio: {
              sampleRate: 16000,
              channelCount: 1,
              echoCancellation: false,
              noiseSuppression: false,
            },
          });
          this.sourceName.set('Microphone / Audio Device');
        }
      } else {
        stream = await mediaDevices.getUserMedia({ audio: true });
        this.sourceName.set('Microphone');
      }

      this.mediaStream = stream;

      // Monitor audio track state for unexpected disconnection
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.onended = () => {
          console.warn('[CaptureComponent] Audio track ended unexpectedly. Reconnecting...');
          if (this.isCapturing()) {
            this.stopCapture();
            setTimeout(() => this.startCapture(), 1500);
          }
        };
        audioTrack.onmute = () => {
          console.warn('[CaptureComponent] Audio track muted by OS or audio device.');
        };
        audioTrack.onunmute = () => {
          console.log('[CaptureComponent] Audio track unmuted.');
        };
      }

      this.setupAudioPipeline(stream);
      this.isCapturing.set(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.errorMessage.set(`Audio capture error: ${msg}`);
      // Fall back to simulation mode so development and IPC verification continue smoothly
      this.startSimulationAudioStream();
    }
  }

  private setupAudioPipeline(stream: MediaStream): void {
    // Target 16 kHz sample rate as per PRD FR-13 / STT requirements
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.audioContext = new AudioCtx({ sampleRate: 16000 });

    const source = this.audioContext.createMediaStreamSource(stream);
    // 4096 buffer size at 16 kHz ≈ 256 ms audio chunks
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

    this.processor.onaudioprocess = (e) => {
      if (!this.isCapturing()) return;

      const inputData = e.inputBuffer.getChannelData(0);
      const len = inputData.length;

      // Convert Float32 [-1.0, 1.0] to signed Int16 [-32768, 32767] PCM
      const pcm16 = new Int16Array(len);
      let sumSquares = 0;

      for (let i = 0; i < len; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        sumSquares += s * s;
      }

      // Calculate RMS level (0.0 to 1.0)
      const rms = Math.sqrt(sumSquares / len);
      const normalizedLevel = Math.min(1, rms * 5); // Scale for responsive meter
      this.audioLevel.set(normalizedLevel);
      this.ipcService.sendAudioLevel(normalizedLevel);

      // Stream binary PCM16 chunk to Electron main process
      this.ipcService.sendAudioChunk(pcm16.buffer);
    };

    source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
  }

  stopCapture(): void {
    this.isCapturing.set(false);
    this.audioLevel.set(0);

    if (this.processor) {
      this.processor.disconnect();
      this.processor = undefined;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = undefined;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = undefined;
    }
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
    // Generate a synthetic 16 kHz audio chunk (256ms = 4096 samples)
    const samples = 4096;
    const pcm16 = new Int16Array(samples);
    const freq = 440; // 440 Hz tone burst
    const level = 0.3 + Math.random() * 0.4;

    for (let i = 0; i < samples; i++) {
      const t = i / 16000;
      pcm16[i] = Math.sin(2 * Math.PI * freq * t) * level * 0x7fff;
    }

    this.audioLevel.set(level);
    this.ipcService.sendAudioLevel(level);
    this.ipcService.sendAudioChunk(pcm16.buffer);

    setTimeout(() => {
      if (this.isCapturing()) {
        this.audioLevel.set(0.05);
        this.ipcService.sendAudioLevel(0.05);
      }
    }, 300);
  }
}
