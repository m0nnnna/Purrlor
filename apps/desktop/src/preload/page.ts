import { contextBridge, ipcRenderer } from 'electron';

/**
 * The Purrlor page's side of the bridge. The web client (apps/web/src/desktop/desktopBridge.ts)
 * was written against WebView2's `window.chrome.webview` message channel, so this gives the page
 * exactly that: postMessage out, 'message' events in, carrying the same JSON. The main process
 * answers only the configured server's own top-level page (see bridge.ts).
 *
 * It also makes a click on one of the page's notifications bring the window forward, which
 * Chromium leaves to the page (and window.focus() can't do from the tray).
 */
type Api = { send(text: string): void; onMessage(listener: (text: string) => void): void; focus(): void };

const api: Api = {
  send: (text) => ipcRenderer.send('page:bridge', text),
  onMessage: (listener) => {
    ipcRenderer.on('page:bridge', (_e, text: string) => listener(text));
  },
  focus: () => ipcRenderer.send('page:focus'),
};

contextBridge.executeInMainWorld({
  func: (bridge: Api) => {
    const listeners = new Set<(e: MessageEvent) => void>();
    bridge.onMessage((text) => {
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        return;
      }
      const event = new MessageEvent('message', { data });
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (err) {
          console.error(err);
        }
      }
    });
    const webview = Object.freeze({
      postMessage(message: unknown) {
        bridge.send(JSON.stringify(message));
      },
      addEventListener(type: string, listener: (e: MessageEvent) => void) {
        if (type === 'message' && typeof listener === 'function') listeners.add(listener);
      },
      removeEventListener(type: string, listener: (e: MessageEvent) => void) {
        if (type === 'message') listeners.delete(listener);
      },
    });
    const w = window as unknown as { chrome?: Record<string, unknown> };
    if (!w.chrome || typeof w.chrome !== 'object') {
      Object.defineProperty(window, 'chrome', { value: {}, configurable: false, writable: false });
    }
    Object.defineProperty(w.chrome, 'webview', { value: webview, configurable: false, writable: false });

    const Native = window.Notification;
    if (typeof Native === 'function') {
      class PurrlorNotification extends Native {
        constructor(title: string, options?: NotificationOptions) {
          super(title, options);
          this.addEventListener('click', () => bridge.focus());
        }
      }
      Object.defineProperty(PurrlorNotification, 'permission', { get: () => Native.permission });
      Object.defineProperty(PurrlorNotification, 'requestPermission', { value: Native.requestPermission.bind(Native) });
      Object.defineProperty(window, 'Notification', { value: PurrlorNotification, configurable: true, writable: true });
    }
  },
  args: [api],
});
