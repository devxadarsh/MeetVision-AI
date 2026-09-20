import { Injectable } from '@angular/core';
import {
  HotkeyAction,
  SessionStatus,
  TranscriptSegment,
  Question,
  AnswerChunk,
  RegeneratePayload,
  AppSettings,
  AppDiagnostics,
  KnowledgeDoc,
  MeetingSummary,
} from '@shared/ipc';

@Injectable({
  providedIn: 'root',
})
export class IpcService {
  private get api() {
    return window.electronAPI;
  }

  isElectron(): boolean {
    return typeof window !== 'undefined' && !!window.electronAPI;
  }

  async ping(message: string): Promise<string> {
    if (!this.api) {
      return `Electron API unavailable (running in browser). Message: "${message}"`;
    }
    return this.api.ping(message);
  }

  async getDiagnostics(): Promise<AppDiagnostics> {
    if (!this.api) {
      return {
        platform: typeof navigator !== 'undefined' ? navigator.platform : 'web',
        arch: 'web',
        electronVersion: 'N/A (Browser)',
        chromeVersion: typeof navigator !== 'undefined' ? navigator.userAgent : 'Browser',
        nodeVersion: 'N/A',
        uptimeSec: 360,
        memoryUsageMb: {
          rss: 85,
          heapUsed: 42,
          heapTotal: 64,
        },
        contentProtectionActive: false,
        sttConnected: true,
        activeWindows: 1,
      };
    }
    return this.api.getDiagnostics();
  }

  async setClickThrough(ignore: boolean): Promise<boolean> {
    if (!this.api) return false;
    return this.api.setClickThrough(ignore);
  }

  async getClickThrough(): Promise<boolean> {
    if (!this.api) return false;
    return this.api.getClickThrough();
  }

  async setOverlaySize(width: number, height: number): Promise<{ width: number; height: number }> {
    if (!this.api) {
      return { width, height };
    }
    return this.api.setOverlaySize(width, height);
  }

  async getOverlaySize(): Promise<{ width: number; height: number }> {
    if (!this.api) {
      return { width: 380, height: 600 };
    }
    return this.api.getOverlaySize();
  }

  async moveOverlay(deltaX: number, deltaY: number): Promise<{ x: number; y: number } | null> {
    if (!this.api) {
      return null;
    }
    return this.api.moveOverlay(deltaX, deltaY);
  }

  async setOverlayOpacity(opacity: number): Promise<number> {
    if (!this.api) {
      return opacity;
    }
    return this.api.setOverlayOpacity(opacity);
  }

  onOverlayOpacityChanged(callback: (opacity: number) => void): (() => void) {
    if (!this.api) return () => {};
    return this.api.onOverlayOpacityChanged(callback);
  }

  async setMultiWorkspace(enabled: boolean): Promise<boolean> {
    if (!this.api) {
      localStorage.setItem('ql_multi_workspace', String(enabled));
      return enabled;
    }
    return this.api.setMultiWorkspace(enabled);
  }

  onMultiWorkspaceChanged(callback: (enabled: boolean) => void): (() => void) {
    if (!this.api) return () => {};
    return this.api.onMultiWorkspaceChanged(callback);
  }

  async setOverlayVersion(version: 'v1' | 'v2'): Promise<'v1' | 'v2'> {
    if (!this.api) {
      localStorage.setItem('ql_overlay_version', version);
      return version;
    }
    return this.api.setOverlayVersion(version);
  }

  onOverlayVersionChanged(callback: (version: 'v1' | 'v2') => void): (() => void) {
    if (!this.api) return () => {};
    return this.api.onOverlayVersionChanged(callback);
  }

  async close(): Promise<void> {
    if (!this.api) return;
    return this.api.close();
  }

  onHotkey(callback: (action: HotkeyAction) => void): (() => void) {
    if (!this.api) return () => {};
    return this.api.onHotkey(callback);
  }

  async startSession(): Promise<void> {
    if (!this.api) return;
    return this.api.startSession();
  }

  async stopSession(): Promise<void> {
    if (!this.api) return;
    return this.api.stopSession();
  }

  async getSessionStatus(): Promise<SessionStatus> {
    if (!this.api) {
      return { active: true, provider: 'Browser Dev Simulation' };
    }
    return this.api.getSessionStatus();
  }

  sendAudioChunk(chunk: ArrayBuffer): void {
    if (!this.api) return;
    this.api.sendAudioChunk(chunk);
  }

  sendAudioLevel(level: number): void {
    if (!this.api) return;
    this.api.sendAudioLevel(level);
  }

  onAudioLevel(callback: (level: number) => void): (() => void) {
    if (!this.api) return () => {};
    return this.api.onAudioLevel(callback);
  }

  onTranscriptUpdate(callback: (segment: TranscriptSegment) => void): (() => void) {
    if (!this.api) return () => {};
    return this.api.onTranscriptUpdate(callback);
  }

  async clearTranscript(): Promise<void> {
    if (!this.api) return;
    return this.api.clearTranscript();
  }

  onTranscriptClear(callback: () => void): (() => void) {
    if (!this.api) return () => {};
    return this.api.onTranscriptClear(callback);
  }

  // Question & Answer channels (Milestone 3)
  onQuestionNew(callback: (question: Question) => void): (() => void) {
    if (!this.api) return () => {};
    return this.api.onQuestionNew(callback);
  }

  onAnswerChunk(callback: (chunk: AnswerChunk) => void): (() => void) {
    if (!this.api) return () => {};
    return this.api.onAnswerChunk(callback);
  }

  async regenerateAnswer(payload: RegeneratePayload): Promise<void> {
    if (!this.api) return;
    return this.api.regenerateAnswer(payload);
  }

  // Settings & Profile channels (Milestone 4)
  async getSettings(): Promise<AppSettings> {
    if (!this.api) {
      return {
        sttProvider: 'simulation',
        llmProvider: 'local',
        llmModel: 'claude-3-5-sonnet-20241022',
        temperature: 0.3,
        maxTokens: 500,
        overlayOpacity: 0.88,
        hasAnthropicKey: false,
        hasDeepgramKey: false,
        isEncryptionAvailable: false,
        profile: {
          role: 'Staff Software Engineer / Tech Lead',
          projectSummary:
            'Leading the core payments and ledger infrastructure v2 migration. High reliability, zero data loss, strict idempotency.',
          glossary: ['idempotency', 'circuit breaker', 'canary cohort', 'ledger', 'p99 latency'],
          tone: 'concise',
        },
      };
    }
    return this.api.getSettings();
  }

  async setSettings(settings: AppSettings): Promise<AppSettings> {
    if (!this.api) {
      return settings;
    }
    return this.api.setSettings(settings);
  }

  async openSettings(): Promise<boolean> {
    if (!this.api) {
      if (window.location.hash === '#/settings') {
        window.location.hash = '#/overlay';
        return false;
      } else {
        window.location.hash = '#/settings';
        return true;
      }
    }
    return this.api.openSettings();
  }

  onSettingsVisibilityChanged(callback: (isOpen: boolean) => void): (() => void) | undefined {
    if (!this.api) return undefined;
    return this.api.onSettingsVisibilityChanged(callback);
  }

  // Milestone 6: Consent & Data Purge
  async acceptConsent(): Promise<void> {
    if (!this.api) return;
    return this.api.acceptConsent();
  }

  async clearAllData(): Promise<void> {
    if (!this.api) return;
    return this.api.clearAllData();
  }

  // Milestone 7: Knowledge Base (RAG)
  async listKnowledgeDocs(): Promise<KnowledgeDoc[]> {
    if (!this.api) {
      return [
        {
          id: 'mock_1',
          title: 'Payment Gateway Architecture (Mock)',
          content: 'Retry with jittered exponential backoff: 500ms base, 4s max cap.',
          category: 'Architecture',
          updatedAt: Date.now(),
        },
      ];
    }
    return this.api.listKnowledgeDocs();
  }

  async addKnowledgeDoc(doc: Omit<KnowledgeDoc, 'id' | 'updatedAt'>): Promise<KnowledgeDoc> {
    if (!this.api) {
      return {
        ...doc,
        id: `mock_${Date.now()}`,
        updatedAt: Date.now(),
      };
    }
    return this.api.addKnowledgeDoc(doc);
  }

  async removeKnowledgeDoc(id: string): Promise<boolean> {
    if (!this.api) return true;
    return this.api.removeKnowledgeDoc(id);
  }

  // Milestone 7: Meeting Summary & Export
  async generateMeetingSummary(): Promise<MeetingSummary> {
    if (!this.api) {
      const now = new Date().toLocaleDateString();
      return {
        id: `summary_mock`,
        generatedAt: Date.now(),
        title: `Meeting Summary — ${now}`,
        overview: 'Sample meeting discussion regarding system architecture and reliability.',
        keyQuestions: [
          {
            question: 'How does the retry logic work in payment flow?',
            answerSummary: 'Three retries with jittered exponential backoff (500ms - 4000ms).',
            speaker: 'Speaker 1',
          },
        ],
        actionItems: [
          {
            id: 'act_1',
            task: 'Verify Datadog error-budget alarms for 10% canary cohort.',
            owner: 'Alex',
            dueDate: 'Tuesday',
          },
        ],
        markdown: `# Meeting Summary\n\n- Executive overview\n- Q: Retry logic\n- Action item: Canary alarms`,
      };
    }
    return this.api.generateMeetingSummary();
  }

  async exportMeetingSummary(markdown: string): Promise<boolean> {
    if (!this.api) {
      console.log('[IpcService Mock] Exported markdown summary:\n', markdown);
      return true;
    }
    return this.api.exportMeetingSummary(markdown);
  }
}
