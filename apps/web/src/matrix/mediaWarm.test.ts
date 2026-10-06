import { afterEach, describe, expect, it, vi } from 'vitest';
import { MatrixEvent, type MatrixClient, type Room } from 'matrix-js-sdk';
import type { GlobalPost } from './globalFeed';

vi.mock('./mediaWorker', () => ({ mediaWorkerReady: vi.fn(async () => true) }));
vi.mock('./mediaAuth', () => ({ needsMediaAuthentication: vi.fn(async () => true) }));

import { mediaWorkerReady } from './mediaWorker';
import { warmPostMedia, warmRoomMedia } from './mediaWarm';

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

describe('warmPostMedia', () => {
  function post(content: Record<string, unknown>, ownerAvatarUrl?: string): GlobalPost {
    const event = new MatrixEvent({ type: 'xyz.nekous.post', event_id: `$${Math.random()}`, sender: '@m:cats', content });
    return { eventId: event.getId()!, ts: 0, event, source: { roomId: '!f', owner: '@m:cats', ownerName: 'M', ownerAvatarUrl, origin: { kind: 'global' }, isPublic: true } };
  }
  const image = (url: string, extra: Record<string, unknown> = {}) => ({ kind: 'image', url, name: 'x', info: { mimetype: 'image/jpeg', size: 1, w: 3000, h: 2000 }, ...extra });

  it('asks for a post’s pictures as PostMedia shows them, and its author’s avatar', async () => {
    const urls = stubFetch();
    await warmPostMedia(mx, [
      post({ body: 'look', 'xyz.nekous.attachments': [image('mxc://p/one'), { kind: 'video', url: 'mxc://p/clip', name: 'v', info: { mimetype: 'video/mp4', size: 1 } }] }, 'mxc://p/me'),
    ]);
    await vi.waitFor(() => expect(urls).toHaveLength(2));
    expect(urls.sort()).toEqual(['https://hs/p/me?w=96&h=96&m=crop', 'https://hs/p/one?w=800&h=600&m=scale']);
  });

  it('leaves covered and encrypted media alone', async () => {
    const urls = stubFetch();
    await warmPostMedia(mx, [
      post({ body: 'cw', 'xyz.nekous.content_warning': 'spoilers', 'xyz.nekous.attachments': [image('mxc://p/hidden')] }),
      post({ body: 'nsfw', 'xyz.nekous.sensitive': true, 'xyz.nekous.attachments': [image('mxc://p/blurred')] }),
      post({ body: 'secret', 'xyz.nekous.attachments': [{ ...image('mxc://p/enc'), url: undefined, file: { url: 'mxc://p/enc' } }] }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(urls).toEqual([]);
  });
});
