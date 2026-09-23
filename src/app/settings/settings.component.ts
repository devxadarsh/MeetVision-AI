import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  OnDestroy,
  inject,
  signal,
  computed,
} from '@angular/core';
import { IpcService } from '../core/ipc.service';
import {
  AppSettings,
  ContextProfile,
  AppDiagnostics,
  KnowledgeDoc,
  TranscriptionMode,
  MeetingSummary,
  MacosPermissions,
  STTEngineType,
  STTEngineInfo,
  ParakeetModelType,
  ParakeetStatus,
  ParakeetDownloadProgress,
  LlmProviderInfo,
} from '@shared/ipc';
import type { LlmProviderId } from '@shared/llm-provider-catalog';
import {
  STT_MODEL_CATALOG,
  artifactTotalBytes,
  formatModelBytes,
} from '@shared/stt-model-catalog';
import type { SttPlatform } from '@shared/stt-model-catalog';

export interface ParakeetModelCard {
  id: ParakeetModelType;
  name: string;
  subtitle: string;
  icon: string;
  description: string;
  ramRequirement: string;
  fileSizeStr: string;
  badge: string;
  /** Inference runtime backing this model on the host platform. */
  runtime: string;
  /** False when the artifact choice has not been validated on real hardware. */
  verified: boolean;
  /** True when no artifact is mapped for the host platform. */
  unsupported: boolean;
}

const PARAKEET_BADGES: Record<ParakeetModelType, string> = {
  'parakeet-flash': 'Ultra Low Latency',
  'parakeet-tdt-v2': 'Balanced English',
  'parakeet-tdt-v3': '25 Languages',
  'parakeet-ctc-1.1b': 'Flagship 1.1B',
  'nemotron-speech-3.5': 'Streaming English',
  'nemotron-3.5-multilingual': 'Multilingual',
};

/**
 * Best-effort platform key for the renderer. Used only for display sizes: both
 * macOS arches and both Windows arches share identical payloads, so a rough
 * guess is safe. The authoritative key arrives with `ParakeetStatus.platform`.
 */
function detectRendererPlatform(): SttPlatform {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/Windows/i.test(ua)) {
    return /Win64|x64|WOW64/i.test(ua) ? 'win32-x64' : 'win32-ia32';
  }
  return 'darwin-arm64';
}

function buildParakeetCards(platform: SttPlatform): ParakeetModelCard[] {
  return STT_MODEL_CATALOG.map((entry) => {
    const artifact = entry.artifacts[platform];
    return {
      id: entry.id,
      name: entry.name,
      subtitle: entry.subtitle,
      icon: entry.icon,
      description: entry.description,
      ramRequirement: entry.ramRequirement,
      fileSizeStr: artifact ? `~${formatModelBytes(artifactTotalBytes(artifact))}` : 'Not available',
      badge: PARAKEET_BADGES[entry.id],
      runtime: artifact?.runtime ?? 'unsupported',
      verified: artifact?.verified ?? false,
      unsupported: !artifact,
    };
  });
}

/** Sentinel option value that reveals the free-text model id input. */
const CUSTOM_MODEL_VALUE = '__custom__';

@Component({
  selector: 'app-settings',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './settings.component.scss',
  templateUrl: './settings.component.html',
})
export class SettingsComponent implements OnInit, OnDestroy {
  private readonly ipcService = inject(IpcService);

  // Tabs
  readonly activeTab = signal<
    'profile' | 'audio' | 'ai' | 'overlay' | 'keys' | 'knowledge' | 'privacy' | 'shortcuts' | 'diagnostics'
  >('profile');

  // Diagnostics Signal (Milestone 5)
  readonly diagnostics = signal<AppDiagnostics | null>(null);
  readonly isLoadingDiagnostics = signal(false);

  // Overlay Dimensions & Transparency & Layout Mode
  readonly overlayWidth = signal(380);
  readonly overlayHeight = signal(600);
  readonly overlayOpacity = signal(0.88);
  readonly overlayVersion = signal<'v1' | 'v2'>('v1');
  readonly multiWorkspace = signal(true);
  readonly opacityPercent = computed(() => Math.round(this.overlayOpacity() * 100));

  readonly previewWidth = computed(() => {
    const w = this.overlayWidth();
    return Math.round(140 + ((w - 300) / 900) * 85);
  });

  readonly previewHeight = computed(() => {
    const h = this.overlayHeight();
    return Math.round(85 + ((h - 400) / 700) * 45);
  });

  // Context Profile Signals (FR-62)
  readonly role = signal('Staff Software Engineer / Tech Lead');
  readonly tone = signal<'concise' | 'friendly' | 'formal'>('concise');
  readonly projectSummary = signal('');
  readonly glossary = signal<string[]>([]);
  readonly newGlossaryTerm = signal('');

  // Audio & Transcription Modes (Mode A: Other Only vs Mode B: Everyone)
  readonly transcriptionMode = signal<TranscriptionMode>('everyone');
  readonly sttProvider = signal<STTEngineType>('parakeet');
  readonly sttEngines = signal<STTEngineInfo[]>([]);
  readonly sttLanguage = signal<'en' | 'hi' | 'multi'>('en');
  readonly parakeetModel = signal<ParakeetModelType>('parakeet-flash');
  readonly meetingAudioDeviceId = signal<string>('');
  readonly micAudioDeviceId = signal<string>('');
  readonly audioInputDevices = signal<{ deviceId: string; label: string }[]>([]);

  // NVIDIA Parakeet Status & Model Manager
  readonly parakeetStatus = signal<ParakeetStatus | null>(null);
  readonly parakeetDownloadProgress = signal<ParakeetDownloadProgress | null>(null);
  readonly isDownloadingParakeet = signal(false);
  /** True when running on macOS — used to label the reveal button correctly. */
  readonly isMacOS = typeof navigator !== 'undefined'
    ? /mac/i.test(navigator.userAgent) && !/windows|linux/i.test(navigator.userAgent)
    : false;
  /** Tracks which model is currently being revealed in Finder/Explorer */
  readonly parakeetRevealingModel = signal<ParakeetModelType | null>(null);
  readonly isParakeetPaused = signal(false);

  /** Platform key reported by the main process, used to resolve artifact sizes. */
  readonly parakeetPlatform = signal<SttPlatform>(detectRendererPlatform());

  readonly parakeetModelsList = computed<ParakeetModelCard[]>(() =>
    buildParakeetCards(this.parakeetPlatform())
  );

  // macOS Permissions
  readonly macosPermissions = signal<MacosPermissions | null>(null);

  // Voice Frequency Filter & Speech-to-Text Enhancements
  readonly voiceFilterEnabled = signal<boolean>(true);
  readonly voiceLowCutHz = signal<number>(120);
  readonly voiceHighCutHz = signal<number>(4000);
  readonly voiceFilterPreset = signal<'optimal-voice' | 'aggressive-noise-cut' | 'wide-natural' | 'custom'>('optimal-voice');
  readonly vadSensitivity = signal<number>(0.006);
  readonly noiseSuppression = signal<boolean>(true);
  readonly echoCancellation = signal<boolean>(true);
  readonly autoGainControl = signal<boolean>(true);

  // LLM Signals
  readonly llmProviders = signal<LlmProviderInfo[]>([]);
  readonly llmProvider = signal<LlmProviderId>('deepseek');
  readonly llmModel = signal('deepseek-flash');
  readonly llmThinkingEnabled = signal(false);
  readonly temperature = signal(0.3);
  readonly maxTokens = signal(500);

  // Active LLM provider metadata + its model list (data-driven UI).
  readonly activeLlmProvider = computed(() => {
    const id = this.llmProvider();
    return this.llmProviders().find((p) => p.id === id) ?? this.llmProviders()[0] ?? null;
  });
  readonly availableLlmModels = computed(() => this.activeLlmProvider()?.models ?? []);

  // Custom model id entry (gateway providers such as OpenRouter).
  readonly customModelValue = CUSTOM_MODEL_VALUE;
  readonly customModelMode = signal(false);
  readonly customLlmModel = signal('');
  readonly selectLlmModel = computed(() => (this.customModelMode() ? CUSTOM_MODEL_VALUE : this.llmModel()));
  readonly effectiveLlmModel = computed(() => {
    const provider = this.activeLlmProvider();
    if (this.customModelMode() && provider?.allowCustomModel) {
      return this.customLlmModel().trim() || provider.defaultModel;
    }
    return this.llmModel();
  });

  // Knowledge Base Signals (Milestone 7 / FR-44)
  readonly knowledgeDocs = signal<KnowledgeDoc[]>([]);
  readonly newDocTitle = signal('');
  readonly newDocCategory = signal('Architecture');
  readonly newDocContent = signal('');
  readonly isAddingDoc = signal(false);

  // Meeting Summary Signals (Milestone 7 / FR-50)
  readonly isGeneratingSummary = signal(false);
  readonly isExportingSummary = signal(false);
  readonly latestSummary = signal<MeetingSummary | null>(null);

  // API Key Form State (per provider)
  readonly apiKeyInputs = signal<Record<string, string>>({});
  readonly hasApiKeys = signal<Partial<Record<LlmProviderId, boolean>>>({});
  readonly showApiKeys = signal<Record<string, boolean>>({});
  readonly apiKeyProviders = computed(() => this.llmProviders().filter((p) => p.requiresApiKey));
  readonly isEncryptionAvailable = signal(true);
  readonly isSaving = signal(false);

  // Toast State
  readonly toastMessage = signal<string | null>(null);
  readonly toastType = signal<'success' | 'error' | 'info'>('info');
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  // Cleanup references
  private unsubscribeParakeetDownloadProgress?: () => void;
  private unsubscribeModeChanged?: () => void;

  // Dynamic Speech-to-Text Model Download Requirement Evaluator
  readonly sttRequirement = computed(() => {
    const provider = this.sttProvider();
    const parakeetM = this.parakeetModel();
    const installedParakeet = this.parakeetStatus()?.installedModels || [];

    if (provider === 'apple-speech') {
      return {
        needsDownload: false,
        badgeType: 'no-download' as const,
        badgeLabel: '✨ No Download Needed',
        modelName: 'macOS Neural Engine (Native Dictation)',
        modelSize: '0 MB',
        ramRequirement: 'Built-in',
        message: 'No download needed. Integrated directly into macOS Sonoma & Sequoia. Operates 100% on-device accelerated by the Apple Neural Engine (ANE) with zero external model downloads.',
      };
    }

    const meta = this.parakeetModelsList().find((m) => m.id === parakeetM) || this.parakeetModelsList()[0];
    const isParakeetInstalled = installedParakeet.includes(meta.id);
    if (isParakeetInstalled) {
      return {
        needsDownload: false,
        badgeType: 'ready' as const,
        badgeLabel: `✓ Model Ready (${meta.fileSizeStr})`,
        modelName: meta.name,
        modelSize: meta.fileSizeStr,
        ramRequirement: meta.ramRequirement,
        message: `NVIDIA Parakeet (${meta.name}) is installed locally (${meta.fileSizeStr} • ${meta.ramRequirement}). Ready for high-performance offline inference.`,
      };
    }

    return {
      needsDownload: true,
      badgeType: 'download-needed' as const,
      badgeLabel: `⬇️ Download Required (${meta.fileSizeStr})`,
      modelName: meta.name,
      modelSize: meta.fileSizeStr,
      ramRequirement: meta.ramRequirement,
      message: `Model download required before starting transcription: ${meta.name} (${meta.fileSizeStr} • ${meta.ramRequirement}). Click "Download Model" in the card below.`,
    };
  });

  async ngOnInit(): Promise<void> {
    await this.loadLlmProviders();
    await this.loadSettings();
    await this.loadSttEngines();
    await this.refreshParakeetStatus();
    await this.refreshMacosPermissions();
    await this.enumerateAudioDevices();

    this.unsubscribeParakeetDownloadProgress = this.ipcService.onParakeetDownloadProgress((progress) => {
      this.parakeetDownloadProgress.set(progress);
      if (progress.paused) {
        this.isDownloadingParakeet.set(false);
        this.isParakeetPaused.set(true);
        this.showToast('Parakeet model download paused.', 'info');
      } else if (progress.cancelled) {
        this.isDownloadingParakeet.set(false);
        this.isParakeetPaused.set(false);
        this.parakeetDownloadProgress.set(null);
        this.showToast('Parakeet model download cancelled.', 'info');
      } else if (progress.completed || progress.error) {
        this.isDownloadingParakeet.set(false);
        this.isParakeetPaused.set(false);
        this.refreshParakeetStatus();
        if (progress.completed) {
          const meta = this.parakeetModelsList().find((m) => m.id === progress.model);
          const name = meta ? meta.name : progress.model;
          this.showToast(`Parakeet model ${name} downloaded successfully!`, 'success');
        } else if (progress.error) {
          this.showToast(`Parakeet download error: ${progress.error}`, 'info');
        }
      }
    });

    this.unsubscribeModeChanged = this.ipcService.onTranscriptionModeChanged((mode) => {
      this.transcriptionMode.set(mode);
    });
  }

  ngOnDestroy(): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    if (this.unsubscribeParakeetDownloadProgress) {
      this.unsubscribeParakeetDownloadProgress();
    }
    if (this.unsubscribeModeChanged) {
      this.unsubscribeModeChanged();
    }
  }

  private async loadSettings(): Promise<void> {
    const settings = await this.ipcService.getSettings();

    // Context Profile
    if (settings.profile) {
      this.role.set(settings.profile.role || '');
      this.tone.set(settings.profile.tone || 'concise');
      this.projectSummary.set(settings.profile.projectSummary || '');
      this.glossary.set(settings.profile.glossary || []);
    }

    // Audio & STT Configuration
    this.sttProvider.set(settings.sttProvider || 'parakeet');
    this.transcriptionMode.set(settings.transcriptionMode || 'everyone');
    this.sttLanguage.set(settings.sttLanguage || 'en');
    if (settings.parakeetModel) this.parakeetModel.set(settings.parakeetModel);
    this.meetingAudioDeviceId.set(settings.meetingAudioDeviceId || '');
    this.micAudioDeviceId.set(settings.micAudioDeviceId || '');

    // Voice Frequency Filter & Tuning
    if (typeof settings.voiceFilterEnabled === 'boolean') this.voiceFilterEnabled.set(settings.voiceFilterEnabled);
    if (typeof settings.voiceLowCutHz === 'number') this.voiceLowCutHz.set(settings.voiceLowCutHz);
    if (typeof settings.voiceHighCutHz === 'number') this.voiceHighCutHz.set(settings.voiceHighCutHz);
    if (settings.voiceFilterPreset) this.voiceFilterPreset.set(settings.voiceFilterPreset);
    if (typeof settings.vadSensitivity === 'number') this.vadSensitivity.set(settings.vadSensitivity);
    if (typeof settings.noiseSuppression === 'boolean') this.noiseSuppression.set(settings.noiseSuppression);
    if (typeof settings.echoCancellation === 'boolean') this.echoCancellation.set(settings.echoCancellation);
    if (typeof settings.autoGainControl === 'boolean') this.autoGainControl.set(settings.autoGainControl);

    // LLM Configuration
    const providerId = settings.llmProvider || 'deepseek';
    const storedModel = settings.llmModel || 'deepseek-flash';
    this.llmProvider.set(providerId);
    this.llmModel.set(storedModel);
    const providerEntry = this.llmProviders().find((p) => p.id === providerId);
    if (providerEntry?.allowCustomModel && !providerEntry.models.some((m) => m.id === storedModel)) {
      this.customModelMode.set(true);
      this.customLlmModel.set(storedModel);
    } else {
      this.customModelMode.set(false);
      this.customLlmModel.set('');
    }
    this.llmThinkingEnabled.set(Boolean(settings.llmThinkingEnabled));
    this.temperature.set(typeof settings.temperature === 'number' ? settings.temperature : 0.3);
    this.maxTokens.set(settings.maxTokens || 500);

    // Key Statuses
    this.hasApiKeys.set(settings.hasApiKeys ?? {});
    this.isEncryptionAvailable.set(settings.isEncryptionAvailable !== false);

    // Overlay Dimensions & Transparency & Layout Mode
    if (settings.overlayWidth) this.overlayWidth.set(settings.overlayWidth);
    if (settings.overlayHeight) this.overlayHeight.set(settings.overlayHeight);
    if (typeof settings.overlayOpacity === 'number') this.overlayOpacity.set(settings.overlayOpacity);
    if (settings.overlayVersion) this.overlayVersion.set(settings.overlayVersion);
    if (typeof settings.multiWorkspace === 'boolean') this.multiWorkspace.set(settings.multiWorkspace);

    await this.loadKnowledgeDocs();
  }

  async loadSttEngines(): Promise<void> {
    try {
      const engines = await this.ipcService.getSttEngines();
      this.sttEngines.set(engines);
    } catch (err) {
      console.warn('[SettingsComponent] Failed to load STT engines:', err);
    }
  }

  async loadLlmProviders(): Promise<void> {
    try {
      const providers = await this.ipcService.getLlmProviders();
      this.llmProviders.set(providers);
    } catch (err) {
      console.warn('[SettingsComponent] Failed to load LLM providers:', err);
    }
  }


  async refreshMacosPermissions(): Promise<void> {
    try {
      const perms = await this.ipcService.getMacosPermissions();
      this.macosPermissions.set(perms);
    } catch (err) {
      console.warn('[SettingsComponent] Failed to get macOS permissions:', err);
    }
  }

  async requestMicrophoneAccess(): Promise<void> {
    const granted = await this.ipcService.requestMacosMicrophonePermission();
    await this.refreshMacosPermissions();
    if (granted) {
      this.showToast('Microphone permission granted!', 'success');
      await this.enumerateAudioDevices();
    } else {
      this.showToast('Microphone access denied. Please allow in macOS System Settings.', 'info');
    }
  }

  async enumerateAudioDevices(): Promise<void> {
    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.enumerateDevices) {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const inputs = devices
          .filter((d) => d.kind === 'audioinput')
          .map((d, index) => ({
            deviceId: d.deviceId,
            label: d.label || `Audio Input Device ${index + 1}`,
          }));
        this.audioInputDevices.set(inputs);
      } catch (err) {
        console.warn('[SettingsComponent] Failed enumerating audio devices:', err);
      }
    }
  }

  async selectTranscriptionMode(mode: TranscriptionMode): Promise<void> {
    this.transcriptionMode.set(mode);
    await this.ipcService.setTranscriptionMode(mode);
    this.showToast(
      mode === 'other-only'
        ? 'Transcription Mode: Other Participant Only (Mic Muted)'
        : 'Transcription Mode: Everyone (Meeting Audio + Microphone)',
      'success'
    );
  }

  async refreshParakeetStatus(): Promise<void> {
    try {
      const status = await this.ipcService.getParakeetStatus();
      this.parakeetStatus.set(status);
      const platform = this.toSttPlatform(status.platform);
      if (platform) this.parakeetPlatform.set(platform);
    } catch (err) {
      console.warn('[SettingsComponent] Failed to get Parakeet status:', err);
    }
  }

  private toSttPlatform(value?: string): SttPlatform | null {
    switch (value) {
      case 'darwin-arm64':
      case 'darwin-x64':
      case 'win32-x64':
      case 'win32-ia32':
        return value;
      default:
        return null;
    }
  }

  async downloadParakeetModel(modelId: ParakeetModelType): Promise<void> {
    if (this.isDownloadingParakeet()) return;

    const meta = this.parakeetModelsList().find((m) => m.id === modelId) || this.parakeetModelsList()[0];
    const artifact = STT_MODEL_CATALOG.find((entry) => entry.id === modelId)?.artifacts[
      this.parakeetPlatform()
    ];
    const totalMb = artifact ? Math.round(artifactTotalBytes(artifact) / (1024 * 1024)) : 0;

    const wasPaused = this.isParakeetPaused() && this.parakeetDownloadProgress()?.model === modelId;
    const currentProgress = this.parakeetDownloadProgress();

    this.isDownloadingParakeet.set(true);
    this.isParakeetPaused.set(false);

    if (!wasPaused || !currentProgress) {
      this.parakeetDownloadProgress.set({
        model: modelId,
        percent: 0,
        downloadedMb: 0,
        totalMb,
        completed: false,
      });
    }

    try {
      this.showToast(
        wasPaused
          ? `Resuming download for ${meta.name}...`
          : `Starting download for ${meta.name} (${meta.fileSizeStr})...`,
        'info'
      );
      await this.ipcService.downloadParakeetModel(modelId);
    } catch (err: unknown) {
      this.isDownloadingParakeet.set(false);
      const msg = err instanceof Error ? err.message : String(err);
      this.showToast(`Failed downloading Parakeet model: ${msg}`, 'info');
    }
  }

  async pauseParakeetDownload(): Promise<void> {
    try {
      await this.ipcService.pauseParakeetDownload();
      this.isDownloadingParakeet.set(false);
      this.isParakeetPaused.set(true);
    } catch (err) {
      console.warn('[SettingsComponent] Failed to pause download:', err);
    }
  }

  async cancelParakeetDownload(): Promise<void> {
    try {
      await this.ipcService.cancelParakeetDownload();
      this.isDownloadingParakeet.set(false);
      this.isParakeetPaused.set(false);
      this.parakeetDownloadProgress.set(null);
    } catch (err) {
      console.warn('[SettingsComponent] Failed to cancel download:', err);
    }
  }

  async deleteParakeetModel(modelId: ParakeetModelType): Promise<void> {
    try {
      const ok = await this.ipcService.deleteParakeetModel(modelId);
      await this.refreshParakeetStatus();
      if (ok) {
        this.showToast(`Parakeet model ${modelId} deleted successfully.`, 'info');
      } else {
        this.showToast(`Parakeet model ${modelId} was not found.`, 'info');
      }
    } catch {
      this.showToast('Failed to delete Parakeet model.', 'info');
    }
  }

  async revealParakeetModel(modelId: ParakeetModelType): Promise<void> {
    this.parakeetRevealingModel.set(modelId);
    try {
      const ok = await this.ipcService.revealParakeetModel(modelId);
      if (!ok) {
        this.showToast('Model file not found. It may have been moved or deleted.', 'info');
      }
    } catch {
      this.showToast('Failed to open file location.', 'info');
    } finally {
      this.parakeetRevealingModel.set(null);
    }
  }

  async loadKnowledgeDocs(): Promise<void> {
    try {
      const docs = await this.ipcService.listKnowledgeDocs();
      this.knowledgeDocs.set(docs);
    } catch (err) {
      console.warn('[SettingsComponent] Failed to load knowledge docs:', err);
    }
  }

  async addKnowledgeDoc(): Promise<void> {
    const title = this.newDocTitle().trim();
    const content = this.newDocContent().trim();
    if (!title || !content) return;

    try {
      await this.ipcService.addKnowledgeDoc({
        title,
        content,
        category: this.newDocCategory().trim() || 'Architecture',
      });
      this.newDocTitle.set('');
      this.newDocContent.set('');
      this.isAddingDoc.set(false);
      await this.loadKnowledgeDocs();
      this.showToast('Document indexed into local RAG knowledge base!', 'success');
    } catch {
      this.showToast('Failed to add document to knowledge base.', 'info');
    }
  }

  async removeKnowledgeDoc(id: string): Promise<void> {
    try {
      await this.ipcService.removeKnowledgeDoc(id);
      await this.loadKnowledgeDocs();
      this.showToast('Document removed from knowledge base.', 'success');
    } catch {
      this.showToast('Failed to remove document.', 'info');
    }
  }

  onRoleChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.role.set(target.value);
  }

  onSummaryChange(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.projectSummary.set(target.value);
  }

  onNewGlossaryChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.newGlossaryTerm.set(target.value);
  }

  addGlossaryTerm(): void {
    const term = this.newGlossaryTerm().trim();
    if (term && !this.glossary().includes(term)) {
      this.glossary.update((terms) => [...terms, term]);
      this.newGlossaryTerm.set('');
    }
  }

  removeGlossaryTerm(termToRemove: string): void {
    this.glossary.update((terms) => terms.filter((t) => t !== termToRemove));
  }

  onSttProviderChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.sttProvider.set(target.value as STTEngineType);
  }

  onSttLanguageChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.sttLanguage.set(target.value as 'en' | 'hi' | 'multi');
  }

  onParakeetModelSelect(model: ParakeetModelType): void {
    this.parakeetModel.set(model);
    this.sttProvider.set('parakeet');
  }

  onMeetingDeviceChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.meetingAudioDeviceId.set(target.value);
  }

  onMicDeviceChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.micAudioDeviceId.set(target.value);
  }

  onLlmProviderChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    const id = target.value as LlmProviderId;
    this.llmProvider.set(id);
    const entry = this.llmProviders().find((p) => p.id === id);
    if (entry) {
      this.llmModel.set(entry.defaultModel);
    }
    this.customModelMode.set(false);
    this.customLlmModel.set('');
  }

  onLlmModelChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    if (target.value === CUSTOM_MODEL_VALUE) {
      this.customModelMode.set(true);
      return;
    }
    this.customModelMode.set(false);
    this.llmModel.set(target.value);
  }

  onCustomLlmModelChange(event: Event): void {
    this.customLlmModel.set((event.target as HTMLInputElement).value);
  }

  onLlmThinkingChange(event: Event): void {
    this.llmThinkingEnabled.set((event.target as HTMLInputElement).checked);
  }

  onTemperatureChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.temperature.set(parseFloat(target.value));
  }

  onMaxTokensChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.maxTokens.set(parseInt(target.value, 10) || 500);
  }

  onApiKeyChange(providerId: LlmProviderId, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.apiKeyInputs.update((inputs) => ({ ...inputs, [providerId]: value }));
  }

  toggleApiKeyVisibility(providerId: LlmProviderId): void {
    this.showApiKeys.update((state) => ({ ...state, [providerId]: !state[providerId] }));
  }

  hasKey(providerId: LlmProviderId): boolean {
    return Boolean(this.hasApiKeys()[providerId]);
  }

  apiKeyValue(providerId: LlmProviderId): string {
    return this.apiKeyInputs()[providerId] ?? '';
  }

  isApiKeyVisible(providerId: LlmProviderId): boolean {
    return Boolean(this.showApiKeys()[providerId]);
  }

  onOverlayWidthChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    const val = parseInt(target.value, 10);
    if (!isNaN(val)) {
      this.overlayWidth.set(val);
      if (this.ipcService.isElectron()) {
        this.ipcService.setOverlaySize(val, this.overlayHeight());
      }
    }
  }

  onOverlayHeightChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    const val = parseInt(target.value, 10);
    if (!isNaN(val)) {
      this.overlayHeight.set(val);
      if (this.ipcService.isElectron()) {
        this.ipcService.setOverlaySize(this.overlayWidth(), val);
      }
    }
  }

  onOverlayOpacityChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    const val = parseFloat(target.value);
    if (!isNaN(val)) {
      this.applyOverlayOpacity(val);
    }
  }

  async applyOverlayOpacity(opacity: number): Promise<void> {
    const clamped = Math.round(Math.max(0.2, Math.min(1.0, opacity)) * 100) / 100;
    this.overlayOpacity.set(clamped);
    if (this.ipcService.isElectron()) {
      await this.ipcService.setOverlayOpacity(clamped);
    }
  }

  stepWidth(delta: number): void {
    const next = Math.max(300, Math.min(1200, this.overlayWidth() + delta));
    this.overlayWidth.set(next);
    if (this.ipcService.isElectron()) {
      this.ipcService.setOverlaySize(next, this.overlayHeight());
    }
  }

  stepHeight(delta: number): void {
    const next = Math.max(400, Math.min(1100, this.overlayHeight() + delta));
    this.overlayHeight.set(next);
    if (this.ipcService.isElectron()) {
      this.ipcService.setOverlaySize(this.overlayWidth(), next);
    }
  }

  async applyOverlaySize(w: number, h: number): Promise<void> {
    const clampedW = Math.max(300, Math.min(1600, w));
    const clampedH = Math.max(400, Math.min(1400, h));
    this.overlayWidth.set(clampedW);
    this.overlayHeight.set(clampedH);
    if (this.ipcService.isElectron()) {
      await this.ipcService.setOverlaySize(clampedW, clampedH);
    }
    this.showToast(`Overlay dimensions set to ${clampedW} × ${clampedH}px`, 'success');
  }

  async applyPresetDimensions(width: number, height: number): Promise<void> {
    return this.applyOverlaySize(width, height);
  }

  async selectOverlayVersion(version: 'v1' | 'v2'): Promise<void> {
    this.overlayVersion.set(version);
    await this.ipcService.setOverlayVersion(version);
    this.showToast(`Overlay layout set to ${version === 'v2' ? 'Modern HUD (V2)' : 'Classic (V1)'}`, 'success');
  }

  async toggleMultiWorkspaceSetting(): Promise<void> {
    const next = !this.multiWorkspace();
    this.multiWorkspace.set(next);
    await this.ipcService.setMultiWorkspace(next);
    this.showToast(next ? 'Multi-Workspace persistence enabled (all spaces)' : 'Single Workspace mode enabled (pinned to space)', 'info');
  }

  async saveSettings(): Promise<void> {
    this.isSaving.set(true);

    const payload: AppSettings = {
      sttProvider: this.sttProvider(),
      transcriptionMode: this.transcriptionMode(),
      sttLanguage: this.sttLanguage(),
      parakeetModel: this.parakeetModel(),
      meetingAudioDeviceId: this.meetingAudioDeviceId() || undefined,
      micAudioDeviceId: this.micAudioDeviceId() || undefined,
      llmProvider: this.llmProvider(),
      llmModel: this.effectiveLlmModel(),
      llmThinkingEnabled: this.llmThinkingEnabled(),
      temperature: this.temperature(),
      maxTokens: this.maxTokens(),
      overlayWidth: this.overlayWidth(),
      overlayHeight: this.overlayHeight(),
      overlayOpacity: this.overlayOpacity(),
      overlayVersion: this.overlayVersion(),
      multiWorkspace: this.multiWorkspace(),
      voiceFilterEnabled: this.voiceFilterEnabled(),
      voiceLowCutHz: this.voiceLowCutHz(),
      voiceHighCutHz: this.voiceHighCutHz(),
      voiceFilterPreset: this.voiceFilterPreset(),
      vadSensitivity: this.vadSensitivity(),
      noiseSuppression: this.noiseSuppression(),
      echoCancellation: this.echoCancellation(),
      autoGainControl: this.autoGainControl(),
      profile: {
        role: this.role(),
        projectSummary: this.projectSummary(),
        glossary: this.glossary(),
        tone: this.tone(),
      },
    };

    const apiKeys: Record<string, string> = {};
    for (const [providerId, value] of Object.entries(this.apiKeyInputs())) {
      if (value.trim().length > 0) {
        apiKeys[providerId] = value.trim();
      }
    }
    if (Object.keys(apiKeys).length > 0) {
      payload.apiKeys = apiKeys;
    }

    try {
      const updated = await this.ipcService.setSettings(payload);
      this.hasApiKeys.set(updated.hasApiKeys ?? {});
      this.apiKeyInputs.set({});
      this.showToast('Settings, audio routing, and context profile saved successfully!', 'success');
    } catch {
      this.showToast('Failed to save settings.', 'info');
    } finally {
      this.isSaving.set(false);
    }
  }

  resetDefaults(): void {
    this.role.set('Staff Software Engineer / Tech Lead');
    this.tone.set('concise');
    this.projectSummary.set(
      'Leading core payments and distributed ledger migration. Zero downtime, strict idempotency, resilient circuit breaker patterns.'
    );
    this.glossary.set(['idempotency', 'jitter', 'canary rollout', 'circuit breaker', 'ledger', 'p99 latency']);
    this.sttProvider.set('parakeet');
    this.transcriptionMode.set('everyone');
    this.parakeetModel.set('parakeet-flash');
    this.sttLanguage.set('en');
    this.voiceFilterEnabled.set(true);
    this.voiceLowCutHz.set(120);
    this.voiceHighCutHz.set(4000);
    this.voiceFilterPreset.set('optimal-voice');
    this.vadSensitivity.set(0.006);
    this.noiseSuppression.set(true);
    this.echoCancellation.set(true);
    this.autoGainControl.set(true);
    this.llmProvider.set('deepseek');
    this.llmModel.set('deepseek-flash');
    this.customModelMode.set(false);
    this.customLlmModel.set('');
    this.llmThinkingEnabled.set(false);
    this.temperature.set(0.3);
    this.maxTokens.set(500);
    this.overlayWidth.set(380);
    this.overlayHeight.set(600);
    this.overlayVersion.set('v1');
    this.multiWorkspace.set(true);
    this.applyOverlayOpacity(0.88);
    this.showToast('Defaults loaded. Click "Save Changes" to apply.', 'info');
  }

  setVoiceFilterPreset(preset: 'optimal-voice' | 'aggressive-noise-cut' | 'wide-natural' | 'custom'): void {
    this.voiceFilterPreset.set(preset);
    if (preset === 'optimal-voice') {
      this.voiceLowCutHz.set(120);
      this.voiceHighCutHz.set(4000);
      this.vadSensitivity.set(0.006);
    } else if (preset === 'aggressive-noise-cut') {
      this.voiceLowCutHz.set(200);
      this.voiceHighCutHz.set(3200);
      this.vadSensitivity.set(0.012);
    } else if (preset === 'wide-natural') {
      this.voiceLowCutHz.set(80);
      this.voiceHighCutHz.set(7500);
      this.vadSensitivity.set(0.004);
    }
  }

  onVoiceLowCutChange(event: Event): void {
    const val = parseInt((event.target as HTMLInputElement).value, 10);
    if (!isNaN(val)) {
      this.voiceLowCutHz.set(val);
      this.voiceFilterPreset.set('custom');
    }
  }

  onVoiceHighCutChange(event: Event): void {
    const val = parseInt((event.target as HTMLInputElement).value, 10);
    if (!isNaN(val)) {
      this.voiceHighCutHz.set(val);
      this.voiceFilterPreset.set('custom');
    }
  }

  onVadSensitivityChange(event: Event): void {
    const val = parseFloat((event.target as HTMLInputElement).value);
    if (!isNaN(val)) {
      this.vadSensitivity.set(val);
      this.voiceFilterPreset.set('custom');
    }
  }

  toggleVoiceFilter(): void {
    this.voiceFilterEnabled.update((v) => !v);
  }

  toggleNoiseSuppression(): void {
    this.noiseSuppression.update((v) => !v);
  }

  toggleEchoCancellation(): void {
    this.echoCancellation.update((v) => !v);
  }

  toggleAutoGainControl(): void {
    this.autoGainControl.update((v) => !v);
  }

  async purgeAllData(): Promise<void> {
    if (
      typeof window !== 'undefined' &&
      !window.confirm(
        'Are you sure you want to delete all stored credentials, context profiles, and meeting data? This cannot be undone.'
      )
    ) {
      return;
    }

    try {
      await this.ipcService.clearAllData();
      await this.loadSettings();
      this.showToast('All stored credentials and meeting data have been purged.', 'success');
    } catch {
      this.showToast('Failed to purge data.', 'info');
    }
  }

  async switchTab(tab: typeof this.activeTab extends () => infer R ? R : never): Promise<void> {
    this.activeTab.set(tab);
    if (tab === 'diagnostics') {
      await this.refreshDiagnostics();
    } else if (tab === 'audio') {
      await this.refreshParakeetStatus();
      await this.refreshMacosPermissions();
      await this.enumerateAudioDevices();
    }
  }

  async refreshDiagnostics(): Promise<void> {
    this.isLoadingDiagnostics.set(true);
    try {
      const diag = await this.ipcService.getDiagnostics();
      this.diagnostics.set(diag);
    } catch (err) {
      console.warn('[SettingsComponent] Failed to load diagnostics:', err);
    } finally {
      this.isLoadingDiagnostics.set(false);
    }
  }

  async loadDiagnostics(): Promise<void> {
    return this.refreshDiagnostics();
  }

  formatUptime(sec: number): string {
    const hrs = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (hrs > 0) return `${hrs}h ${mins}m ${s}s`;
    if (mins > 0) return `${mins}m ${s}s`;
    return `${s}s`;
  }

  showToast(message: string, type: 'success' | 'info' = 'success'): void {
    this.toastMessage.set(message);
    this.toastType.set(type);
    setTimeout(() => {
      this.toastMessage.set(null);
    }, 3200);
  }
}
