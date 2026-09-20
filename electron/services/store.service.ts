import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { AppSettings, ContextProfile } from '@shared/ipc';

interface StoredConfigFile {
  sttProvider: 'deepgram' | 'simulation';
  llmProvider: 'anthropic' | 'local';
  llmModel: string;
  temperature: number;
  maxTokens: number;
  profile: ContextProfile;
  encryptedAnthropicApiKey?: string; // base64 encoded ciphertext
  encryptedDeepgramApiKey?: string;  // base64 encoded ciphertext
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
}

const DEFAULT_PROFILE: ContextProfile = {
  role: 'Staff Software Engineer / Tech Lead',
  projectSummary:
    'Leading core payments and distributed ledger migration. Zero downtime, strict idempotency, resilient circuit breaker patterns.',
  glossary: ['idempotency', 'jitter', 'canary rollout', 'circuit breaker', 'ledger', 'p99 latency'],
  tone: 'concise',
};

const DEFAULT_SETTINGS: StoredConfigFile = {
  sttProvider: 'simulation',
  llmProvider: 'local',
  llmModel: 'claude-3-5-sonnet-20241022',
  temperature: 0.3,
  maxTokens: 500,
  overlayOpacity: 0.88,
  overlayVersion: 'v1',
  multiWorkspace: true,
  profile: DEFAULT_PROFILE,
};

export class StoreService {
  private filePath: string;
  private data: StoredConfigFile;

  constructor() {
    const userDataPath = app.getPath('userData');
    this.filePath = path.join(userDataPath, 'questionlens-settings.json');
    this.data = this.loadFromDisk();
  }

  private loadFromDisk(): StoredConfigFile {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
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

  getDecryptedAnthropicKey(): string | undefined {
    const decrypted = this.decryptSecret(this.data.encryptedAnthropicApiKey);
    return decrypted || process.env.ANTHROPIC_API_KEY || undefined;
  }

  getDecryptedDeepgramKey(): string | undefined {
    const decrypted = this.decryptSecret(this.data.encryptedDeepgramApiKey);
    return decrypted || process.env.DEEPGRAM_API_KEY || undefined;
  }

  getContextProfile(): ContextProfile {
    return { ...this.data.profile };
  }

  getSettings(): AppSettings {
    const isEncAvailable = safeStorage.isEncryptionAvailable();
    const hasAnthropic = Boolean(this.getDecryptedAnthropicKey());
    const hasDeepgram = Boolean(this.getDecryptedDeepgramKey());

    return {
      sttProvider: this.data.sttProvider,
      llmProvider: this.data.llmProvider,
      llmModel: this.data.llmModel,
      temperature: this.data.temperature,
      maxTokens: this.data.maxTokens,
      profile: { ...this.data.profile },
      hasAnthropicKey: hasAnthropic,
      hasDeepgramKey: hasDeepgram,
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
    };
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

  updateSettings(newSettings: AppSettings): AppSettings {
    if (newSettings.anthropicApiKey !== undefined) {
      if (newSettings.anthropicApiKey.trim() === '') {
        delete this.data.encryptedAnthropicApiKey;
      } else {
        this.data.encryptedAnthropicApiKey = this.encryptSecret(newSettings.anthropicApiKey);
      }
    }

    if (newSettings.deepgramApiKey !== undefined) {
      if (newSettings.deepgramApiKey.trim() === '') {
        delete this.data.encryptedDeepgramApiKey;
      } else {
        this.data.encryptedDeepgramApiKey = this.encryptSecret(newSettings.deepgramApiKey);
      }
    }

    if (newSettings.sttProvider) this.data.sttProvider = newSettings.sttProvider;
    if (newSettings.llmProvider) this.data.llmProvider = newSettings.llmProvider;
    if (newSettings.llmModel) this.data.llmModel = newSettings.llmModel;
    if (typeof newSettings.temperature === 'number') this.data.temperature = newSettings.temperature;
    if (typeof newSettings.maxTokens === 'number') this.data.maxTokens = newSettings.maxTokens;
    if (newSettings.sttLanguage) this.data.sttLanguage = newSettings.sttLanguage;
    if (typeof newSettings.overlayWidth === 'number') this.data.overlayWidth = newSettings.overlayWidth;
    if (typeof newSettings.overlayHeight === 'number') this.data.overlayHeight = newSettings.overlayHeight;
    if (typeof newSettings.overlayX === 'number') this.data.overlayX = newSettings.overlayX;
    if (typeof newSettings.overlayY === 'number') this.data.overlayY = newSettings.overlayY;
    if (typeof newSettings.overlayOpacity === 'number') this.data.overlayOpacity = newSettings.overlayOpacity;
    if (newSettings.overlayVersion) this.data.overlayVersion = newSettings.overlayVersion;
    if (typeof newSettings.multiWorkspace === 'boolean') this.data.multiWorkspace = newSettings.multiWorkspace;

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

    this.saveToDisk();
    return this.getSettings();
  }
}
