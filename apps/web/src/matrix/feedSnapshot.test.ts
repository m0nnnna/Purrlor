import { describe, expect, it } from 'vitest';
import { MatrixEvent } from 'matrix-js-sdk';
import { applyPostEdits } from './feed';
import { fromStoredSnapshot, SNAPSHOT_POSTS, toStoredSnapshot } from './feedSnapshot';
import type { FeedSource, GlobalPost } from './globalFeed';

const source: FeedSource = { roomId: '!feed:cats', owner: '@mochi:cats', ownerName: 'Mochi', origin: { kind: 'global' }, isPublic: true };
const unused: FeedSource = { ...source, roomId: '!other:cats', owner: '@sol:cats' };

function post(id: string, ts: number, body = id): GlobalPost {
  const event = new MatrixEvent({ type: 'xyz.nekous.post', event_id: id, sender: source.owner, room_id: source.roomId, origin_server_ts: ts, content: { body } });
  return { eventId: id, ts, event, source };
}

describe('feed snapshots', () => {
  it('round-trips posts, their sources and the edits that apply to them', () => {
    const edit = new MatrixEvent({
      type: 'xyz.nekous.post',
      event_id: '$edit',
      sender: source.owner,
      origin_server_ts: 5,
      content: { body: '* fixed', 'm.new_content': { body: 'fixed' }, 'm.relates_to': { rel_type: 'm.replace', event_id: '$a' } },
    });
    const elsewhere = new MatrixEvent({
      type: 'xyz.nekous.post',
      event_id: '$edit2',
      sender: source.owner,
      content: { body: '* x', 'm.new_content': { body: 'x' }, 'm.relates_to': { rel_type: 'm.replace', event_id: '$gone' } },
    });
    const stored = toStoredSnapshot({ sources: [source, unused], posts: [post('$b', 2), post('$a', 1, 'typo')], publicSpaces: [] }, [edit, elsewhere]);
    // Only what a kept post needs, and plain data (it goes into IndexedDB).
    expect(stored.sources).toEqual([source]);
    expect(stored.edits).toHaveLength(1);
    expect(structuredClone(stored)).toEqual(stored);

    const back = fromStoredSnapshot(structuredClone(stored));
    expect(back.posts.map((p) => [p.eventId, p.ts, p.source.roomId])).toEqual([
      ['$b', 2, '!feed:cats'],
      ['$a', 1, '!feed:cats'],
    ]);
    applyPostEdits(back.posts.map((p) => p.event), back.edits);
    expect(back.posts[1].event.getContent().body).toBe('fixed');
  });

  it('keeps no local echo or encrypted post, and at most a few screens', () => {
    const echo = post('~local', 3);
    const encrypted = post('$enc', 2);
    encrypted.event.event.type = 'm.room.encrypted';
    const many = Array.from({ length: SNAPSHOT_POSTS + 10 }, (_, i) => post(`$p${i}`, 100 - i));
    const stored = toStoredSnapshot({ sources: [source], posts: [echo, encrypted, ...many], publicSpaces: [] }, []);
    expect(stored.posts).toHaveLength(SNAPSHOT_POSTS);
    expect(stored.posts.some((p) => p.raw.event_id === '~local' || p.raw.event_id === '$enc')).toBe(false);
  });
});
