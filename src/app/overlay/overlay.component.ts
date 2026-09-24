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
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { highlightLeetCodeSnippet, getLineNumbersList, detectCodeLanguage } from '../core/syntax-highlighter';
import { IpcService } from '../core/ipc.service';
import {
  Question,
  HotkeyAction,
  TranscriptSegment,
  SpeakerTurn,
  AnswerChunk,
  MeetingSummary,
  TranscriptionMode,
  AnswerMode,
  AppSettings,
  ScreenVisionStatus,
} from '@shared/ipc';

type AnswerModeLabel = 'Short' | 'Detailed' | 'Simple';

const ANSWER_MODE_TO_LABEL: Record<AnswerMode, AnswerModeLabel> = {
  short: 'Short',
  detailed: 'Detailed',
  simple: 'Simple',
};

const ANSWER_MODE_FROM_LABEL: Record<AnswerModeLabel, AnswerMode> = {
  Short: 'short',
  Detailed: 'detailed',
  Simple: 'simple',
};

interface ParsedAnswer {
  bullets: string[];
  code?: string;
}

/**
 * Parses streamed answer text into bullet lines and fenced code blocks. Text
 * outside ``` fences becomes bullets (markdown heading/bold markers stripped);
 * code inside fences is collected into a single snippet so coding and
 * system-design answers are not shredded into one bullet per line.
 */
function parseAnswerMarkdown(raw: string): ParsedAnswer {
  const text = raw || '';
  const codeParts: string[] = [];
  let prose = '';
  let lastIndex = 0;
  const fenceRe = /```[^\n]*\n?([\s\S]*?)(?:```|$)/g;
  let match: RegExpExecArray | null;

  while ((match = fenceRe.exec(text)) !== null) {
    prose += text.slice(lastIndex, match.index) + '\n';
    const block = match[1].replace(/\s+$/, '');
    if (block.trim()) codeParts.push(block);
    lastIndex = fenceRe.lastIndex;
  }
  prose += text.slice(lastIndex);

  const bullets = prose
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) =>
      line
        .replace(/^#{1,6}\s*/, '')
        .replace(/^[•\-\*]\s*/, '')
        .replace(/\*\*/g, '')
        .replace(/`/g, '')
        .trim()
    )
    .filter((line) => line.length > 0);

  return { bullets, code: codeParts.length > 0 ? codeParts.join('\n\n') : undefined };
}

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

/**
 * Returns the portion of the live interim transcript not already present in the
 * finalized row text, using word-aligned overlap detection. Lets a single row
 * grow (finalized text + live tail + cursor) instead of showing a second row.
 */
function liveInterimTail(finalText: string, interimText: string): string {
  const base = (finalText || '').trim();
  const interim = (interimText || '').trim();
  if (!interim) return '';
  if (!base) return interim;
  if (base.toLowerCase().endsWith(interim.toLowerCase())) return '';

  const baseWords = base.split(/\s+/);
  const interimWords = interim.split(/\s+/);
  const maxOverlap = Math.min(baseWords.length, interimWords.length);
  for (let n = maxOverlap; n > 0; n--) {
    const baseSuffix = baseWords.slice(baseWords.length - n).join(' ').toLowerCase();
    const interimPrefix = interimWords.slice(0, n).join(' ').toLowerCase();
    if (baseSuffix === interimPrefix) {
      return interimWords.slice(n).join(' ');
    }
  }

  if (base.toLowerCase().includes(interim.toLowerCase())) return '';
  return interim;
}

@Component({
  selector: 'app-overlay',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './overlay.component.scss',
  templateUrl: './overlay.component.html',
})
export class OverlayComponent implements OnInit, OnDestroy {
  private readonly ipcService = inject(IpcService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly transcriptContainer = viewChild<ElementRef<HTMLElement>>('transcriptContainer');
  private readonly highlightedCodeCache = new Map<string, SafeHtml>();

  // State Signals
  readonly isElectron = signal(this.ipcService.isElectron());
  readonly isListening = signal(true);
  readonly sessionSeconds = signal(0);
  readonly clickThroughActive = signal(false);
  readonly selectedMode = signal<'Short' | 'Detailed' | 'Simple'>('Short');
  readonly showHotkeys = signal(true);
  readonly toastMessage = signal<string | null>(null);
  readonly showConsentModal = signal(false);
  readonly overlayOpacity = signal<number>(0.88);
  readonly isSettingsOpen = signal(false);
  readonly overlayVersion = signal<'v1' | 'v2'>('v1');
  readonly multiWorkspace = signal<boolean>(true);
  readonly transcriptionMode = signal<TranscriptionMode>('everyone');
  readonly hasMicPermission = signal<boolean>(true);
  readonly isMacOS = typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent || navigator.platform);

  // Tab: 'questions' | 'transcript' | 'screenvision' | 'summary' (Milestones 2, 7 & ScreenVision)
  readonly currentTab = signal<'questions' | 'transcript' | 'screenvision' | 'summary'>('questions');

  // Meeting Summary Signals (Milestone 7 / FR-52)
  readonly meetingSummary = signal<MeetingSummary | null>(null);
  readonly isGeneratingSummary = signal(false);
  readonly isExportingSummary = signal(false);

  // Transcript & Audio Signals (Milestone 2)
  readonly transcriptSegments = signal<TranscriptSegment[]>([]);
  readonly activeInterim = signal<TranscriptSegment | null>(null);
  readonly audioLevel = signal<number>(0);
  readonly sttProvider = signal<string>('Initializing STT...');
  readonly sttModel = signal<string>('');
  readonly answeringSegmentIds = signal<Set<string>>(new Set<string>());
  readonly answeredSegmentIds = signal<Set<string>>(new Set<string>());
  readonly activeLiveText = signal<string>('');
  readonly activeLiveSpeaker = signal<string>('');
  readonly isSpeaking = signal<boolean>(false);
  /**
   * Fresh, not-yet-final row. Created automatically after Give Answer (and on
   * the first speech of a session) and filled by the next utterance. Rendered
   * like a normal row but with a disabled Give Answer button until it finalizes.
   */
  readonly draftRow = signal<TranscriptSegment | null>(null);

  // Custom Tooltip State (Smart non-clipping placement)
  readonly tooltipText = signal<string | null>(null);
  readonly tooltipPosition = signal<{ x: number; y: number }>({ x: 0, y: 0 });
  readonly tooltipPlacement = signal<'top' | 'bottom'>('bottom');
  readonly tooltipArrowOffset = signal<number>(0);

  // Set of collapsed question IDs
  readonly collapsedIds = signal<Set<string>>(new Set<string>());

  // Set of question IDs with expanded source context (other speech, your speech, OCR text)
  readonly expandedContextIds = signal<Set<string>>(new Set<string>());

  // ScreenVision Status & OCR Signals
  readonly screenVisionStatus = signal<ScreenVisionStatus | null>(null);
  readonly isScanningScreen = signal<boolean>(false);

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

  readonly displayedTranscriptSegments = computed(() => {
    const segs = this.transcriptSegments();
    if (this.transcriptionMode() === 'other-only') {
      return segs.filter((s) => s.speaker !== 'You');
    }
    return segs;
  });

  readonly displayedInterim = computed(() => {
    const interim = this.activeInterim();
    if (!interim) return null;
    if (this.transcriptionMode() === 'other-only' && interim.speaker === 'You') {
      return null;
    }
    return interim;
  });

  /** Id of the final row still accumulating speech, so it can host the live cursor. */
  readonly activeTranscriptRowId = computed(() => {
    // A pending draft row owns the live text; the previous row stops accumulating.
    if (this.draftRow()) return null;
    const segs = this.displayedTranscriptSegments();
    const last = segs[segs.length - 1];
    if (!last) return null;
    if (this.answeredSegmentIds().has(last.id) || this.answeringSegmentIds().has(last.id)) {
      return null;
    }
    return last.id;
  });

  /** Live-typing tail appended inline to the active final row. */
  readonly inlineInterimTail = computed(() => {
    const interim = this.displayedInterim();
    if (!interim) return '';
    const segs = this.displayedTranscriptSegments();
    const last = segs[segs.length - 1];
    if (!last || last.id !== this.activeTranscriptRowId()) return '';
    return liveInterimTail(last.text, interim.text);
  });

  /** The draft row, unless the current mode filters out its speaker. */
  readonly displayedDraftRow = computed(() => {
    const draft = this.draftRow();
    if (!draft) return null;
    if (this.transcriptionMode() === 'other-only' && draft.speaker === 'You') {
      return null;
    }
    return draft;
  });

  readonly displayedLiveText = computed(() => {    if (this.transcriptionMode() === 'other-only' && this.activeLiveSpeaker() === 'You') {
      return '';
    }
    return this.activeLiveText();
  });

  readonly isLatestRowAnswered = computed(() => {
    const segs = this.displayedTranscriptSegments();
    if (segs.length === 0) return true;
    const last = segs[segs.length - 1];
    return this.answeredSegmentIds().has(last.id) || this.answeringSegmentIds().has(last.id);
  });

  readonly latestSpeech = computed(() => {
    const interim = this.displayedInterim();
    if (interim && interim.text && interim.text.trim().length > 0) {
      return {
        text: interim.text,
        speaker: interim.speaker || (this.transcriptionMode() === 'other-only' ? 'Other' : 'You'),
        isLive: true,
      };
    }
    const segs = this.displayedTranscriptSegments();
    if (segs.length > 0) {
      const last = segs[segs.length - 1];
      return {
        text: last.text,
        speaker: last.speaker || (this.transcriptionMode() === 'other-only' ? 'Other' : 'You'),
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
  private unsubscribeSettingsChanged?: () => void;
  private unsubscribeTranscriptClear?: () => void;
  private unsubscribeScreenVisionStatus?: () => void;
  private lastShiftTime = 0;

  private rawBufferMap = new Map<string, string>();
  private templateIndex = 0;

  ngOnInit(): void {
    const savedVer = localStorage.getItem('ql_overlay_version');
    if (savedVer === 'v1' || savedVer === 'v2') {
      this.overlayVersion.set(savedVer);
    }
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
      if (settings.answerMode && ANSWER_MODE_TO_LABEL[settings.answerMode]) {
        this.selectedMode.set(ANSWER_MODE_TO_LABEL[settings.answerMode]);
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
    if (this.unsubscribeSettingsChanged) this.unsubscribeSettingsChanged();
    if (this.unsubscribeTranscriptClear) this.unsubscribeTranscriptClear();
    if (this.unsubscribeScreenVisionStatus) this.unsubscribeScreenVisionStatus();
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
          totalTokens: 342,
          inputTokens: 218,
          outputTokens: 124,
          createdAt: now - 12000,
        },
        contextSnapshot: {
          otherText: 'How does the retry logic and backoff work in the payment pipeline?',
          userText: 'We use jittered exponential backoff with a circuit breaker probe.',
          finalPrompt: '[SYSTEM INSTRUCTIONS]\nYou are MeetVision AI, a senior engineer answering a CODING / DSA question in real time.\n- Approach: 2-4 bullets explaining the algorithm.\n- Code: exactly ONE complete solution inside a fenced block.\n\n[USER CONTEXT & TARGET QUESTION]\nQuestion asked: "How does the retry logic and exponential backoff work in the payment flow?"',
          capturedAt: now - 15000,
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
          totalTokens: 485,
          inputTokens: 290,
          outputTokens: 195,
          createdAt: now - 110000,
        },
        contextSnapshot: {
          otherText: 'What is the rollout schedule and canary plan for the v2 migration?',
          finalPrompt: '[SYSTEM INSTRUCTIONS]\nYou are MeetVision AI, a senior software architect answering a SYSTEM DESIGN question.\n\n[USER CONTEXT & TARGET QUESTION]\nQuestion asked: "What\'s the rollout schedule and canary plan for the v2 migration?"',
          capturedAt: now - 120000,
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
          totalTokens: 260,
          inputTokens: 175,
          outputTokens: 85,
          createdAt: now - 350000,
        },
        contextSnapshot: {
          otherText: 'What fallback triggers if KYC verification times out?',
          finalPrompt: '[SYSTEM INSTRUCTIONS]\nYou are MeetVision AI answering a question in simple mode.\n\n[USER CONTEXT & TARGET QUESTION]\nQuestion asked: "What fallback triggers if the KYC verification service times out?"',
          capturedAt: now - 360000,
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
    }

    this.ipcService.getSessionStatus().then((status) => {
      this.isListening.set(status.active);
      this.sttProvider.set(status.provider);
      if (status.model) {
        this.sttModel.set(status.model);
      }
    }).catch(() => {});

    // Reactive App Settings changed (e.g. user selected new engine/model in Settings panel and clicked Save)
    this.unsubscribeSettingsChanged = this.ipcService.onSettingsChanged(async (settings: AppSettings) => {
      try {
        if (settings?.answerMode && ANSWER_MODE_TO_LABEL[settings.answerMode]) {
          this.selectedMode.set(ANSWER_MODE_TO_LABEL[settings.answerMode]);
        }
        const status = await this.ipcService.getSessionStatus();
        this.sttProvider.set(status.provider);
        this.sttModel.set(status.model || '');
        const modelLabel = status.model ? `${status.model} (${status.provider})` : status.provider;
        this.showToast(`Active STT Model: ${modelLabel}`);
      } catch (err) {
        console.warn('[OverlayComponent] Failed to refresh STT session status after settings changed:', err);
      }
    });

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

    // Streaming Transcript Segments (Milestone 2) with deduplication & row accumulation until Give Answer
    this.unsubscribeTranscript = this.ipcService.onTranscriptUpdate(
      (segment: TranscriptSegment) => {
        if (segment.isFinal) {
          this.activeInterim.set(null);
          this.activeLiveText.set('');
          this.isSpeaking.set(false);
          const text = segment.text ? segment.text.trim() : '';
          if (!text) return;

          const draft = this.draftRow();

          this.transcriptSegments.update((prev) => {
            // Deduplicate exact repeat by segment ID
            if (prev.some((s) => s.id === segment.id)) {
              return prev;
            }

            const last = prev[prev.length - 1];
            // Check if latest row has already been answered (or answering)
            const isLastAnswered =
              last &&
              (this.answeredSegmentIds().has(last.id) || this.answeringSegmentIds().has(last.id));

            // Append to the active row unless a new draft row has been requested.
            if (last && !isLastAnswered && !draft) {
              const currentSpeaker = segment.speaker || 'Other';

              // Initialize turns array if not yet present
              const existingTurns: SpeakerTurn[] = last.turns
                ? [...last.turns]
                : [{ speaker: last.speaker || 'Other', text: last.text, timestamp: last.startMs }];

              const lastTurn = existingTurns[existingTurns.length - 1];

              if (lastTurn && lastTurn.speaker === currentSpeaker) {
                // Same speaker continues speaking: append to the current turn
                if (lastTurn.text.toLowerCase().endsWith(text.toLowerCase()) || lastTurn.text.includes(text)) {
                  return prev;
                }

                let base = lastTurn.text.trim();
                let addition = text.trim();

                const isContinuation =
                  /^[a-z]/.test(addition) ||
                  /^(and|but|so|because|which|that|to|for|or|also|then|with|as|if|when)\b/i.test(addition);

                if (isContinuation && base.endsWith('.')) {
                  base = base.slice(0, -1).trim();
                }

                lastTurn.text = `${base} ${addition}`.trim();
              } else {
                // Different speaker responded in the same conversation! Add as a separate turn
                existingTurns.push({
                  speaker: currentSpeaker,
                  text: text.trim(),
                  timestamp: segment.startMs,
                });
              }

              // The row's full text is the combined conversation of all turns
              const combinedText = existingTurns
                .map((t) => `${t.speaker === 'You' ? 'You' : 'Other Attendee'}: ${t.text}`)
                .join('\n');

              const updatedLast: TranscriptSegment = {
                ...last,
                text: combinedText,
                endMs: segment.endMs || Date.now(),
                turns: existingTurns,
              };
              return [...prev.slice(0, -1), updatedLast];
            }

            // Otherwise start a brand new row. If a draft row was showing, keep
            // its id/start time so the live row seamlessly becomes the final row.
            const initialSpeaker = segment.speaker || 'Other';
            const next = [
              ...prev,
              {
                ...segment,
                id: draft?.id ?? segment.id,
                startMs: draft?.startMs ?? segment.startMs,
                text,
                turns: [{ speaker: initialSpeaker, text, timestamp: segment.startMs }],
              },
            ];
            return next.length > 500 ? next.slice(-500) : next;
          });

          this.draftRow.set(null);
        } else {
          const raw = segment.text ? segment.text.trim() : '';
          // Engine placeholder text ('Listening...', '...') carries no decoded
          // words; keep the speaker so the live cursor renders on the active row.
          const isEmpty = !raw || raw === '...' || raw === 'Listening...';
          this.activeInterim.set({ ...segment, text: isEmpty ? '' : raw });
          this.activeLiveText.set(isEmpty ? '' : raw);
          this.activeLiveSpeaker.set(segment.speaker || this.activeLiveSpeaker());
          this.isSpeaking.set(true);

          // With an active accumulating row the interim merges inline; otherwise
          // it fills the draft row (created after Give Answer, or on first speech).
          if (this.activeTranscriptRowId() === null) {
            if (this.transcriptionMode() !== 'other-only' || segment.speaker !== 'You') {
              const base = this.draftRow();
              this.draftRow.set({
                id: base && base.text.trim().length > 0 ? base.id : segment.id,
                text: isEmpty ? base?.text ?? '' : raw,
                isFinal: false,
                startMs: base?.startMs ?? segment.startMs,
                endMs: segment.endMs || Date.now(),
                speaker: segment.speaker || base?.speaker,
              });
            }
          } else if (this.draftRow()) {
            this.draftRow.set(null);
          }
        }
        this.scrollToBottom();
      }
    );

    // Active Meeting Session Reset
    this.unsubscribeTranscriptClear = this.ipcService.onTranscriptClear(() => {
      this.transcriptSegments.set([]);
      this.draftRow.set(null);
      this.activeInterim.set(null);
      this.activeLiveText.set('');
      this.activeLiveSpeaker.set('');
      this.isSpeaking.set(false);
      this.questions.set([]);
      this.answeringSegmentIds.set(new Set());
      this.answeredSegmentIds.set(new Set());
      this.sessionSeconds.set(0);
      this.rawBufferMap.clear();
      this.showToast('Session reset. Ready for meeting speech.');
    });

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

    // ScreenVision Status
    this.ipcService.getScreenVisionStatus().then((status) => {
      if (status) {
        this.screenVisionStatus.set(status);
      }
    }).catch(() => {});

    this.unsubscribeScreenVisionStatus = this.ipcService.onScreenVisionStatusChanged((status) => {
      this.screenVisionStatus.set(status);
    });
  }

  async scanScreenNow(): Promise<void> {
    if (this.isScanningScreen()) return;
    this.isScanningScreen.set(true);
    try {
      const res = await this.ipcService.captureScreenVisionNow();
      if (res && res.success) {
        this.showToast(`👁️ ScreenVision: extracted ${res.wordCount} words`);
      } else {
        this.showToast(res?.error || 'Screen capture failed');
      }
    } catch (err: any) {
      this.showToast(err?.message || 'Screen capture error');
    } finally {
      this.isScanningScreen.set(false);
    }
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
    const existing = this.questions().some((q) => q.id === question.id);

    if (existing) {
      // The same question is re-announced when answer generation starts (after
      // detection). Update it in place: duplicate ids would break the
      // `@for (... track q.id)` rendering and hide the streamed answer.
      this.questions.update((list) =>
        list.map((q) => {
          if (q.id !== question.id) return q;
          const status: Question['status'] = q.status === 'pinned' ? 'pinned' : question.status;
          const needsAnswer = status === 'answering' || status === 'answered';
          return {
            ...q,
            ...question,
            status,
            answer:
              q.answer ??
              (needsAnswer
                ? {
                    questionId: q.id,
                    mode: this.selectedMode().toLowerCase() as 'short' | 'detailed' | 'simple',
                    bullets: [],
                    createdAt: Date.now(),
                  }
                : undefined),
          };
        })
      );

      // Keep current tab stable so transcript rows remain visible and uninterrupted
      return;
    }

    // New question: prepend to the feed with 50-item bounding. Preserve the
    // status the main process sent ('unanswered' on detection, 'answering' when
    // generation has already started).
    this.questions.update((prev) => {
      const updated = [
        {
          ...question,
          answer:
            question.status === 'answering'
              ? {
                  questionId: question.id,
                  mode: this.selectedMode().toLowerCase() as 'short' | 'detailed' | 'simple',
                  bullets: [],
                  createdAt: Date.now(),
                }
              : undefined,
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

    // Keep current tab stable so transcript rows remain visible and uninterrupted
    this.showToast('Question detected and logged in radar.');
  }

  private handleAnswerChunk(chunk: AnswerChunk): void {
    const existing = this.rawBufferMap.get(chunk.questionId) || '';
    const updated = existing + chunk.delta;
    this.rawBufferMap.set(chunk.questionId, updated);

    // Parse the accumulated markdown-ish text into bullets + code blocks so
    // design/coding answers are not shredded into one bullet per line.
    const parsed = parseAnswerMarkdown(updated);
    const bullets = parsed.bullets;

    const isComplete = Boolean(chunk.isComplete);
    if (isComplete) {
      const segId = chunk.questionId.replace(/^q-/, '');
      this.answeringSegmentIds.update((set) => {
        const copy = new Set(set);
        copy.delete(segId);
        return copy;
      });
      this.answeredSegmentIds.update((set) => new Set(set).add(segId));
    }

    this.questions.update((list) =>
      list.map((q) => {
        if (q.id === chunk.questionId) {
          const estimatedIn = Math.max(1, Math.round((q.text?.length || 40) / 4));
          const estimatedOut = Math.max(1, Math.round((updated?.length || 80) / 4));
          const inTokens = chunk.inputTokens ?? q.answer?.inputTokens ?? (isComplete ? estimatedIn : undefined);
          const outTokens = chunk.outputTokens ?? q.answer?.outputTokens ?? (isComplete ? estimatedOut : undefined);
          const totTokens =
            chunk.totalTokens ??
            q.answer?.totalTokens ??
            (inTokens !== undefined && outTokens !== undefined ? inTokens + outTokens : (isComplete ? estimatedIn + estimatedOut : undefined));

          if (isComplete) {
            console.log(
              `[Overlay] Answer completed for "${q.text.slice(0, 40)}" | Tokens: total=${totTokens}, input=${inTokens}, output=${outTokens}`
            );
          }

          let updatedSnapshot = q.contextSnapshot ? { ...q.contextSnapshot } : undefined;
          if (chunk.finalPrompt) {
            if (!updatedSnapshot) {
              updatedSnapshot = { capturedAt: Date.now() };
            }
            updatedSnapshot.finalPrompt = chunk.finalPrompt;
          }

          return {
            ...q,
            contextSnapshot: updatedSnapshot || q.contextSnapshot,
            status: isComplete
              ? q.status === 'pinned'
                ? 'pinned'
                : 'answered'
              : 'answering',
            answer: {
              questionId: q.id,
              mode: chunk.mode || q.answer?.mode || 'short',
              bullets: bullets.length > 0 ? bullets : q.answer?.bullets || [],
              code: parsed.code || chunk.code || q.answer?.code,
              truncated: chunk.truncated || q.answer?.truncated,
              totalTokens: totTokens,
              inputTokens: inTokens,
              outputTokens: outTokens,
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
                  totalTokens: 185,
                  inputTokens: 110,
                  outputTokens: 75,
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

  async triggerAnswer(questionId?: string): Promise<void> {
    if (questionId) {
      this.questions.update((list) =>
        list.map((item) => (item.id === questionId ? { ...item, status: 'answering' } : item))
      );
    }
    this.showToast('Generating answer talking points...');
    if (this.isElectron()) {
      await this.ipcService.answerQuestion({
        questionId,
        mode: ANSWER_MODE_FROM_LABEL[this.selectedMode()],
      });
    }
  }

  /** Opens a fresh row for the next utterance without closing the current one. */
  startNewRowFrom(seg: TranscriptSegment): void {
    this.startDraftRow(seg.speaker);
    this.showToast('New transcript row ready');
  }

  /**
   * Re-generates the answer for an already-answered row, clearing the existing
   * answer so the new one streams into the same card.
   */
  async reanswerForSegment(segment: TranscriptSegment): Promise<void> {
    const questionId = `q-${segment.id}`;
    const mode = ANSWER_MODE_FROM_LABEL[this.selectedMode()];
    this.rawBufferMap.delete(questionId);

    this.questions.update((list) =>
      list.map((item) =>
        item.id === questionId
          ? {
              ...item,
              status: 'answering',
              answer: { questionId: item.id, mode, bullets: [], createdAt: Date.now() },
            }
          : item
      )
    );

    // Reflect progress on the transcript row (shows "Answering..." then "View Answer").
    this.answeredSegmentIds.update((set) => {
      const copy = new Set(set);
      copy.delete(segment.id);
      return copy;
    });
    this.answeringSegmentIds.update((set) => new Set(set).add(segment.id));

    this.showToast(`Re-answering (${mode})...`);

    if (this.isElectron()) {
      await this.ipcService.answerQuestion({
        questionId,
        text: segment.text,
        speaker: segment.speaker,
        mode,
      });
    }
  }

  /** Clears a row's text. If it is the active row, it resets to a fresh live row. */
  clearRowText(seg: TranscriptSegment): void {
    this.rawBufferMap.delete(seg.id);
    const list = this.transcriptSegments();
    const isLast = list.length > 0 && list[list.length - 1].id === seg.id;
    const closable =
      isLast && !this.answeredSegmentIds().has(seg.id) && !this.answeringSegmentIds().has(seg.id);

    if (closable) {
      // Keep the row visible as an empty live row so the next speech fills it.
      this.transcriptSegments.update((items) => items.filter((s) => s.id !== seg.id));
      this.draftRow.set({
        id: seg.id,
        text: '',
        isFinal: false,
        startMs: seg.startMs,
        endMs: Date.now(),
        speaker: seg.speaker,
      });
    } else {
      this.transcriptSegments.update((items) =>
        items.map((s) => (s.id === seg.id ? { ...s, text: '' } : s))
      );
    }
    this.showToast('Row cleared');
  }

  getHighlightedCode(code: string | undefined): SafeHtml {
    if (!code) return '';
    const cached = this.highlightedCodeCache.get(code);
    if (cached) return cached;
    const rawHtml = highlightLeetCodeSnippet(code);
    const safe = this.sanitizer.bypassSecurityTrustHtml(rawHtml);
    this.highlightedCodeCache.set(code, safe);
    return safe;
  }

  getCodeLineNumbers(code: string | undefined): number[] {
    return getLineNumbersList(code);
  }

  getCodeLanguage(code: string | undefined): string {
    return detectCodeLanguage(code);
  }

  async copyCodeSnippet(code: string | undefined, event: MouseEvent): Promise<void> {
    event.stopPropagation();
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      this.showToast('Code copied to clipboard!');
    } catch {
      this.showToast('Failed to copy code');
    }
  }

  async copyText(text: string | undefined, event: MouseEvent): Promise<void> {
    event.stopPropagation();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this.showToast('Prompt copied to clipboard!');
    } catch {
      this.showToast('Failed to copy prompt');
    }
  }

  /** Opens a fresh, empty draft row to receive the next utterance. */
  private startDraftRow(speaker?: string): void {
    this.draftRow.set({
      id: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      text: '',
      isFinal: false,
      startMs: Date.now(),
      endMs: Date.now(),
      speaker: speaker || this.activeLiveSpeaker() || undefined,
    });
  }

  async giveAnswerForSegment(segment: TranscriptSegment): Promise<void> {
    if (!segment.text || !segment.text.trim()) return;

    if (this.answeredSegmentIds().has(segment.id)) {
      this.currentTab.set('questions');
      const target = this.questions().find(
        (q) => q.id === `q-${segment.id}` || q.text.trim().toLowerCase() === segment.text.trim().toLowerCase()
      );
      if (target) {
        this.collapsedIds.update((set) => {
          const copy = new Set(set);
          copy.delete(target.id);
          return copy;
        });
      }
      return;
    }

    this.answeringSegmentIds.update((set) => new Set(set).add(segment.id));
    this.showToast('Synthesizing answer talking points...');

    // Immediately open a fresh row for the next utterance. Its Give Answer
    // button stays disabled until the row fills with final text.
    this.startDraftRow(segment.speaker);

    if (this.isElectron()) {
      await this.ipcService.answerQuestion({
        questionId: `q-${segment.id}`,
        text: segment.text,
        speaker: segment.speaker,
        mode: ANSWER_MODE_FROM_LABEL[this.selectedMode()],
      });
    }
  }

  isRowAnswered(seg: TranscriptSegment): boolean {
    return this.answeredSegmentIds().has(seg.id) || this.answeringSegmentIds().has(seg.id);
  }

  async startNewSession(): Promise<void> {
    this.questions.set([]);
    this.collapsedIds.set(new Set());
    this.transcriptSegments.set([]);
    this.activeInterim.set(null);
    this.activeLiveText.set('');
    this.activeLiveSpeaker.set('');
    this.isSpeaking.set(false);
    this.answeringSegmentIds.set(new Set());
    this.answeredSegmentIds.set(new Set());
    this.meetingSummary.set(null);
    this.sessionSeconds.set(0);
    this.rawBufferMap.clear();
    if (this.isElectron()) {
      await this.ipcService.resetSession();
    }
    this.showToast('New meeting session started.');
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
    this.draftRow.set(null);
    this.activeInterim.set(null);
    if (this.isElectron()) {
      await this.ipcService.clearTranscript();
    }
    this.showToast('Transcript cleared');
  }

  cycleAnswerMode(): void {
    const modes: AnswerModeLabel[] = ['Short', 'Detailed', 'Simple'];
    const current = this.selectedMode();
    const next = modes[(modes.indexOf(current) + 1) % modes.length];
    this.selectedMode.set(next);
    this.showToast(`Mode set to: ${next}`);
    if (this.isElectron()) {
      // Persist so voice-triggered answers use the same depth.
      this.ipcService.setSettings({ answerMode: ANSWER_MODE_FROM_LABEL[next] }).catch(() => {});
    }
  }

  simulateNewQuestion(): void {
    const template =
      SAMPLE_QUESTION_TEMPLATES[this.templateIndex % SAMPLE_QUESTION_TEMPLATES.length];
    this.templateIndex++;

    const isUnanswered = this.templateIndex % 2 === 1;
    const newId = `q-${Date.now()}`;
    const newQuestion: Question = {
      id: newId,
      sessionId: 'session-demo',
      text: template.text,
      speaker: template.speaker || 'Speaker 1',
      askedAt: Date.now(),
      status: isUnanswered ? 'unanswered' : 'new',
      answer: isUnanswered
        ? undefined
        : {
            questionId: newId,
            mode: template.mode,
            bullets: template.bullets,
            code: template.code,
            totalTokens: 215,
            inputTokens: 140,
            outputTokens: 75,
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

  toggleContextExpanded(id: string, event?: Event): void {
    if (event) event.stopPropagation();
    this.expandedContextIds.update((set) => {
      const copy = new Set(set);
      if (copy.has(id)) {
        copy.delete(id);
      } else {
        copy.add(id);
      }
      return copy;
    });
  }

  isContextExpanded(id: string): boolean {
    return this.expandedContextIds().has(id);
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
    const totalSecs = Math.max(0, Math.floor(startMs / 1000));
    const hours = Math.floor(totalSecs / 3600)
      .toString()
      .padStart(2, '0');
    const mins = Math.floor((totalSecs % 3600) / 60)
      .toString()
      .padStart(2, '0');
    const secs = (totalSecs % 60).toString().padStart(2, '0');
    return `${hours}:${mins}:${secs}`;
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

  async copyScreenText(): Promise<void> {
    const text = this.screenVisionStatus()?.lastExtractedText;
    if (!text) {
      this.showToast('No screen text to copy.');
      return;
    }
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      }
      this.showToast('Screen OCR text copied to clipboard!');
    } catch {
      this.showToast('Could not access clipboard.');
    }
  }

  formatScanTimestamp(timestamp: number | null | undefined): string {
    if (!timestamp) return '';
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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

    if (event.key === 'Shift') {
      const now = Date.now();
      if (now - this.lastShiftTime <= 450) {
        this.lastShiftTime = 0;
        this.scanScreenNow();
        return;
      }
      this.lastShiftTime = now;
    } else {
      this.lastShiftTime = 0;
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
