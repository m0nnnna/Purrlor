/**
 * Talking to the Purrlor desktop app (apps/desktop), when this page is running inside it.
 *
 * The desktop app hosts this page in WebView2, which gives it `window.chrome.webview`: a message
 * channel to the app around it. A browser has no such object, so `desktopBridge()` is null there
 * and everything desktop-only stays hidden. The app only answers messages from the server it was
 * pointed at (see apps/desktop/README.md, "The bridge"), and this side only trusts replies from it.
 *
 * Messages are JSON, all tagged `purrlor: 1` (the protocol version):
 *   page → app:  { purrlor: 1, id, method, params }
 *   app → page:  { purrlor: 1, id, result } or { purrlor: 1, id, error }
 *                { purrlor: 1, event, data }   (things the app tells the page unasked)
 */

type WebViewChannel = {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (e: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (e: MessageEvent) => void): void;
};

/** What the desktop app tells the page about itself and its own settings. */
export type DesktopInfo = {
  version: string;
  settings: DesktopSettings;
  /** Desktop 1.2.0 on. */
  update?: DesktopUpdate;
};

/** Where the app's auto-update is (apps/desktop/Purrlor/Updater.cs). */
export type DesktopUpdate = {
  state: 'idle' | 'checking' | 'upToDate' | 'downloading' | 'ready' | 'failed';
  /** The new version, while one is downloading or ready (or failed to). */
  version: string | null;
  error: string | null;
  releaseUrl: string | null;
  /** False in a build that can't verify updates: it only says one exists. */
  automatic: boolean;
};

export type DesktopSettings = {
  startWithWindows: boolean;
  /** The window's close button hides Purrlor in the tray (true) or quits it (false). */
  closeToTray: boolean;
  /** Desktop 1.2.0 on: download updates by itself. */
  autoUpdate?: boolean;
};

type Reply = { purrlor: 1; id: number; result?: unknown; error?: string };
type AppEvent = { purrlor: 1; event: string; data?: unknown };

export type DesktopBridge = {
  request<T>(method: string, params?: unknown): Promise<T>;
  on(event: string, listener: (data: unknown) => void): () => void;
};

const TIMEOUT_MS = 5000;
let bridge: DesktopBridge | null | undefined;

function channel(): WebViewChannel | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { chrome?: { webview?: WebViewChannel } }).chrome?.webview;
}

function isOurs(data: unknown): data is Reply | AppEvent {
  return typeof data === 'object' && data !== null && (data as { purrlor?: unknown }).purrlor === 1;
}

function createBridge(webview: WebViewChannel): DesktopBridge {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, Set<(data: unknown) => void>>();

  webview.addEventListener('message', (e) => {
    const data: unknown = e.data;
    if (!isOurs(data)) return;
    if ('event' in data) {
      listeners.get(data.event)?.forEach((l) => l(data.data));
      return;
    }
    const waiting = pending.get(data.id);
    if (!waiting) return;
    pending.delete(data.id);
    if (data.error !== undefined) waiting.reject(new Error(data.error));
    else waiting.resolve(data.result);
  });

  return {
    request<T>(method: string, params?: unknown): Promise<T> {
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`The desktop app didn’t answer (${method})`));
        }, TIMEOUT_MS);
        pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v as T);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
        webview.postMessage({ purrlor: 1, id, method, params });
      });
    },
    on(event, listener) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(listener);
      return () => set.delete(listener);
    },
  };
}

/** The desktop app, or null in a browser. */
export function desktopBridge(): DesktopBridge | null {
  if (bridge === undefined) {
    const webview = channel();
    bridge = webview ? createBridge(webview) : null;
  }
  return bridge;
}

export function isDesktopApp(): boolean {
  return desktopBridge() !== null;
}
