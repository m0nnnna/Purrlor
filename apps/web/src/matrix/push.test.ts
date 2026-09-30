import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatrixClient } from 'matrix-js-sdk';
import { enableBackgroundPush, within, type EnableStep } from './push';

vi.mock('./openIdToken', () => ({ getOpenIdTokenCached: async () => ({ access_token: 't' }) }));

const GATEWAY = 'https://push.example.com';
const mx = { setPusher: vi.fn(async () => ({})), getUserId: () => '@me:example.com' } as unknown as MatrixClient;

/** A browser whose push service answers with `subscribe`, and a gateway that accepts anything. */
function fakeBrowser(subscribe: () => Promise<unknown>, permission: NotificationPermission = 'granted') {
  const registration = { pushManager: { subscribe: vi.fn(subscribe) } };
  vi.stubGlobal('Notification', { requestPermission: async () => permission });
  vi.stubGlobal('navigator', {
    userAgent: 'test',
    language: 'en',
    serviceWorker: { register: async () => registration, ready: Promise.resolve(registration) },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.endsWith('/vapid-public-key') ? new Response(JSON.stringify({ publicKey: 'AAAA' })) : new Response(null, { status: 200 })
    )
  );
}

const subscription = { toJSON: () => ({ endpoint: 'https://fcm.example/1' }) };

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('within', () => {
  it('passes a settled promise through, and rejects with the message when it takes too long', async () => {
    await expect(within(Promise.resolve(1), 1000, 'slow')).resolves.toBe(1);
    vi.useFakeTimers();
    const stuck = within(new Promise(() => undefined), 1000, 'too slow');
    const assertion = expect(stuck).rejects.toThrow('too slow');
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });
});

describe('enableBackgroundPush', () => {
  it('reports each step as it starts, and ends by setting the pusher', async () => {
    fakeBrowser(async () => subscription);
    const steps: EnableStep[] = [];
    await enableBackgroundPush(mx, GATEWAY, (step) => steps.push(step));
    expect(steps).toEqual(['permission', 'service-worker', 'push-service', 'gateway', 'homeserver']);
    expect(mx.setPusher).toHaveBeenCalled();
  });

  it('gives up on a push service that never answers, saying so, instead of spinning forever', async () => {
    fakeBrowser(() => new Promise(() => undefined));
    vi.useFakeTimers();
    const steps: EnableStep[] = [];
    const enabling = enableBackgroundPush(mx, GATEWAY, (step) => steps.push(step));
    const assertion = expect(enabling).rejects.toThrow('Your browser’s push service didn’t answer');
    // Slow is fine: still waiting after a minute.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(steps[steps.length - 1]).toBe('push-service');
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it('says whose refusal it is when the browser turns the subscription down', async () => {
    fakeBrowser(async () => {
      throw new DOMException('Registration failed - push service error', 'AbortError');
    });
    await expect(enableBackgroundPush(mx, GATEWAY)).rejects.toThrow(
      'Your browser’s push service refused: Registration failed - push service error'
    );
  });

  it('points at the site settings when notifications are blocked', async () => {
    fakeBrowser(async () => subscription, 'denied');
    await expect(enableBackgroundPush(mx, GATEWAY)).rejects.toThrow('Notifications are blocked for this site');
  });
});
