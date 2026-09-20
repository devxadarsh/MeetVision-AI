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
  const x = Math.round((screenWidth - windowWidth) / 2);
  const y = 32;

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

  // Always on top at screen-saver level so it floats over fullscreen / presentation apps
  mainWindow.setAlwaysOnTop(true, 'screen-saver');

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

async function handleTranscriptSegment(segment: TranscriptSegment): Promise<void> {
  // 1. Broadcast segment to overlay for Live Transcript view
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.TRANSCRIPT_UPDATE, segment);
  }

  // 2. On final segments, evaluate question detection and answer generation
  if (segment.isFinal) {
    recentTranscript.push(segment.text);
    if (recentTranscript.length > 25) {
      recentTranscript.shift();
    }

    const detectedQuestion = detector.evaluate(segment);
    if (detectedQuestion) {
      if (segment.speaker) {
        detectedQuestion.speaker = segment.speaker;
      }
      questionsMap.set(detectedQuestion.id, detectedQuestion);
      if (questionsMap.size > 50) {
        const oldestKey = questionsMap.keys().next().value;
        if (oldestKey) questionsMap.delete(oldestKey);
      }

      // Emit new detected question to overlay
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.QUESTION_NEW, detectedQuestion);
      }

      // Retrieve top matching local knowledge base snippets (RAG)
      const relevantSnippets = knowledgeService.retrieveRelevantSnippets(detectedQuestion.text);

      // Stream LLM answer bullets tailored to context profile & knowledge docs
      const settings = storeService.getSettings();
      llmService.generateAnswerStream(
        detectedQuestion,
        recentTranscript,
        {
          mode: 'short',
          profile: storeService.getContextProfile(),
          apiKey: storeService.getDecryptedAnthropicKey(),
          model: settings.llmModel,
          temperature: settings.temperature,
          maxTokens: settings.maxTokens,
          knowledgeSnippets: relevantSnippets,
        },
        (chunk) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.ANSWER_CHUNK, chunk);
          }
        }
      );
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

  ipcMain.handle(IPC_CHANNELS.OVERLAY_SET_OPACITY, async (_event, opacity: number) => {
    const clamped = Math.max(0.2, Math.min(1.0, Number(opacity) || 0.88));
    storeService.updateSettings({ overlayOpacity: clamped });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.OVERLAY_OPACITY_CHANGED, clamped);
    }
    return clamped;
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
      apiKey: storeService.getDecryptedDeepgramKey(),
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
    };
  });

  // Audio chunk from capture window
  ipcMain.on(IPC_CHANNELS.AUDIO_CHUNK, (_event, chunk: ArrayBuffer) => {
    sttService.feedAudio(chunk);
  });

  // Audio energy level for meter
  ipcMain.on(IPC_CHANNELS.AUDIO_LEVEL, (_event, level: number) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.AUDIO_LEVEL, level);
    }
  });

  // Clear transcript
  ipcMain.handle(IPC_CHANNELS.TRANSCRIPT_CLEAR, async () => {
    recentTranscript.length = 0;
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
        const settings = storeService.getSettings();
        const relevantSnippets = knowledgeService.retrieveRelevantSnippets(question.text);
        await llmService.generateAnswerStream(
          question,
          recentTranscript,
          {
            mode: payload.mode,
            profile: storeService.getContextProfile(),
            apiKey: storeService.getDecryptedAnthropicKey(),
            model: settings.llmModel,
            temperature: settings.temperature,
            maxTokens: settings.maxTokens,
            knowledgeSnippets: relevantSnippets,
          },
          (chunk) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send(IPC_CHANNELS.ANSWER_CHUNK, chunk);
            }
          }
        );
      }
    }
  );

  // Settings & Profile (Milestone 4)
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, async () => {
    return storeService.getSettings();
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, async (_event, newSettings: AppSettings) => {
    const updated = storeService.updateSettings(newSettings);
    if (mainWindow && !mainWindow.isDestroyed() && typeof updated.overlayOpacity === 'number') {
      mainWindow.webContents.send(IPC_CHANNELS.OVERLAY_OPACITY_CHANGED, updated.overlayOpacity);
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
        apiKey: storeService.getDecryptedDeepgramKey(),
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
      apiKey: storeService.getDecryptedDeepgramKey(),
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
