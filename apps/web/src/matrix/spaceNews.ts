import type { MatrixClient, Room } from 'matrix-js-sdk';
import type { ChannelCategory } from './channelCategories';
import { readChannelType } from './channelType';
import { readFreshAccountData } from './freshAccountData';

/**
 * A Space's news: one page of announcements that people with the "Edit the Space's news" role
 * (roles.ts, Space Settings → Roles) write, and that everyone sees the first time they open the
 * Space after it changes. Opening the Space once it's been seen goes to its first text channel
 * instead (spaceLanding below, SpaceLanding in ChannelList).
 *
 * The news is a state event on the Space, so the homeserver enforces who may change it (its level
 * in the Space's power levels). Each update meant to be seen gets a new `revision`; a small fix can
 * keep the old one, so nobody is shown it again for a typo. Which revision you've seen is kept per
 * Space in account data, so it's the same on every device.
 */
export const SPACE_NEWS_EVENT = 'xyz.nekous.space_news';
export const NEWS_SEEN_ACCOUNT_DATA = 'xyz.nekous.news_seen';

/** Long enough for a real announcement, short enough to stay a page rather than a document. */
export const MAX_NEWS_LENGTH = 10_000;

export type SpaceNews = { body: string; revision: string; updatedTs: number; updatedBy?: string };

type NewsContent = { body?: unknown; revision?: unknown; updated_ts?: unknown; updated_by?: unknown };

/** The Space's news, or undefined when it has none (never written, or cleared). */
export function readSpaceNews(space: Room): SpaceNews | undefined {
  const content = space.currentState.getStateEvents(SPACE_NEWS_EVENT, '')?.getContent<NewsContent>();
  if (!content || typeof content.body !== 'string' || !content.body.trim() || typeof content.revision !== 'string') return undefined;
  return {
    body: content.body,
    revision: content.revision,
    updatedTs: typeof content.updated_ts === 'number' ? content.updated_ts : 0,
    updatedBy: typeof content.updated_by === 'string' ? content.updated_by : undefined,
  };
}

/**
 * What this session has marked seen, ahead of the account data write coming back from the
 * homeserver: leaving the news the moment it opens mustn't bring it straight back.
 */
const seenThisSession = new Map<string, string>();

function readNewsSeen(mx: MatrixClient): Record<string, string> {
  const stored = mx.getAccountData(NEWS_SEEN_ACCOUNT_DATA as any)?.getContent<Record<string, string>>() ?? {};
  return { ...stored, ...Object.fromEntries(seenThisSession) };
}

/** Whether the Space has news you haven't seen: never opened since it was written or last announced. */
export function hasUnseenNews(mx: MatrixClient, space: Room): boolean {
  const news = readSpaceNews(space);
  return !!news && readNewsSeen(mx)[space.roomId] !== news.revision;
}

/** Records that you've seen the Space's current news. Skips the write when it's already recorded. */
export async function markNewsSeen(mx: MatrixClient, space: Room): Promise<void> {
  const news = readSpaceNews(space);
  if (!news) return;
  const stored = mx.getAccountData(NEWS_SEEN_ACCOUNT_DATA as any)?.getContent<Record<string, string>>() ?? {};
  seenThisSession.set(space.roomId, news.revision);
  if (stored[space.roomId] === news.revision) return;
  const current = (await readFreshAccountData<Record<string, string>>(mx, NEWS_SEEN_ACCOUNT_DATA)) ?? {};
  await mx.setAccountData(NEWS_SEEN_ACCOUNT_DATA as any, { ...current, [space.roomId]: news.revision } as any);
}

/**
 * Writes the Space's news. `announce` gives it a new revision, so everyone is shown it on their
 * next visit; without it (a small fix) people who've seen the last version aren't shown it again.
 * News written for the first time is always announced. An empty body clears the news.
 */
export async function saveSpaceNews(mx: MatrixClient, space: Room, body: string, { announce }: { announce: boolean }): Promise<void> {
  const text = body.trim();
  if (text.length > MAX_NEWS_LENGTH) throw new Error(`Keep the news under ${MAX_NEWS_LENGTH.toLocaleString()} characters.`);
  const previous = readSpaceNews(space);
  const content = text
    ? {
        body: text,
        revision: announce || !previous ? newRevision() : previous.revision,
        updated_ts: Date.now(),
        updated_by: mx.getUserId() ?? undefined,
      }
    : {};
  await mx.sendStateEvent(space.roomId, SPACE_NEWS_EVENT as any, content as any, '');
  // Whoever wrote it has seen it: no point showing them their own news on their next visit.
  if (text) await markNewsSeen(mx, space).catch(() => undefined);
}

function newRevision(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The Space's channels in the order the channel list shows them: those in no category first, in the
 * Space's own order, then each category's, category by category. Pure.
 */
export function channelsInListOrder(spaceRooms: Room[], categories: ChannelCategory[]): Room[] {
  const byId = new Map(spaceRooms.map((room) => [room.roomId, room]));
  const categorized = new Set(categories.flatMap((category) => category.channelIds));
  return [
    ...spaceRooms.filter((room) => !categorized.has(room.roomId)),
    ...categories.flatMap((category) => category.channelIds.flatMap((id) => byId.get(id) ?? [])),
  ];
}

/** The first text channel from the top of the channel list, if the Space has one. Pure. */
export function firstTextChannel(spaceRooms: Room[], categories: ChannelCategory[]): Room | undefined {
  return channelsInListOrder(spaceRooms, categories).find((room) => readChannelType(room) === 'text');
}

/**
 * Where opening a Space takes you: its news when there's some you haven't seen, else its first
 * text channel, else nowhere in particular (a Space with no text channels yet).
 */
export function spaceLanding(
  mx: MatrixClient,
  space: Room,
  spaceRooms: Room[],
  categories: ChannelCategory[]
): { kind: 'news' } | { kind: 'channel'; roomId: string } | { kind: 'none' } {
  if (hasUnseenNews(mx, space)) return { kind: 'news' };
  const channel = firstTextChannel(spaceRooms, categories);
  return channel ? { kind: 'channel', roomId: channel.roomId } : { kind: 'none' };
}
