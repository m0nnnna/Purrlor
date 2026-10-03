import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  describeError,
  errorReportsEnabled,
  pagePattern,
  reportError,
  reportUrl,
  resetErrorReporting,
  setErrorReportsEnabled,
} from './errorReporting';
import { getRuntimeConfig, parseRuntimeConfig } from './runtimeConfig';

vi.mock('./runtimeConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtimeConfig')>();
  return { ...actual, getRuntimeConfig: vi.fn(() => ({})) };
});

describe('pagePattern', () => {
  it('keeps the kind of page and drops who and what', () => {
    expect(pagePattern('/@luna/post/abcdefghijklmnopqrstuvwxyz')).toBe('/:user/post/:id');
    expect(pagePattern('/%40luna%3Apurr.example/music/a1')).toBe('/:user/music/a1');
    expect(pagePattern('/rooms/!abc:purr.example/$event123')).toBe('/rooms/:id/:id');
    expect(pagePattern('/art/12345')).toBe('/art/:id');
    expect(pagePattern('/')).toBe('/');
    expect(pagePattern('')).toBe('/');
  });
});

describe('reportUrl', () => {
  it("is the token server's public API, from the voice endpoint", () => {
    expect(reportUrl('https://purr.example/api/livekit/token')).toBe('https://purr.example/api/public/client-errors');
    expect(reportUrl('https://token.purr.example/api/livekit/token')).toBe('https://token.purr.example/api/public/client-errors');
    expect(reportUrl(undefined)).toBeUndefined();
    expect(reportUrl('not a url')).toBeUndefined();
  });
});

describe('describeError', () => {
  it('keeps the message, stack and page, and nothing else', () => {
    const err = new TypeError('x is undefined');
    const report = describeError(err, '/@luna');
    expect(report).toMatchObject({ message: 'TypeError: x is undefined', where: '/:user' });
    expect(report?.stack).toBe(err.stack);
    expect(Object.keys(report ?? {}).sort()).toEqual(['message', 'stack', 'where']);
  });

  it('takes what a promise rejected with, whatever it is', () => {
    expect(describeError('plain text', '/')?.message).toBe('plain text');
    expect(describeError({ errcode: 'M_FORBIDDEN' }, '/')?.message).toBe('{"errcode":"M_FORBIDDEN"}');
  });

  it('leaves out network trouble, cancelled requests, and extensions', () => {
    expect(describeError(new TypeError('Failed to fetch'), '/')).toBeUndefined();
    expect(describeError(new DOMException('The user aborted a request.', 'AbortError'), '/')).toBeUndefined();
    expect(describeError('Script error.', '/')).toBeUndefined();
    expect(describeError('ResizeObserver loop completed with undelivered notifications.', '/')).toBeUndefined();
    const ext = new Error('boom');
    ext.stack = 'Error: boom\n    at x (chrome-extension://abcdef/content.js:1:1)';
    expect(describeError(ext, '/')).toBeUndefined();
  });
});

describe('reportError', () => {
  const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockClear();
    resetErrorReporting();
    setErrorReportsEnabled(true);
    vi.mocked(getRuntimeConfig).mockReturnValue(parseRuntimeConfig({ tokenEndpoint: 'https://purr.example/api/livekit/token' }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the report to the token server, without credentials', () => {
    reportError(new Error('first'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://purr.example/api/public/client-errors');
    expect(init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'omit' });
    expect(JSON.parse(init.body as string)).toMatchObject({ message: 'Error: first' });
  });

  it('sends the same error once per page, and at most ten', () => {
    const err = new Error('again');
    reportError(err);
    reportError(err);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i++) reportError(new Error(`n${i}`));
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it('sends nothing when turned off, or without a deployment', () => {
    setErrorReportsEnabled(false);
    expect(errorReportsEnabled()).toBe(false);
    reportError(new Error('off'));
    setErrorReportsEnabled(true);
    vi.mocked(getRuntimeConfig).mockReturnValue({});
    reportError(new Error('no deployment'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
