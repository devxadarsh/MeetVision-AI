import { AudioFrame, STTEngineInfo, STTEngineType, TranscriptSegment, TranscriptionMode } from '@shared/ipc';

export interface STTEngineOptions {
  model?: string;
  language?: 'en' | 'hi' | 'multi';
  apiKey?: string;
  transcriptionMode?: TranscriptionMode;
  promptPriming?: boolean;
}

export interface ISTTEngine {
  readonly id: STTEngineType;
  readonly name: string;
  readonly isExperimental: boolean;

  initialize(): Promise<boolean>;
  start(onSegment: (segment: TranscriptSegment) => void, options?: STTEngineOptions): Promise<void>;
  stop(): Promise<void>;
  feedAudio(frame: AudioFrame): void;
  getStatus(): STTEngineInfo;
  isActive(): boolean;
  isConnected(): boolean;
  setPromptPriming?(enabled: boolean): void;
  setModel?(modelName: string): Promise<boolean>;
}
