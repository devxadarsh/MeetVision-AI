import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  OnDestroy,
  inject,
  signal,
  computed,
  ElementRef,
  viewChild,
  HostListener,
} from '@angular/core';
import { IpcService } from '../core/ipc.service';
import {
  Question,
  HotkeyAction,
  TranscriptSegment,
  AnswerChunk,
  MeetingSummary,
  TranscriptionMode,
} from '@shared/ipc';

interface DummyQuestionTemplate {
  text: string;
  speaker?: string;
  mode: 'short' | 'detailed' | 'simple';
  bullets: string[];
  code?: string;
}

const SAMPLE_QUESTION_TEMPLATES: DummyQuestionTemplate[] = [
  {
    text: 'How does the retry logic and exponential backoff work in the payment flow?',
    speaker: 'Speaker 1',
    mode: 'short',
    bullets: [
      'Three retries with jittered exponential backoff: base 500ms, cap at 4,000ms.',
      'Only idempotency-safe HTTP status codes (500, 502, 503, 504) trigger a retry; 4xx fail immediately.',
      'Circuit breaker opens after 5 consecutive failures with a 30s cooling period.',
    ],
    code: 'retry({ count: 3, delay: (err, i) => Math.min(500 * 2 ** i, 4000) })',
  },
  {
    text: "What's the rollout schedule and canary plan for the v2 migration?",
    speaker: 'Speaker 2',
    mode: 'detailed',
    bullets: [
      'Phase 1: Internal alpha team rollout (100% complete and healthy).',
      'Phase 2: 10% canary traffic cohort starting Tuesday 09:00 UTC with automated rollback alarms.',
      'Phase 3: 50% rollout on Thursday after evaluating p99 latency and error rate metrics.',
      'Phase 4: Full 100% cutover next Monday with zero planned downtime.',
    ],
  },
  {
    text: 'What is the fallback mechanism if the external KYC verification provider times out?',
    speaker: 'Speaker 1',
    mode: 'simple',
    bullets: [
      'Enqueue customer verification into an asynchronous processing queue.',
      'Issue a background webhook check with a 2-minute SLA guarantee.',
      'Grant immediate partial access while background verification resolves.',
    ],
  },
  {
    text: 'Can you explain the difference in p99 database latency after the Redis caching update?',
    speaker: 'Speaker 2',
    mode: 'short',
    bullets: [
      'p99 query latency decreased from 340ms to 42ms on heavy read endpoints.',
      'Database read replicas CPU dropped from 78% average to 24%.',
      'TTL is set to 15 minutes with proactive stale-while-revalidate invalidation on writes.',
    ],
  },
  {
    text: 'Are there any security concerns with storing auth tokens in localStorage vs HTTP-only cookies?',
    speaker: 'Speaker 3',
    mode: 'detailed',
    bullets: [
      'localStorage is vulnerable to XSS token theft through third-party scripts.',
      'HTTP-only cookies mitigate script access and protect session tokens.',
      'Combined with SameSite=Lax/Strict and CSRF tokens for full defense-in-depth.',
    ],
  },
];

@Component({
  selector: 'app-overlay',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './overlay.component.scss',
  templateUrl: './overlay.component.html',
})
export class OverlayComponent implements OnInit, OnDestroy {
  private readonly ipcService = inject(IpcService);
  private readonly transcriptContainer = viewChild<ElementRef<HTMLElement>>('transcriptContainer');

  // State Signals
  readonly isElectron = signal(this.ipcService.isElectron());
  readonly isListening = signal(true);
  readonly sessionSeconds = signal(872);
  readonly clickThroughActive = signal(false);
  readonly selectedMode = signal<'Short' | 'Detailed' | 'Simple'>('Short');
  readonly showHotkeys = signal(true);
  readonly toastMessage = signal<string | null>(null);
  readonly showConsentModal = signal(false);
  readonly overlayOpacity = signal<number>(0.88);
  readonly isSettingsOpen = signal(false);
  readonly overlayVersion = signal<'v1' | 'v2'>('v1');
  readonly multiWorkspace = signal<boolean>(true);
  readonly transcriptionMode = signal<TranscriptionMode>('other-only');
  readonly hasMicPermission = signal<boolean>(true);

  // Tab: 'questions' | 'transcript' | 'summary' (Milestones 2 & 7)
  readonly currentTab = signal<'questions' | 'transcript' | 'summary'>('questions');

  // Meeting Summary Signals (Milestone 7 / FR-52)
  readonly meetingSummary = signal<MeetingSummary | null>(null);
  readonly isGeneratingSummary = signal(false);
  readonly isExportingSummary = signal(false);

  // Transcript & Audio Signals (Milestone 2)
  readonly transcriptSegments = signal<TranscriptSegment[]>([]);
  readonly activeInterim = signal<TranscriptSegment | null>(null);
  readonly audioLevel = signal<number>(0);
  readonly sttProvider = signal<string>('Initializing STT...');

  // Custom Tooltip State (Smart non-clipping placement)
  readonly tooltipText = signal<string | null>(null);
  readonly tooltipPosition = signal<{ x: number; y: number }>({ x: 0, y: 0 });
  readonly tooltipPlacement = signal<'top' | 'bottom'>('bottom');
  readonly tooltipArrowOffset = signal<number>(0);

  // Set of collapsed question IDs
  readonly collapsedIds = signal<Set<string>>(new Set<string>());

  // Question List Signal
  readonly questions = signal<Question[]>([]);

  // Computed Properties
  readonly sortedQuestions = computed(() => {
    return [...this.questions()].sort((a, b) => {
      if (a.status === 'pinned' && b.status !== 'pinned') return -1;
      if (a.status !== 'pinned' && b.status === 'pinned') return 1;
      return b.askedAt - a.askedAt;
    });
  });

  readonly allCollapsed = computed(() => {
    const list = this.questions();
    if (list.length === 0) return false;
    const collapsed = this.collapsedIds();
    return list.every((q) => collapsed.has(q.id));
  });

  readonly latestSpeech = computed(() => {
    const interim = this.activeInterim();
    if (interim && interim.text && interim.text.trim().length > 0) {
      return {
        text: interim.text,
        speaker: interim.speaker || 'You',
        isLive: true,
      };
    }
    const segs = this.transcriptSegments();
    if (segs.length > 0) {
      const last = segs[segs.length - 1];
      return {
        text: last.text,
        speaker: last.speaker || 'You',
        isLive: false,
      };
    }
    return null;
  });

  // Telemetry Teleprompter Metrics (Milestone 5)
  readonly wordCount = computed(() => {
    return this.transcriptSegments().reduce(
      (acc, s) => acc + s.text.trim().split(/\s+/).filter(Boolean).length,
      0
    );
  });

  readonly sessionTimeFormatted = computed(() => {
    const totalSec = this.sessionSeconds();
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  });

  private timerInterval: any = null;
  private unsubscribeHotkey?: () => void;
  private unsubscribeAudioLevel?: () => void;
  private unsubscribeTranscript?: () => void;
  private unsubscribeQuestionNew?: () => void;
  private unsubscribeAnswerChunk?: () => void;
  private unsubscribeOverlayOpacity?: () => void;
  private unsubscribeSettingsVisibility?: () => void;
  private unsubscribeOverlayVersion?: () => void;
  private unsubscribeMultiWorkspace?: () => void;
  private unsubscribeTranscriptionMode?: () => void;

  private rawBufferMap = new Map<string, string>();
  private templateIndex = 0;

  ngOnInit(): void {
    const savedVer = localStorage.getItem('ql_overlay_version');
    if (savedVer === 'v1' || savedVer === 'v2') {
      this.overlayVersion.set(savedVer);
    }
    this.seedInitialQuestions();
    this.setupSessionTimer();
    this.setupIpcListeners();
    this.checkConsentStatus().catch((err) => {
      console.warn('[OverlayComponent] Consent status check error:', err);
    });
  }

  private async checkConsentStatus(): Promise<void> {
    try {
      const settings = await this.ipcService.getSettings();
      if (typeof settings.overlayOpacity === 'number') {
        this.overlayOpacity.set(settings.overlayOpacity);
      }
      if (settings.overlayVersion) {
        this.overlayVersion.set(settings.overlayVersion);
      }
      if (typeof settings.multiWorkspace === 'boolean') {
        this.multiWorkspace.set(settings.multiWorkspace);
      }
      if (settings.transcriptionMode) {
        this.transcriptionMode.set(settings.transcriptionMode);
      } else {
        const mode = await this.ipcService.getTranscriptionMode();
        this.transcriptionMode.set(mode);
      }
      const perms = await this.ipcService.getMacosPermissions();
      this.hasMicPermission.set(perms.microphone === 'granted');
      if (!settings.hasAcceptedConsent) {
        this.showConsentModal.set(true);
        this.isListening.set(false);
      }
    } catch (err) {
      console.warn('[OverlayComponent] Failed to verify consent status:', err);
    }
  }

  async confirmConsent(): Promise<void> {
    try {
      await this.ipcService.acceptConsent();
      this.showConsentModal.set(false);
      this.isListening.set(true);
      this.showToast('Consent recorded. Audio capture active.');
    } catch (err) {
      console.warn('[OverlayComponent] Failed to record consent:', err);
    }
  }

  ngOnDestroy(): void {
    if (this.timerInterval) clearInterval(this.timerInterval);
    if (this.unsubscribeHotkey) this.unsubscribeHotkey();
    if (this.unsubscribeAudioLevel) this.unsubscribeAudioLevel();
    if (this.unsubscribeTranscript) this.unsubscribeTranscript();
    if (this.unsubscribeQuestionNew) this.unsubscribeQuestionNew();
    if (this.unsubscribeAnswerChunk) this.unsubscribeAnswerChunk();
    if (this.unsubscribeOverlayOpacity) this.unsubscribeOverlayOpacity();
    if (this.unsubscribeSettingsVisibility) this.unsubscribeSettingsVisibility();
    if (this.unsubscribeOverlayVersion) this.unsubscribeOverlayVersion();
    if (this.unsubscribeMultiWorkspace) this.unsubscribeMultiWorkspace();
    if (this.unsubscribeTranscriptionMode) this.unsubscribeTranscriptionMode();
  }

  private seedInitialQuestions(): void {
    const now = Date.now();
    const initial: Question[] = [
      {
        id: 'q-1',
        sessionId: 'session-demo',
        text: SAMPLE_QUESTION_TEMPLATES[0].text,
        speaker: 'Speaker 1',
        askedAt: now - 15000,
        status: 'answered',
        answer: {
          questionId: 'q-1',
          mode: 'short',
          bullets: SAMPLE_QUESTION_TEMPLATES[0].bullets,
          code: SAMPLE_QUESTION_TEMPLATES[0].code,
          createdAt: now - 12000,
        },
      },
      {
        id: 'q-2',
        sessionId: 'session-demo',
        text: SAMPLE_QUESTION_TEMPLATES[1].text,
        speaker: 'Speaker 2',
        askedAt: now - 120000,
        status: 'answered',
        answer: {
          questionId: 'q-2',
          mode: 'detailed',
          bullets: SAMPLE_QUESTION_TEMPLATES[1].bullets,
          createdAt: now - 110000,
        },
      },
      {
        id: 'q-3',
        sessionId: 'session-demo',
        text: SAMPLE_QUESTION_TEMPLATES[2].text,
        speaker: 'Speaker 1',
        askedAt: now - 360000,
        status: 'pinned',
        answer: {
          questionId: 'q-3',
          mode: 'simple',
          bullets: SAMPLE_QUESTION_TEMPLATES[2].bullets,
          createdAt: now - 350000,
        },
      },
    ];

    this.questions.set(initial);
    this.collapsedIds.set(new Set(['q-2', 'q-3']));
    this.templateIndex = 3;
  }

  private setupSessionTimer(): void {
    this.timerInterval = setInterval(() => {
      this.sessionSeconds.update((s) => s + 1);
    }, 1000);
  }

  private setupIpcListeners(): void {
    if (this.isElectron()) {
      this.ipcService.getClickThrough().then((val) => {
        this.clickThroughActive.set(val);
      });

      this.ipcService.getSessionStatus().then((status) => {
        this.isListening.set(status.active);
        this.sttProvider.set(status.provider);
      });
    }

    // Global Hotkeys
    this.unsubscribeHotkey = this.ipcService.onHotkey((action: HotkeyAction) => {
      this.handleHotkeyAction(action);
    });

    // Reactive Overlay Opacity (live updates from Settings)
    this.unsubscribeOverlayOpacity = this.ipcService.onOverlayOpacityChanged((opacity: number) => {
      this.overlayOpacity.set(opacity);
    });

    // Settings Window Visibility (Toggle State)
    this.unsubscribeSettingsVisibility = this.ipcService.onSettingsVisibilityChanged((isOpen: boolean) => {
      this.isSettingsOpen.set(isOpen);
    });

    // Reactive Overlay Layout Version (live updates from Settings)
    this.unsubscribeOverlayVersion = this.ipcService.onOverlayVersionChanged((ver: 'v1' | 'v2') => {
      this.overlayVersion.set(ver);
      this.showToast(`Layout updated: ${ver === 'v2' ? 'Modern HUD (V2)' : 'Classic (V1)'}`);
    });

    // Reactive Multi-Workspace Persistence (live updates)
    this.unsubscribeMultiWorkspace = this.ipcService.onMultiWorkspaceChanged((enabled: boolean) => {
      this.multiWorkspace.set(enabled);
    });

    // Real-time Audio Level Meter (Milestone 2)
    this.unsubscribeAudioLevel = this.ipcService.onAudioLevel((level: number) => {
      this.audioLevel.set(level);
    });

    // Streaming Transcript Segments (Milestone 2)
    this.unsubscribeTranscript = this.ipcService.onTranscriptUpdate(
      (segment: TranscriptSegment) => {
        if (segment.isFinal) {
          this.activeInterim.set(null);
          // Ring buffer: limit transcript segments to 500 max for long 60+ min meetings
          this.transcriptSegments.update((prev) => {
            const next = [...prev, segment];
            return next.length > 500 ? next.slice(-500) : next;
          });
        } else {
          this.activeInterim.set(segment);
        }
        this.scrollToBottom();
      }
    );

    // Detected Spoken Questions (Milestone 3)
    this.unsubscribeQuestionNew = this.ipcService.onQuestionNew((newQuestion: Question) => {
      this.handleNewQuestion(newQuestion);
    });

    // Streamed Answer Chunks (Milestone 3)
    this.unsubscribeAnswerChunk = this.ipcService.onAnswerChunk((chunk: AnswerChunk) => {
      this.handleAnswerChunk(chunk);
    });

    // Reactive Transcription Mode (Mode A: Other Only vs Mode B: Everyone)
    this.unsubscribeTranscriptionMode = this.ipcService.onTranscriptionModeChanged((mode) => {
      this.transcriptionMode.set(mode);
    });
  }

  async toggleTranscriptionMode(): Promise<void> {
    const nextMode = this.transcriptionMode() === 'other-only' ? 'everyone' : 'other-only';
    this.transcriptionMode.set(nextMode);
    await this.ipcService.setTranscriptionMode(nextMode);
    this.showToast(
      nextMode === 'other-only'
        ? 'Mode: Other Participant Only (Mic Muted)'
        : 'Mode: Everyone (Meeting Audio + Microphone)'
    );
  }

  private handleNewQuestion(question: Question): void {
    // Add new question to top of feed with 50-item bounding
    this.questions.update((prev) => {
      const updated = [
        {
          ...question,
          status: 'answering' as const,
          answer: {
            questionId: question.id,
            mode: this.selectedMode().toLowerCase() as 'short' | 'detailed' | 'simple',
            bullets: [],
            createdAt: Date.now(),
          },
        },
        ...prev,
      ];

      // Evict oldest unpinned if exceeding 50 items
      if (updated.length > 50) {
        for (let i = updated.length - 1; i >= 0; i--) {
          if (updated[i].status !== 'pinned') {
            this.rawBufferMap.delete(updated[i].id);
            updated.splice(i, 1);
            break;
          }
        }
      }

      return updated;
    });

    // Ensure expanded
    this.collapsedIds.update((set) => {
      const copy = new Set(set);
      copy.delete(question.id);
      return copy;
    });

    // Switch to questions tab and notify
    this.currentTab.set('questions');
    this.showToast('Spoken question detected!');
  }

  private handleAnswerChunk(chunk: AnswerChunk): void {
    const existing = this.rawBufferMap.get(chunk.questionId) || '';
    const updated = existing + chunk.delta;
    this.rawBufferMap.set(chunk.questionId, updated);

    // Extract bullet points from accumulated text
    const lines = updated.split('\n').filter((l) => l.trim().length > 0);
    const bullets = lines
      .map((l) => l.replace(/^[•\-\*]\s*/, '').trim())
      .filter((b) => b.length > 0);

    this.questions.update((list) =>
      list.map((q) => {
        if (q.id === chunk.questionId) {
          const isComplete = Boolean(chunk.isComplete);
          return {
            ...q,
            status: isComplete
              ? q.status === 'pinned'
                ? 'pinned'
                : 'answered'
              : 'answering',
            answer: {
              questionId: q.id,
              mode: chunk.mode || q.answer?.mode || 'short',
              bullets: bullets.length > 0 ? bullets : q.answer?.bullets || [],
              code: chunk.code || q.answer?.code,
              createdAt: q.answer?.createdAt || Date.now(),
            },
          };
        }
        return q;
      })
    );
  }

  async regenerateAnswer(q: Question): Promise<void> {
    const mode = this.selectedMode().toLowerCase() as 'short' | 'detailed' | 'simple';
    this.rawBufferMap.delete(q.id);

    this.questions.update((list) =>
      list.map((item) => {
        if (item.id === q.id) {
          return {
            ...item,
            status: 'answering',
            answer: {
              questionId: item.id,
              mode,
              bullets: [],
              createdAt: Date.now(),
            },
          };
        }
        return item;
      })
    );

    this.showToast(`Regenerating answer (${mode})...`);

    if (this.isElectron()) {
      await this.ipcService.regenerateAnswer({ questionId: q.id, mode });
    } else {
      // Local demo fallback for browser testing
      setTimeout(() => {
        this.questions.update((list) =>
          list.map((item) => {
            if (item.id === q.id) {
              return {
                ...item,
                status: 'answered',
                answer: {
                  questionId: item.id,
                  mode,
                  bullets: [
                    `Regenerated point 1 in ${mode} mode.`,
                    `Regenerated point 2 with direct talking advice.`,
                    `Regenerated point 3 with clear meeting guidance.`,
                  ],
                  createdAt: Date.now(),
                },
              };
            }
            return item;
          })
        );
      }, 600);
    }
  }

  private scrollToBottom(): void {
    const el = this.transcriptContainer()?.nativeElement;
    if (el) {
      setTimeout(() => {
        el.scrollTop = el.scrollHeight;
      }, 50);
    }
  }

  private handleHotkeyAction(action: HotkeyAction): void {
    switch (action) {
      case 'toggle-click-through':
        this.clickThroughActive.update((prev) => !prev);
        this.showToast(
          this.clickThroughActive()
            ? 'Click-through enabled'
            : 'Click-through disabled'
        );
        break;

      case 'clear':
        if (this.currentTab() === 'transcript') {
          this.clearTranscript();
        } else {
          this.clearUnpinnedQuestions();
        }
        break;

      case 'pin':
        this.pinTopQuestion();
        break;

      case 'copy-answer':
        this.copyTopAnswer();
        break;

      case 'regenerate':
        this.regenerateTopQuestion();
        break;

      default:
        break;
    }
  }

  regenerateTopQuestion(): void {
    const sorted = this.sortedQuestions();
    if (sorted.length > 0) {
      this.regenerateAnswer(sorted[0]);
    }
  }

  async openSettings(): Promise<void> {
    const isOpen = await this.ipcService.openSettings();
    if (typeof isOpen === 'boolean') {
      this.isSettingsOpen.set(isOpen);
    }
  }

  toggleOverlayVersion(): void {
    const next = this.overlayVersion() === 'v1' ? 'v2' : 'v1';
    this.overlayVersion.set(next);
    localStorage.setItem('ql_overlay_version', next);
    this.showToast(`Switched to ${next === 'v2' ? 'New V2' : 'Classic V1'} Layout`);
  }

  async toggleMultiWorkspace(): Promise<void> {
    const nextVal = !this.multiWorkspace();
    this.multiWorkspace.set(nextVal);
    await this.ipcService.setMultiWorkspace(nextVal);
    this.showToast(
      nextVal
        ? 'Multi-Workspace: Visible across all spaces'
        : 'Single Workspace: Pinned to this space'
    );
  }

  async toggleClickThrough(): Promise<void> {
    const nextVal = !this.clickThroughActive();
    if (this.isElectron()) {
      await this.ipcService.setClickThrough(nextVal);
    }
    this.clickThroughActive.set(nextVal);
    this.showToast(
      nextVal
        ? 'Click-through enabled (⌘⇧M to disable)'
        : 'Click-through disabled'
    );
  }

  async toggleSessionListening(): Promise<void> {
    const nextState = !this.isListening();
    if (nextState) {
      await this.ipcService.startSession();
      this.isListening.set(true);
      this.showToast('Audio session listening');
    } else {
      await this.ipcService.stopSession();
      this.isListening.set(false);
      this.showToast('Audio session paused');
    }
  }

  async clearTranscript(): Promise<void> {
    this.transcriptSegments.set([]);
    this.activeInterim.set(null);
    if (this.isElectron()) {
      await this.ipcService.clearTranscript();
    }
    this.showToast('Transcript cleared');
  }

  cycleAnswerMode(): void {
    const modes: Array<'Short' | 'Detailed' | 'Simple'> = ['Short', 'Detailed', 'Simple'];
    const current = this.selectedMode();
    const next = modes[(modes.indexOf(current) + 1) % modes.length];
    this.selectedMode.set(next);
    this.showToast(`Mode set to: ${next}`);
  }

  simulateNewQuestion(): void {
    const template =
      SAMPLE_QUESTION_TEMPLATES[this.templateIndex % SAMPLE_QUESTION_TEMPLATES.length];
    this.templateIndex++;

    const newId = `q-${Date.now()}`;
    const newQuestion: Question = {
      id: newId,
      sessionId: 'session-demo',
      text: template.text,
      speaker: template.speaker || 'Speaker 1',
      askedAt: Date.now(),
      status: 'new',
      answer: {
        questionId: newId,
        mode: template.mode,
        bullets: template.bullets,
        code: template.code,
        createdAt: Date.now(),
      },
    };

    this.questions.update((prev) => [newQuestion, ...prev]);

    this.collapsedIds.update((set) => {
      const copy = new Set(set);
      copy.delete(newId);
      return copy;
    });

    this.showToast('New question simulated');
  }

  togglePin(id: string): void {
    this.questions.update((list) =>
      list.map((q) => {
        if (q.id === id) {
          const nextStatus = q.status === 'pinned' ? 'answered' : 'pinned';
          return { ...q, status: nextStatus };
        }
        return q;
      })
    );
  }

  pinTopQuestion(): void {
    const sorted = this.sortedQuestions();
    if (sorted.length > 0) {
      const top = sorted[0];
      this.togglePin(top.id);
      this.showToast(top.status === 'pinned' ? 'Question unpinned' : 'Question pinned');
    }
  }

  copyTopAnswer(): void {
    const sorted = this.sortedQuestions();
    if (sorted.length > 0) {
      this.copyAnswer(sorted[0]);
    }
  }

  async copyAnswer(question: Question): Promise<void> {
    if (!question.answer) return;

    const formatted = [
      `Q: ${question.text}`,
      '',
      'Talking Points:',
      ...question.answer.bullets.map((b) => `• ${b}`),
      ...(question.answer.code ? ['', 'Snippet:', question.answer.code] : []),
    ].join('\n');

    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(formatted);
      }
      this.showToast('Answer copied to clipboard!');
    } catch {
      this.showToast('Could not access clipboard');
    }
  }

  dismissQuestion(id: string): void {
    this.rawBufferMap.delete(id);
    this.questions.update((list) => list.filter((q) => q.id !== id));
    this.collapsedIds.update((set) => {
      const copy = new Set(set);
      copy.delete(id);
      return copy;
    });
  }

  clearUnpinnedQuestions(): void {
    const unpinned = this.questions().filter((q) => q.status !== 'pinned');
    for (const q of unpinned) {
      this.rawBufferMap.delete(q.id);
    }
    this.questions.update((list) => list.filter((q) => q.status === 'pinned'));
    this.showToast('Cleared questions');
  }

  toggleCollapse(id: string): void {
    this.collapsedIds.update((set) => {
      const copy = new Set(set);
      if (copy.has(id)) {
        copy.delete(id);
      } else {
        copy.add(id);
      }
      return copy;
    });
  }

  toggleCollapseAll(): void {
    if (this.allCollapsed()) {
      this.collapsedIds.set(new Set());
    } else {
      const allIds = this.questions().map((q) => q.id);
      this.collapsedIds.set(new Set(allIds));
    }
  }

  isCollapsed(id: string): boolean {
    return this.collapsedIds().has(id);
  }

  formatRelativeTime(timestamp: number): string {
    const diffSec = Math.floor((Date.now() - timestamp) / 1000);
    if (diffSec < 20) return 'Just now';
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    return `${Math.floor(diffMin / 60)}h ago`;
  }

  formatSegmentTime(startMs: number): string {
    const totalSecs = Math.floor(startMs / 1000);
    const mins = Math.floor(totalSecs / 60)
      .toString()
      .padStart(2, '0');
    const secs = (totalSecs % 60).toString().padStart(2, '0');
    return `${mins}:${secs}`;
  }

  // Post-Meeting Summary & Action Items (Milestone 7 / FR-52)
  async loadOrGenerateSummary(): Promise<void> {
    this.currentTab.set('summary');
    if (!this.meetingSummary()) {
      await this.generateMeetingSummary();
    }
  }

  async generateMeetingSummary(): Promise<void> {
    this.isGeneratingSummary.set(true);
    try {
      const summary = await this.ipcService.generateMeetingSummary();
      this.meetingSummary.set(summary);
      this.showToast('Meeting summary generated!');
    } catch (err) {
      console.warn('[OverlayComponent] Failed to generate meeting summary:', err);
      this.showToast('Failed to generate meeting summary.');
    } finally {
      this.isGeneratingSummary.set(false);
    }
  }

  async exportMeetingSummary(): Promise<void> {
    const summary = this.meetingSummary();
    if (!summary) return;

    this.isExportingSummary.set(true);
    try {
      const success = await this.ipcService.exportMeetingSummary(summary.markdown);
      if (success) {
        this.showToast('Summary exported to Markdown file.');
      }
    } catch (err) {
      console.warn('[OverlayComponent] Failed exporting meeting summary:', err);
      this.showToast('Failed to export summary file.');
    } finally {
      this.isExportingSummary.set(false);
    }
  }

  async copySummaryMarkdown(): Promise<void> {
    const summary = this.meetingSummary();
    if (!summary) return;

    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(summary.markdown);
      }
      this.showToast('Summary markdown copied to clipboard!');
    } catch {
      this.showToast('Could not access clipboard.');
    }
  }

  // Adjust Overlay Width & Length (Height)
  private isResizing = false;
  private startX = 0;
  private startY = 0;
  private startWidth = 380;
  private startHeight = 600;

  async onResizePointerDown(event: PointerEvent): Promise<void> {
    if (!this.isElectron()) return;
    event.preventDefault();
    event.stopPropagation();

    this.isResizing = true;
    this.startX = event.screenX;
    this.startY = event.screenY;

    try {
      const currentSize = await this.ipcService.getOverlaySize();
      this.startWidth = currentSize.width;
      this.startHeight = currentSize.height;
    } catch {
      this.startWidth = window.outerWidth || 380;
      this.startHeight = window.outerHeight || 600;
    }

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (!this.isResizing) return;
      const deltaX = moveEvent.screenX - this.startX;
      const deltaY = moveEvent.screenY - this.startY;
      const newWidth = Math.max(300, Math.round(this.startWidth + deltaX));
      const newHeight = Math.max(400, Math.round(this.startHeight + deltaY));
      this.ipcService.setOverlaySize(newWidth, newHeight);
    };

    const onPointerUp = () => {
      this.isResizing = false;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  }

  showToast(message: string): void {
    this.toastMessage.set(message);
    setTimeout(() => {
      if (this.toastMessage() === message) {
        this.toastMessage.set(null);
      }
    }, 2500);
  }

  @HostListener('window:keydown', ['$event'])
  handleKeyboardNavigation(event: KeyboardEvent): void {
    // Avoid moving the window if the user is typing in an input or textarea
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable)
    ) {
      return;
    }

    let deltaX = 0;
    let deltaY = 0;
    const step = event.shiftKey ? 40 : 10;

    switch (event.key) {
      case 'ArrowUp':
        deltaY = -step;
        break;
      case 'ArrowDown':
        deltaY = step;
        break;
      case 'ArrowLeft':
        deltaX = -step;
        break;
      case 'ArrowRight':
        deltaX = step;
        break;
      default:
        return;
    }

    // Suppress default window scroll behavior
    event.preventDefault();
    this.ipcService.moveOverlay(deltaX, deltaY).catch((err) => {
      console.warn('[OverlayComponent] Failed to move overlay window:', err);
    });
  }

  showTooltip(event: MouseEvent, text: string): void {
    const target = event.currentTarget as HTMLElement;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const winW = window.innerWidth;
    const winH = window.innerHeight;

    // Check vertical clearance:
    // If rect.top is tight (< 45px) or space below is greater than space above, place below.
    const spaceAbove = rect.top;
    const spaceBelow = winH - rect.bottom;
    const placement: 'top' | 'bottom' = (spaceAbove < 45 && spaceBelow >= 35) || spaceBelow > spaceAbove
      ? 'bottom'
      : 'top';

    // Target element's horizontal center
    const buttonCenterX = rect.left + rect.width / 2;

    // Ensure the tooltip's center doesn't push its edges off screen
    // Keep at least 80px from window left and right borders
    const minCenterX = 80;
    const maxCenterX = Math.max(minCenterX, winW - 80);
    const clampedX = Math.max(minCenterX, Math.min(maxCenterX, buttonCenterX));

    // Arrow offset: points at buttonCenterX even when clamped
    const rawOffset = buttonCenterX - clampedX;
    const arrowOffset = Math.max(-65, Math.min(65, rawOffset));

    const y = placement === 'bottom' ? rect.bottom + 8 : rect.top - 8;

    this.tooltipPlacement.set(placement);
    this.tooltipPosition.set({ x: Math.round(clampedX), y: Math.round(y) });
    this.tooltipArrowOffset.set(Math.round(arrowOffset));
    this.tooltipText.set(text);
  }

  hideTooltip(): void {
    this.tooltipText.set(null);
  }
}
