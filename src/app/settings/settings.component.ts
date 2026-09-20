import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  inject,
  signal,
  computed,
} from '@angular/core';
import { IpcService } from '../core/ipc.service';
import { AppSettings, ContextProfile, AppDiagnostics, KnowledgeDoc } from '@shared/ipc';

@Component({
  selector: 'app-settings',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './settings.component.scss',
  templateUrl: './settings.component.html',
})
export class SettingsComponent implements OnInit {
  private readonly ipcService = inject(IpcService);

  // Tabs
  readonly activeTab = signal<'profile' | 'ai' | 'overlay' | 'keys' | 'knowledge' | 'privacy' | 'shortcuts' | 'diagnostics'>('profile');

  // Diagnostics Signal (Milestone 5)
  readonly diagnostics = signal<AppDiagnostics | null>(null);
  readonly isLoadingDiagnostics = signal(false);

  // Overlay Dimensions & Transparency
  readonly overlayWidth = signal(380);
  readonly overlayHeight = signal(600);
  readonly overlayOpacity = signal(0.88);
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

  // AI Signals (FR-61 & FR-23)
  readonly sttProvider = signal<'deepgram' | 'simulation'>('simulation');
  readonly sttLanguage = signal<'en' | 'hi' | 'multi'>('en');
  readonly llmProvider = signal<'anthropic' | 'local'>('local');
  readonly llmModel = signal('claude-3-5-sonnet-20241022');
  readonly temperature = signal(0.3);
  readonly maxTokens = signal(500);

  // Knowledge Base Signals (Milestone 7 / FR-44)
  readonly knowledgeDocs = signal<KnowledgeDoc[]>([]);
  readonly newDocTitle = signal('');
  readonly newDocCategory = signal('Architecture');
  readonly newDocContent = signal('');
  readonly isAddingDoc = signal(false);

  // Key Signals (FR-60)
  readonly hasAnthropicKey = signal(false);
  readonly hasDeepgramKey = signal(false);
  readonly isEncryptionAvailable = signal(true);
  readonly anthropicKeyInput = signal('');
  readonly deepgramKeyInput = signal('');
  readonly showAnthropicKey = signal(false);
  readonly showDeepgramKey = signal(false);

  // UI state
  readonly isSaving = signal(false);
  readonly toastMessage = signal<string | null>(null);
  readonly toastType = signal<'success' | 'info'>('success');

  async ngOnInit(): Promise<void> {
    await this.loadSettings();
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

    // AI Configuration
    this.sttProvider.set(settings.sttProvider || 'simulation');
    this.sttLanguage.set(settings.sttLanguage || 'en');
    this.llmProvider.set(settings.llmProvider || 'local');
    this.llmModel.set(settings.llmModel || 'claude-3-5-sonnet-20241022');
    this.temperature.set(typeof settings.temperature === 'number' ? settings.temperature : 0.3);
    this.maxTokens.set(settings.maxTokens || 500);

    // Key Statuses
    this.hasAnthropicKey.set(Boolean(settings.hasAnthropicKey));
    this.hasDeepgramKey.set(Boolean(settings.hasDeepgramKey));
    this.isEncryptionAvailable.set(settings.isEncryptionAvailable !== false);

    // Overlay Dimensions & Transparency
    if (settings.overlayWidth) this.overlayWidth.set(settings.overlayWidth);
    if (settings.overlayHeight) this.overlayHeight.set(settings.overlayHeight);
    if (typeof settings.overlayOpacity === 'number') this.overlayOpacity.set(settings.overlayOpacity);

    await this.loadKnowledgeDocs();
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
    this.sttProvider.set(target.value as 'deepgram' | 'simulation');
  }

  onSttLanguageChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.sttLanguage.set(target.value as 'en' | 'hi' | 'multi');
  }

  onLlmProviderChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.llmProvider.set(target.value as 'anthropic' | 'local');
  }

  onLlmModelChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.llmModel.set(target.value);
  }

  onTemperatureChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.temperature.set(parseFloat(target.value));
  }

  onMaxTokensChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.maxTokens.set(parseInt(target.value, 10) || 500);
  }

  onAnthropicKeyChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.anthropicKeyInput.set(target.value);
  }

  onDeepgramKeyChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.deepgramKeyInput.set(target.value);
  }

  onOverlayWidthChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    const val = parseInt(target.value, 10);
    if (!isNaN(val)) this.overlayWidth.set(val);
  }

  onOverlayHeightChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    const val = parseInt(target.value, 10);
    if (!isNaN(val)) this.overlayHeight.set(val);
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
  }

  stepHeight(delta: number): void {
    const next = Math.max(400, Math.min(1100, this.overlayHeight() + delta));
    this.overlayHeight.set(next);
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

  async saveSettings(): Promise<void> {
    this.isSaving.set(true);

    const payload: AppSettings = {
      sttProvider: this.sttProvider(),
      sttLanguage: this.sttLanguage(),
      llmProvider: this.llmProvider(),
      llmModel: this.llmModel(),
      temperature: this.temperature(),
      maxTokens: this.maxTokens(),
      overlayWidth: this.overlayWidth(),
      overlayHeight: this.overlayHeight(),
      overlayOpacity: this.overlayOpacity(),
      profile: {
        role: this.role(),
        projectSummary: this.projectSummary(),
        glossary: this.glossary(),
        tone: this.tone(),
      },
    };

    if (this.anthropicKeyInput().trim().length > 0) {
      payload.anthropicApiKey = this.anthropicKeyInput().trim();
    }
    if (this.deepgramKeyInput().trim().length > 0) {
      payload.deepgramApiKey = this.deepgramKeyInput().trim();
    }

    try {
      const updated = await this.ipcService.setSettings(payload);
      this.hasAnthropicKey.set(Boolean(updated.hasAnthropicKey));
      this.hasDeepgramKey.set(Boolean(updated.hasDeepgramKey));
      this.anthropicKeyInput.set('');
      this.deepgramKeyInput.set('');
      this.showToast('Settings and Context Profile saved successfully!', 'success');
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
    this.sttProvider.set('simulation');
    this.sttLanguage.set('en');
    this.llmProvider.set('local');
    this.llmModel.set('claude-3-5-sonnet-20241022');
    this.temperature.set(0.3);
    this.maxTokens.set(500);
    this.overlayWidth.set(380);
    this.overlayHeight.set(600);
    this.applyOverlayOpacity(0.88);
    this.showToast('Defaults loaded. Click "Save Changes" to apply.', 'info');
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
      this.showToast('All local application data and credentials have been purged.', 'success');
    } catch {
      this.showToast('Failed to purge data.', 'info');
    }
  }

  switchTab(tab: 'profile' | 'ai' | 'overlay' | 'keys' | 'knowledge' | 'privacy' | 'shortcuts' | 'diagnostics'): void {
    this.activeTab.set(tab);
    if (tab === 'diagnostics') {
      this.loadDiagnostics();
    }
  }

  async loadDiagnostics(): Promise<void> {
    this.isLoadingDiagnostics.set(true);
    try {
      const data = await this.ipcService.getDiagnostics();
      this.diagnostics.set(data);
    } catch (err) {
      console.warn('[SettingsComponent] Failed to load diagnostics:', err);
    } finally {
      this.isLoadingDiagnostics.set(false);
    }
  }

  formatUptime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m === 0) return `${s}s`;
    return `${m}m ${s}s`;
  }

  private showToast(msg: string, type: 'success' | 'info'): void {
    this.toastMessage.set(msg);
    this.toastType.set(type);
    setTimeout(() => {
      if (this.toastMessage() === msg) {
        this.toastMessage.set(null);
      }
    }, 3000);
  }
}
