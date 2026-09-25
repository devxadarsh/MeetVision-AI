import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { AppSettings, AnswerMode, CodeLanguage, ContextProfile, TranscriptionMode, STTEngineType, ParakeetModelType, ScreenVisionSettings } from '@shared/ipc';
import {
  LlmProviderId,
  LLM_PROVIDERS,
  DEFAULT_LLM_PROVIDER,
  getLlmProviderEntry,
} from '@shared/llm-provider-catalog';

interface StoredConfigFile {
  sttProvider: STTEngineType;
  transcriptionMode?: TranscriptionMode;
  parakeetModel?: ParakeetModelType;
  meetingAudioDeviceId?: string;
  micAudioDeviceId?: string;
  llmProvider: LlmProviderId;
  llmModel: string;
  llmThinkingEnabled?: boolean;
  answerMode?: AnswerMode;
  codeLanguage?: CodeLanguage;
  temperature: number;
  maxTokens: number;
  modeTokens?: {
    short?: number;
    simple?: number;
    detailed?: number;
  };
  profile: ContextProfile;
  screenVision?: ScreenVisionSettings;
  encryptedApiKeys?: Record<string, string>; // provider id -> base64 encoded ciphertext
  hasAcceptedConsent?: boolean;
  consentAcceptedAt?: number;
  sttLanguage?: 'en' | 'hi' | 'multi';
  overlayWidth?: number;
  overlayHeight?: number;
  overlayX?: number;
  overlayY?: number;
  overlayOpacity?: number;
  overlayVersion?: 'v1' | 'v2';
  multiWorkspace?: boolean;
  voiceFilterEnabled?: boolean;
  voiceLowCutHz?: number;
  voiceHighCutHz?: number;
  voiceFilterPreset?: 'optimal-voice' | 'aggressive-noise-cut' | 'wide-natural' | 'custom';
  vadSensitivity?: number;
  noiseSuppression?: boolean;
  echoCancellation?: boolean;
  autoGainControl?: boolean;
}

const DEFAULT_PROFILE: ContextProfile = {
  role: 'Staff Software Engineer / Tech Lead',
  projectSummary:
    'Leading core payments and distributed ledger migration. Zero downtime, strict idempotency, resilient circuit breaker patterns.',
  glossary: ['idempotency', 'jitter', 'canary rollout', 'circuit breaker', 'ledger', 'p99 latency'],
  tone: 'concise',
};

const DEFAULT_SETTINGS: StoredConfigFile = {
  sttProvider: 'parakeet',
  transcriptionMode: 'everyone',
  parakeetModel: 'parakeet-flash',
  llmProvider: DEFAULT_LLM_PROVIDER,
  llmModel: 'deepseek-flash',
  llmThinkingEnabled: false,
  answerMode: 'short',
  codeLanguage: 'auto',
  temperature: 0.3,
  maxTokens: 500,
  modeTokens: {
    short: 500,
    simple: 500,
    detailed: 1500,
  },
  overlayOpacity: 0.88,
  overlayVersion: 'v1',
  multiWorkspace: true,
  voiceFilterEnabled: true,
  voiceLowCutHz: 120,
  voiceHighCutHz: 4000,
  voiceFilterPreset: 'optimal-voice',
  vadSensitivity: 0.006,
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  profile: DEFAULT_PROFILE,
  screenVision: {
    enabled: true,
    activeModelId: 'pp-ocrv5-mobile',
    autoIntervalSeconds: 0,
    technicalWordCorrectionEnabled: true,
    noiseFilteringEnabled: true,
  },
};

export class StoreService {
  private filePath: string;
  private data: StoredConfigFile;

  constructor() {
    const userDataPath = app.getPath('userData');
    this.filePath = path.join(userDataPath, 'meetvision-ai-settings.json');
    this.data = this.loadFromDisk();
  }

  private loadFromDisk(): StoredConfigFile {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);

        // One-time migration from the single Anthropic key field.
        if (parsed.encryptedAnthropicApiKey && !parsed.encryptedApiKeys) {
          parsed.encryptedApiKeys = { anthropic: parsed.encryptedAnthropicApiKey };
        }
        delete parsed.encryptedAnthropicApiKey;

        // Drop an unknown provider id so the default takes over.
        if (parsed.llmProvider && !getLlmProviderEntry(parsed.llmProvider)) {
          delete parsed.llmProvider;
          delete parsed.llmModel;
        }

        return {
          ...DEFAULT_SETTINGS,
          ...parsed,
          profile: {
            ...DEFAULT_PROFILE,
            ...(parsed.profile || {}),
          },
        };
      }
    } catch (err) {
      console.warn('[StoreService] Failed to read settings file, using defaults:', err);
    }
    return { ...DEFAULT_SETTINGS };
  }

  private saveToDisk(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      console.error('[StoreService] Failed to save settings to disk:', err);
    }
  }

  private encryptSecret(plainText: string): string {
    if (!plainText.trim()) return '';
    try {
      if (safeStorage.isEncryptionAvailable()) {
        const buffer = safeStorage.encryptString(plainText.trim());
        return buffer.toString('base64');
      }
    } catch (err) {
      console.warn('[StoreService] safeStorage encryption failed, using fallback:', err);
    }
    // Fallback if OS keychain is unavailable
    return Buffer.from(plainText.trim(), 'utf-8').toString('base64');
  }

  private decryptSecret(cipherBase64?: string): string | undefined {
    if (!cipherBase64) return undefined;
    try {
      const buffer = Buffer.from(cipherBase64, 'base64');
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(buffer);
      }
      return buffer.toString('utf-8');
    } catch (err) {
      console.warn('[StoreService] Secret decryption failed:', err);
      return undefined;
    }
  }

  getDecryptedApiKey(providerId: LlmProviderId): string | undefined {
    const decrypted = this.decryptSecret(this.data.encryptedApiKeys?.[providerId]);
    if (decrypted) return decrypted;
    const envKey = getLlmProviderEntry(providerId)?.envKey;
    return envKey ? process.env[envKey] || undefined : undefined;
  }

  hasApiKey(providerId: LlmProviderId): boolean {
    return Boolean(this.getDecryptedApiKey(providerId));
  }

  getContextProfile(): ContextProfile {
    return { ...this.data.profile };
  }

  getSettings(): AppSettings {
    const isEncAvailable = safeStorage.isEncryptionAvailable();
    const hasApiKeys: Partial<Record<LlmProviderId, boolean>> = {};
    for (const provider of LLM_PROVIDERS) {
      hasApiKeys[provider.id] = this.hasApiKey(provider.id);
    }

    return {
      sttProvider: this.data.sttProvider === 'apple-speech' ? 'apple-speech' : 'parakeet',
      transcriptionMode: this.data.transcriptionMode || 'everyone',
      parakeetModel: this.data.parakeetModel || 'parakeet-flash',
      meetingAudioDeviceId: this.data.meetingAudioDeviceId,
      micAudioDeviceId: this.data.micAudioDeviceId,
      llmProvider: this.data.llmProvider,
      llmModel: this.data.llmModel,
      llmThinkingEnabled: Boolean(this.data.llmThinkingEnabled),
      answerMode: this.data.answerMode || 'short',
      codeLanguage: this.data.codeLanguage || 'auto',
      temperature: this.data.temperature,
      maxTokens: this.data.maxTokens,
      modeTokens: this.data.modeTokens ? { ...this.data.modeTokens } : { short: 500, simple: 500, detailed: 1500 },
      profile: { ...this.data.profile },
      hasApiKeys,
      hasAnthropicKey: hasApiKeys.anthropic,
      isEncryptionAvailable: isEncAvailable,
      hasAcceptedConsent: Boolean(this.data.hasAcceptedConsent),
      consentAcceptedAt: this.data.consentAcceptedAt,
      sttLanguage: this.data.sttLanguage,
      overlayWidth: this.data.overlayWidth,
      overlayHeight: this.data.overlayHeight,
      overlayX: this.data.overlayX,
      overlayY: this.data.overlayY,
      overlayOpacity: typeof this.data.overlayOpacity === 'number' ? this.data.overlayOpacity : 0.88,
      overlayVersion: this.data.overlayVersion || 'v1',
      multiWorkspace: typeof this.data.multiWorkspace === 'boolean' ? this.data.multiWorkspace : true,
      voiceFilterEnabled: this.data.voiceFilterEnabled !== false,
      voiceLowCutHz: typeof this.data.voiceLowCutHz === 'number' ? this.data.voiceLowCutHz : 120,
      voiceHighCutHz: typeof this.data.voiceHighCutHz === 'number' ? this.data.voiceHighCutHz : 4000,
      voiceFilterPreset: this.data.voiceFilterPreset || 'optimal-voice',
      vadSensitivity: typeof this.data.vadSensitivity === 'number' ? this.data.vadSensitivity : 0.006,
      noiseSuppression: this.data.noiseSuppression !== false,
      echoCancellation: this.data.echoCancellation !== false,
      autoGainControl: this.data.autoGainControl !== false,
      screenVision: this.data.screenVision
        ? { ...this.data.screenVision }
        : {
            enabled: true,
            activeModelId: 'pp-ocrv5-mobile',
            autoIntervalSeconds: 0,
            technicalWordCorrectionEnabled: true,
            noiseFilteringEnabled: true,
          },
    };
  }

  getTranscriptionMode(): TranscriptionMode {
    return this.data.transcriptionMode || 'everyone';
  }

  setTranscriptionMode(mode: TranscriptionMode): TranscriptionMode {
    this.data.transcriptionMode = mode;
    this.saveToDisk();
    return mode;
  }

  acceptConsent(): void {
    this.data.hasAcceptedConsent = true;
    this.data.consentAcceptedAt = Date.now();
    this.saveToDisk();
  }

  hasAcceptedConsent(): boolean {
    return Boolean(this.data.hasAcceptedConsent);
  }

  clearAllData(): void {
    this.data = { ...DEFAULT_SETTINGS };
    try {
      if (fs.existsSync(this.filePath)) {
        fs.unlinkSync(this.filePath);
      }
    } catch (err) {
      console.warn('[StoreService] Failed to unlink settings file during purge:', err);
    }
  }

  setOverlayVersion(version: 'v1' | 'v2'): 'v1' | 'v2' {
    this.data.overlayVersion = version;
    this.saveToDisk();
    return this.data.overlayVersion;
  }

  setMultiWorkspace(enabled: boolean): boolean {
    this.data.multiWorkspace = enabled;
    this.saveToDisk();
    return this.data.multiWorkspace;
  }

  updateSettings(newSettings: Partial<AppSettings>): AppSettings {
    if (newSettings.apiKeys) {
      for (const [providerId, key] of Object.entries(newSettings.apiKeys)) {
        if (!getLlmProviderEntry(providerId)) continue;
        if (key.trim() === '') {
          if (this.data.encryptedApiKeys) {
            delete this.data.encryptedApiKeys[providerId];
          }
        } else {
          this.data.encryptedApiKeys = {
            ...(this.data.encryptedApiKeys || {}),
            [providerId]: this.encryptSecret(key),
          };
        }
      }
    }

    if (newSettings.sttProvider) this.data.sttProvider = newSettings.sttProvider;
    if (newSettings.transcriptionMode) this.data.transcriptionMode = newSettings.transcriptionMode;
    if (newSettings.parakeetModel) this.data.parakeetModel = newSettings.parakeetModel;
    if (newSettings.meetingAudioDeviceId !== undefined) this.data.meetingAudioDeviceId = newSettings.meetingAudioDeviceId;
    if (newSettings.micAudioDeviceId !== undefined) this.data.micAudioDeviceId = newSettings.micAudioDeviceId;
    if (newSettings.llmProvider && getLlmProviderEntry(newSettings.llmProvider)) {
      this.data.llmProvider = newSettings.llmProvider;
    }
    if (newSettings.llmModel) this.data.llmModel = newSettings.llmModel;
    if (typeof newSettings.llmThinkingEnabled === 'boolean') {
      this.data.llmThinkingEnabled = newSettings.llmThinkingEnabled;
    }
    if (newSettings.answerMode && ['short', 'detailed', 'simple'].includes(newSettings.answerMode)) {
      this.data.answerMode = newSettings.answerMode;
    }
    if (newSettings.codeLanguage) {
      this.data.codeLanguage = newSettings.codeLanguage;
    }
    if (typeof newSettings.temperature === 'number') this.data.temperature = newSettings.temperature;
    if (typeof newSettings.maxTokens === 'number') this.data.maxTokens = newSettings.maxTokens;
    if (newSettings.modeTokens) {
      this.data.modeTokens = {
        ...(this.data.modeTokens || { short: 500, simple: 500, detailed: 1500 }),
        ...newSettings.modeTokens,
      };
    }
    if (newSettings.sttLanguage) this.data.sttLanguage = newSettings.sttLanguage;
    if (typeof newSettings.overlayWidth === 'number') this.data.overlayWidth = newSettings.overlayWidth;
    if (typeof newSettings.overlayHeight === 'number') this.data.overlayHeight = newSettings.overlayHeight;
    if (typeof newSettings.overlayX === 'number') this.data.overlayX = newSettings.overlayX;
    if (typeof newSettings.overlayY === 'number') this.data.overlayY = newSettings.overlayY;
    if (typeof newSettings.overlayOpacity === 'number') this.data.overlayOpacity = newSettings.overlayOpacity;
    if (newSettings.overlayVersion) this.data.overlayVersion = newSettings.overlayVersion;
    if (typeof newSettings.multiWorkspace === 'boolean') this.data.multiWorkspace = newSettings.multiWorkspace;
    if (typeof newSettings.voiceFilterEnabled === 'boolean') this.data.voiceFilterEnabled = newSettings.voiceFilterEnabled;
    if (typeof newSettings.voiceLowCutHz === 'number') this.data.voiceLowCutHz = newSettings.voiceLowCutHz;
    if (typeof newSettings.voiceHighCutHz === 'number') this.data.voiceHighCutHz = newSettings.voiceHighCutHz;
    if (newSettings.voiceFilterPreset) this.data.voiceFilterPreset = newSettings.voiceFilterPreset;
    if (typeof newSettings.vadSensitivity === 'number') this.data.vadSensitivity = newSettings.vadSensitivity;
    if (typeof newSettings.noiseSuppression === 'boolean') this.data.noiseSuppression = newSettings.noiseSuppression;
    if (typeof newSettings.echoCancellation === 'boolean') this.data.echoCancellation = newSettings.echoCancellation;
    if (typeof newSettings.autoGainControl === 'boolean') this.data.autoGainControl = newSettings.autoGainControl;

    if (newSettings.profile) {
      this.data.profile = {
        role: newSettings.profile.role?.trim() || DEFAULT_PROFILE.role,
        projectSummary: newSettings.profile.projectSummary?.trim() || DEFAULT_PROFILE.projectSummary,
        glossary: Array.isArray(newSettings.profile.glossary)
          ? newSettings.profile.glossary.map((g) => g.trim()).filter((g) => g.length > 0)
          : DEFAULT_PROFILE.glossary,
        tone: newSettings.profile.tone || 'concise',
      };
    }

    if (newSettings.screenVision) {
      this.data.screenVision = {
        ...(this.data.screenVision || DEFAULT_SETTINGS.screenVision!),
        ...newSettings.screenVision,
      };
    }

    this.saveToDisk();
    return this.getSettings();
  }
}
