import { describe, expect, it } from 'vitest';
import { POST_EVENT_TYPE, type RepostOf } from './feed';
import { compareRepost } from './repostCheck';

const repostOf: RepostOf = {
  roomId: '!feed:x',
  eventId: '$post',
  sender: '@alice:x',
  senderName: 'Alice',
  origin: { kind: 'global' },
  ts: 1,
  body: 'hello',
  attachments: [{ kind: 'image', url: 'mxc://x/a', name: 'a.webp', info: { mimetype: 'image/webp', size: 1 } }],
};

const original = {
  type: POST_EVENT_TYPE,
  sender: '@alice:x',
  content: {
    body: 'hello',
    'xyz.nekous.attachments': [{ kind: 'image', url: 'mxc://x/a', name: 'a.webp', info: { mimetype: 'image/webp', size: 1 } }],
  },
};

describe('compareRepost', () => {
  it('verifies a copy that matches its original', () => {
    expect(compareRepost(repostOf, original)).toBe('verified');
  });

  it('reports a redacted original as deleted, with or without redacted_because', () => {
    expect(compareRepost(repostOf, { ...original, unsigned: { redacted_because: {} } })).toBe('deleted');
    expect(compareRepost(repostOf, { ...original, content: {} })).toBe('deleted');
  });

  it('rejects words the author never posted', () => {
    expect(compareRepost({ ...repostOf, body: 'something else' }, original)).toBe('mismatch');
  });

  it('rejects a copy claiming someone else wrote it', () => {
    expect(compareRepost({ ...repostOf, sender: '@bob:x' }, original)).toBe('mismatch');
  });

  it('rejects swapped or extra media', () => {
    expect(compareRepost({ ...repostOf, attachments: [] }, original)).toBe('mismatch');
    const swapped = [{ ...repostOf.attachments![0], url: 'mxc://x/other' }];
    expect(compareRepost({ ...repostOf, attachments: swapped }, original)).toBe('mismatch');
  });

  it('rejects an "original" that is not a post at all', () => {
    expect(compareRepost(repostOf, { ...original, type: 'm.room.message' })).toBe('mismatch');
  });
});

describe('compareRepost with edits', () => {
  const edit = (sender: string, body: string, redacted = false) => ({
    type: POST_EVENT_TYPE,
    sender,
    content: { 'm.new_content': { body, 'xyz.nekous.attachments': original.content['xyz.nekous.attachments'] } },
    ...(redacted && { unsigned: { redacted_because: {} } }),
  });

  it('verifies a copy of an edited version', () => {
    expect(compareRepost({ ...repostOf, body: 'hello, edited' }, original, [edit('@alice:x', 'hello, edited')])).toBe('verified');
  });

  it('ignores an "edit" by anyone else, or one that was deleted', () => {
    expect(compareRepost({ ...repostOf, body: 'forged' }, original, [edit('@mallory:x', 'forged')])).toBe('mismatch');
    expect(compareRepost({ ...repostOf, body: 'retracted' }, original, [edit('@alice:x', 'retracted', true)])).toBe('mismatch');
  });
});

describe('compareRepost — a reposted comment', () => {
  const commentCopy: RepostOf = {
    roomId: '!feed:x',
    eventId: '$comment',
    sender: '@bob:x',
    senderName: 'Bob',
    origin: { kind: 'global' },
    ts: 2,
    body: 'nice',
    commentOn: { eventId: '$post', sender: '@alice:x' },
  };
  const theComment = {
    type: 'xyz.nekous.comment',
    sender: '@bob:x',
    content: { body: 'nice', 'm.relates_to': { rel_type: 'm.reference', event_id: '$post' } },
  };

  it('verifies a comment under the post the copy names', () => {
    expect(compareRepost(commentCopy, theComment)).toBe('verified');
  });

  it('refuses a post passed off as a comment, or a comment under another post', () => {
    expect(compareRepost(commentCopy, { ...theComment, type: POST_EVENT_TYPE })).toBe('mismatch');
    expect(
      compareRepost(commentCopy, { ...theComment, content: { ...theComment.content, 'm.relates_to': { rel_type: 'm.reference', event_id: '$elsewhere' } } })
    ).toBe('mismatch');
  });

  it('refuses a comment copy whose original is a post', () => {
    const { commentOn: _gone, ...asPost } = commentCopy;
    expect(compareRepost(asPost, theComment)).toBe('mismatch');
  });
});
