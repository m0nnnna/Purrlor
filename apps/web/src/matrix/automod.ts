import { type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { canRedactEvent } from './permissions';
import { fileAutomodReport, isSpaceModerator, readModerationConfig } from './reports';

/**
 * A Space's blocked words (`blocked_words` in its `xyz.nekous.moderation` state). Matrix can't
 * stop a message before it's sent, so there are two halves:
 *
 * - **Your own messages.** Purrlor's composer won't send a message with a blocked word in a
 *   channel of that Space (moderators excepted), and says why.
 * - **Everyone else's.** Messages sent from other apps skip that, so a moderator's client deletes
 *   any it sees arrive with a blocked word and files an automod report (reports.ts) saying so.
 *   That needs a moderator online when the message arrives; ones sent while none is are caught by
 *   people reporting them.
 *
 * Matching is whole words or phrases, ignoring case and accents: "cat" matches "Cat!" but not
 * "concatenate". No wildcards or patterns, so a word list can't be written that makes matching
 * slow.
 */

/** Lower case, accents stripped, anything that isn't a letter or digit turned into a space. */
export function normalizeForMatching(text: string): string {
  return ` ${text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;
}

/** The first blocked word or phrase in `text`, if any. Pure. */
export function findBlockedWord(text: string, blockedWords: string[]): string | undefined {
  const haystack = normalizeForMatching(text);
  return blockedWords.find((word) => {
    const needle = normalizeForMatching(word);
    return needle.trim() !== '' && haystack.includes(needle);
  });
}

/** For the composer: the blocked word stopping this message, if the room is a channel of a Space
 *  with a list and the sender isn't one of its moderators. */
export function blockedWordForOwnMessage(mx: MatrixClient, space: Room | undefined, text: string): string | undefined {
  if (!space || isSpaceModerator(space, mx.getUserId() ?? '')) return undefined;
  return findBlockedWord(text, readModerationConfig(space).blockedWords);
}

/**
 * Checks one incoming message in a channel of `space`, from this moderator's client: deletes it
 * if it has a blocked word and this user may, and files an automod report either way.
 */
export async function enforceAutomod(mx: MatrixClient, space: Room, channel: Room, event: MatrixEvent): Promise<void> {
  const myUserId = mx.getUserId() ?? '';
  const sender = event.getSender() ?? '';
  if (!isSpaceModerator(space, myUserId) || sender === myUserId || isSpaceModerator(space, sender)) return;
  const { blockedWords } = readModerationConfig(space);
  if (blockedWords.length === 0 || event.isRedacted()) return;
  const body = event.getContent<{ body?: unknown }>().body;
  if (typeof body !== 'string') return;
  const word = findBlockedWord(body, blockedWords);
  if (!word) return;

  let deleted = false;
  if (canRedactEvent(channel, myUserId, event)) {
    try {
      await mx.redactEvent(channel.roomId, event.getId()!, undefined, { reason: 'Automod: a word this Space doesn’t allow' });
      deleted = true;
    } catch {
      // Another moderator's client probably got there first.
    }
  }
  await fileAutomodReport(mx, space, event, word, deleted);
}
