import type { LlmProviderCatalogEntry, LlmProviderId } from './llm-provider-catalog';

export type QuestionStatus = 'new' | 'unanswered' | 'answering' | 'answered' | 'pinned' | 'dismissed';

export interface QuestionContextSnapshot {
  otherText?: string;
  userText?: string;
  ocrText?: string;
  capturedAt?: number;
  finalPrompt?: string;
}

export interface Question {
  id: string;
  sessionId: string;
  text: string;
  askedAt: number;
  status: QuestionStatus;
  speaker?: string;
  answer?: Answer;
  answers?: Answer[];
  activeAnswerIndex?: number;
  contextSnapshot?: QuestionContextSnapshot;
}

export interface KnowledgeDoc {
  id: string;
  title: string;
  content: string;
  category?: string;
  updatedAt: number;
}

export interface ActionItem {
  id: string;
  task: string;
  owner?: string;
  dueDate?: string;
}

export interface MeetingSummary {
  id: string;
  generatedAt: number;
  title: string;
  overview: string;
  keyQuestions: { question: string; answerSummary: string; speaker?: string }[];
  actionItems: ActionItem[];
  markdown: string;
}

export type AnswerMode = 'short' | 'detailed' | 'simple';

/** Preferred language for coding/DSA answers. */
export type CodeLanguage =
  | 'auto'
  | 'python'
  | 'javascript'
  | 'typescript'
  | 'java'
  | 'cpp'
  | 'csharp'
  | 'go'
  | 'rust';

export interface Answer {
  questionId: string;
  mode: AnswerMode;
  bullets: string[];
  code?: string;
  /** True when the provider stopped because it hit the output-token cap. */
  truncated?: boolean;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  createdAt: number;
  versionIndex?: number;
}

export interface AnswerChunk {
  questionId: string;
  delta: string;
  isComplete?: boolean;
  mode?: AnswerMode;
  code?: string;
  truncated?: boolean;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  finalPrompt?: string;
}

export interface RegeneratePayload {
  questionId: string;
  mode: AnswerMode;
  text?: string;
  speaker?: string;
}

export interface AnswerQuestionPayload {
  questionId?: string;
  text?: string;
  speaker?: string;
  /** Answer depth for this request; falls back to settings.answerMode. */
  mode?: AnswerMode;
}

export interface SpeakerTurn {
  speaker: string;
  text: string;
  timestamp?: number;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface TranscriptSegment {
  id: string;
  text: string;
  isFinal: boolean;
  startMs: number;
  endMs: number;
  speaker?: string;
  turns?: SpeakerTurn[];
}

export interface SessionStatus {
  active: boolean;
  provider: string;
  model?: string;
}

export interface ContextProfile {
  role: string;
  projectSummary: string;
  glossary: string[];
  tone: 'concise' | 'friendly' | 'formal';
}

export type TranscriptionMode = 'other-only' | 'everyone';

export type AudioChunkPayload =
  | ArrayBuffer
  | AudioFrame;

export interface MacosPermissions {
  microphone: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown';
  screen: 'granted' | 'denied' | 'not-determined' | 'unknown';
}

export type STTEngineType = 'parakeet' | 'apple-speech';

export type ParakeetModelType =
  | 'parakeet-flash'
  | 'parakeet-tdt-v2'
  | 'parakeet-tdt-v3'
  | 'parakeet-ctc-1.1b'
  | 'nemotron-speech-3.5'
  | 'nemotron-3.5-multilingual';

export interface ParakeetDownloadProgress {
  model: ParakeetModelType;
  percent: number;
  downloadedMb: number;
  totalMb: number;
  completed: boolean;
  error?: string;
  /** True when the download was intentionally paused (the .part file is preserved for resume) */
  paused?: boolean;
  /** True when the download was cancelled (the .part file has been deleted) */
  cancelled?: boolean;
}

export interface ParakeetStatus {
  available: boolean;
  binaryPath?: string;
  installedModels: ParakeetModelType[];
  currentModel: ParakeetModelType;
  isDownloading?: boolean;
  downloadProgress?: number;
  downloadingModel?: ParakeetModelType;
  /** Host platform key used to resolve model artifacts (e.g. `darwin-arm64`). */
  platform?: string;
  /** Inference runtime backing the selected model (e.g. `coreml`, `sherpa-onnx`). */
  runtime?: string;
  /** Human-readable runtime name for the settings UI. */
  runtimeName?: string;
  /** False when the runtime binary is missing on this machine. */
  runtimeAvailable?: boolean;
  /** Explains why a runtime is unavailable, or how the model was resolved. */
  runtimeDetail?: string;
  /** True when every required file for the selected model exists locally. */
  currentModelInstalled?: boolean;
  /** Bytes required by the selected model on this platform (0 when unsupported). */
  currentModelBytes?: number;
  /** Caveats about the resolved artifact (provenance, unverified variant, ...). */
  currentModelNotes?: string[];
}

export interface AudioFrame {
  channel: 'system' | 'mic';
  buffer: ArrayBuffer;
  sampleRate?: number;
  rmsVolume?: number;
  timestamp?: number;
}

export interface STTEngineInfo {
  id: STTEngineType;
  name: string;
  description: string;
  isExperimental: boolean;
  available: boolean;
  statusDetail?: string;
}

import type { OcrModelId, OcrModelCatalogEntry } from './screenvision-catalog';
export type { OcrModelId, OcrModelCatalogEntry };

export interface ScreenVisionSettings {
  enabled?: boolean;
  activeModelId?: OcrModelId;
  autoIntervalSeconds?: number; // 0 = manual only, 5 = every 5s, etc.
  technicalWordCorrectionEnabled?: boolean;
  noiseFilteringEnabled?: boolean;
}

export interface ScreenVisionStatus {
  enabled: boolean;
  activeModelId: OcrModelId;
  isScanning: boolean;
  lastScanTimestamp: number | null;
  lastScanWordCount: number;
  lastExtractedText: string;
  installedModels: OcrModelId[];
  error: string | null;
}

export interface OcrDownloadProgress {
  modelId: OcrModelId;
  percent: number;
  downloadedBytes: number;
  totalBytes: number;
  status: 'idle' | 'downloading' | 'verifying' | 'completed' | 'error';
  error?: string;
}

export interface ScreenVisionCaptureResult {
  text: string;
  wordCount: number;
  timestamp: number;
  success: boolean;
  error?: string;
}

export interface AppSettings {
  sttProvider: STTEngineType;
  transcriptionMode?: TranscriptionMode;
  parakeetModel?: ParakeetModelType;
  meetingAudioDeviceId?: string;
  micAudioDeviceId?: string;
  llmProvider: LlmProviderId;
  llmModel: string;
  llmThinkingEnabled?: boolean;
  /** Preferred answer depth; drives the prompt and the voice-triggered answers. */
  answerMode?: AnswerMode;
  /** Preferred language for coding/DSA answers. */
  codeLanguage?: CodeLanguage;
  temperature: number;
  maxTokens: number;
  profile: ContextProfile;
  // ScreenVision: Text-first Screen Understanding & OCR Settings
  screenVision?: ScreenVisionSettings;
  // Per-provider key presence map returned to UI (keys themselves are encrypted via safeStorage in main process)
  hasApiKeys?: Partial<Record<LlmProviderId, boolean>>;
  /** @deprecated retained for backward compatibility; use hasApiKeys. */
  hasAnthropicKey?: boolean;
  // Write-only form inputs when the user updates a key, keyed by provider id
  apiKeys?: Record<string, string>;
  isEncryptionAvailable?: boolean;
  // First-run privacy & legal consent (PRD Section 11 / Milestone 6)
  hasAcceptedConsent?: boolean;
  consentAcceptedAt?: number;
  // Milestone 7: Language & Diarization
  sttLanguage?: 'en' | 'hi' | 'multi';
  // Overlay Dimensions (Adjustable Length & Width), Position, Opacity, Version & Multi-Workspace
  overlayWidth?: number;
  overlayHeight?: number;
  overlayX?: number;
  overlayY?: number;
  overlayOpacity?: number;
  overlayVersion?: 'v1' | 'v2';
  multiWorkspace?: boolean;
  // Voice Frequency Filter & Speech-to-Text Tuning
  voiceFilterEnabled?: boolean;
  voiceLowCutHz?: number;
  voiceHighCutHz?: number;
  voiceFilterPreset?: 'optimal-voice' | 'aggressive-noise-cut' | 'wide-natural' | 'custom';
  vadSensitivity?: number;
  noiseSuppression?: boolean;
  echoCancellation?: boolean;
  autoGainControl?: boolean;
}

export type LlmProviderInfo = LlmProviderCatalogEntry;

export interface AppDiagnostics {
  platform: string;
  arch: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  uptimeSec: number;
  memoryUsageMb: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
  };
  contentProtectionActive: boolean;
  sttConnected: boolean;
  activeWindows: number;
}

export type HotkeyAction =
  | 'toggle-visibility'
  | 'toggle-click-through'
  | 'clear'
  | 'pin'
  | 'copy-answer'
  | 'regenerate';

export const IPC_CHANNELS = {
  PING: 'app:ping',
  APP_DIAGNOSTICS: 'app:diagnostics',
  OVERLAY_SET_CLICK_THROUGH: 'overlay:set-click-through',
  OVERLAY_GET_CLICK_THROUGH: 'overlay:get-click-through',
  OVERLAY_SET_SIZE: 'overlay:set-size',
  OVERLAY_GET_SIZE: 'overlay:get-size',
  OVERLAY_MOVE: 'overlay:move',
  OVERLAY_SET_OPACITY: 'overlay:set-opacity',
  OVERLAY_OPACITY_CHANGED: 'overlay:opacity-changed',
  OVERLAY_SET_MULTI_WORKSPACE: 'overlay:set-multi-workspace',
  OVERLAY_MULTI_WORKSPACE_CHANGED: 'overlay:multi-workspace-changed',
  OVERLAY_SET_VERSION: 'overlay:set-version',
  OVERLAY_VERSION_CHANGED: 'overlay:version-changed',
  OVERLAY_CLOSE: 'overlay:close',
  HOTKEY_TRIGGERED: 'hotkey:triggered',
  SESSION_START: 'session:start',
  SESSION_STOP: 'session:stop',
  SESSION_GET_STATUS: 'session:get-status',
  AUDIO_CHUNK: 'audio:chunk',
  AUDIO_LEVEL: 'audio:level',
  TRANSCRIPT_UPDATE: 'transcript:update',
  TRANSCRIPT_CLEAR: 'transcript:clear',
  QUESTION_NEW: 'question:new',
  QUESTION_ANSWER: 'question:answer',
  ANSWER_CHUNK: 'answer:chunk',
  ANSWER_REGENERATE: 'answer:regenerate',
  SESSION_RESET: 'session:reset',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_OPEN: 'settings:open',
  SETTINGS_CHANGED: 'settings:changed',
  SETTINGS_VISIBILITY_CHANGED: 'settings:visibility-changed',
  // Milestone 6: Consent & Data Purge
  CONSENT_ACCEPT: 'consent:accept',
  DATA_CLEAR_ALL: 'data:clear-all',
  // Milestone 7: Knowledge Base (RAG) & Meeting Summary
  KNOWLEDGE_LIST: 'knowledge:list',
  KNOWLEDGE_ADD: 'knowledge:add',
  KNOWLEDGE_REMOVE: 'knowledge:remove',
  SUMMARY_GENERATE: 'summary:generate',
  SUMMARY_EXPORT: 'summary:export',
  // Local Real-Time Transcription & macOS Audio Channels
  TRANSCRIPTION_MODE_GET: 'transcription-mode:get',
  TRANSCRIPTION_MODE_SET: 'transcription-mode:set',
  TRANSCRIPTION_MODE_CHANGED: 'transcription-mode:changed',
  PARAKEET_STATUS_GET: 'parakeet:status-get',
  PARAKEET_MODEL_DOWNLOAD: 'parakeet:model-download',
  PARAKEET_MODEL_DELETE: 'parakeet:model-delete',
  PARAKEET_MODEL_REVEAL: 'parakeet:model-reveal',
  PARAKEET_MODEL_PAUSE: 'parakeet:model-pause',
  PARAKEET_MODEL_CANCEL: 'parakeet:model-cancel',
  PARAKEET_DOWNLOAD_PROGRESS: 'parakeet:download-progress',
  MACOS_PERMISSIONS_GET: 'macos:permissions-get',
  MACOS_PERMISSION_REQUEST: 'macos:permission-request',
  STT_ENGINES_GET: 'stt:engines-get',
  LLM_PROVIDERS_GET: 'llm:providers-get',
  // ScreenVision: Text-first Screen Understanding & OCR
  SCREENVISION_STATUS_GET: 'screenvision:status-get',
  SCREENVISION_CAPTURE_NOW: 'screenvision:capture-now',
  SCREENVISION_MODEL_DOWNLOAD: 'screenvision:model-download',
  SCREENVISION_MODEL_DELETE: 'screenvision:model-delete',
  SCREENVISION_DOWNLOAD_PROGRESS: 'screenvision:download-progress',
  SCREENVISION_STATUS_CHANGED: 'screenvision:status-changed',
  // System Clipboard
  CLIPBOARD_WRITE_TEXT: 'clipboard:write-text',
} as const;

export interface ElectronAPI {
  ping: (message: string) => Promise<string>;
  getDiagnostics: () => Promise<AppDiagnostics>;
  setClickThrough: (ignore: boolean) => Promise<boolean>;
  getClickThrough: () => Promise<boolean>;
  setOverlaySize: (width: number, height: number) => Promise<{ width: number; height: number }>;
  getOverlaySize: () => Promise<{ width: number; height: number }>;
  moveOverlay: (deltaX: number, deltaY: number) => Promise<{ x: number; y: number }>;
  setOverlayOpacity: (opacity: number) => Promise<number>;
  onOverlayOpacityChanged: (callback: (opacity: number) => void) => () => void;
  setMultiWorkspace: (enabled: boolean) => Promise<boolean>;
  onMultiWorkspaceChanged: (callback: (enabled: boolean) => void) => () => void;
  setOverlayVersion: (version: 'v1' | 'v2') => Promise<'v1' | 'v2'>;
  onOverlayVersionChanged: (callback: (version: 'v1' | 'v2') => void) => () => void;
  close: () => Promise<void>;
  onHotkey: (callback: (action: HotkeyAction) => void) => () => void;
  // Session & Audio channels
  startSession: () => Promise<void>;
  stopSession: () => Promise<void>;
  getSessionStatus: () => Promise<SessionStatus>;
  sendAudioChunk: (chunk: AudioChunkPayload) => void;
  sendAudioLevel: (level: number) => void;
  onAudioLevel: (callback: (level: number) => void) => () => void;
  onTranscriptUpdate: (callback: (segment: TranscriptSegment) => void) => () => void;
  clearTranscript: () => Promise<void>;
  onTranscriptClear: (callback: () => void) => () => void;
  // Transcription Mode (Mode A: Other Only vs Mode B: Everyone)
  getTranscriptionMode: () => Promise<TranscriptionMode>;
  setTranscriptionMode: (mode: TranscriptionMode) => Promise<TranscriptionMode>;
  onTranscriptionModeChanged: (callback: (mode: TranscriptionMode) => void) => () => void;
  // NVIDIA Parakeet STT Engine Management
  getParakeetStatus: () => Promise<ParakeetStatus>;
  downloadParakeetModel: (modelId: ParakeetModelType) => Promise<boolean>;
  deleteParakeetModel: (modelId: ParakeetModelType) => Promise<boolean>;
  revealParakeetModel: (modelId: ParakeetModelType) => Promise<boolean>;
  pauseParakeetDownload: () => Promise<boolean>;
  cancelParakeetDownload: () => Promise<boolean>;
  onParakeetDownloadProgress: (callback: (progress: ParakeetDownloadProgress) => void) => () => void;
  // ScreenVision: Text-first Screen Understanding & OCR Management
  getScreenVisionStatus: () => Promise<ScreenVisionStatus>;
  captureScreenVisionNow: () => Promise<ScreenVisionCaptureResult>;
  downloadOcrModel: (modelId: OcrModelId) => Promise<boolean>;
  deleteOcrModel: (modelId: OcrModelId) => Promise<boolean>;
  onOcrDownloadProgress: (callback: (progress: OcrDownloadProgress) => void) => () => void;
  onScreenVisionStatusChanged: (callback: (status: ScreenVisionStatus) => void) => () => void;
  // Pluggable STT Engines
  getSttEngines: () => Promise<STTEngineInfo[]>;
  // Pluggable LLM Providers
  getLlmProviders: () => Promise<LlmProviderInfo[]>;
  // macOS Permissions
  getMacosPermissions: () => Promise<MacosPermissions>;
  requestMacosMicrophonePermission: () => Promise<boolean>;
  // Question & Answer channels (Milestone 3)
  onQuestionNew: (callback: (question: Question) => void) => () => void;
  onAnswerChunk: (callback: (chunk: AnswerChunk) => void) => () => void;
  regenerateAnswer: (payload: RegeneratePayload) => Promise<void>;
  answerQuestion: (payload?: string | AnswerQuestionPayload) => Promise<boolean>;
  resetSession: () => Promise<boolean>;
  // Settings & Profile channels (Milestone 4)
  getSettings: () => Promise<AppSettings>;
  setSettings: (settings: Partial<AppSettings>) => Promise<AppSettings>;
  openSettings: () => Promise<boolean>;
  onSettingsChanged: (callback: (settings: AppSettings) => void) => () => void;
  onSettingsVisibilityChanged: (callback: (isOpen: boolean) => void) => () => void;
  // Milestone 6: Consent & Data Purge
  acceptConsent: () => Promise<void>;
  clearAllData: () => Promise<void>;
  // Milestone 7: Knowledge Base & Meeting Summary
  listKnowledgeDocs: () => Promise<KnowledgeDoc[]>;
  addKnowledgeDoc: (doc: Omit<KnowledgeDoc, 'id' | 'updatedAt'>) => Promise<KnowledgeDoc>;
  removeKnowledgeDoc: (id: string) => Promise<boolean>;
  generateMeetingSummary: () => Promise<MeetingSummary>;
  exportMeetingSummary: (markdown: string) => Promise<boolean>;
  // System Clipboard
  copyToClipboard: (text: string) => Promise<boolean>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
