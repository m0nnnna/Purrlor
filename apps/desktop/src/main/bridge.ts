/**
 * The bridge: the page (apps/web/src/desktop/desktopBridge.ts) asks the app for things. The
 * protocol is the one the 1.x app spoke, unchanged (apps/desktop/README.md, "The bridge"):
 *
 *   page → app:  { purrlor: 1, id, method, params }
 *   app → page:  { purrlor: 1, id, result } or { purrlor: 1, id, error }
 *                { purrlor: 1, event, data }
 */
import type { WantedBinding } from './hotkeys';
import type { UpdateStatus } from './updater';

export type BridgeSettings = { startWithWindows: boolean; closeToTray: boolean; autoUpdate: boolean };

export type BridgeHost = {
  version: string;
  platform: string;
  settings(): BridgeSettings;
  setSetting(name: string, value: boolean): void;
  setHotkeys(bindings: WantedBinding[]): string[];
  setBadge(count: number): void;
  watchIdle(minutes: number): void;
  update(): UpdateStatus;
  checkForUpdates(): void;
  installUpdate(): void;
  changeServer(): void;
};

export class BridgeError extends Error {}

const SETTINGS = new Set(['startWithWindows', 'closeToTray', 'autoUpdate']);

function object(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function handleRequest(host: BridgeHost, method: unknown, params: unknown): unknown {
  const p = object(params);
  switch (method) {
    case 'getInfo':
      return { version: host.version, platform: host.platform, settings: host.settings(), update: host.update() };
    case 'setSetting': {
      const name = p?.name;
      const value = p?.value;
      if (typeof name !== 'string' || typeof value !== 'boolean') throw new BridgeError('setSetting takes a name and a true/false value.');
      if (!SETTINGS.has(name)) throw new BridgeError(`There’s no desktop setting called ${name}.`);
      host.setSetting(name, value);
      return host.settings();
    }
    case 'setHotkeys': {
      const list = p?.bindings;
      if (!Array.isArray(list)) throw new BridgeError('setHotkeys takes a list of bindings.');
      const wanted: WantedBinding[] = list.map((item) => {
        const b = object(item);
        const id = b?.id;
        const code = b?.code;
        if (typeof id !== 'string' || !id || typeof code !== 'string' || !code) throw new BridgeError('Each binding needs an id and a code.');
        return { id, code, ctrl: b?.ctrl === true, alt: b?.alt === true, shift: b?.shift === true };
      });
      return { unknown: host.setHotkeys(wanted) };
    }
    case 'setBadge': {
      const count = p?.count;
      if (typeof count !== 'number' || !Number.isInteger(count)) throw new BridgeError('setBadge takes a count.');
      host.setBadge(Math.max(0, count));
      return null;
    }
    case 'watchIdle': {
      const minutes = p?.minutes;
      if (typeof minutes !== 'number' || !Number.isInteger(minutes)) throw new BridgeError('watchIdle takes a number of minutes (0 stops).');
      host.watchIdle(minutes);
      return null;
    }
    case 'checkForUpdates':
      host.checkForUpdates();
      return host.update();
    case 'installUpdate':
      if (host.update().state !== 'ready') throw new BridgeError('There’s no update downloaded yet.');
      host.installUpdate();
      return null;
    case 'changeServer':
      host.changeServer();
      return null;
    default:
      throw new BridgeError(`The desktop app doesn’t know ${String(method)}.`);
  }
}

/** One message from the page, answered; null when it isn't a bridge request at all. */
export function answer(host: BridgeHost, text: string, onError: (method: unknown, err: unknown) => void): object | null {
  let message: Record<string, unknown> | null;
  try {
    message = object(JSON.parse(text));
  } catch {
    return null;
  }
  if (!message || message.purrlor !== 1 || typeof message.id !== 'number' || !Number.isInteger(message.id)) return null;
  const id = message.id;
  try {
    return { purrlor: 1, id, result: handleRequest(host, message.method, message.params) ?? null };
  } catch (err) {
    if (err instanceof BridgeError) return { purrlor: 1, id, error: err.message };
    onError(message.method, err);
    return { purrlor: 1, id, error: 'The desktop app couldn’t do that.' };
  }
}

export function event(name: string, data: unknown): object {
  return { purrlor: 1, event: name, data };
}
