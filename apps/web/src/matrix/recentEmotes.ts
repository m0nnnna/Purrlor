import type { MatrixClient } from 'matrix-js-sdk';
import type { Emote } from './emotes';

/**
 * The picker's "Recents" section (EmojiAndEmotePicker.tsx): the emotes you've actually picked
 * lately, most recent first — plain account data, the same private-per-user mechanism
 * savedMessages.ts uses for bookmarks, so it follows your account across devices without ever
 * being visible to anyone else or living in any one room (a recent pick can be a channel's own
 * emote, gone the moment you switch to a channel without it).
 */
export const RECENT_EMOTES_EVENT = 'xyz.nekous.recent_emotes';

/** However many rooms' worth of picks you keep — plenty for a "recently used" strip without the
 *  account data event growing without bound. */
export const MAX_RECENT_EMOTES = 24;

type RecentEmotesContent = { items?: Emote[] };

export function readRecentEmotes(mx: MatrixClient): Emote[] {
  const content = mx.getAccountData(RECENT_EMOTES_EVENT as any)?.getContent<RecentEmotesContent>();
  const items = content?.items;
  return Array.isArray(items)
    ? items.filter((item): item is Emote => typeof item?.shortcode === 'string' && typeof item?.mxcUrl === 'string')
    : [];
}

/** Moves `emote` to the front of the list (deduping by shortcode — picking the same one again
 *  just re-bumps it), trimmed to `MAX_RECENT_EMOTES`. */
export async function noteRecentEmote(mx: MatrixClient, emote: Emote): Promise<void> {
  const items = [emote, ...readRecentEmotes(mx).filter((item) => item.shortcode !== emote.shortcode)].slice(
    0,
    MAX_RECENT_EMOTES
  );
  await mx.setAccountData(RECENT_EMOTES_EVENT as any, { items } as any);
}
