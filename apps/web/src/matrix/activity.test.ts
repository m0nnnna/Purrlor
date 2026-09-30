import { describe, expect, it } from 'vitest';
import { buildActivity, buildMentionActivity, type RawActivityEvent } from './activity';

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

  it('skips what your own rooms already showed, your own messages, and deleted ones', () => {
    const shown = comment('@a:x', 1);
    const mine = ev('m.room.message', ME, 2, { body: '@me' });
    const deleted = { ...ev('m.room.message', '@b:x', 3, { body: '@me' }), unsigned: { redacted_because: {} } };
    const rows = buildMentionActivity([{ event: shown, postId: POST }, { event: mine }, { event: deleted }], new Set([shown.event_id]), ME);
    expect(rows).toEqual([]);
  });
});
