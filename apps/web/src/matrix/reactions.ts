import { EventType, RelationType, type MatrixClient } from 'matrix-js-sdk';

/** The field Element/Cinny already put a reaction's shortcode on, when its `key` is a custom
 *  emote's `mxc://` URL rather than a plain Unicode character — `m.reaction`'s `key` has to stay
 *  a plain string either way (there's no way to attach an image to it directly), so the shortcode
 *  travels alongside for anything that wants to show it as text instead of resolving the mxc URL
 *  (see ReactionBar.tsx, and useReactions.ts for how it's read back off the aggregated group). */
export const REACTION_SHORTCODE_FIELD = 'com.beeper.reaction.shortcode';

/** Sends an `m.reaction` annotation — see `useReactions.ts` for how these get aggregated back.
 *  `key` is either a plain Unicode emoji or, for a custom emote (ReactionPicker.tsx), that
 *  emote's own `mxc://` URL; `shortcode` is only meaningful (and only ever sent) in the latter
 *  case. */
export async function sendReaction(mx: MatrixClient, roomId: string, eventId: string, key: string, shortcode?: string): Promise<void> {
  await mx.sendEvent(roomId, EventType.Reaction, {
    'm.relates_to': { rel_type: RelationType.Annotation, event_id: eventId, key },
    ...(shortcode && { [REACTION_SHORTCODE_FIELD]: shortcode }),
  });
}

/** Un-reacting is redacting your own reaction event, same as any other message. */
export async function removeReaction(mx: MatrixClient, roomId: string, reactionEventId: string): Promise<void> {
  await mx.redactEvent(roomId, reactionEventId);
}
