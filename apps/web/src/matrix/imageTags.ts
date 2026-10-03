import type { PostAttachment } from './postMedia';

/**
 * People tagged in a post's or comment's picture: who, and where on it (docs/posts.md, "Tagging
 * people in pictures"). Each image in `xyz.nekous.attachments` may carry `tags`, a list of
 * `{ user_id, x, y }`, `x` and `y` being how far across and down the picture the spot is, in
 * ten-thousandths (0 to 10000), so it stays put at any size. Whole numbers, because Matrix events
 * can't hold fractions (canonical JSON): a homeserver refuses a post with `0.5` in it.
 *
 * Tagging someone also mentions them (`buildPostContent` adds them to `m.mentions`), so they're
 * notified the way a mention notifies, worded "Tagged you in a photo", and a Global post invites
 * them to the author's profile room the same way (mentionInvites.ts). The public web never shows
 * tags: the token server copies only a picture's file and size.
 */
export type ImageTag = { user_id: string; x: number; y: number };

export const MAX_TAGS_PER_IMAGE = 20;
/** A tag's `x` and `y` go from 0 to this: how far across and down, in ten-thousandths. */
export const TAG_SCALE = 10_000;

const USER_ID = /^@[^\s:]+:[^\s]+$/;

const clamp = (n: number) => Math.min(TAG_SCALE, Math.max(0, Math.round(n)));

/** A spot given as fractions of the picture (0 to 1), as a tag stores it. */
export function tagAt(userId: string, fx: number, fy: number): ImageTag {
  return { user_id: userId, x: clamp(fx * TAG_SCALE), y: clamp(fy * TAG_SCALE) };
}

/** Where a tag is, as CSS percentages of the picture. */
export function tagPosition(tag: ImageTag): { left: string; top: string } {
  return { left: `${(tag.x / TAG_SCALE) * 100}%`, top: `${(tag.y / TAG_SCALE) * 100}%` };
}

/** Tags as read off an event: each a real user ID at a spot on the picture, once per person. Pure. */
export function readTags(raw: unknown): ImageTag[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const tags: ImageTag[] = [];
  for (const item of raw) {
    const tag = item as Partial<ImageTag> | null;
    if (!tag || typeof tag.user_id !== 'string' || tag.user_id.length > 255 || !USER_ID.test(tag.user_id) || seen.has(tag.user_id)) continue;
    if (typeof tag.x !== 'number' || typeof tag.y !== 'number' || !Number.isFinite(tag.x) || !Number.isFinite(tag.y)) continue;
    seen.add(tag.user_id);
    tags.push({ user_id: tag.user_id, x: clamp(tag.x), y: clamp(tag.y) });
    if (tags.length === MAX_TAGS_PER_IMAGE) break;
  }
  return tags;
}

/** Everyone tagged in any of these pictures, each once. Pure. */
export function taggedUsers(attachments: PostAttachment[] | undefined): string[] {
  return [...new Set((attachments ?? []).flatMap((attachment) => (attachment.tags ?? []).map((tag) => tag.user_id)))];
}

/**
 * Whether `userId` is tagged in an event's pictures, read straight from its content — for wording
 * a notification "Tagged you in a photo" rather than "Mentioned you". Pure.
 */
export function isTaggedIn(content: Record<string, unknown> | undefined, userId: string | null | undefined): boolean {
  const attachments = content?.['xyz.nekous.attachments'];
  if (!userId || !Array.isArray(attachments)) return false;
  return attachments.some((attachment) => readTags((attachment as { tags?: unknown } | null)?.tags).some((tag) => tag.user_id === userId));
}

/** A tag placed or moved: the same person tagged again moves their tag rather than doubling it. */
export function placeTag(tags: ImageTag[], tag: ImageTag): ImageTag[] {
  const others = tags.filter((t) => t.user_id !== tag.user_id);
  return others.length >= MAX_TAGS_PER_IMAGE ? tags : [...others, { ...tag, x: clamp(tag.x), y: clamp(tag.y) }];
}
