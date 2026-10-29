import { app, dialog, shell } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PurrlorApp } from './app';
import { configurePaths, isWindows, logError, settingsFile } from './paths';
import { SettingsStore } from './settings';

const APP_ID = 'net.meowops.purrlor';

configurePaths();
if (isWindows) app.setAppUserModelId(APP_ID);
// Media keys and the system's media controls (Windows' flyout, MPRIS on Linux) drive Purrlor's
// music player through the page's Media Session, which Chromium handles itself.
app.commandLine.appendSwitch('enable-features', 'HardwareMediaKeyHandling,WebRTCPipeWireCapturer');

process.on('uncaughtException', (err) => logError('fatal', err));
process.on('unhandledRejection', (err) => logError('unhandled', err));

// One copy per user: a second launch (Start menu, desktop shortcut, the installer's "run now")
// just brings the running one out of the tray.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  let purrlor: PurrlorApp | null = null;
  app.on('second-instance', () => purrlor?.show());
  app.on('before-quit', () => purrlor?.allowQuitting());
  app.on('will-quit', () => purrlor?.dispose());
  // The window hides to the tray, so closing it isn't quitting.
  app.on('window-all-closed', () => undefined);
  app.on('web-contents-created', (_e, contents) => {
    // Nothing here ever needs a <webview>.
    contents.on('will-attach-webview', (e) => e.preventDefault());
  });

  void app.whenReady().then(async () => {
    try {
      if (isWindows) ensureStartMenuShortcut();
      const startHidden = process.argv.includes('--tray');
      purrlor = new PurrlorApp(new SettingsStore(settingsFile()), startHidden);
      await purrlor.start();
    } catch (err) {
      logError('startup', err);
      dialog.showErrorBox('Purrlor couldn’t start', err instanceof Error ? err.message : String(err));
      app.exit(1);
    }
  });
}

/**
 * Windows only shows an app's notifications if a Start menu shortcut carries its
 * AppUserModelID. The installer makes the shortcut; this keeps the ID on it, pointing at this copy.
 */
function ensureStartMenuShortcut(): void {
  if (!app.isPackaged) return;
  try {
    const dir = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Purrlor');
    const link = join(dir, 'Purrlor.lnk');
    const wanted = { target: process.execPath, appUserModelId: APP_ID, icon: process.execPath, iconIndex: 0, description: 'Purrlor' };
    if (existsSync(link)) {
      const current = shell.readShortcutLink(link);
      if (current.target === wanted.target && current.appUserModelId === APP_ID) return;
      shell.writeShortcutLink(link, 'replace', wanted);
    } else {
      mkdirSync(dir, { recursive: true });
      shell.writeShortcutLink(link, 'create', wanted);
    }
  } catch (err) {
    logError('start menu shortcut', err);
  }
}
