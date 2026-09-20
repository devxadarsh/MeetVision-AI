import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import {
  IPC_CHANNELS,
  ElectronAPI,
  HotkeyAction,
  SessionStatus,
  TranscriptSegment,
  Question,
  AnswerChunk,
  RegeneratePayload,
  AppSettings,
} from '@shared/ipc';

const api: ElectronAPI = {
  ping: (message: string): Promise<string> => {
    return ipcRenderer.invoke(IPC_CHANNELS.PING, message);
  },
  getDiagnostics: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.APP_DIAGNOSTICS);
  },
  setClickThrough: (ignore: boolean): Promise<boolean> => {
    return ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_SET_CLICK_THROUGH, ignore);
  },
  getClickThrough: (): Promise<boolean> => {
    return ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_GET_CLICK_THROUGH);
  },
  setOverlaySize: (width: number, height: number): Promise<{ width: number; height: number }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_SET_SIZE, { width, height });
  },
  getOverlaySize: (): Promise<{ width: number; height: number }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_GET_SIZE);
  },
  setOverlayOpacity: (opacity: number): Promise<number> => {
    return ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_SET_OPACITY, opacity);
  },
  onOverlayOpacityChanged: (callback: (opacity: number) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, opacity: number) => {
      callback(opacity);
    };
    ipcRenderer.on(IPC_CHANNELS.OVERLAY_OPACITY_CHANGED, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.OVERLAY_OPACITY_CHANGED, handler);
    };
  },
  setMultiWorkspace: (enabled: boolean): Promise<boolean> => {
    return ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_SET_MULTI_WORKSPACE, enabled);
  },
  onMultiWorkspaceChanged: (callback: (enabled: boolean) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, enabled: boolean) => {
      callback(enabled);
    };
    ipcRenderer.on(IPC_CHANNELS.OVERLAY_MULTI_WORKSPACE_CHANGED, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.OVERLAY_MULTI_WORKSPACE_CHANGED, handler);
    };
  },
  setOverlayVersion: (version: 'v1' | 'v2'): Promise<'v1' | 'v2'> => {
    return ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_SET_VERSION, version);
  },
  onOverlayVersionChanged: (callback: (version: 'v1' | 'v2') => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, version: 'v1' | 'v2') => {
      callback(version);
    };
    ipcRenderer.on(IPC_CHANNELS.OVERLAY_VERSION_CHANGED, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.OVERLAY_VERSION_CHANGED, handler);
    };
  },
  close: (): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_CLOSE);
  },
  onHotkey: (callback: (action: HotkeyAction) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, action: HotkeyAction) => {
      callback(action);
    };
    ipcRenderer.on(IPC_CHANNELS.HOTKEY_TRIGGERED, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.HOTKEY_TRIGGERED, handler);
    };
  },
  startSession: (): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SESSION_START);
  },
  stopSession: (): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SESSION_STOP);
  },
  getSessionStatus: (): Promise<SessionStatus> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SESSION_GET_STATUS);
  },
  sendAudioChunk: (chunk: ArrayBuffer): void => {
    ipcRenderer.send(IPC_CHANNELS.AUDIO_CHUNK, chunk);
  },
  sendAudioLevel: (level: number): void => {
    ipcRenderer.send(IPC_CHANNELS.AUDIO_LEVEL, level);
  },
  onAudioLevel: (callback: (level: number) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, level: number) => {
      callback(level);
    };
    ipcRenderer.on(IPC_CHANNELS.AUDIO_LEVEL, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.AUDIO_LEVEL, handler);
    };
  },
  onTranscriptUpdate: (callback: (segment: TranscriptSegment) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, segment: TranscriptSegment) => {
      callback(segment);
    };
    ipcRenderer.on(IPC_CHANNELS.TRANSCRIPT_UPDATE, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.TRANSCRIPT_UPDATE, handler);
    };
  },
  clearTranscript: (): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TRANSCRIPT_CLEAR);
  },
  onTranscriptClear: (callback: () => void): (() => void) => {
    const handler = () => {
      callback();
    };
    ipcRenderer.on(IPC_CHANNELS.TRANSCRIPT_CLEAR, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.TRANSCRIPT_CLEAR, handler);
    };
  },
  // Question & Answer channels (Milestone 3)
  onQuestionNew: (callback: (question: Question) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, question: Question) => {
      callback(question);
    };
    ipcRenderer.on(IPC_CHANNELS.QUESTION_NEW, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.QUESTION_NEW, handler);
    };
  },
  onAnswerChunk: (callback: (chunk: AnswerChunk) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, chunk: AnswerChunk) => {
      callback(chunk);
    };
    ipcRenderer.on(IPC_CHANNELS.ANSWER_CHUNK, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.ANSWER_CHUNK, handler);
    };
  },
  regenerateAnswer: (payload: RegeneratePayload): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.ANSWER_REGENERATE, payload);
  },
  // Settings & Profile channels (Milestone 4)
  getSettings: (): Promise<AppSettings> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET);
  },
  setSettings: (settings: AppSettings): Promise<AppSettings> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, settings);
  },
  openSettings: (): Promise<boolean> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_OPEN);
  },
  onSettingsVisibilityChanged: (callback: (isOpen: boolean) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, isOpen: boolean) => {
      callback(isOpen);
    };
    ipcRenderer.on(IPC_CHANNELS.SETTINGS_VISIBILITY_CHANGED, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SETTINGS_VISIBILITY_CHANGED, handler);
    };
  },
  // Milestone 6: Consent & Data Purge
  acceptConsent: (): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.CONSENT_ACCEPT);
  },
  clearAllData: (): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.DATA_CLEAR_ALL);
  },
  // Milestone 7: Knowledge Base & Meeting Summary
  listKnowledgeDocs: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_LIST);
  },
  addKnowledgeDoc: (doc) => {
    return ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_ADD, doc);
  },
  removeKnowledgeDoc: (id: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_REMOVE, id);
  },
  generateMeetingSummary: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.SUMMARY_GENERATE);
  },
  exportMeetingSummary: (markdown: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.SUMMARY_EXPORT, markdown);
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);
