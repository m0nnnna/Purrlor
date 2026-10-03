import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describePostActivity } from './postActivity.js';

const ALICE = '@alice:x';

describe('describePostActivity', () => {
  it('words a comment for the post’s author', () => {
    assert.equal(
      describePostActivity({ type: 'xyz.nekous.comment', content: { body: 'nice' }, recipient: ALICE, highlight: false }),
      'Commented on your post: nice'
    );
  });

  it('words a reply for the person replied to, even though it also mentions them', () => {
    const content = { body: 'agreed', 'xyz.nekous.reply_to': { sender: ALICE }, 'm.mentions': { user_ids: [ALICE] } };
    assert.equal(describePostActivity({ type: 'xyz.nekous.comment', content, recipient: ALICE, highlight: true }), 'Replied to your comment: agreed');
  });

  it('words a mention in a comment', () => {
    const content = { body: 'look @Alice', 'm.mentions': { user_ids: [ALICE] } };
    assert.equal(describePostActivity({ type: 'xyz.nekous.comment', content, recipient: ALICE, highlight: true }), 'Mentioned you in a comment: look @Alice');
  });

  it('falls back to the highlight tweak for an older pusher that doesn’t say whose it is', () => {
    const content = { body: 'look', 'm.mentions': { user_ids: [ALICE] } };
    assert.equal(describePostActivity({ type: 'xyz.nekous.comment', content, highlight: true }), 'Mentioned you in a comment: look');
    assert.equal(describePostActivity({ type: 'xyz.nekous.comment', content, highlight: false }), 'Commented on your post: look');
  });

  it('words a reply in a thread the recipient is in, and a like on their comment', () => {
    const content = { body: 'same', 'xyz.nekous.reply_to': { sender: '@bob:x' }, 'xyz.nekous.thread': '$root', 'm.mentions': { user_ids: ['@bob:x', ALICE] } };
    assert.equal(describePostActivity({ type: 'xyz.nekous.comment', content, recipient: ALICE, highlight: true }), 'Replied in a thread you’re in: same');
    assert.equal(describePostActivity({ type: 'xyz.nekous.comment', content, recipient: '@bob:x', highlight: true }), 'Replied to your comment: same');
    assert.equal(
      describePostActivity({ type: 'xyz.nekous.comment_like', content: { 'm.mentions': { user_ids: [ALICE] } }, recipient: ALICE, highlight: true }),
      'Liked your comment'
    );
  });

  it('words a mention in a post, and a like', () => {
    assert.equal(describePostActivity({ type: 'xyz.nekous.post', content: { body: 'hi @Alice' }, recipient: ALICE, highlight: true }), 'Mentioned you in a post: hi @Alice');
    assert.equal(describePostActivity({ type: 'm.reaction', content: {}, recipient: ALICE, highlight: false }), 'Liked your post');
  });

  it('words a Global-post mention that arrives as an invite, and leaves ordinary invites alone', () => {
    const mention = { membership: 'invite', reason: 'Mentioned you in a post (xyz.nekous.mention $abc)' };
    assert.equal(describePostActivity({ type: 'm.room.member', content: mention, recipient: ALICE, highlight: false }), 'Mentioned you in a post');
    assert.equal(describePostActivity({ type: 'm.room.member', content: { membership: 'invite' }, recipient: ALICE, highlight: false }), undefined);
  });

  it('words a tag in a picture, in a post, a comment and an invite', () => {
    const attachments = [{ kind: 'image', url: 'mxc://x/p', tags: [{ user_id: ALICE, x: 5000, y: 5000 }] }];
    const mentions = { user_ids: [ALICE] };
    assert.equal(
      describePostActivity({ type: 'xyz.nekous.post', content: { body: 'beach', 'xyz.nekous.attachments': attachments, 'm.mentions': mentions }, recipient: ALICE, highlight: true }),
      'Tagged you in a photo: beach'
    );
    assert.equal(
      describePostActivity({ type: 'xyz.nekous.comment', content: { body: '', 'xyz.nekous.attachments': attachments, 'm.mentions': mentions }, recipient: ALICE, highlight: true }),
      'Tagged you in a photo'
    );
    // Someone else in the same post is only mentioned.
    assert.equal(
      describePostActivity({ type: 'xyz.nekous.post', content: { body: '', 'xyz.nekous.attachments': attachments, 'm.mentions': { user_ids: ['@bo:x'] } }, recipient: '@bo:x', highlight: true }),
      'Mentioned you in a post'
    );
    assert.equal(
      describePostActivity({ type: 'm.room.member', content: { membership: 'invite', reason: 'Tagged you in a photo (xyz.nekous.mention $p)' }, recipient: ALICE, highlight: false }),
      'Tagged you in a photo'
    );
  });

  it('leaves chat messages alone', () => {
    assert.equal(describePostActivity({ type: 'm.room.message', content: { body: 'hey' }, recipient: ALICE, highlight: false }), undefined);
  });
});
