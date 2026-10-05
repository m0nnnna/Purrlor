import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatrixClient, Room } from 'matrix-js-sdk';

vi.mock('./mediaWorker', () => ({ mediaWorkerReady: vi.fn(async () => true) }));
vi.mock('./mediaAuth', () => ({ needsMediaAuthentication: vi.fn(async () => true) }));

import { mediaWorkerReady } from './mediaWorker';
import { warmRoomMedia } from './mediaWarm';

type Ev = { type: string; content: Record<string, unknown>; avatar?: string };

function room(events: Ev[]): Room {
  const timeline = events.map((e) => ({
    getType: () => e.type,
    getContent: () => e.content,
    isRedacted: () => false,
    sender: e.avatar ? { getMxcAvatarUrl: () => e.avatar } : null,
  }));
  return { getLiveTimeline: () => ({ getEvents: () => timeline }) } as unknown as Room;
}

const mx = {
  mxcUrlToHttp: (mxc: string, w?: number, h?: number, method?: string) => `https://hs/${mxc.slice(6)}${w ? `?w=${w}&h=${h}&m=${method}` : ''}`,
} as unknown as MatrixClient;

function stubFetch() {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      return new Response('x');
    })
  );
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('warmRoomMedia', () => {
  it('asks for what the timeline will: an inline thumbnail, a whole GIF, a 40px avatar, once each', async () => {
    const urls = stubFetch();
    const r = room([
      { type: 'm.room.message', content: { msgtype: 'm.image', url: 'mxc://a/big', info: { mimetype: 'image/jpeg', w: 4000, h: 3000 } }, avatar: 'mxc://a/face' },
      { type: 'm.room.message', content: { msgtype: 'm.image', url: 'mxc://b/anim', info: { mimetype: 'image/gif', w: 400, h: 300 } }, avatar: 'mxc://a/face' },
      { type: 'm.room.message', content: { msgtype: 'm.text', body: 'hi' } },
    ]);
    await warmRoomMedia(mx, r);
    await warmRoomMedia(mx, r);
    await vi.waitFor(() => expect(urls).toHaveLength(3));
    expect(urls.sort()).toEqual(['https://hs/a/big?w=800&h=600&m=scale', 'https://hs/a/face?w=96&h=96&m=crop', 'https://hs/b/anim'].sort());
  });

  it('does nothing without the worker to keep a copy', async () => {
    vi.mocked(mediaWorkerReady).mockResolvedValueOnce(false);
    const urls = stubFetch();
    await warmRoomMedia(mx, room([{ type: 'm.sticker', content: { url: 'mxc://c/s', info: { mimetype: 'image/png', w: 100, h: 100 } } }]));
    expect(urls).toEqual([]);
  });

  it('leaves encrypted files alone', async () => {
    const urls = stubFetch();
    await warmRoomMedia(mx, room([{ type: 'm.room.message', content: { msgtype: 'm.image', file: { url: 'mxc://d/secret' } } }]));
    expect(urls).toEqual([]);
  });
});
