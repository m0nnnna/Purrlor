import { describe, expect, it } from 'vitest';
import { buildPostContent, toEventContent } from './feed';
import { isTaggedIn, MAX_TAGS_PER_IMAGE, placeTag, readTags, tagAt, taggedUsers } from './imageTags';
import { mentionInviteReason, parseMentionInviteReason } from './mentionInvites';
import { readAttachments, type PostAttachment } from './postMedia';

const image = (tags?: unknown): PostAttachment =>
  ({ kind: 'image', url: 'mxc://x/pic', name: 'pic.webp', info: { mimetype: 'image/webp', size: 10 }, ...(tags !== undefined && { tags }) }) as PostAttachment;

describe('readTags', () => {
  it('keeps real user IDs at a spot on the picture, once each, in whole ten-thousandths clamped to it', () => {
    expect(
      readTags([
        { user_id: '@luna:x', x: 2500, y: 5000 },
        { user_id: '@luna:x', x: 9000, y: 9000 },
        { user_id: '@bo:x', x: 14000.4, y: -20 },
        { user_id: 'not a user', x: 1000, y: 1000 },
        { user_id: '@cy:x', x: '0.1', y: 0.1 },
        { user_id: '@di:x', x: Number.NaN, y: 0.1 },
        null,
      ])
    ).toEqual([
      { user_id: '@luna:x', x: 2500, y: 5000 },
      { user_id: '@bo:x', x: 10000, y: 0 },
    ]);
    // Never a fraction: a homeserver refuses an event holding one.
    expect(tagAt('@luna:x', 1 / 3, 0.5)).toEqual({ user_id: '@luna:x', x: 3333, y: 5000 });
    expect(readTags('nope')).toEqual([]);
  });

  it(`takes at most ${MAX_TAGS_PER_IMAGE}`, () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ user_id: `@u${i}:x`, x: 5000, y: 5000 }));
    expect(readTags(many)).toHaveLength(MAX_TAGS_PER_IMAGE);
  });
});

describe('placeTag', () => {
  it('adds a tag, and moves rather than doubles one for the same person', () => {
    const one = placeTag([], tagAt('@luna:x', 0.1, 0.1));
    expect(placeTag(one, tagAt('@luna:x', 0.8, 0.2))).toEqual([{ user_id: '@luna:x', x: 8000, y: 2000 }]);
  });
});

describe('tags on attachments', () => {
  it('are read back checked, and only on pictures', () => {
    const [picture] = readAttachments([image([{ user_id: '@luna:x', x: 5000, y: 5000 }, { user_id: 'bad', x: 0, y: 0 }])]);
    expect(picture.tags).toEqual([{ user_id: '@luna:x', x: 5000, y: 5000 }]);
    const [video] = readAttachments([
      { kind: 'video', url: 'mxc://x/v', name: 'v.mp4', info: { mimetype: 'video/mp4', size: 1 }, tags: [{ user_id: '@luna:x', x: 5000, y: 5000 }] },
    ]);
    expect(video.tags).toBeUndefined();
    expect(readAttachments([image([])])[0]).not.toHaveProperty('tags');
  });

  it('mention everyone tagged, as well as anyone @mentioned', () => {
    const attachments = [image([{ user_id: '@luna:x', x: 5000, y: 5000 }]), image([{ user_id: '@bo:x', x: 1000, y: 1000 }, { user_id: '@luna:x', x: 2000, y: 2000 }])];
    expect(taggedUsers(attachments)).toEqual(['@luna:x', '@bo:x']);
    const content = buildPostContent('look', undefined, { attachments, mentions: ['@cy:x', '@luna:x'] });
    expect(content.mentions).toEqual(['@cy:x', '@luna:x', '@bo:x']);
    const sent = toEventContent(content);
    expect(sent['m.mentions']).toEqual({ user_ids: ['@cy:x', '@luna:x', '@bo:x'] });
    expect(isTaggedIn(sent, '@bo:x')).toBe(true);
    expect(isTaggedIn(sent, '@cy:x')).toBe(false);
    expect(isTaggedIn(sent, null)).toBe(false);
  });
});

describe('mention invites for a tag', () => {
  it('say "Tagged you in a photo" and still carry the post', () => {
    expect(mentionInviteReason('$post', true)).toBe('Tagged you in a photo (xyz.nekous.mention $post)');
    expect(mentionInviteReason('$post')).toBe('Mentioned you in a post (xyz.nekous.mention $post)');
    expect(parseMentionInviteReason(mentionInviteReason('$post', true))).toBe('$post');
  });
});
