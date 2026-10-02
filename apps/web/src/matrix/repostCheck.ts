import { RelationType, type MatrixClient } from 'matrix-js-sdk';
import { POST_EVENT_TYPE, readPostContent, type RepostOf } from './feed';
import { attachmentMxc, type PostAttachment } from './postMedia';
import { COMMENT_EVENT_TYPE } from './postInteractions';

/**
 * Checking a repost's embedded copy against the post it claims to be.
 *
 * A repost carries the original **inside itself** (feed.ts, RepostOf), which is what lets people
 * read it without access to the original's room. It also means the copy is whatever the reposter's
 * client wrote: nothing stops a hand-made event "reposting" words Alice never posted, under Alice's
 * name. And when Alice deletes her post, every repost would go on showing it.
 *
 * Reposts only ever come from places the reader can read (canRepost: public places, or the same
 * Space), so the original can be fetched and compared:
 *
 * - `verified`: it's there, it's a post by the claimed author, and its text and media match.
 * - `deleted`: redacted, or gone. The author took it down, so the repost shows that it was removed
 *   instead of the copy.
 * - `mismatch`: it exists but isn't what the repost says. The copy isn't shown.
 * - `unknown`: the check itself failed (offline, a server error). The copy is shown, marked as
 *   unchecked, rather than blanking every repost whenever the network blips.
 */
export type RepostStatus = 'verified' | 'deleted' | 'mismatch' | 'unknown';

type RawEvent = {
  type?: string;
  sender?: string;
  content?: Record<string, unknown>;
  unsigned?: { redacted_because?: unknown };
};

function sameAttachments(a: PostAttachment[] = [], b: PostAttachment[] = []): boolean {
  return a.length === b.length && a.every((attachment, i) => attachmentMxc(attachment) === attachmentMxc(b[i]));
}

/**
 * The pure comparison, so it's tested without a server. The copy may be of any version of the
 * post — the original, or one of its author's edits (a repost made after an edit carries the
 * edited text) — so `edits` are the post's `m.replace` events.
 */
export function compareRepost(repostOf: RepostOf, original: RawEvent, edits: RawEvent[] = []): RepostStatus {
  if (original.unsigned?.redacted_because) return 'deleted';
  // A reposted comment is a comment, and under the post the copy says (comments aren't edited).
  if (repostOf.commentOn) {
    const relation = original.content?.['m.relates_to'] as { event_id?: unknown } | undefined;
    if (original.type !== COMMENT_EVENT_TYPE || original.sender !== repostOf.sender || relation?.event_id !== repostOf.commentOn.eventId) {
      return 'mismatch';
    }
  } else if (original.type !== POST_EVENT_TYPE || original.sender !== repostOf.sender) {
    return 'mismatch';
  }
  const content = readPostContent(original.content ?? {});
  // A post redacted by a server that doesn't set redacted_because has no content left.
  if (!content) return 'deleted';
  const versions = [
    content,
    ...edits
      .filter((edit) => edit.type === POST_EVENT_TYPE && edit.sender === original.sender && !edit.unsigned?.redacted_because)
      .map((edit) => readPostContent((edit.content?.['m.new_content'] as Record<string, unknown> | undefined) ?? {})),
  ];
  const matches = versions.some(
    (version) => version && version.body === repostOf.body && sameAttachments(version.attachments, repostOf.attachments)
  );
  return matches ? 'verified' : 'mismatch';
}

function httpStatusOf(err: unknown): number | undefined {
  const status = (err as { httpStatus?: unknown } | null)?.httpStatus;
  return typeof status === 'number' ? status : undefined;
}

/** One check per original, shared by every repost of it on the page. */
const checks = new Map<string, Promise<RepostStatus>>();

export function checkRepost(mx: MatrixClient, repostOf: RepostOf): Promise<RepostStatus> {
  const key = `${repostOf.roomId}|${repostOf.eventId}|${repostOf.sender}|${repostOf.body}`;
  let check = checks.get(key);
  if (!check) {
    check = mx
      .fetchRoomEvent(repostOf.roomId, repostOf.eventId)
      .then(async (event) => {
        const first = compareRepost(repostOf, event as RawEvent);
        if (first !== 'mismatch') return first;
        // Maybe a copy of an edited version: only then is it worth asking for the edits.
        const { chunk } = await mx.fetchRelations(repostOf.roomId, repostOf.eventId, RelationType.Replace, POST_EVENT_TYPE);
        return compareRepost(repostOf, event as RawEvent, chunk as RawEvent[]);
      })
      .catch((err: unknown) => {
        // Neither answer is remembered: a private Space's feed room may simply not be joined yet
        // (the Posts page joins them as it opens), and a network blip isn't a verdict.
        checks.delete(key);
        // Not found: reposts only come from places their readers can read, so an original that
        // isn't there is gone (or never was). Anything else, including "forbidden", is unchecked.
        return httpStatusOf(err) === 404 ? ('deleted' as const) : ('unknown' as const);
      });
    checks.set(key, check);
  }
  return check;
}

/** Forgets what's known about one original, after it's been deleted here. */
export function forgetRepostCheck(roomId: string, eventId: string): void {
  [...checks.keys()].filter((key) => key.startsWith(`${roomId}|${eventId}|`)).forEach((key) => checks.delete(key));
}
