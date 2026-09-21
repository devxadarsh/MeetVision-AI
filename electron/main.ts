import { app, BrowserWindow, globalShortcut, ipcMain, screen, session, systemPreferences } from 'electron';
import * as path from 'path';
import * as url from 'url';
import {
  IPC_CHANNELS,
  HotkeyAction,
  TranscriptSegment,
  SessionStatus,
  Question,
  RegeneratePayload,
  AppSettings,
  AppDiagnostics,
  TranscriptionMode,
  AudioChunkPayload,
  MacosPermissions,
  ParakeetStatus,
  ParakeetModelType,
} from '@shared/ipc';
import { SttService } from './services/stt.service';
import { QuestionDetector } from './services/detector.service';
import { LlmService } from './services/llm.service';
import { StoreService } from './services/store.service';
import { UpdaterService } from './services/updater.service';
import { KnowledgeService } from './services/knowledge.service';
import { SummaryService } from './services/summary.service';

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

  if (isDev) {
    const devUrl = 'http://localhost:4200/#/overlay';
    mainWindow.loadURL(devUrl).catch((err) => {
      console.warn('Initial loadURL failed, retrying in 1s:', err);
      setTimeout(() => {
        mainWindow?.loadURL(devUrl);
      }, 1000);
    });
  } else {
    const distPath = path.join(__dirname, '../dist/QuestionLens/browser/index.html');
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
    captureWindow.loadURL(devUrl).catch((err) => {
      console.warn('Capture window initial loadURL failed, retrying in 1s:', err);
      setTimeout(() => {
        captureWindow?.loadURL(devUrl);
      }, 1000);
    });
  } else {
    const distPath = path.join(__dirname, '../dist/QuestionLens/browser/index.html');
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
    title: 'QuestionLens Settings',
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
    const distPath = path.join(__dirname, '../dist/QuestionLens/browser/index.html');
    settingsWindow.loadURL(url.pathToFileURL(distPath).href + '#/settings');
  }

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

  // Clear questions
  globalShortcut.register('CommandOrControl+Shift+C', () => {
    sendHotkeyToRenderer('clear');
  });

  // Pin latest question
  globalShortcut.register('CommandOrControl+Shift+P', () => {
    sendHotkeyToRenderer('pin');
  });

  // Copy latest answer
  globalShortcut.register('CommandOrControl+Shift+Y', () => {
    sendHotkeyToRenderer('copy-answer');
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
}

function generateAnswerForQuestion(question: Question, mode: 'short' | 'detailed' | 'simple' = 'short'): void {
  question.status = 'answering';
  questionsMap.set(question.id, question);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.QUESTION_NEW, question);
  }

  const settings = storeService.getSettings();
  const relevantSnippets = knowledgeService.retrieveRelevantSnippets(question.text);

  llmService.generateAnswerStream(
    question,
    recentTranscript,
    {
      mode,
      profile: storeService.getContextProfile(),
      apiKey: storeService.getDecryptedAnthropicKey(),
      model: settings.llmModel,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      knowledgeSnippets: relevantSnippets,
    },
    (chunk) => {
      if (chunk.isFinal && question.answer) {
        question.status = 'answered';
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

  // 1. Broadcast segment to overlay for Live Transcript view
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.TRANSCRIPT_UPDATE, segment);
  }

  // 2. On final segments, evaluate question detection and voice answer triggers
  if (segment.isFinal) {
    recentTranscript.push(segment.text);
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

  // Regenerate Answer (Milestones 3, 4 & 7)
  ipcMain.handle(
    IPC_CHANNELS.ANSWER_REGENERATE,
    async (_event, payload: RegeneratePayload) => {
      const question = questionsMap.get(payload.questionId);
      if (question) {
        generateAnswerForQuestion(question, payload.mode);
      }
    }
  );

  // Answer Question (Voice / UI Manual Trigger)
  ipcMain.handle(
    IPC_CHANNELS.QUESTION_ANSWER,
    async (_event, payload?: string | { questionId?: string; text?: string; speaker?: string }) => {
      let targetQuestion: Question | undefined;
      const questionId = typeof payload === 'string' ? payload : payload?.questionId;
      const segmentText = typeof payload === 'object' ? payload?.text?.trim() : undefined;
      const segmentSpeaker = typeof payload === 'object' ? payload?.speaker : undefined;

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
        targetQuestion =
          [...allQuestions].reverse().find((q) => q.status === 'unanswered') ||
          allQuestions[allQuestions.length - 1];
      }

      if (targetQuestion) {
        generateAnswerForQuestion(targetQuestion);
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
    return storeService.getSettings();
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, async (_event, newSettings: AppSettings) => {
    const updated = storeService.updateSettings(newSettings);
    await sttService.applySettings(updated);

    const activeModel = sttService.getModelName();
    const activeProvider = sttService.getProviderName();

    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.SETTINGS_CHANGED, updated);
      }
    }

    // Broadcast a system segment in the live transcript stream so user sees the exact model switch
    if (sttService.isActive()) {
      const modelLabel = activeModel ? `${activeProvider} • ${activeModel}` : activeProvider;
      handleTranscriptSegment({
        id: `model-switch-${Date.now()}`,
        speaker: 'System',
        text: `[Active Speech-to-Text Model: ${modelLabel}]`,
        startMs: 0,
        endMs: 0,
        isFinal: true,
      });
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

  // Pluggable STT Engines
  ipcMain.handle(IPC_CHANNELS.STT_ENGINES_GET, async () => {
    return sttService.getEngines();
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
}

app.whenReady().then(() => {
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

  // Configure loopback audio capture permission handler
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
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
      if (process.platform === 'win32') {
        safeCallback({
          audio: 'loopback',
        });
        return;
      }

      // On macOS and other platforms, loopback string is not supported directly in getDisplayMedia.
      // Calling callback with empty streams rejects getDisplayMedia cleanly,
      // allowing capture window to fall back to getUserMedia (microphone / BlackHole).
      safeCallback({});
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
  globalShortcut.unregisterAll();
  sttService.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
