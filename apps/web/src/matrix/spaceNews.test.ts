import { describe, expect, it, vi } from 'vitest';
import type { MatrixClient, Room } from 'matrix-js-sdk';
import type { ChannelCategory } from './channelCategories';
import { capabilityLevel, withCapability } from './roles';
import {
  channelsInListOrder,
  firstTextChannel,
  hasUnseenNews,
  markNewsSeen,
  NEWS_SEEN_ACCOUNT_DATA,
  readSpaceNews,
  saveSpaceNews,
  SPACE_NEWS_EVENT,
  spaceLanding,
} from './spaceNews';

/** A Space whose news is whatever was last written to it, and a client with account data. */
function fakeWorld(spaceId: string, news?: Record<string, unknown>) {
  const state: { news?: Record<string, unknown> } = { news };
  const accountData: Record<string, Record<string, unknown>> = {};
  const space = {
    roomId: spaceId,
    currentState: {
      getStateEvents: (type: string) => (type === SPACE_NEWS_EVENT && state.news ? { getContent: () => state.news } : null),
    },
  } as unknown as Room;
  const mx = {
    getUserId: () => '@editor:x',
    getAccountData: (type: string) => (accountData[type] ? { getContent: () => accountData[type] } : undefined),
    getAccountDataFromServer: async (type: string) => accountData[type] ?? null,
    setAccountData: vi.fn(async (type: string, content: Record<string, unknown>) => {
      accountData[type] = content;
    }),
    sendStateEvent: vi.fn(async (_roomId: string, _type: string, content: Record<string, unknown>) => {
      state.news = content;
    }),
  } as unknown as MatrixClient;
  return { space, mx, accountData };
}

function channel(roomId: string, type?: 'voice' | 'feed'): Room {
  return {
    roomId,
    name: roomId,
    currentState: { getStateEvents: (t: string) => (t === 'xyz.nekous.channel_type' && type ? { getContent: () => ({ type }) } : null) },
  } as unknown as Room;
}

describe('readSpaceNews', () => {
  it('reads news with a body and a revision, and treats anything else as none', () => {
    expect(readSpaceNews(fakeWorld('!s', { body: 'Hello', revision: 'r1', updated_ts: 5, updated_by: '@a:x' }).space)).toEqual({
      body: 'Hello',
      revision: 'r1',
      updatedTs: 5,
      updatedBy: '@a:x',
    });
    expect(readSpaceNews(fakeWorld('!s').space)).toBeUndefined();
    expect(readSpaceNews(fakeWorld('!s', {}).space)).toBeUndefined(); // cleared
    expect(readSpaceNews(fakeWorld('!s', { body: '  ', revision: 'r1' }).space)).toBeUndefined();
  });
});

describe('seeing the news', () => {
  it('is unseen until marked, then seen, per Space', async () => {
    const { space, mx, accountData } = fakeWorld('!seen-a', { body: 'Hello', revision: 'r1' });
    expect(hasUnseenNews(mx, space)).toBe(true);
    await markNewsSeen(mx, space);
    expect(hasUnseenNews(mx, space)).toBe(false);
    expect(accountData[NEWS_SEEN_ACCOUNT_DATA]).toEqual({ '!seen-a': 'r1' });
  });

  it('counts as seen at once, before the account data write comes back', () => {
    const { space, mx } = fakeWorld('!seen-b', { body: 'Hello', revision: 'r1' });
    (mx.getAccountDataFromServer as unknown) = () => new Promise(() => undefined); // never answers
    void markNewsSeen(mx, space);
    expect(hasUnseenNews(mx, space)).toBe(false);
  });

  it('has nothing to see in a Space without news', () => {
    const { space, mx } = fakeWorld('!seen-c');
    expect(hasUnseenNews(mx, space)).toBe(false);
  });
});

describe('saveSpaceNews', () => {
  it('announces new news, so everyone else sees it — but not whoever wrote it', async () => {
    const { space, mx } = fakeWorld('!save-a');
    await saveSpaceNews(mx, space, '  Movie night on Friday  ', { announce: false });
    const news = readSpaceNews(space)!;
    expect(news.body).toBe('Movie night on Friday');
    expect(news.revision).toBeTruthy();
    expect(news.updatedBy).toBe('@editor:x');
    expect(hasUnseenNews(mx, space)).toBe(false);
  });

  it('keeps the revision for a small fix, and makes a new one when announced', async () => {
    const { space, mx } = fakeWorld('!save-b', { body: 'Movie nihgt', revision: 'r1' });
    await saveSpaceNews(mx, space, 'Movie night', { announce: false });
    expect(readSpaceNews(space)!.revision).toBe('r1');
    await saveSpaceNews(mx, space, 'Movie night moved to Saturday', { announce: true });
    expect(readSpaceNews(space)!.revision).not.toBe('r1');
  });

  it('clears the news when saved empty, and refuses a novel', async () => {
    const { space, mx } = fakeWorld('!save-c', { body: 'Old news', revision: 'r1' });
    await saveSpaceNews(mx, space, '   ', { announce: true });
    expect(readSpaceNews(space)).toBeUndefined();
    await expect(saveSpaceNews(mx, space, 'x'.repeat(10_001), { announce: true })).rejects.toThrow('Keep the news under');
  });
});

describe('where opening a Space goes', () => {
  const general = channel('!general');
  const lounge = channel('!lounge', 'voice');
  const rules = channel('!rules');
  const games = channel('!games');
  const categories: ChannelCategory[] = [
    { id: 'c1', name: 'Voice', channelIds: ['!lounge'] },
    { id: 'c2', name: 'Info', channelIds: ['!rules', '!gone'] },
  ];

  it('orders channels as the list shows them: uncategorized first, then category by category', () => {
    expect(channelsInListOrder([rules, lounge, general, games], categories).map((r) => r.roomId)).toEqual([
      '!general',
      '!games',
      '!lounge',
      '!rules',
    ]);
  });

  it('picks the first text channel from the top, skipping voice', () => {
    expect(firstTextChannel([lounge, rules], categories)?.roomId).toBe('!rules');
    expect(firstTextChannel([lounge], categories)).toBeUndefined();
  });

  it('goes to unseen news first, else the first text channel, else nowhere', async () => {
    const withNews = fakeWorld('!land-a', { body: 'Hello', revision: 'r1' });
    expect(spaceLanding(withNews.mx, withNews.space, [general], [])).toEqual({ kind: 'news' });
    await markNewsSeen(withNews.mx, withNews.space);
    expect(spaceLanding(withNews.mx, withNews.space, [general], [])).toEqual({ kind: 'channel', roomId: '!general' });

    const empty = fakeWorld('!land-b');
    expect(spaceLanding(empty.mx, empty.space, [lounge], categories)).toEqual({ kind: 'none' });
  });
});

describe('the news capability', () => {
  it('is the news event’s own level in the Space’s power levels', () => {
    expect(capabilityLevel({}, 'news')).toBe(50);
    expect(capabilityLevel({ state_default: 100 }, 'news')).toBe(100);
    const levels = withCapability({ events: { 'm.room.name': 50 } }, 'news', 25);
    expect(levels.events).toEqual({ 'm.room.name': 50, [SPACE_NEWS_EVENT]: 25 });
    expect(capabilityLevel(levels, 'news')).toBe(25);
  });
});
