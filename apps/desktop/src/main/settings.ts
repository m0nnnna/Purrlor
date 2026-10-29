import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type Bounds = { x: number; y: number; width: number; height: number };

export type Settings = {
  serverUrl: string | null;
  bounds: Bounds | null;
  maximized: boolean;
  /** Start in the tray when you sign in to the computer. The bridge calls it startWithWindows. */
  startOnLogin: boolean;
  /** The close button hides Purrlor in the tray (true) or quits it. */
  closeToTray: boolean;
  autoUpdate: boolean;
  trayHintShown: boolean;
  /** Came from the 1.x app, whose sign-ins stayed in WebView2: say so once. */
  migrationNoticePending: boolean;
};

export const defaults: Settings = {
  serverUrl: null,
  bounds: null,
  maximized: false,
  startOnLogin: false,
  closeToTray: true,
  autoUpdate: true,
  trayHintShown: false,
  migrationNoticePending: false,
};

const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

function bounds(v: unknown): Bounds | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  // The 1.x app wrote .NET's Rectangle: X, Y, Width, Height.
  const pick = (a: string, b: string) => (typeof o[a] === 'number' ? o[a] : o[b]) as unknown;
  const [x, y, width, height] = [pick('x', 'X'), pick('y', 'Y'), pick('width', 'Width'), pick('height', 'Height')];
  if (![x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return { x: x as number, y: y as number, width: width as number, height: height as number };
}

/**
 * Reads settings.json. A file from the 1.x app (PascalCase: ServerUrl, StartWithWindows…) reads
 * the same, and marks that its sign-ins need doing again.
 */
export function parseSettings(text: string | null): Settings {
  if (!text) return { ...defaults };
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...defaults };
    raw = parsed as Record<string, unknown>;
  } catch {
    return { ...defaults };
  }
  const legacy = !('version' in raw) && ('ServerUrl' in raw || 'CloseToTray' in raw || 'StartWithWindows' in raw);
  const get = (camel: string, pascal: string) => (camel in raw ? raw[camel] : raw[pascal]);
  const server = get('serverUrl', 'ServerUrl');
  return {
    serverUrl: typeof server === 'string' && server ? server : null,
    bounds: bounds(get('bounds', 'Bounds')),
    maximized: bool(get('maximized', 'Maximized'), defaults.maximized),
    startOnLogin: bool(get('startOnLogin', 'StartWithWindows'), defaults.startOnLogin),
    closeToTray: bool(get('closeToTray', 'CloseToTray'), defaults.closeToTray),
    autoUpdate: bool(get('autoUpdate', 'AutoUpdate'), defaults.autoUpdate),
    trayHintShown: bool(get('trayHintShown', 'TrayHintShown'), defaults.trayHintShown),
    migrationNoticePending: legacy ? true : bool(raw.migrationNoticePending, false),
  };
}

export class SettingsStore {
  private value: Settings;

  constructor(private readonly file: string) {
    let text: string | null = null;
    try {
      if (existsSync(file)) text = readFileSync(file, 'utf8');
    } catch {
      text = null;
    }
    this.value = parseSettings(text);
  }

  get(): Readonly<Settings> {
    return this.value;
  }

  update(change: Partial<Settings>): Readonly<Settings> {
    this.value = { ...this.value, ...change };
    this.save();
    return this.value;
  }

  save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      // Written beside and renamed over, so a crash mid-write can't leave half a file.
      const temp = `${this.file}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: 2, ...this.value }, null, 2));
      renameSync(temp, this.file);
    } catch {
      // A read-only profile: settings just don't stick.
    }
  }
}
