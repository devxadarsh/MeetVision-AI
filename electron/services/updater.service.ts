import { app } from 'electron';
import { autoUpdater } from 'electron-updater';

export class UpdaterService {
  private isChecking = false;

  constructor() {
    // Configure logger and updater settings
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
      console.log('[UpdaterService] Checking for updates...');
    });

    autoUpdater.on('update-available', (info) => {
      console.log(`[UpdaterService] Update available: v${info.version}`);
    });

    autoUpdater.on('update-not-available', (info) => {
      console.log(`[UpdaterService] App is up to date (current: v${info.version}).`);
    });

    autoUpdater.on('error', (err) => {
      console.warn('[UpdaterService] Auto-update check encountered an error:', err?.message || err);
    });

    autoUpdater.on('update-downloaded', (info) => {
      console.log(`[UpdaterService] Update v${info.version} downloaded; will install on quit.`);
    });
  }

  async checkForUpdates(): Promise<void> {
    if (!app.isPackaged) {
      console.log('[UpdaterService] Skipping update check in development / unpacked mode.');
      return;
    }

    if (this.isChecking) return;
    this.isChecking = true;

    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      console.warn('[UpdaterService] Failed checking for updates:', err);
    } finally {
      this.isChecking = false;
    }
  }
}
