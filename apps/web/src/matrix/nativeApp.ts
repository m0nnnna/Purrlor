/**
 * The Android app (apps/android) runs this web client in its own WebView and hands it a few
 * native abilities as `window.PurrlorNative`: notifications that arrive with the app closed
 * (through a UnifiedPush app, which a WebView's own Push API can't do) and a foreground service
 * that keeps a voice call alive in the background. Everywhere else there is no bridge, and every
 * function here quietly does nothing. The contract is in docs/android.md.
 */
type Bridge = {
  /** JSON: NativePushState. */
  pushState(): string;
  /** Asks for the notification permission and a UnifiedPush endpoint; answers with a `purrlor-native-push` event. */
  enablePush(): void;
  disablePush(): void;
  /** Shows a local notification, as proof that they work on this device. */
  testNotification(): void;
  /** Whether a voice call is going on, so the app keeps running when it leaves the screen. */
  callActive(active: boolean): void;
  /** Whether the microphone is off, for the call notification's Mute / Unmute button. */
  callMuted(muted: boolean): void;
};

export type NativePushState = {
  /** The UnifiedPush endpoint the distributor gave the app, once it has one. */
  endpoint: string;
  /** How many UnifiedPush apps (ntfy and the like) are installed. */
  distributors: number;
  /** Whether the app may show notifications (Android 13 asks). */
  allowed: boolean;
};

/** The event the app fires on `window` when its push state changes. */
export const NATIVE_PUSH_EVENT = 'purrlor-native-push';
/** The event the app fires when a notification was tapped while the page was open. `detail.roomId`. */
export const NATIVE_OPEN_ROOM_EVENT = 'purrlor-open-room';

export function nativeBridge(): Bridge | undefined {
  const bridge = (window as unknown as { PurrlorNative?: Bridge }).PurrlorNative;
  return bridge && typeof bridge.pushState === 'function' ? bridge : undefined;
}

export function nativePushState(): NativePushState {
  try {
    const state = JSON.parse(nativeBridge()?.pushState() ?? '{}') as Partial<NativePushState>;
    return {
      endpoint: typeof state.endpoint === 'string' ? state.endpoint : '',
      distributors: typeof state.distributors === 'number' ? state.distributors : 0,
      allowed: state.allowed !== false,
    };
  } catch {
    return { endpoint: '', distributors: 0, allowed: true };
  }
}

/** Resolves with the endpoint once the app has one; rejects after `ms`. */
export function waitForNativeEndpoint(ms: number, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const { endpoint } = nativePushState();
      if (!endpoint) return false;
      cleanup();
      resolve(endpoint);
      return true;
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(message));
    }, ms);
    const listener = () => void check();
    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener(NATIVE_PUSH_EVENT, listener);
    }
    window.addEventListener(NATIVE_PUSH_EVENT, listener);
    check();
  });
}

/** Tells the app whether a call is going on. */
export function reportCallActive(active: boolean): void {
  try {
    nativeBridge()?.callActive(active);
  } catch {
    // A bridge that can't be reached just means no background call.
  }
}

/** The event the app fires on `window` when a button on the call notification is pressed: detail.action is `mute` or `leave`. */
export const NATIVE_CALL_ACTION_EVENT = 'purrlor-call-action';

/** Tells the app whether the microphone is off, so the call notification's button reads right. */
export function reportCallMuted(muted: boolean): void {
  try {
    nativeBridge()?.callMuted(muted);
  } catch {
    // An older app without the method: the button just keeps its label.
  }
}
