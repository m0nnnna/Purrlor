import { describe, expect, it, vi } from 'vitest';
import type { MatrixClient } from 'matrix-js-sdk';
import { buildActivity, buildMentionActivity, createActivityReader, isUnread, markChannelReads, type ActivityItem, type RawActivityEvent } from './activity';

const ME = '@me:x';
const POST = '$post';
let seq = 0;

function ev(type: string, sender: string, ts: number, content: Record<string, unknown>): RawActivityEvent {
  seq += 1;
  return { event_id: `$e${seq}`, room_id: '!mine', type, sender, origin_server_ts: ts, content };
}

const like = (sender: string, ts: number, post = POST) =>
  ev('m.reaction', sender, ts, { 'm.relates_to': { rel_type: 'm.annotation', event_id: post, key: '❤️' } });

const comment = (sender: string, ts: number, replyTo?: string) =>
  ev('xyz.nekous.comment', sender, ts, {
    body: 'hi',
    'm.relates_to': { rel_type: 'm.reference', event_id: POST },
    ...(replyTo && { 'xyz.nekous.reply_to': { event_id: '$c', sender: replyTo } }),
  });

const repost = (sender: string, ts: number, quote = false) =>
  ev('xyz.nekous.repost', sender, ts, {
    'xyz.nekous.repost_event': { room_id: '!theirs', event_id: `$q${ts}`, quote },
    'm.relates_to': { rel_type: 'm.reference', event_id: POST },
  });

describe('buildActivity', () => {
  it('groups likes per post, newest liker first, and keeps comments separate', () => {
    const rows = buildActivity([like('@a:x', 1), like('@b:x', 3), comment('@c:x', 2), like('@a:x', 4, '$other')], ME);
    expect(rows.map((row) => [row.kind, row.senders])).toEqual([
      ['like', ['@a:x']],
      ['like', ['@b:x', '@a:x']],
      ['comment', ['@c:x']],
    ]);
    expect(rows[1]).toMatchObject({ postId: POST, ts: 3 });
  });

  it('tells a reply to you from a comment, and a quote from a repost', () => {
    const rows = buildActivity(
      [comment('@a:x', 1, ME), comment('@b:x', 2, '@b:x'), repost('@c:x', 3), repost('@d:x', 4, true)],
      ME
    );
    expect(rows.map((row) => row.kind)).toEqual(['quote', 'repost', 'comment', 'reply']);
    expect(rows[0].quote).toEqual({ roomId: '!theirs', eventId: '$q4' });
  });

  it("doesn't count a repost of a comment under your post as a repost of the post", () => {
    const ofComment = ev('xyz.nekous.repost', '@c:x', 5, {
      'xyz.nekous.repost_event': { room_id: '!theirs', event_id: '$r', quote: false },
      'xyz.nekous.comment': '$c',
      'm.relates_to': { rel_type: 'm.reference', event_id: POST },
    });
    expect(buildActivity([ofComment], ME)).toEqual([]);
  });

  it('skips your own actions, undone ones, and other reactions', () => {
    const undone = { ...like('@a:x', 2), unsigned: { redacted_because: {} } };
    const laugh = ev('m.reaction', '@b:x', 3, { 'm.relates_to': { rel_type: 'm.annotation', event_id: POST, key: '😂' } });
    expect(buildActivity([like(ME, 1), undone, laugh], ME)).toEqual([]);
  });

  it('puts one day of new followers in one row', () => {
    const day = new Date(2026, 8, 26, 10).getTime();
    const rows = buildActivity(
      [
        ev('xyz.nekous.followed', '@a:x', day, {}),
        ev('xyz.nekous.followed', '@b:x', day + 1000, {}),
        ev('xyz.nekous.followed', '@c:x', day - 86_400_000, {}),
      ],
      ME
    );
    expect(rows.map((row) => row.senders)).toEqual([['@b:x', '@a:x'], ['@c:x']]);
  });
});

describe('buildMentionActivity', () => {
  it('turns chat, post and comment mentions into rows, and a comment answering you into a reply', () => {
    const chat = { ...ev('m.room.message', '@a:x', 1, { body: 'hey @me' }), room_id: '!channel' };
    const inPost = ev('xyz.nekous.post', '@b:x', 2, { body: 'with @me' });
    const answer = comment('@c:x', 3, ME);
    const rows = buildMentionActivity(
      [{ event: chat }, { event: inPost, postId: inPost.event_id }, { event: answer, postId: POST }],
      new Set(),
      ME
    );
    expect(rows.map((row) => [row.kind, row.roomId, row.postId])).toEqual([
      ['mention', '!channel', undefined],
      ['mention', '!mine', inPost.event_id],
      ['reply', '!mine', POST],
    ]);
  });

  it('tells a reply in your thread, and a like on your comment', () => {
    const inThread = ev('xyz.nekous.comment', '@a:x', 1, {
      body: 'me too',
      'xyz.nekous.reply_to': { event_id: '$b', sender: '@b:x' },
      'xyz.nekous.thread': '$root',
      'm.mentions': { user_ids: ['@b:x', ME] },
      'm.relates_to': { rel_type: 'm.reference', event_id: POST },
    });
    const named = ev('xyz.nekous.comment', '@a:x', 2, {
      body: `hey ${ME}`,
      'xyz.nekous.reply_to': { event_id: '$b', sender: '@b:x' },
      'xyz.nekous.thread': '$root',
      'm.relates_to': { rel_type: 'm.reference', event_id: POST },
    });
    const liked = ev('xyz.nekous.comment_like', '@c:x', 3, {
      'xyz.nekous.comment': '$mine',
      'm.mentions': { user_ids: [ME] },
      'm.relates_to': { rel_type: 'm.reference', event_id: POST },
    });
    const rows = buildMentionActivity(
      [{ event: inThread, postId: POST }, { event: named, postId: POST }, { event: liked, postId: POST }],
      new Set(),
      ME
    );
    expect(rows.map((row) => row.kind)).toEqual(['thread', 'mention', 'commentLike']);
    expect(rows[2]).toMatchObject({ commentId: '$mine', postId: POST });
  });

  it('skips what your own rooms already showed, your own messages, and deleted ones', () => {
    const shown = comment('@a:x', 1);
    const mine = ev('m.room.message', ME, 2, { body: '@me' });
    const deleted = { ...ev('m.room.message', '@b:x', 3, { body: '@me' }), unsigned: { redacted_because: {} } };
    const rows = buildMentionActivity([{ event: shown, postId: POST }, { event: mine }, { event: deleted }], new Set([shown.event_id]), ME);
    expect(rows).toEqual([]);
  });
});

describe('createActivityReader', () => {
  function client() {
    const accountData: Record<string, unknown> = {
      'xyz.nekous.profile_room': { roomId: '!profile' },
      'xyz.nekous.feed_rooms': { '!space': '!feed' },
      'xyz.nekous.mention_inbox': { items: [{ roomId: '!chan', eventId: '$m1', mentionedAt: 1 }] },
    };
    const authedRequest = vi.fn(async (_method: string, path: string) => ({
      chunk: path.includes('!feed') ? [{ ...like('@a:x', 5), room_id: undefined }] : [],
    }));
    const fetchRoomEvent = vi.fn(async (_roomId: string, eventId: string) => ({
      event_id: eventId,
      type: 'm.room.message',
      sender: '@b:x',
      origin_server_ts: 9,
      content: { body: 'hi @me' },
    }));
    const mx = {
      getUserId: () => ME,
      getRoom: () => null,
      getAccountData: (type: string) => (accountData[type] ? { getContent: () => accountData[type] } : undefined),
      http: { authedRequest },
      fetchRoomEvent,
    } as unknown as MatrixClient;
    return { mx, authedRequest, fetchRoomEvent, accountData };
  }
  const roomsRead = (calls: unknown[][]) => calls.map((call) => decodeURIComponent(String(call[1])).split('/')[2]);

  it('reads everything once, then only the room that changed, and each mention once', async () => {
    const c = client();
    const reader = createActivityReader(c.mx);

    const first = await reader.read();
    expect(roomsRead(c.authedRequest.mock.calls).sort()).toEqual(['!feed', '!profile']);
    expect(first.map((item) => item.kind)).toEqual(['mention', 'like']);

    c.authedRequest.mockClear();
    const second = await reader.read({ rooms: ['!feed'] });
    expect(roomsRead(c.authedRequest.mock.calls)).toEqual(['!feed']);
    expect(c.fetchRoomEvent).toHaveBeenCalledTimes(1);
    expect(second).toHaveLength(2);
  });

  it('drops a mention once it’s deleted or leaves the inbox', async () => {
    const c = client();
    const reader = createActivityReader(c.mx);
    await reader.read();
    expect(reader.forget('!chan', '$m1')).toBe(true);
    c.accountData['xyz.nekous.mention_inbox'] = { items: [] };
    const items = await reader.read({ rooms: [] });
    expect(items.map((item) => item.kind)).toEqual(['like']);
  });
});

describe('a chat mention you read in its channel', () => {
  const item = (over: Partial<ActivityItem>): ActivityItem => ({
    key: 'k',
    kind: 'mention',
    senders: ['@a:x'],
    ts: 100,
    roomId: '!chan',
    eventId: '$m',
    ...over,
  });
  const client = (readEvents: string[]) =>
    ({
      getUserId: () => ME,
      getRoom: (roomId: string) => (roomId === '!chan' ? { hasUserReadEvent: (_u: string, eventId: string) => readEvents.includes(eventId) } : null),
    }) as unknown as MatrixClient;

  it('stops counting as new once your read receipt covers it, and only chat mentions do', () => {
    const chat = item({});
    const inPost = item({ key: 'p', eventId: '$p', postId: '$post' });
    const like = item({ key: 'l', kind: 'like', eventId: '$l' });

    const unread = markChannelReads(client([]), [chat, inPost, like]);
    expect(unread.map((i) => isUnread(i, 0))).toEqual([true, true, true]);

    const read = markChannelReads(client(['$m', '$p']), [chat, inPost, like]);
    // The post mention has no read receipt to go by, even if its event ID matched one.
    expect(read.map((i) => isUnread(i, 0))).toEqual([false, true, true]);
  });

  it('keeps the same array when nothing changed, and counts only what’s newer than you last looked', () => {
    const items = [item({})];
    expect(markChannelReads(client([]), items)).toBe(items);
    expect(isUnread(item({ ts: 100 }), 100)).toBe(false);
    expect(isUnread(item({ ts: 101 }), 100)).toBe(true);
  });

  it('a room it can’t see leaves it counting', () => {
    expect(isUnread(markChannelReads(client(['$m']), [item({ roomId: '!gone' })])[0], 0)).toBe(true);
  });
});
