import { describe, expect, it, vi } from 'vitest';
import type { MatrixClient, Room } from 'matrix-js-sdk';
import { channelPosition, moveCategory, moveChannel, sameLayout, saveChannelLayout, type ChannelLayout } from './channelLayout';

const layout: ChannelLayout = {
  uncategorized: ['rules', 'welcome'],
  categories: [
    { id: 'text', channelIds: ['general', 'memes', 'art'] },
    { id: 'voice', channelIds: ['lounge'] },
    { id: 'empty', channelIds: [] },
  ],
};

describe('moveChannel', () => {
  it('reorders within a category, counting positions from before the move', () => {
    expect(moveChannel(layout, 'general', { categoryId: 'text', index: 3 }).categories[0].channelIds).toEqual(['memes', 'art', 'general']);
    expect(moveChannel(layout, 'art', { categoryId: 'text', index: 0 }).categories[0].channelIds).toEqual(['art', 'general', 'memes']);
    // Just below itself: where it already is.
    expect(moveChannel(layout, 'memes', { categoryId: 'text', index: 2 })).toEqual(layout);
  });

  it('moves between categories, and into and out of the uncategorized channels', () => {
    const intoVoice = moveChannel(layout, 'memes', { categoryId: 'voice', index: 1 });
    expect(intoVoice.categories[0].channelIds).toEqual(['general', 'art']);
    expect(intoVoice.categories[1].channelIds).toEqual(['lounge', 'memes']);

    const toTop = moveChannel(layout, 'lounge', { categoryId: null, index: 0 });
    expect(toTop.uncategorized).toEqual(['lounge', 'rules', 'welcome']);
    expect(toTop.categories[1].channelIds).toEqual([]);

    const intoEmpty = moveChannel(layout, 'rules', { categoryId: 'empty', index: 5 });
    expect(intoEmpty.uncategorized).toEqual(['welcome']);
    expect(intoEmpty.categories[2].channelIds).toEqual(['rules']);
  });

  it('leaves the layout alone for an unknown channel or category', () => {
    expect(moveChannel(layout, 'nope', { categoryId: null, index: 0 })).toBe(layout);
    expect(moveChannel(layout, 'general', { categoryId: 'gone', index: 0 })).toBe(layout);
  });

  it('finds where a channel is', () => {
    expect(channelPosition(layout, 'welcome')).toEqual({ categoryId: null, index: 1 });
    expect(channelPosition(layout, 'art')).toEqual({ categoryId: 'text', index: 2 });
    expect(channelPosition(layout, 'nope')).toBeUndefined();
  });
});

describe('moveCategory', () => {
  it('reorders categories, counting positions from before the move', () => {
    expect(moveCategory(layout, 'text', 3).categories.map((c) => c.id)).toEqual(['voice', 'empty', 'text']);
    expect(moveCategory(layout, 'empty', 0).categories.map((c) => c.id)).toEqual(['empty', 'text', 'voice']);
    expect(sameLayout(moveCategory(layout, 'text', 1), layout)).toBe(true);
    expect(moveCategory(layout, 'gone', 0)).toBe(layout);
  });
});

describe('saveChannelLayout', () => {
  function fakeSpace(orders: Record<string, string>) {
    const categories = [
      { id: 'text', name: 'Text', channelIds: ['general', 'memes', 'art'] },
      { id: 'voice', name: 'Voice', channelIds: ['lounge'] },
      { id: 'empty', name: 'Empty', channelIds: [] },
    ];
    return {
      roomId: '!space:x',
      currentState: {
        getStateEvents: (type: string, key: string) =>
          type === 'xyz.nekous.channel_categories'
            ? { getContent: () => ({ categories }) }
            : { getContent: () => ({ via: ['x'], order: orders[key] }) },
      },
    } as unknown as Room;
  }

  it('writes only what changed, keeping category names', async () => {
    const sendStateEvent = vi.fn().mockResolvedValue({});
    const mx = { sendStateEvent } as unknown as MatrixClient;
    const space = fakeSpace({ rules: '0', welcome: '1' });

    // Within a category: one categories write, no channel links.
    await saveChannelLayout(mx, space, layout, moveChannel(layout, 'art', { categoryId: 'text', index: 0 }));
    expect(sendStateEvent).toHaveBeenCalledTimes(1);
    expect(sendStateEvent.mock.calls[0][1]).toBe('xyz.nekous.channel_categories');
    expect(sendStateEvent.mock.calls[0][2].categories[0]).toEqual({ id: 'text', name: 'Text', channelIds: ['art', 'general', 'memes'] });

    // Out of a category to the top: the categories, and only the links whose order changed.
    sendStateEvent.mockClear();
    await saveChannelLayout(mx, space, layout, moveChannel(layout, 'lounge', { categoryId: null, index: 2 }));
    const linkWrites = sendStateEvent.mock.calls.filter((call) => call[1] === 'm.space.child');
    expect(linkWrites.map((call) => [call[3], call[2].order])).toEqual([['lounge', '2']]);
    expect(sendStateEvent.mock.calls.some((call) => call[1] === 'xyz.nekous.channel_categories')).toBe(true);

    // No change: nothing written.
    sendStateEvent.mockClear();
    await saveChannelLayout(mx, space, layout, layout);
    expect(sendStateEvent).not.toHaveBeenCalled();
  });
});
