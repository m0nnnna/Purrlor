import { app } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where Purrlor keeps its things. On Windows that's %LOCALAPPDATA%\Purrlor, the same folder the
 * 1.x app (C# and WebView2) used, so its settings.json carries over; the browser data goes in
 * App\ beside it rather than Electron's default roaming folder, since it's large and per-machine.
 * On Linux it's ~/.config/Purrlor, the usual place.
 */
export const isWindows = process.platform === 'win32';
export const isLinux = process.platform === 'linux';

export function rootDir(): string {
  // For tests and trying a build side by side with an installed copy.
  if (process.env.PURRLOR_DATA_DIR) return process.env.PURRLOR_DATA_DIR;
  if (isWindows) return join(process.env.LOCALAPPDATA ?? app.getPath('appData'), 'Purrlor');
  return app.getPath('userData');
}

/** Called once at startup, before anything reads app.getPath('userData'). */
export function configurePaths(): void {
  app.setName('Purrlor');
  if (isWindows || process.env.PURRLOR_DATA_DIR) app.setPath('userData', join(rootDir(), 'App'));
  else app.setPath('userData', join(app.getPath('appData'), 'Purrlor'));
}

export const settingsFile = () => join(rootDir(), 'settings.json');
export const updatesDir = () => join(rootDir(), 'Updates');
/** The 1.x app's WebView2 profile: its sign-ins can't be carried over to Chromium's. */
export const legacyWebViewDir = () => join(rootDir(), 'WebView2');

export function logError(context: string, error: unknown): void {
  try {
    mkdirSync(rootDir(), { recursive: true });
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    appendFileSync(join(rootDir(), 'errors.log'), `${new Date().toISOString()} ${context}: ${detail}\n`);
  } catch {
    // Nowhere left to report it.
  }
}
