import { afterEach, describe, expect, it, vi } from 'vitest';
import { NATIVE_PUSH_EVENT, nativeBridge, nativePushState, reportCallActive, reportCallMuted, waitForNativeEndpoint } from './nativeApp';

function installBridge(state: object) {
  const bridge = { pushState: vi.fn(() => JSON.stringify(state)), enablePush: vi.fn(), disablePush: vi.fn(), testNotification: vi.fn(), callActive: vi.fn(), callMuted: vi.fn() };
  (window as unknown as { PurrlorNative?: unknown }).PurrlorNative = bridge;
  return bridge;
}

afterEach(() => {
  delete (window as unknown as { PurrlorNative?: unknown }).PurrlorNative;
  vi.useRealTimers();
});

describe('the Android app bridge', () => {
  it('is absent in a browser, and every call does nothing', () => {
    expect(nativeBridge()).toBeUndefined();
    expect(nativePushState()).toEqual({ endpoint: '', distributors: 0, allowed: true });
    expect(() => reportCallActive(true)).not.toThrow();
    expect(() => reportCallMuted(true)).not.toThrow();
  });

  it('reads the app’s push state, and tolerates nonsense', () => {
    installBridge({ endpoint: 'https://ntfy.example/up1', distributors: 2, allowed: false });
    expect(nativePushState()).toEqual({ endpoint: 'https://ntfy.example/up1', distributors: 2, allowed: false });
    installBridge({ endpoint: 5 });
    expect(nativePushState().endpoint).toBe('');
  });

  it('tells the app when a call starts and ends', () => {
    const bridge = installBridge({});
    reportCallActive(true);
    reportCallActive(false);
    expect(bridge.callActive.mock.calls).toEqual([[true], [false]]);
  });

  it('tells the app when the microphone goes off or on', () => {
    const bridge = installBridge({});
    reportCallMuted(true);
    reportCallMuted(false);
    expect(bridge.callMuted.mock.calls).toEqual([[true], [false]]);
  });

  it('waits for the endpoint to arrive, and gives up with the message otherwise', async () => {
    vi.useFakeTimers();
    const state: { endpoint?: string } = {};
    const bridge = installBridge(state);
    bridge.pushState.mockImplementation(() => JSON.stringify(state));
    const arrived = waitForNativeEndpoint(1000, 'nope');
    state.endpoint = 'https://ntfy.example/up1';
    window.dispatchEvent(new Event(NATIVE_PUSH_EVENT));
    await expect(arrived).resolves.toBe('https://ntfy.example/up1');

    delete state.endpoint;
    const late = waitForNativeEndpoint(1000, 'nope');
    const failure = expect(late).rejects.toThrow('nope');
    await vi.advanceTimersByTimeAsync(1001);
    await failure;
  });
});
