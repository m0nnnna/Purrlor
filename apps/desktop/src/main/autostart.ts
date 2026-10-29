import { app } from 'electron';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isWindows, logError } from './paths';

/**
 * Start Purrlor (in the tray) when you sign in. Windows: the Run key, through Electron's login
 * item, pointing at wherever this copy is installed now. Linux: an XDG autostart entry, which
 * GNOME, KDE and the rest all read; an AppImage points it at the AppImage file, not the
 * temporary mount it's running from.
 */
function autostartFile(): string {
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(config, 'autostart', 'purrlor.desktop');
}

function quote(arg: string): string {
  return /[\s"'\\$`]/.test(arg) ? `"${arg.replace(/(["\\$`])/g, '\\$1')}"` : arg;
}

export function linuxAutostartEntry(exec: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Purrlor',
    'Comment=Start Purrlor in the tray',
    `Exec=${quote(exec)} --tray`,
    'Icon=purrlor',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

export function setStartOnLogin(enabled: boolean): void {
  if (!app.isPackaged) return;
  try {
    if (isWindows) {
      app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: ['--tray'], name: 'Purrlor' });
      return;
    }
    const file = autostartFile();
    if (!enabled) {
      rmSync(file, { force: true });
      return;
    }
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, linuxAutostartEntry(process.env.APPIMAGE || process.execPath));
  } catch (err) {
    logError('start on login', err);
  }
}
