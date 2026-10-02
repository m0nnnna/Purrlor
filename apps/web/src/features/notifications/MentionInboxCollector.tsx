import { useEffect } from 'react';
import { RoomEvent, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { isPostEvent } from '../../matrix/feed';
import { addMentionToInbox } from '../../matrix/mentionInbox';
import { COMMENT_EVENT_TYPE, COMMENT_LIKE_TYPE } from '../../matrix/postInteractions';

/**
 * Watches every live incoming message across every room for a real @-mention of you
 * (`m.mentions.user_ids` — the same signal MessageTimeline.tsx uses for its own highlight
 * styling), and logs it to the private Mention Inbox (matrix/mentionInbox.ts) so it's findable
 * without scrolling back through a busy channel. `@room` doesn't count — this is specifically
 * "someone pinged *you*," not "a mass ping landed in a room you're in."
 *
 * `data.liveEvent` (same flag `DesktopNotifications.tsx` relies on) is what keeps this from
 * replaying a room's entire recent backlog into the inbox on every reload — only genuinely new
 * events arriving after this session is already caught up on `/sync` count.
 *
 * Headless: mounted once in AppShell, renders nothing, runs for the app's lifetime.
 */
export function MentionInboxCollector() {
  const mx = useMatrixClient();

  useEffect(() => {
    const onTimeline = (
      event: MatrixEvent,
      room: Room | undefined,
      toStartOfTimeline: boolean | undefined,
      removed: boolean,
      data: { liveEvent?: boolean }
    ) => {
      if (toStartOfTimeline || removed || !room || !data.liveEvent) return;
      // Chat messages, and posts and comments (a mention in either notifies the same way). An
      // edit is a post event too, but it isn't a new mention.
      const isChat = event.getType() === 'm.room.message';
      const isPost = isPostEvent(event);
      // A comment like mentions the comment's author, so it's logged here like a mention.
      const isComment = event.getType() === COMMENT_EVENT_TYPE || event.getType() === COMMENT_LIKE_TYPE;
      if (!isChat && !isPost && !isComment) return;
      const myUserId = mx.getUserId();
      // Also sidesteps a real bug found while testing this with only one account available: a
      // *self*-sent message is briefly a local echo with a temporary `~`-prefixed event ID before
      // `/sync` confirms it and the timeline re-keys it to the real one — `RoomEvent.Timeline`
      // fires `liveEvent: true` for that local echo but not again for the swap-in, so logging it
      // then would permanently point at an ID the room never resolves, showing "message no
      // longer available" forever. Doesn't apply to a real mention: an event that arrives from
      // someone *else* is never in a local-echo state from this client's perspective — it's
      // always already real by the time it's seen here.
      if (!myUserId || event.getSender() === myUserId) return;

      const mentionsMe = event.getContent()['m.mentions']?.user_ids?.includes(myUserId);
      if (!mentionsMe) return;

      const eventId = event.getId();
      if (!eventId) return;
      const postId = isPost ? eventId : isComment ? event.getRelation()?.event_id : undefined;
      void addMentionToInbox(mx, room.roomId, eventId, postId);
    };

    mx.on(RoomEvent.Timeline, onTimeline);
    return () => {
      mx.removeListener(RoomEvent.Timeline, onTimeline);
    };
  }, [mx]);

  return null;
}
