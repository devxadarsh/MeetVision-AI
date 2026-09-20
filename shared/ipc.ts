export type QuestionStatus = 'new' | 'answering' | 'answered' | 'pinned' | 'dismissed';

export interface Question {
  id: string;
  sessionId: string;
  text: string;
  askedAt: number;
  status: QuestionStatus;
  speaker?: string;
  answer?: Answer;
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

export interface Answer {
  questionId: string;
  mode: 'short' | 'detailed' | 'simple';
  bullets: string[];
  code?: string;
  createdAt: number;
}

export interface AnswerChunk {
  questionId: string;
  delta: string;
  isComplete?: boolean;
  mode?: 'short' | 'detailed' | 'simple';
  code?: string;
}

export interface RegeneratePayload {
  questionId: string;
  mode: 'short' | 'detailed' | 'simple';
}

export interface TranscriptSegment {
  id: string;
  text: string;
  isFinal: boolean;
  startMs: number;
  endMs: number;
  speaker?: string;
}

export interface SessionStatus {
  active: boolean;
  provider: string;
}

export interface ContextProfile {
  role: string;
  projectSummary: string;
  glossary: string[];
  tone: 'concise' | 'friendly' | 'formal';
}

export interface AppSettings {
  sttProvider: 'deepgram' | 'simulation';
  llmProvider: 'anthropic' | 'local';
  llmModel: string;
  temperature: number;
  maxTokens: number;
  profile: ContextProfile;
  // Key flags returned to UI (keys themselves are encrypted via safeStorage in main process)
  hasAnthropicKey?: boolean;
  hasDeepgramKey?: boolean;
  // Form input field when user updates their key
  anthropicApiKey?: string;
  deepgramApiKey?: string;
  isEncryptionAvailable?: boolean;
  // First-run privacy & legal consent (PRD Section 11 / Milestone 6)
  hasAcceptedConsent?: boolean;
  consentAcceptedAt?: number;
  // Milestone 7: Language & Diarization
  sttLanguage?: 'en' | 'hi' | 'multi';
  // Overlay Dimensions (Adjustable Length & Width) & Opacity
  overlayWidth?: number;
  overlayHeight?: number;
  overlayOpacity?: number;
}

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
  OVERLAY_SET_OPACITY: 'overlay:set-opacity',
  OVERLAY_OPACITY_CHANGED: 'overlay:opacity-changed',
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
  ANSWER_CHUNK: 'answer:chunk',
  ANSWER_REGENERATE: 'answer:regenerate',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_OPEN: 'settings:open',
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
} as const;

export interface ElectronAPI {
  ping: (message: string) => Promise<string>;
  getDiagnostics: () => Promise<AppDiagnostics>;
  setClickThrough: (ignore: boolean) => Promise<boolean>;
  getClickThrough: () => Promise<boolean>;
  setOverlaySize: (width: number, height: number) => Promise<{ width: number; height: number }>;
  getOverlaySize: () => Promise<{ width: number; height: number }>;
  setOverlayOpacity: (opacity: number) => Promise<number>;
  onOverlayOpacityChanged: (callback: (opacity: number) => void) => () => void;
  close: () => Promise<void>;
  onHotkey: (callback: (action: HotkeyAction) => void) => () => void;
  // Session & Audio channels
  startSession: () => Promise<void>;
  stopSession: () => Promise<void>;
  getSessionStatus: () => Promise<SessionStatus>;
  sendAudioChunk: (chunk: ArrayBuffer) => void;
  sendAudioLevel: (level: number) => void;
  onAudioLevel: (callback: (level: number) => void) => () => void;
  onTranscriptUpdate: (callback: (segment: TranscriptSegment) => void) => () => void;
  clearTranscript: () => Promise<void>;
  onTranscriptClear: (callback: () => void) => () => void;
  // Question & Answer channels (Milestone 3)
  onQuestionNew: (callback: (question: Question) => void) => () => void;
  onAnswerChunk: (callback: (chunk: AnswerChunk) => void) => () => void;
  regenerateAnswer: (payload: RegeneratePayload) => Promise<void>;
  // Settings & Profile channels (Milestone 4)
  getSettings: () => Promise<AppSettings>;
  setSettings: (settings: AppSettings) => Promise<AppSettings>;
  openSettings: () => Promise<boolean>;
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
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
