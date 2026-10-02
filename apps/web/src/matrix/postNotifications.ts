import { EventType, Method, PushRuleKind, type IPushRule, type MatrixClient } from 'matrix-js-sdk';
import { listOwnFeedRoomIds, POST_EVENT_TYPE } from './feed';
import { COMMENT_EVENT_TYPE, COMMENT_LIKE_TYPE } from './postInteractions';
import { getOwnProfileRoomId } from './profileFeed';

/**
 * Telling a post's author when someone likes or comments on it.
 *
 * Both are silent by default: a comment is a custom event type, which no default push rule
 * matches, and a like is an `m.reaction`, which the server-default `.m.rule.reaction` rule
 * explicitly mutes. So the author gets their own **push rules**, one pair per feed room they own:
 *
 * - comments in that room → notify, with sound;
 * - reactions in that room → notify, quietly (the homeserver marks them low priority).
 *
 * User-defined override rules beat the server defaults, so these win over `.m.rule.reaction`.
 * They're scoped by `room_id`, so they cover only the author's own feeds — not every feed room
 * they've joined to like or comment elsewhere. And because they're real push rules, the homeserver
 * applies them itself: in-app notifications (DesktopNotifications) and background push through the
 * push gateway both follow, with nothing running on the client. Checked against Continuwuity with
 * a stand-in push gateway: no rules, nothing delivered; with them, the comment and the like both
 * arrive; the same actions in some other room, nothing.
 *
 * Your own likes and comments never notify you: servers don't push a user's own events.
 */

export type PostNotificationSettings = { comments: boolean; likes: boolean };

const SETTINGS_ACCOUNT_DATA = 'xyz.nekous.post_notifications';
const DEFAULTS: PostNotificationSettings = { comments: true, likes: true };

/** Every rule this module manages starts with one of these, then the room ID. */
const COMMENT_RULE_PREFIX = 'xyz.nekous.feed_comment.';
const LIKE_RULE_PREFIX = 'xyz.nekous.feed_like.';

export function readPostNotificationSettings(mx: MatrixClient): PostNotificationSettings {
  const content = mx.getAccountData(SETTINGS_ACCOUNT_DATA as any)?.getContent<Partial<PostNotificationSettings>>();
  return {
    comments: typeof content?.comments === 'boolean' ? content.comments : DEFAULTS.comments,
    likes: typeof content?.likes === 'boolean' ? content.likes : DEFAULTS.likes,
  };
}

export async function setPostNotificationSettings(mx: MatrixClient, settings: PostNotificationSettings): Promise<void> {
  await mx.setAccountData(SETTINGS_ACCOUNT_DATA as any, settings as any);
  await syncPostNotificationRules(mx, settings);
}

/** The feed rooms you own: your profile feed plus your feed in each Space. */
export function ownFeedRoomIds(mx: MatrixClient): string[] {
  const profile = getOwnProfileRoomId(mx);
  return [...new Set([...(profile ? [profile] : []), ...listOwnFeedRoomIds(mx)])];
}

type WantedRule = { ruleId: string; body: Pick<IPushRule, 'conditions' | 'actions'> };

/** The rules that should exist for these rooms and settings. Pure, so it's tested directly. */
export function wantedPostRules(roomIds: string[], settings: PostNotificationSettings): WantedRule[] {
  return roomIds.flatMap((roomId) => {
    const inRoom = { kind: 'event_match', key: 'room_id', pattern: roomId };
    const rules: WantedRule[] = [];
    if (settings.comments) {
      rules.push({
        ruleId: COMMENT_RULE_PREFIX + roomId,
        body: {
          conditions: [{ kind: 'event_match', key: 'type', pattern: COMMENT_EVENT_TYPE }, inRoom] as IPushRule['conditions'],
          actions: ['notify', { set_tweak: 'sound', value: 'default' }] as IPushRule['actions'],
        },
      });
    }
    if (settings.likes) {
      rules.push({
        ruleId: LIKE_RULE_PREFIX + roomId,
        body: {
          conditions: [{ kind: 'event_match', key: 'type', pattern: EventType.Reaction }, inRoom] as IPushRule['conditions'],
          actions: ['notify'] as IPushRule['actions'],
        },
      });
    }
    return rules;
  });
}

function isManaged(ruleId: string): boolean {
  return ruleId.startsWith(COMMENT_RULE_PREFIX) || ruleId.startsWith(LIKE_RULE_PREFIX);
}

/**
 * Muting one post: a push rule with no actions for everything related to it in its room — its
 * likes and comments, replies in its threads, likes on its comments, reposts of either. It sits
 * above the rules that would notify (your feed rules above, and the server's mention rule, which
 * user rules always beat), so the homeserver itself stays quiet: no phone push, no in-app
 * notification. Checked against Continuwuity: a mention under a muted post doesn't count, one
 * under another post does. The rules themselves are the list of muted posts, so it follows you
 * to every device.
 *
 * The key is escaped (`m\.relates_to`) because the field name has a dot in it; both Continuwuity
 * and matrix-js-sdk read the escape.
 */
const MUTE_RULE_PREFIX = 'xyz.nekous.mute_post.';

export function muteRuleBody(roomId: string, postId: string): Pick<IPushRule, 'conditions' | 'actions'> {
  return {
    conditions: [
      { kind: 'event_match', key: 'room_id', pattern: roomId },
      { kind: 'event_match', key: 'content.m\\.relates_to.event_id', pattern: postId },
    ] as IPushRule['conditions'],
    actions: [] as IPushRule['actions'],
  };
}

/** The posts you've muted, from your push rules. */
export function mutedPostIds(mx: MatrixClient): Set<string> {
  return new Set(
    (mx.pushRules?.global?.override ?? [])
      .filter((rule) => rule.rule_id.startsWith(MUTE_RULE_PREFIX))
      .map((rule) => rule.rule_id.slice(MUTE_RULE_PREFIX.length))
  );
}

/** Adds an override rule at a chosen place: matrix-js-sdk's addPushRule always puts it first. */
async function putOverrideRule(
  mx: MatrixClient,
  ruleId: string,
  body: Pick<IPushRule, 'conditions' | 'actions'>,
  place: { before?: string; after?: string } = {}
): Promise<void> {
  const query = place.before ? { before: place.before } : place.after ? { after: place.after } : undefined;
  await mx.http.authedRequest(Method.Put, `/pushrules/global/override/${encodeURIComponent(ruleId)}`, query, body);
}

export async function setPostMuted(mx: MatrixClient, roomId: string, postId: string, muted: boolean): Promise<void> {
  const ruleId = MUTE_RULE_PREFIX + postId;
  if (!muted) {
    await mx.deletePushRule('global', PushRuleKind.Override, ruleId);
    return;
  }
  // Ahead of every rule of yours, so nothing of yours that notifies can win over it.
  const first = (mx.pushRules?.global?.override ?? []).find((rule) => !rule.rule_id.startsWith('.') && rule.rule_id !== ruleId);
  await putOverrideRule(mx, ruleId, muteRuleBody(roomId, postId), first ? { before: first.rule_id } : {});
}

/**
 * Makes your push rules match your feed rooms and settings: adds what's missing, removes what's no
 * longer wanted (a setting turned off, a feed you no longer own). Reads the rules the client already
 * has from sync — Continuwuity doesn't implement listing a single rule kind — and changes nothing
 * when they already match, so it's cheap to run on every start.
 */
export async function syncPostNotificationRules(
  mx: MatrixClient,
  settings: PostNotificationSettings = readPostNotificationSettings(mx)
): Promise<void> {
  const existing = (mx.pushRules?.global?.override ?? []).filter((rule) => isManaged(rule.rule_id));
  const existingIds = new Set(existing.map((rule) => rule.rule_id));
  const wanted = wantedPostRules(ownFeedRoomIds(mx), settings);
  const wantedIds = new Set(wanted.map((rule) => rule.ruleId));

  // New rules go below any muted post's rule, or they'd win over it.
  const mutes = (mx.pushRules?.global?.override ?? []).filter((rule) => rule.rule_id.startsWith(MUTE_RULE_PREFIX));
  const lastMute = mutes[mutes.length - 1]?.rule_id;
  for (const rule of wanted) {
    if (!existingIds.has(rule.ruleId)) {
      await putOverrideRule(mx, rule.ruleId, rule.body, lastMute ? { after: lastMute } : {});
    }
  }
  for (const rule of existing) {
    if (!wantedIds.has(rule.rule_id)) {
      await mx.deletePushRule('global', PushRuleKind.Override, rule.rule_id);
    }
  }
}

/** For DesktopNotifications: an event about posts. A post itself only notifies when it mentions
 *  you (the spec's mention rule); comments and likes through the rules above, or a mention. */
export function isPostActivity(eventType: string): 'post' | 'comment' | 'like' | 'commentLike' | undefined {
  if (eventType === POST_EVENT_TYPE) return 'post';
  if (eventType === COMMENT_EVENT_TYPE) return 'comment';
  if (eventType === EventType.Reaction) return 'like';
  if (eventType === COMMENT_LIKE_TYPE) return 'commentLike';
  return undefined;
}
