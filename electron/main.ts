import { app, BrowserWindow, clipboard, desktopCapturer, globalShortcut, ipcMain, screen, session, shell, systemPreferences } from 'electron';

if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');
}
import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';
import { GlobalKeyboardListener, IGlobalKeyEvent } from 'node-global-key-listener';
import {
  IPC_CHANNELS,
  HotkeyAction,
  TranscriptSegment,
  SessionStatus,
  Question,
  RegeneratePayload,
  AppSettings,
  AnswerMode,
  AnswerQuestionPayload,
  AppDiagnostics,
  TranscriptionMode,
  AudioChunkPayload,
  MacosPermissions,
  ParakeetStatus,
  ParakeetModelType,
  ConversationTurn,
} from '@shared/ipc';
import { LLM_PROVIDERS } from '@shared/llm-provider-catalog';
import { SttService } from './services/stt.service';
import { QuestionDetector } from './services/detector.service';
import { LlmService } from './services/llm.service';
import { StoreService } from './services/store.service';
import { UpdaterService } from './services/updater.service';
import { KnowledgeService } from './services/knowledge.service';
import { SummaryService } from './services/summary.service';
import { ScreenVisionService } from './services/screenvision.service';
import { OcrModelId, ScreenVisionStatus, ScreenVisionCaptureResult } from '@shared/ipc';

let mainWindow: BrowserWindow | null = null;
let captureWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let isClickThrough = false;
let isQuitting = false;

const storeService = new StoreService();
const sttService = new SttService();
const detector = new QuestionDetector();
const llmService = new LlmService();
const updaterService = new UpdaterService();
const knowledgeService = new KnowledgeService();
const summaryService = new SummaryService(llmService);
const screenVisionService = new ScreenVisionService(storeService);

let lastShiftPressTime = 0;
let globalKeyboardListener: GlobalKeyboardListener | null = null;

function getKeyServerPath(): string | undefined {
  const binName = process.platform === 'win32' ? 'WinKeyServer.exe' : 'MacKeyServer';

  // 1. Packaged app: process.resourcesPath/bin/<binName>
  if (app.isPackaged) {
    const packagedPath = path.join(process.resourcesPath, 'bin', binName);
    if (fs.existsSync(packagedPath)) return packagedPath;
  }

  // 2. Dev mode / resource path: electron/resources/bin/<binName>
  const resourcePath = path.join(__dirname, '..', 'electron', 'resources', 'bin', binName);
  if (fs.existsSync(resourcePath)) return resourcePath;

  // 3. Project root resources/bin/<binName>
  const rootResourcePath = path.join(process.cwd(), 'electron', 'resources', 'bin', binName);
  if (fs.existsSync(rootResourcePath)) return rootResourcePath;

  // 4. Node modules path
  const nodeModulesPath = path.join(process.cwd(), 'node_modules', 'node-global-key-listener', 'bin', binName);
  if (fs.existsSync(nodeModulesPath)) return nodeModulesPath;

  return undefined;
}

let accessibilityPollTimer: NodeJS.Timeout | null = null;
let lastAnswerTriggerTime = 0;

function answerLatestConversation(): void {
  const now = Date.now();
  if (now - lastAnswerTriggerTime < 1000) {
    console.log('[Main] Debouncing duplicate answerLatestConversation trigger');
    return;
  }
  lastAnswerTriggerTime = now;

  // If mainWindow exists and is active, let renderer handle it via IPC so that
  // the exact same UI flow as clicking '⚡ Give Answer' runs (creates draft row,
  // marks row answering, and calls backend answerQuestion).
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.getOpacity() === 0) {
      mainWindow.setOpacity(1);
      mainWindow.setIgnoreMouseEvents(false);
    }
    console.log('[Main] Delegating double-Alt answer trigger to renderer window');
    mainWindow.webContents.send(IPC_CHANNELS.HOTKEY_TRIGGERED, 'answer-latest');
    return;
  }

  // Fallback: If mainWindow is not available, find and answer directly in main process
  const allQuestions = Array.from(questionsMap.values());
  let targetQuestion = [...allQuestions].reverse().find((q) => q.status === 'unanswered');

  if (!targetQuestion && allQuestions.length > 0) {
    targetQuestion = allQuestions[allQuestions.length - 1];
  }

  if (!targetQuestion) {
    const history = sttService.transcriptManager.getHistory();
    const latestSegment = [...history].reverse().find((s) => s.text.trim().length > 0);
    if (latestSegment) {
      const newId = `q-conv-${Date.now()}`;
      targetQuestion = {
        id: newId,
        sessionId: 'session-live',
        text: latestSegment.text.trim(),
        speaker: latestSegment.speaker || 'Speaker',
        askedAt: Date.now(),
        status: 'unanswered',
      };
      questionsMap.set(newId, targetQuestion);
    }
  }

  if (targetQuestion) {
    console.log(`[Main] Fallback answering latest conversation item: "${targetQuestion.text.slice(0, 60)}"`);
    generateAnswerForQuestion(targetQuestion);
  } else {
    console.log('[Main] No conversation speech or questions found to answer yet.');
  }
}

function startGlobalShiftListener(): boolean {
  if (globalKeyboardListener) return true;

  const serverPath = getKeyServerPath();
  console.log('[ScreenVision] Starting global key listener with serverPath:', serverPath);

  if (process.platform !== 'win32' && serverPath && fs.existsSync(serverPath)) {
    try {
      fs.chmodSync(serverPath, 0o755);
    } catch {
      // ignore
    }
  }

  try {
    const listenerConfig: any = {};
    if (serverPath) {
      if (process.platform === 'darwin') {
        listenerConfig.mac = {
          serverPath,
          onError: (errorCode: number | null) => {
            console.warn(`[ScreenVision] MacKeyServer closed (code: ${errorCode}).`);
            if (globalKeyboardListener) {
              try {
                globalKeyboardListener.kill();
              } catch {}
              globalKeyboardListener = null;
            }
            if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) {
              pollForAccessibilityPermission();
            }
          },
          onInfo: (msg: string) => {
            console.log('[ScreenVision] MacKeyServer info:', msg.trim());
          },
        };
      } else if (process.platform === 'win32') {
        listenerConfig.windows = {
          serverPath,
          onError: (errorCode: number) => {
            console.warn(`[ScreenVision] WinKeyServer closed (code: ${errorCode}).`);
            if (globalKeyboardListener) {
              try {
                globalKeyboardListener.kill();
              } catch {}
              globalKeyboardListener = null;
            }
          },
        };
      }
    }

    globalKeyboardListener = new GlobalKeyboardListener(listenerConfig);

    let isShiftDown = false;
    let globalLastShiftPressTime = 0;
    let isAltDown = false;
    let globalLastAltPressTime = 0;
    const DOUBLE_TAP_MAX_INTERVAL_MS = 450;
    const DOUBLE_TAP_MIN_INTERVAL_MS = 50;

    globalKeyboardListener.addListener((event: IGlobalKeyEvent) => {
      const isShiftKey = event.name === 'LEFT SHIFT' || event.name === 'RIGHT SHIFT';
      const isAltKey = event.name === 'LEFT ALT' || event.name === 'RIGHT ALT';

      if (event.state === 'DOWN') {
        if (isShiftKey) {
          globalLastAltPressTime = 0;
          if (isShiftDown) return;
          isShiftDown = true;
          const now = Date.now();
          const interval = now - globalLastShiftPressTime;

          if (interval >= DOUBLE_TAP_MIN_INTERVAL_MS && interval <= DOUBLE_TAP_MAX_INTERVAL_MS) {
            globalLastShiftPressTime = 0;
            console.log('[ScreenVision] Global double-Shift detected -> Triggering screen scan');
            screenVisionService.captureScreen().catch((err) => {
              console.warn('[ScreenVision] Error in global double-Shift triggered capture:', err);
            });
          } else {
            globalLastShiftPressTime = now;
          }
        } else if (isAltKey) {
          globalLastShiftPressTime = 0;
          if (isAltDown) return;
          isAltDown = true;
          const now = Date.now();
          const interval = now - globalLastAltPressTime;

          if (interval >= DOUBLE_TAP_MIN_INTERVAL_MS && interval <= DOUBLE_TAP_MAX_INTERVAL_MS) {
            globalLastAltPressTime = 0;
            console.log('[Main] Global double-Alt detected -> Answering latest conversation');
            answerLatestConversation();
          } else {
            globalLastAltPressTime = now;
          }
        } else {
          globalLastShiftPressTime = 0;
          globalLastAltPressTime = 0;
        }
      } else if (event.state === 'UP') {
        if (isShiftKey) {
          isShiftDown = false;
        } else if (isAltKey) {
          isAltDown = false;
        }
      }
    });

    console.log('[Main] Global keyboard listener active. Double-Shift (OCR) & Double-Alt (Answer) globally enabled.');
    return true;
  } catch (err) {
    console.warn('[Main] Failed to start GlobalKeyboardListener:', err);
    globalKeyboardListener = null;
    return false;
  }
}

function pollForAccessibilityPermission(): void {
  if (accessibilityPollTimer) return;

  console.log(
    '[ScreenVision] Polling for macOS Accessibility permission... (Waiting for user to enable in System Settings)'
  );

  accessibilityPollTimer = setInterval(() => {
    if (systemPreferences.isTrustedAccessibilityClient(false)) {
      console.log('[ScreenVision] macOS Accessibility permission granted! Launching global double-Shift listener...');
      if (accessibilityPollTimer) {
        clearInterval(accessibilityPollTimer);
        accessibilityPollTimer = null;
      }
      startGlobalShiftListener();
    }
  }, 2000);
}

function initGlobalShiftListener(): void {
  // On macOS, check / prompt for Accessibility permission required for global event taps
  if (process.platform === 'darwin') {
    const isTrusted = systemPreferences.isTrustedAccessibilityClient(false);
    if (!isTrusted) {
      console.warn(
        '\n' +
        '=========================================================================================\n' +
        '[ScreenVision] macOS Accessibility Permission Required for Global Double-Shift / Double-Alt:\n' +
        '1. Open "System Settings > Privacy & Security > Accessibility"\n' +
        '2. Turn ON the toggle for "Electron" (in development) or "MeetVision AI" (in production).\n' +
        '3. Double-Shift and Double-Alt will activate automatically as soon as the toggle is enabled!\n' +
        'Note: Command+Shift+S remains active globally at all times without requiring Accessibility.\n' +
        '=========================================================================================\n'
      );
      // Trigger native macOS permission prompt modal/dialog
      systemPreferences.isTrustedAccessibilityClient(true);
      // Start waiting for the user to grant permission
      pollForAccessibilityPermission();
      return;
    }
  }

  startGlobalShiftListener();
}

let lastAltPressTime = 0;

function attachDoubleModifierListener(win: BrowserWindow, windowName: string): void {
  win.webContents.on('before-input-event', (_event, input) => {
    // If native global listener is active, it already captures double-Shift and double-Alt globally
    if (globalKeyboardListener) return;

    if (input.type === 'keyDown') {
      const isShift = input.key === 'Shift' || input.code?.startsWith('Shift');
      const isAlt = input.key === 'Alt' || input.code?.startsWith('Alt');

      if (isShift) {
        lastAltPressTime = 0;
        const now = Date.now();
        if (now - lastShiftPressTime <= 450 && now - lastShiftPressTime >= 50) {
          lastShiftPressTime = 0;
          console.log(`[ScreenVision] In-window Double Shift detected from ${windowName} -> Triggering screen scan`);
          screenVisionService.captureScreen().catch((err) => {
            console.warn('[ScreenVision] Error in double-Shift triggered capture:', err);
          });
        } else {
          lastShiftPressTime = now;
        }
      } else if (isAlt) {
        lastShiftPressTime = 0;
        const now = Date.now();
        if (now - lastAltPressTime <= 450 && now - lastAltPressTime >= 50) {
          lastAltPressTime = 0;
          console.log(`[Main] In-window Double Alt detected from ${windowName} -> Answering latest conversation`);
          answerLatestConversation();
        } else {
          lastAltPressTime = now;
        }
      } else {
        lastShiftPressTime = 0;
        lastAltPressTime = 0;
      }
    }
  });
}

const recentTranscript: string[] = [];
const questionsMap = new Map<string, Question>();

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

function createOverlayWindow(): void {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
  const savedSettings = storeService.getSettings();
  const windowWidth = Math.max(300, Math.min(screenWidth - 40, savedSettings.overlayWidth || 380));
  const windowHeight = Math.max(400, Math.min(screenHeight - 64, savedSettings.overlayHeight || 600));
  const x = typeof savedSettings.overlayX === 'number'
    ? Math.max(0, Math.min(screenWidth - 100, savedSettings.overlayX))
    : Math.round((screenWidth - windowWidth) / 2);
  const y = typeof savedSettings.overlayY === 'number'
    ? Math.max(0, Math.min(screenHeight - 100, savedSettings.overlayY))
    : 32;

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    minWidth: 300,
    minHeight: 400,
    x,
    y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    hasShadow: false,
    minimizable: false, // Prevent Cmd+H from hiding the window
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Persist size when resized
  let resizeTimeout: NodeJS.Timeout | null = null;
  mainWindow.on('resize', () => {
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const [w, h] = mainWindow.getSize();
        storeService.updateSettings({ overlayWidth: w, overlayHeight: h });
      }
    }, 250);
  });

  // Persist position when moved
  let moveTimeout: NodeJS.Timeout | null = null;
  mainWindow.on('move', () => {
    if (moveTimeout) clearTimeout(moveTimeout);
    moveTimeout = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const [posX, posY] = mainWindow.getPosition();
        storeService.updateSettings({ overlayX: posX, overlayY: posY });
      }
    }, 250);
  });

  // Always on top at screen-saver level so it floats over fullscreen / presentation apps
  mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);

  const initialSettings = storeService.getSettings();
  if (process.platform === 'darwin' && initialSettings.multiWorkspace !== false) {
    mainWindow.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
  }

  // Ensure window stays on top when user switches focus to other applications
  mainWindow.on('blur', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    }
  });

  try {
    mainWindow.setContentProtection(true);
  } catch (err) {
    console.warn('setContentProtection failed:', err);
  }

  attachDoubleModifierListener(mainWindow, 'OverlayWindow');

  if (isDev) {
    const devUrl = 'http://localhost:4200/#/overlay';
    const loadOverlay = (retries = 6) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.loadURL(devUrl).catch((err) => {
        if (retries > 0) {
          setTimeout(() => loadOverlay(retries - 1), 800);
        } else {
          console.warn('[Main] Overlay window failed to load dev server:', err);
        }
      });
    };
    loadOverlay();
  } else {
    const distPath = path.join(__dirname, '../dist/MeetVisionAI/browser/index.html');
    mainWindow.loadURL(url.pathToFileURL(distPath).href + '#/overlay');
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createCaptureWindow(): void {
  // Hidden window that captures audio loopback and streams PCM to main process
  captureWindow = new BrowserWindow({
    width: 200,
    height: 200,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // Ensure audio continues processing in background
    },
  });

  if (isDev) {
    const devUrl = 'http://localhost:4200/#/capture';
    const loadCapture = (retries = 6) => {
      if (!captureWindow || captureWindow.isDestroyed()) return;
      captureWindow.loadURL(devUrl).catch((err) => {
        if (retries > 0) {
          setTimeout(() => loadCapture(retries - 1), 800);
        } else {
          console.warn('[Main] Capture window failed to load dev server:', err);
        }
      });
    };
    loadCapture();
  } else {
    const distPath = path.join(__dirname, '../dist/MeetVisionAI/browser/index.html');
    captureWindow.loadURL(url.pathToFileURL(distPath).href + '#/capture');
  }

  captureWindow.on('closed', () => {
    captureWindow = null;
  });
}

function broadcastSettingsVisibility(isOpen: boolean): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.SETTINGS_VISIBILITY_CHANGED, isOpen);
  }
}

function toggleSettingsWindow(): boolean {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) {
      settingsWindow.restore();
      settingsWindow.show();
      settingsWindow.focus();
      broadcastSettingsVisibility(true);
      return true;
    }
    if (settingsWindow.isVisible()) {
      settingsWindow.hide();
      broadcastSettingsVisibility(false);
      return false;
    } else {
      settingsWindow.show();
      settingsWindow.focus();
      broadcastSettingsVisibility(true);
      return true;
    }
  }

  createSettingsWindow();
  return true;
}

function createSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    broadcastSettingsVisibility(true);
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 660,
    height: 740,
    minWidth: 500,
    minHeight: 500,
    title: 'MeetVision AI Settings',
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (isDev) {
    const devUrl = 'http://localhost:4200/#/settings';
    settingsWindow.loadURL(devUrl).catch((err) => {
      console.warn('Settings window loadURL failed:', err);
    });
  } else {
    const distPath = path.join(__dirname, '../dist/MeetVisionAI/browser/index.html');
    settingsWindow.loadURL(url.pathToFileURL(distPath).href + '#/settings');
  }

  attachDoubleModifierListener(settingsWindow, 'SettingsWindow');

  broadcastSettingsVisibility(true);

  settingsWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      settingsWindow?.hide();
      broadcastSettingsVisibility(false);
    }
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
    broadcastSettingsVisibility(false);
  });
}

function setClickThrough(enable: boolean): boolean {
  isClickThrough = enable;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setIgnoreMouseEvents(enable, { forward: true });
    sendHotkeyToRenderer('toggle-click-through');
  }
  return isClickThrough;
}

function sendHotkeyToRenderer(action: HotkeyAction): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.HOTKEY_TRIGGERED, action);
  }
}

function registerHotkeys(): void {
  // Toggle Show/Hide overlay with Cmd+Shift+H
  globalShortcut.register('CommandOrControl+H', () => {
    return;
  });

  globalShortcut.register('CommandOrControl+Shift+H', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      console.log('[Hotkey] mainWindow is null or destroyed');
      return;
    }

    const currentOpacity = mainWindow.getOpacity();
    console.log('[Hotkey] Toggle visibility. Current opacity:', currentOpacity);

    if (currentOpacity > 0) {
      // Hide by setting opacity to 0 and disabling mouse events
      mainWindow.setOpacity(0);
      mainWindow.setIgnoreMouseEvents(true);
      console.log('[Hotkey] Window hidden (opacity = 0)');
    } else {
      // Show by restoring opacity and mouse events
      mainWindow.setOpacity(1);
      mainWindow.setIgnoreMouseEvents(isClickThrough, { forward: true });
      console.log('[Hotkey] Window shown (opacity = 1)');
    }
  });

  // Toggle Click-Through mode
  globalShortcut.register('CommandOrControl+Shift+M', () => {
    setClickThrough(!isClickThrough);
  });

  // Regenerate answer
  globalShortcut.register('CommandOrControl+Shift+R', () => {
    sendHotkeyToRenderer('regenerate');
  });

  // Panic hide: hide overlay immediately
  globalShortcut.register('CommandOrControl+Escape', () => {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      mainWindow.setOpacity(0);
      mainWindow.setIgnoreMouseEvents(true);
    }
  });

  // Quit application shortcut
  globalShortcut.register('CommandOrControl+Shift+Q', () => {
    console.log('[Hotkey] CommandOrControl+Shift+Q triggered -> Quitting application');
    isQuitting = true;
    app.quit();
  });

  // ScreenVision scan shortcut: Cmd/Ctrl+Shift+S
  globalShortcut.register('CommandOrControl+Shift+S', async () => {
    console.log('[Hotkey] ScreenVision scan triggered via CommandOrControl+Shift+S');
    await screenVisionService.captureScreen();
  });

  // Native global double-Shift standalone modifier listener
  initGlobalShiftListener();
}

function generateAnswerForQuestion(question: Question, mode?: AnswerMode): void {
  const settings = storeService.getSettings();
  const answerMode: AnswerMode = mode || settings.answerMode || 'short';

  question.status = 'answering';

  // Snapshot context at the moment the answer is requested
  const history = sttService.transcriptManager.getHistory();
  const otherSegments = history.filter((s) => s.speaker === 'Other').map((s) => s.text);
  const userSegments = history.filter((s) => s.speaker === 'You').map((s) => s.text);
  const { combinedText } = screenVisionService.commitPendingScansForQuestion(question.id, question.text);
  const screenContext = combinedText || screenVisionService.getVisibleScreenContext();

  question.contextSnapshot = {
    otherText: otherSegments.slice(-5).join(' ').trim() || (question.speaker === 'Other' ? question.text : undefined),
    userText: userSegments.slice(-5).join(' ').trim() || (question.speaker === 'You' ? question.text : undefined),
    ocrText: screenContext || undefined,
    capturedAt: Date.now(),
  };

  questionsMap.set(question.id, question);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.QUESTION_NEW, question);
  }

  const relevantSnippets = knowledgeService.retrieveRelevantSnippets(question.text);

  // Build recent assistant conversation history (up to last 6 Q&A turns)
  const conversationHistory: ConversationTurn[] = [];
  for (const q of questionsMap.values()) {
    if (q.id !== question.id && q.status === 'answered' && q.answer) {
      const answerContent = [
        ...(q.answer.bullets || []),
        q.answer.code ? `\`\`\`\n${q.answer.code}\n\`\`\`` : '',
      ]
        .filter(Boolean)
        .join('\n');
      if (q.text && answerContent) {
        conversationHistory.push({ role: 'user', content: q.text });
        conversationHistory.push({ role: 'assistant', content: answerContent });
      }
    }
  }

  llmService.generateAnswerStream(
    question,
    recentTranscript,
    {
      mode: answerMode,
      profile: storeService.getContextProfile(),
      providerId: settings.llmProvider,
      apiKey: storeService.getDecryptedApiKey(settings.llmProvider),
      model: settings.llmModel,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      modeTokens: settings.modeTokens,
      thinkingEnabled: Boolean(settings.llmThinkingEnabled),
      codeLanguage: settings.codeLanguage,
      knowledgeSnippets: relevantSnippets,
      screenContext,
      conversationHistory: conversationHistory.slice(-8),
    },
    (chunk) => {
      if (chunk.isComplete) {
        question.status = 'answered';
        if (!question.answer) {
          question.answer = {
            questionId: question.id,
            mode: answerMode,
            bullets: [],
            createdAt: Date.now(),
          };
        }
        question.answer.totalTokens = chunk.totalTokens ?? 0;
        question.answer.inputTokens = chunk.inputTokens ?? 0;
        question.answer.outputTokens = chunk.outputTokens ?? 0;

        if (chunk.finalPrompt) {
          if (!question.contextSnapshot) {
            question.contextSnapshot = { capturedAt: Date.now() };
          }
          question.contextSnapshot.finalPrompt = chunk.finalPrompt;
        }

        console.log(
          `[Main] Answer generation completed for "${question.text.slice(0, 50)}" | Tokens: total=${question.answer.totalTokens}, input=${question.answer.inputTokens}, output=${question.answer.outputTokens}`
        );
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.ANSWER_CHUNK, chunk);
      }
    }
  );
}

async function handleTranscriptSegment(segment: TranscriptSegment): Promise<void> {
  // If segment text is empty, do not forward or create empty rows
  if (!segment.text || !segment.text.trim()) {
    return;
  }

  // Clean transcript with filler removal and technical vocabulary correction from screen
  segment.text = screenVisionService.cleanTranscriptText(segment.text);

  // 1. Broadcast segment to overlay for Live Transcript view
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.TRANSCRIPT_UPDATE, segment);
  }

  // 2. On final segments, evaluate question detection and voice answer triggers
  if (segment.isFinal) {
    const speakerLabel = segment.speaker === 'You' ? '[You]' : '[Other Participant]';
    recentTranscript.push(`${speakerLabel}: ${segment.text}`);
    if (recentTranscript.length > 25) {
      recentTranscript.shift();
    }

    // Voice Trigger: When user says "give answer" / "give the answer" / "answer question"
    const isGiveAnswer = /\b(give\s+answer|give\s+the\s+answer|answer\s+(the\s+)?question|answer\s+this|answer\s+that)\b/i.test(segment.text);
    if (isGiveAnswer) {
      const allQuestions = Array.from(questionsMap.values());
      const targetQuestion =
        [...allQuestions].reverse().find((q) => q.status === 'unanswered') ||
        allQuestions[allQuestions.length - 1];

      if (targetQuestion) {
        console.log(`[Main] Voice trigger 'give answer' activated for question: "${targetQuestion.text}"`);
        generateAnswerForQuestion(targetQuestion);
      }
      return;
    }

    const detectedQuestion = detector.evaluate(segment);
    if (detectedQuestion) {
      if (segment.speaker) {
        detectedQuestion.speaker = segment.speaker;
      }
      detectedQuestion.status = 'unanswered';
      questionsMap.set(detectedQuestion.id, detectedQuestion);
      if (questionsMap.size > 50) {
        const oldestKey = questionsMap.keys().next().value;
        if (oldestKey) questionsMap.delete(oldestKey);
      }

      // Emit new detected question to overlay in 'unanswered' state (ready for answer)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.QUESTION_NEW, detectedQuestion);
      }
    }
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.PING, async (_event, message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    const reply = `Pong from Electron main! Received: "${message}" at ${timestamp}`;
    return reply;
  });

  ipcMain.handle(IPC_CHANNELS.OVERLAY_SET_CLICK_THROUGH, async (_event, enable: boolean) => {
    return setClickThrough(enable);
  });

  ipcMain.handle(IPC_CHANNELS.OVERLAY_GET_CLICK_THROUGH, async () => {
    return isClickThrough;
  });

  ipcMain.handle(
    IPC_CHANNELS.OVERLAY_SET_SIZE,
    async (_event, payload: { width: number; height: number }) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const primaryDisplay = screen.getPrimaryDisplay();
        const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
        const targetW = Math.max(300, Math.min(screenWidth - 20, Math.round(payload.width)));
        const targetH = Math.max(400, Math.min(screenHeight - 20, Math.round(payload.height)));
        mainWindow.setSize(targetW, targetH);
        storeService.updateSettings({ overlayWidth: targetW, overlayHeight: targetH });
        return { width: targetW, height: targetH };
      }
      return payload;
    }
  );

  ipcMain.handle(IPC_CHANNELS.OVERLAY_GET_SIZE, async () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const [width, height] = mainWindow.getSize();
      return { width, height };
    }
    return { width: 380, height: 600 };
  });

  ipcMain.handle(
    IPC_CHANNELS.OVERLAY_MOVE,
    async (_event, { deltaX, deltaY }: { deltaX: number; deltaY: number }) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const [currentX, currentY] = mainWindow.getPosition();
        const [width] = mainWindow.getSize();
        const display = screen.getDisplayMatching(mainWindow.getBounds());
        const { x: workX, y: workY, width: workW, height: workH } = display.workArea;

        // Keep window reasonably within workArea
        const minX = workX - width + 80;
        const maxX = workX + workW - 80;
        const minY = workY;
        const maxY = workY + workH - 60;

        const newX = Math.round(Math.max(minX, Math.min(maxX, currentX + (Number(deltaX) || 0))));
        const newY = Math.round(Math.max(minY, Math.min(maxY, currentY + (Number(deltaY) || 0))));

        mainWindow.setPosition(newX, newY);
        storeService.updateSettings({ overlayX: newX, overlayY: newY });
        return { x: newX, y: newY };
      }
      return null;
    }
  );

  ipcMain.handle(IPC_CHANNELS.OVERLAY_SET_OPACITY, async (_event, opacity: number) => {
    const clamped = Math.max(0.2, Math.min(1.0, Number(opacity) || 0.88));
    storeService.updateSettings({ overlayOpacity: clamped });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.OVERLAY_OPACITY_CHANGED, clamped);
    }
    return clamped;
  });

  ipcMain.handle(IPC_CHANNELS.OVERLAY_SET_MULTI_WORKSPACE, async (_event, enabled: boolean) => {
    const isMulti = Boolean(enabled);
    storeService.setMultiWorkspace(isMulti);
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (process.platform === 'darwin') {
        mainWindow.setVisibleOnAllWorkspaces(isMulti, {
          visibleOnFullScreen: true,
          skipTransformProcessType: true,
        });
      }
      mainWindow.webContents.send(IPC_CHANNELS.OVERLAY_MULTI_WORKSPACE_CHANGED, isMulti);
    }
    return isMulti;
  });

  ipcMain.handle(IPC_CHANNELS.OVERLAY_SET_VERSION, async (_event, version: 'v1' | 'v2') => {
    const ver = version === 'v2' ? 'v2' : 'v1';
    storeService.setOverlayVersion(ver);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.OVERLAY_VERSION_CHANGED, ver);
    }
    return ver;
  });

  ipcMain.handle(IPC_CHANNELS.OVERLAY_CLOSE, async () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }
  });

  // Session Start
  ipcMain.handle(IPC_CHANNELS.SESSION_START, async () => {
    const settings = storeService.getSettings();
    await sttService.start(handleTranscriptSegment, {
      provider: settings.sttProvider,
      parakeetModel: settings.parakeetModel,
      transcriptionMode: settings.transcriptionMode,
      language: settings.sttLanguage,
      diarize: true,
    });
  });

  // Session Stop
  ipcMain.handle(IPC_CHANNELS.SESSION_STOP, async () => {
    await sttService.stop();
  });

  // Session Status
  ipcMain.handle(IPC_CHANNELS.SESSION_GET_STATUS, async (): Promise<SessionStatus> => {
    return {
      active: sttService.isActive(),
      provider: sttService.getProviderName(),
      model: sttService.getModelName(),
      engine: sttService.getProviderName(),
      connected: sttService.isConnected(),
      transcriptionMode: storeService.getTranscriptionMode(),
    };
  });

  // Audio channels
  ipcMain.on(IPC_CHANNELS.AUDIO_CHUNK, (_event, chunk: AudioChunkPayload) => {
    sttService.feedAudio(chunk);
  });

  ipcMain.on(IPC_CHANNELS.AUDIO_LEVEL, (_event, level: number) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.AUDIO_LEVEL, level);
    }
  });

  // Clear transcript
  ipcMain.handle(IPC_CHANNELS.TRANSCRIPT_CLEAR, async () => {
    recentTranscript.length = 0;
    // Clear conversation/transcript-derived questions from questionsMap
    for (const [id, q] of questionsMap.entries()) {
      if (id.startsWith('q-seg-') || id.startsWith('q-conv-') || q.sessionId === 'session-live') {
        questionsMap.delete(id);
      }
    }
    await sttService.stop();
    const settings = storeService.getSettings();
    await sttService.start(handleTranscriptSegment, {
      provider: settings.sttProvider,
      parakeetModel: settings.parakeetModel,
      transcriptionMode: settings.transcriptionMode,
      language: settings.sttLanguage,
      diarize: true,
    });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.TRANSCRIPT_CLEAR);
    }
  });

  // Clear unpinned questions
  ipcMain.handle(IPC_CHANNELS.QUESTIONS_CLEAR, async () => {
    console.log('[Main] Clearing unpinned questions from questionsMap');
    for (const [id, q] of questionsMap.entries()) {
      if (q.status !== 'pinned') {
        questionsMap.delete(id);
      }
    }
    return true;
  });

  // Regenerate Answer (Milestones 3, 4 & 7)
  ipcMain.handle(
    IPC_CHANNELS.ANSWER_REGENERATE,
    async (_event, payload: RegeneratePayload) => {
      let question = questionsMap.get(payload.questionId);
      if (!question && payload.text) {
        // If not found in map, attempt match by text
        for (const q of questionsMap.values()) {
          if (q.text.trim().toLowerCase() === payload.text.trim().toLowerCase()) {
            question = q;
            break;
          }
        }
        if (!question) {
          question = {
            id: payload.questionId,
            sessionId: 'session-live',
            text: payload.text,
            speaker: payload.speaker || 'Speaker',
            askedAt: Date.now(),
            status: 'unanswered',
          };
          questionsMap.set(payload.questionId, question);
        }
      }

      if (question) {
        console.log(`[Main] Regenerating answer for "${question.text.slice(0, 50)}" | Mode: ${payload.mode}`);
        generateAnswerForQuestion(question, payload.mode);
        return true;
      } else {
        console.warn(`[Main] Could not regenerate answer: question "${payload.questionId}" not found in questionsMap.`);
        return false;
      }
    }
  );

  // Answer Question (Voice / UI Manual Trigger)
  ipcMain.handle(
    IPC_CHANNELS.QUESTION_ANSWER,
    async (_event, payload?: string | AnswerQuestionPayload) => {
      let targetQuestion: Question | undefined;
      const questionId = typeof payload === 'string' ? payload : payload?.questionId;
      const segmentText = typeof payload === 'object' ? payload?.text?.trim() : undefined;
      const segmentSpeaker = typeof payload === 'object' ? payload?.speaker : undefined;
      const requestedMode = typeof payload === 'object' ? payload?.mode : undefined;

      if (questionId) {
        targetQuestion = questionsMap.get(questionId);
      }

      // If answering directly by transcript segment text and question not found in map
      if (!targetQuestion && segmentText) {
        for (const q of questionsMap.values()) {
          if (q.text.trim().toLowerCase() === segmentText.toLowerCase()) {
            targetQuestion = q;
            break;
          }
        }
        if (!targetQuestion) {
          const newId = questionId || `q-seg-${Date.now()}`;
          targetQuestion = {
            id: newId,
            sessionId: 'session-live',
            text: segmentText,
            speaker: segmentSpeaker || 'Speaker',
            askedAt: Date.now(),
            status: 'unanswered',
          };
          questionsMap.set(newId, targetQuestion);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.QUESTION_NEW, targetQuestion);
          }
        }
      }

      if (!targetQuestion) {
        const allQuestions = Array.from(questionsMap.values());
        targetQuestion = [...allQuestions].reverse().find((q) => q.status === 'unanswered');
      }

      if (!targetQuestion) {
        const history = sttService.transcriptManager.getHistory();
        const latestSegment = [...history].reverse().find((s) => s.text.trim().length > 0);
        if (latestSegment) {
          const newId = questionId || `q-seg-${Date.now()}`;
          targetQuestion = {
            id: newId,
            sessionId: 'session-live',
            text: latestSegment.text.trim(),
            speaker: latestSegment.speaker || 'Speaker',
            askedAt: Date.now(),
            status: 'unanswered',
          };
          questionsMap.set(newId, targetQuestion);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.QUESTION_NEW, targetQuestion);
          }
        }
      }

      if (targetQuestion) {
        generateAnswerForQuestion(targetQuestion, requestedMode);
        return true;
      }
      return false;
    }
  );

  // Session Reset (Clear active meeting questions, transcript, and context)
  ipcMain.handle(IPC_CHANNELS.SESSION_RESET, async () => {
    console.log('[Main] Resetting active meeting session');
    questionsMap.clear();
    recentTranscript.length = 0;
    sttService.transcriptManager.clear();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.TRANSCRIPT_CLEAR);
    }
    return true;
  });

  // Settings & Profile (Milestone 4)
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, async () => {
    return {
      ...storeService.getSettings(),
      isDev,
    };
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, async (_event, newSettings: Partial<AppSettings>) => {
    const updated = storeService.updateSettings(newSettings);
    await sttService.applySettings(updated);
    if (newSettings.screenVision) {
      screenVisionService.applySettings(newSettings.screenVision);
    }

    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.SETTINGS_CHANGED, updated);
      }
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      if (typeof updated.overlayOpacity === 'number') {
        mainWindow.webContents.send(IPC_CHANNELS.OVERLAY_OPACITY_CHANGED, updated.overlayOpacity);
      }
      if (updated.overlayVersion) {
        mainWindow.webContents.send(IPC_CHANNELS.OVERLAY_VERSION_CHANGED, updated.overlayVersion);
      }
      if (typeof updated.multiWorkspace === 'boolean') {
        mainWindow.webContents.send(IPC_CHANNELS.OVERLAY_MULTI_WORKSPACE_CHANGED, updated.multiWorkspace);
        if (process.platform === 'darwin') {
          mainWindow.setVisibleOnAllWorkspaces(updated.multiWorkspace, {
            visibleOnFullScreen: true,
            skipTransformProcessType: true,
          });
        }
      }
    }
    return updated;
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_OPEN, async () => {
    toggleSettingsWindow();
  });

  // Milestone 6: Consent & Data Purge
  ipcMain.handle(IPC_CHANNELS.CONSENT_ACCEPT, async () => {
    storeService.acceptConsent();
    if (!sttService.isActive()) {
      const settings = storeService.getSettings();
      await sttService.start(handleTranscriptSegment, {
        provider: settings.sttProvider,
        parakeetModel: settings.parakeetModel,
        transcriptionMode: settings.transcriptionMode,
        language: settings.sttLanguage,
        diarize: true,
      });
    }
  });

  ipcMain.handle(IPC_CHANNELS.DATA_CLEAR_ALL, async () => {
    storeService.clearAllData();
    knowledgeService.clearAll();
    recentTranscript.length = 0;
    questionsMap.clear();
    await sttService.stop();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.TRANSCRIPT_CLEAR);
    }
  });

  // Milestone 7: Knowledge Base (RAG)
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_LIST, async () => {
    return knowledgeService.listDocs();
  });

  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_ADD, async (_event, doc) => {
    return knowledgeService.addDoc(doc);
  });

  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_REMOVE, async (_event, id: string) => {
    return knowledgeService.removeDoc(id);
  });

  // Milestone 7: Post-Meeting Summary & Export
  ipcMain.handle(IPC_CHANNELS.SUMMARY_GENERATE, async () => {
    const questions = Array.from(questionsMap.values());
    const transcriptSegs: TranscriptSegment[] = recentTranscript.map((text, idx) => ({
      id: `seg_${idx}`,
      text,
      isFinal: true,
      startMs: idx * 2000,
      endMs: idx * 2000 + 1500,
      speaker: `Speaker ${(idx % 2) + 1}`,
    }));
    return summaryService.generateSummary(questions, transcriptSegs);
  });

  ipcMain.handle(IPC_CHANNELS.SUMMARY_EXPORT, async (_event, markdown: string) => {
    return summaryService.exportMarkdown(markdown, mainWindow);
  });

  // App Diagnostics (Milestone 5)
  ipcMain.handle(IPC_CHANNELS.APP_DIAGNOSTICS, async (): Promise<AppDiagnostics> => {
    const mem = process.memoryUsage();
    const windows = BrowserWindow.getAllWindows();
    return {
      platform: process.platform,
      arch: process.arch,
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      nodeVersion: process.versions.node,
      uptimeSec: Math.round(process.uptime()),
      memoryUsageMb: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      },
      contentProtectionActive: Boolean(mainWindow && !mainWindow.isDestroyed()),
      sttConnected: sttService.isConnected(),
      activeWindows: windows.length,
      isDev,
    };
  });

  // Transcription Mode (Mode A: Other Only vs Mode B: Everyone)
  ipcMain.handle(IPC_CHANNELS.TRANSCRIPTION_MODE_GET, async (): Promise<TranscriptionMode> => {
    return storeService.getTranscriptionMode();
  });

  ipcMain.handle(
    IPC_CHANNELS.TRANSCRIPTION_MODE_SET,
    async (_event, mode: TranscriptionMode): Promise<TranscriptionMode> => {
      const updated = storeService.setTranscriptionMode(mode);
      sttService.setTranscriptionMode(updated);

      // Broadcast mode change to all active windows
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC_CHANNELS.TRANSCRIPTION_MODE_CHANGED, updated);
        }
      }
      return updated;
    }
  );

  // NVIDIA Parakeet Engine Status & Model Management
  sttService.parakeetEngine.onProgressCallback = (progress) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.PARAKEET_DOWNLOAD_PROGRESS, progress);
      }
    }
  };

  ipcMain.handle(IPC_CHANNELS.PARAKEET_STATUS_GET, async (): Promise<ParakeetStatus> => {
    return sttService.parakeetEngine.getParakeetStatus();
  });

  ipcMain.handle(
    IPC_CHANNELS.PARAKEET_MODEL_DOWNLOAD,
    async (_event, modelId: ParakeetModelType): Promise<boolean> => {
      try {
        return await sttService.parakeetEngine.downloadModel(modelId);
      } catch (err) {
        console.warn('[Main] Parakeet model download error:', err);
        throw err;
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.PARAKEET_MODEL_DELETE,
    async (_event, modelId: ParakeetModelType): Promise<boolean> => {
      try {
        return sttService.parakeetEngine.deleteModel(modelId);
      } catch (err) {
        console.warn('[Main] Parakeet model delete error:', err);
        throw err;
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.PARAKEET_MODEL_REVEAL,
    async (_event, modelId: ParakeetModelType): Promise<boolean> => {
      try {
        const filePath = sttService.parakeetEngine.revealModelInFolder(modelId);
        if (filePath) {
          shell.showItemInFolder(filePath);
          return true;
        }
        return false;
      } catch (err) {
        console.warn('[Main] Parakeet model reveal error:', err);
        return false;
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.PARAKEET_MODEL_PAUSE, async (): Promise<boolean> => {
    try {
      return sttService.parakeetEngine.pauseDownload();
    } catch (err) {
      console.warn('[Main] Parakeet pause download error:', err);
      return false;
    }
  });

  ipcMain.handle(IPC_CHANNELS.PARAKEET_MODEL_CANCEL, async (): Promise<boolean> => {
    try {
      return sttService.parakeetEngine.cancelDownload();
    } catch (err) {
      console.warn('[Main] Parakeet cancel download error:', err);
      return false;
    }
  });

  // Pluggable STT Engines
  ipcMain.handle(IPC_CHANNELS.STT_ENGINES_GET, async () => {
    return sttService.getEngines();
  });

  // Pluggable LLM Providers
  ipcMain.handle(IPC_CHANNELS.LLM_PROVIDERS_GET, async () => {
    return LLM_PROVIDERS.map((p) => ({ ...p }));
  });

  // macOS Permissions
  ipcMain.handle(IPC_CHANNELS.MACOS_PERMISSIONS_GET, async (): Promise<MacosPermissions> => {
    if (process.platform === 'darwin') {
      try {
        const micStatus = systemPreferences.getMediaAccessStatus('microphone');
        const screenStatus = systemPreferences.getMediaAccessStatus('screen');
        return {
          microphone: micStatus as MacosPermissions['microphone'],
          screen: screenStatus as MacosPermissions['screen'],
        };
      } catch (err) {
        console.warn('[Main] Error getting macOS permissions:', err);
      }
    }
    return {
      microphone: 'granted',
      screen: 'granted',
    };
  });

  ipcMain.handle(IPC_CHANNELS.MACOS_PERMISSION_REQUEST, async (): Promise<boolean> => {
    if (process.platform === 'darwin') {
      try {
        return await systemPreferences.askForMediaAccess('microphone');
      } catch (err) {
        console.warn('[Main] Error asking for microphone media access:', err);
        return false;
      }
    }
    return true;
  });

  // ScreenVision: Text-first Screen Understanding & OCR
  ipcMain.handle(IPC_CHANNELS.SCREENVISION_STATUS_GET, async (): Promise<ScreenVisionStatus> => {
    return screenVisionService.getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.SCREENVISION_CAPTURE_NOW, async (): Promise<ScreenVisionCaptureResult> => {
    return await screenVisionService.captureScreen();
  });

  ipcMain.handle(IPC_CHANNELS.SCREENVISION_CLEAR_PENDING, async (): Promise<boolean> => {
    screenVisionService.clearPendingScans();
    return true;
  });

  ipcMain.handle(
    IPC_CHANNELS.SCREENVISION_MODEL_DOWNLOAD,
    async (_event, modelId: OcrModelId): Promise<boolean> => {
      return await screenVisionService.downloadModel(modelId);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SCREENVISION_MODEL_DELETE,
    async (_event, modelId: OcrModelId): Promise<boolean> => {
      return await screenVisionService.deleteModel(modelId);
    }
  );

  ipcMain.handle(IPC_CHANNELS.CLIPBOARD_WRITE_TEXT, async (_event, text: string): Promise<boolean> => {
    try {
      clipboard.writeText(text || '');
      return true;
    } catch (err) {
      console.warn('[Clipboard] Failed to write text to system clipboard:', err);
      return false;
    }
  });
}

app.whenReady().then(() => {
  // Initialize ScreenVision engine and wire event broadcasters
  screenVisionService.init();

  screenVisionService.onStatusChange((status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.SCREENVISION_STATUS_CHANGED, status);
    }
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send(IPC_CHANNELS.SCREENVISION_STATUS_CHANGED, status);
    }
  });

  screenVisionService.onDownloadProgress((prog) => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send(IPC_CHANNELS.SCREENVISION_DOWNLOAD_PROGRESS, prog);
    }
  });
  // Hide Dock icon on macOS so overlay stays out of Cmd-Tab / Dock
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
  }

  // macOS microphone permission request
  if (process.platform === 'darwin') {
    try {
      systemPreferences
        .askForMediaAccess('microphone')
        .then((granted) => {
          console.log(`[Main] macOS microphone access: ${granted ? 'granted' : 'denied'}`);
        })
        .catch((err) => {
          console.warn('[Main] macOS askForMediaAccess warning:', err);
        });
    } catch (err) {
      console.warn('[Main] systemPreferences access check failed:', err);
    }
  }

  // Synchronous permission check handler
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return permission === 'media' || (permission as string) === 'display-capture';
  });

  // Configure loopback audio capture permission handler (Windows & macOS)
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    let callbackCalled = false;
    const safeCallback = (streams: Parameters<typeof callback>[0]) => {
      if (!callbackCalled) {
        callbackCalled = true;
        try {
          callback(streams);
        } catch (err) {
          console.warn('[Main] setDisplayMediaRequestHandler callback invocation error:', err);
        }
      }
    };

    try {
      // Both Windows and macOS require a screen video source when providing loopback audio to getDisplayMedia
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      if (sources && sources.length > 0) {
        safeCallback({
          video: sources[0],
          audio: 'loopback',
        });
        return;
      }

      // Fallback if screen enumeration returned empty
      safeCallback({ audio: 'loopback' });
    } catch (err) {
      console.warn('[Main] setDisplayMediaRequestHandler error:', err);
      safeCallback({});
    }
  });

  // Automatically approve media permissions for the hidden capture window
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    let callbackCalled = false;
    const safeCallback = (granted: boolean) => {
      if (!callbackCalled) {
        callbackCalled = true;
        try {
          callback(granted);
        } catch (err) {
          console.warn('[Main] setPermissionRequestHandler callback invocation error:', err);
        }
      }
    };

    if (permission === 'media' || (permission as string) === 'display-capture') {
      safeCallback(true);
      return;
    }
    safeCallback(false);
  });

  registerIpcHandlers();
  createOverlayWindow();
  createCaptureWindow();
  registerHotkeys();

  // Auto-start STT session on launch if first-run consent has been accepted
  if (storeService.hasAcceptedConsent()) {
    const settings = storeService.getSettings();
    sttService.start(handleTranscriptSegment, {
      provider: settings.sttProvider,
      parakeetModel: settings.parakeetModel,
      transcriptionMode: settings.transcriptionMode,
      language: settings.sttLanguage,
      diarize: true,
    });
  }

  // Background auto-update check
  updaterService.checkForUpdates().catch((err) => {
    console.warn('[Main] Auto-update check error:', err);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createOverlayWindow();
      createCaptureWindow();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  if (accessibilityPollTimer) {
    clearInterval(accessibilityPollTimer);
    accessibilityPollTimer = null;
  }
  globalShortcut.unregisterAll();
  if (globalKeyboardListener) {
    try {
      globalKeyboardListener.kill();
      globalKeyboardListener = null;
    } catch (err) {
      console.warn('[ScreenVision] Error killing global keyboard listener:', err);
    }
  }
  sttService.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
