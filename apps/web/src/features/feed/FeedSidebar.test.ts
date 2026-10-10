import { describe, expect, it } from 'vitest';
import { MatrixEvent } from 'matrix-js-sdk';
import { POST_EVENT_TYPE } from '../../matrix/feed';
import type { GlobalPost } from '../../matrix/globalFeed';
import { trendingTags } from './FeedSidebar';

const NOW = Date.UTC(2026, 9, 10, 20, 0, 0);
const HOUR = 60 * 60 * 1000;

function post(body: string, ts: number): GlobalPost {
  const event = new MatrixEvent({ type: POST_EVENT_TYPE, event_id: `$${body}${ts}`, room_id: '!feed', sender: '@a:x', origin_server_ts: ts, content: { body } });
  return { eventId: event.getId()!, ts, event, source: {} as GlobalPost['source'] };
}

describe('trendingTags', () => {
  it('counts each tag once per post, most used first', () => {
    const posts = [post('#owls at #owls', NOW - HOUR), post('more #owls and #3am', NOW - 2 * HOUR), post('#catcafe', NOW - 3 * HOUR)];
    expect(trendingTags(posts, NOW)).toEqual([
      { tag: 'owls', count: 2 },
      { tag: '3am', count: 1 },
      { tag: 'catcafe', count: 1 },
    ]);
  });

  it('leaves out posts older than a day', () => {
    expect(trendingTags([post('#old', NOW - 25 * HOUR)], NOW)).toEqual([]);
  });
});
