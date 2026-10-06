import { describe, expect, it, vi } from 'vitest';
import { MatrixEvent, type MatrixClient } from 'matrix-js-sdk';
import { fromStoredSnapshot, SNAPSHOT_POSTS, toStoredSnapshot, updateFeed, type FeedSnapshot } from './feedSnapshot';
import type { FeedSource, GlobalPost } from './globalFeed';

const source: FeedSource = { roomId: '!feed:cats', owner: '@mochi:cats', ownerName: 'Mochi', origin: { kind: 'global' }, isPublic: true };
const other: FeedSource = { ...source, roomId: '!other:cats', owner: '@sol:cats' };

function raw(id: string, ts: number, body = id, extra: Record<string, unknown> = {}) {
  return { type: 'xyz.nekous.post', event_id: id, sender: source.owner, room_id: source.roomId, origin_server_ts: ts, content: { body }, ...extra };
}

function post(id: string, ts: number, body = id, from = source): GlobalPost {
  const event = new MatrixEvent({ ...raw(id, ts, body), sender: from.owner, room_id: from.roomId });
  return { eventId: id, ts, event, source: from };
}

function snapshot(posts: GlobalPost[], rooms: FeedSnapshot['rooms']): FeedSnapshot {
  return { at: 1, sourcesAt: 1, sources: [source, other], posts, rooms, publicSpaces: [], truncated: false, unreadable: 0 };
}

describe('feed snapshots', () => {
  it('round-trips posts, every feed and how far it was read, and the edits that apply', () => {
    const edit = new MatrixEvent({
      type: 'xyz.nekous.post',
      event_id: '$edit',
      sender: source.owner,
      origin_server_ts: 5,
      content: { body: '* fixed', 'm.new_content': { body: 'fixed' }, 'm.relates_to': { rel_type: 'm.replace', event_id: '$a' } },
    });
    const stored = toStoredSnapshot(snapshot([post('$b', 2), post('$a', 1, 'typo')], { '!feed:cats': { token: 't1' }, '!other:cats': {} }), [edit]);
    expect(stored.sources).toEqual([source, other]);
    expect(stored.rooms).toEqual({ '!feed:cats': { token: 't1' }, '!other:cats': {} });
    // Plain data: it goes into IndexedDB.
    expect(structuredClone(stored)).toEqual(stored);

    const back = fromStoredSnapshot(structuredClone(stored));
    expect(back.posts.map((p) => [p.eventId, p.ts, p.source.roomId])).toEqual([
      ['$b', 2, '!feed:cats'],
      ['$a', 1, '!feed:cats'],
    ]);
    expect(back.posts[1].event.getContent().body).toBe('fixed');
  });

  it('keeps no local echo or encrypted post, and marks a feed whose posts were left out to be read again', () => {
    const encrypted = post('$enc', 500, 'secret', other);
    encrypted.event.event.type = 'm.room.encrypted';
    const many = Array.from({ length: SNAPSHOT_POSTS + 5 }, (_, i) => post(`$p${i}`, 400 - i));
    const stored = toStoredSnapshot(snapshot([post('~local', 999), encrypted, ...many], { '!feed:cats': { token: 't' }, '!other:cats': { token: 'u' } }), []);
    expect(stored.posts).toHaveLength(SNAPSHOT_POSTS);
    expect(stored.posts.some((p) => p.raw.event_id === '~local' || p.raw.event_id === '$enc')).toBe(false);
    expect(stored.rooms).toEqual({ '!feed:cats': { cut: true }, '!other:cats': { cut: true } });
  });
});

describe('bringing a kept feed up to date', () => {
  function client(chunk: Record<string, unknown>[]) {
    const authedRequest = vi.fn(async () => ({ chunk }));
    const createMessagesRequest = vi.fn(async () => ({ chunk: [raw('$top', 50)], end: 'next' }));
    return { mx: { http: { authedRequest }, createMessagesRequest } as unknown as MatrixClient, authedRequest, createMessagesRequest };
  }

  it('asks only for the newest posts, adds them, drops deleted ones, and keeps where older ones carry on', async () => {
    const { mx, createMessagesRequest } = client([
      raw('$new', 30),
      raw('$b', 20, '', { content: {}, unsigned: { redacted_because: { type: 'm.room.redaction' } } }),
      raw('$a', 10),
    ]);
    const read = await updateFeed(mx, source, [post('$b', 20), post('$a', 10)], { token: 'older' }, false);
    expect(read.posts.map((p) => p.eventId)).toEqual(['$new', '$a']);
    expect(read.token).toBe('older');
    expect(createMessagesRequest).not.toHaveBeenCalled();
  });

  it('reads from the top when there may be a gap, or nothing reaches its token', async () => {
    const newest = Array.from({ length: 10 }, (_, i) => raw(`$n${i}`, 100 - i));
    const gap = client(newest);
    expect((await updateFeed(gap.mx, source, [post('$a', 10)], { token: 'older' }, false)).token).toBe('next');
    expect(gap.createMessagesRequest).toHaveBeenCalled();

    const cut = client([]);
    await updateFeed(cut.mx, source, [post('$a', 10)], { cut: true }, false);
    expect(cut.authedRequest).not.toHaveBeenCalled();
    expect(cut.createMessagesRequest).toHaveBeenCalled();
  });

  it('asks nothing for a feed just read, and shows the kept posts when asking fails', async () => {
    const { mx, authedRequest } = client([]);
    expect((await updateFeed(mx, source, [post('$a', 10)], {}, true)).posts.map((p) => p.eventId)).toEqual(['$a']);
    expect(authedRequest).not.toHaveBeenCalled();

    authedRequest.mockRejectedValueOnce(new Error('offline'));
    expect((await updateFeed(mx, source, [post('$a', 10)], { token: 't' }, false)).posts.map((p) => p.eventId)).toEqual(['$a']);
  });
});
