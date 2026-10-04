import type { MatrixClient } from 'matrix-js-sdk';

/**
 * The service worker (public/sw.js) can put the access token on this homeserver's media
 * requests, so `<img>`, `<video>` and `<audio>` point straight at a media URL instead of a blob
 * of the whole file fetched first. Video then streams (range requests), images are cached by
 * the browser and load lazily, and another server's media starts showing while it's still
 * arriving rather than after every byte has.
 *
 * The worker never stores the token: it asks the page for it, per request, over a
 * MessageChannel, and only adds it to requests for the homeserver's own media endpoints.
 */

const PING_TIMEOUT_MS = 1000;
/** Bumped when the worker's half changes in a way the page must know about. */
export const MEDIA_WORKER_VERSION = 1;

let activeClient: MatrixClient | null = null;
let ready: Promise<boolean> | null = null;

function onWorkerMessage(event: MessageEvent) {
  if (event.data?.type !== 'purrlor-media-token') return;
  const port = event.ports[0];
  if (!port) return;
  const mx = activeClient;
  port.postMessage(mx ? { homeserver: mx.getHomeserverUrl(), token: mx.getAccessToken() } : null);
}

/** Lets the worker add this client's token to its media requests. Called once the client starts. */
export function startMediaWorkerAuth(mx: MatrixClient): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (!activeClient) {
    navigator.serviceWorker.addEventListener('message', onWorkerMessage);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      ready = null;
    });
  }
  activeClient = mx;
}

/** Signed out: the worker gets no token from this page any more. */
export function stopMediaWorkerAuth(): void {
  activeClient = null;
  ready = null;
}

/** Whether the worker is controlling this page and speaks this version of the media protocol. */
export function mediaWorkerReady(): Promise<boolean> {
  if (!activeClient || typeof navigator === 'undefined' || !navigator.serviceWorker?.controller) {
    return Promise.resolve(false);
  }
  if (!ready) {
    const controller = navigator.serviceWorker.controller;
    ready = new Promise<boolean>((resolve) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(false), PING_TIMEOUT_MS);
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        resolve(event.data?.version === MEDIA_WORKER_VERSION);
      };
      controller.postMessage({ type: 'purrlor-media-ping' }, [channel.port2]);
    });
  }
  return ready;
}
