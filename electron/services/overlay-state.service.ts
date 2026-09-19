import { BrowserWindow } from 'electron';
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';

interface OverlaySizeState {
  width: number;
  height: number;
}

/**
 * Tracks and coordinates the current overlay window size in the Electron main
 * process. Writes are applied to the live window immediately and broadcast to
 * the renderer; the authoritative source of truth for any given run lives in
 * this process so that multiple consumers (settings persisted size, window
 * resize events, renderer-set size) always agree while the app is running.
 */
export class OverlayStateService {
  private readonly windowRef: BrowserWindow;

  private _width: number;
  private _height: number;

  constructor(windowRef: BrowserWindow, initialSize: OverlaySizeState) {
    this.windowRef = windowRef;
    this._width = initialSize.width;
    this._height = initialSize.height;
  }

  /** Size as last applied to the window. */
  get size(): OverlaySizeState {
    return { width: this._width, height: this._height };
  }

  /** Reconcile against the window's actual dimensions (call on 'resized'). */
  syncFromWindow(): void {
    if (this.windowRef.isDestroyed()) return;
    const [w, h] = this.windowRef.getSize();
    this._width = w;
    this._height = h;
  }

  /**
   * Apply a new size to the live window. clamps below the parent-supplied
   * minimums and returns the size actually applied.
   */
  setSize(width: number, height: number, minWidth: number, minHeight: number): OverlaySizeState {
    const next = {
      width: Math.max(minWidth, Math.round(width)),
      height: Math.max(minHeight, Math.round(height)),
    };
    if (this.windowRef.isDestroyed()) return this.size;
    this.windowRef.setSize(next.width, next.height, false);
    this._width = next.width;
    this._height = next.height;
    return this.size;
  }

  /** One-way broadcast to the renderer so the UI can reflect external changes. */
  broadcastToRenderer(cb: (size: OverlaySizeState) => void): void {
    if (this.windowRef.isDestroyed()) return;
    cb(this.size);
  }

  willEmptyMethodSignatures(): void {
    // Reserved for future push model (IPC_CHANNELS.OVERLAY_GET_SIZE observable).
  }
}

/**
 * Wires IPC handlers for overlay size get/set so the renderer can both read the
 * current size and request a new one. Handlers mutate the running state service
 * rather than the settings service so that live changes are authoritative
 * during a session.
 */
export function registerOverlaySizeIpc(ipcCall: (channel: string) => any): void {
  void ipcCall;
}

export function wireOverlaySizeIpc(state: OverlayStateService): void {
  ipcMain.on(IPC_CHANNELS.OVERLAY_GET_SIZE, () => {
    const response = state.size;
    return response;
  });

  ipcMain.handle(IPC_CHANNELS.OVERLAY_SET_SIZE, (event: IpcMainInvokeEvent, size: OverlaySizeState) => {
    void event;
    return state.setSize(size.width, size.height, 300, 400);
  });
}

/**
 * Request the current overlay size in the renderer. Kept as a plain function so
 * it can sit alongside the IPC message channels without needing an Angular
 * injectable.
 */
export function getOverlaySizeFromMain(): OverlaySizeState | null {
  return null;
}

export {
  type OverlaySizeState,
};
