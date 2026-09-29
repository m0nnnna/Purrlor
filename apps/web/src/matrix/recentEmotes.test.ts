import { describe, expect, it, vi } from 'vitest';
import type { MatrixClient } from 'matrix-js-sdk';
import { MAX_RECENT_EMOTES, noteRecentEmote, readRecentEmotes, RECENT_EMOTES_EVENT } from './recentEmotes';

function fakeClient(initialItems: unknown = undefined) {
  let content: Record<string, unknown> | undefined = initialItems === undefined ? undefined : { items: initialItems };
  const setAccountData = vi.fn(async (_type: string, newContent: Record<string, unknown>) => {
    content = newContent;
  });
  const mx = {
    getAccountData: (type: string) =>
      type === RECENT_EMOTES_EVENT && content ? { getContent: () => content } : undefined,
    setAccountData,
  } as unknown as MatrixClient;
  return { mx, setAccountData, getContent: () => content };
}

describe('readRecentEmotes', () => {
  it('returns nothing when there is no account data yet', () => {
    const { mx } = fakeClient();
    expect(readRecentEmotes(mx)).toEqual([]);
  });

  it('drops malformed entries rather than throwing', () => {
    const { mx } = fakeClient([{ shortcode: 'cat', mxcUrl: 'mxc://x/cat' }, { shortcode: 'bad' }, 'nonsense', null]);
    expect(readRecentEmotes(mx)).toEqual([{ shortcode: 'cat', mxcUrl: 'mxc://x/cat' }]);
  });
});

describe('noteRecentEmote', () => {
  it('adds a newly picked emote to the front', async () => {
    const { mx, getContent } = fakeClient([{ shortcode: 'dog', mxcUrl: 'mxc://x/dog' }]);
    await noteRecentEmote(mx, { shortcode: 'cat', mxcUrl: 'mxc://x/cat' });
    expect(getContent()?.items).toEqual([
      { shortcode: 'cat', mxcUrl: 'mxc://x/cat' },
      { shortcode: 'dog', mxcUrl: 'mxc://x/dog' },
    ]);
  });

  it('re-bumps an already-recent shortcode to the front instead of duplicating it', async () => {
    const { mx, getContent } = fakeClient([
      { shortcode: 'cat', mxcUrl: 'mxc://x/cat' },
      { shortcode: 'dog', mxcUrl: 'mxc://x/dog' },
    ]);
    await noteRecentEmote(mx, { shortcode: 'dog', mxcUrl: 'mxc://x/dog' });
    expect(getContent()?.items).toEqual([
      { shortcode: 'dog', mxcUrl: 'mxc://x/dog' },
      { shortcode: 'cat', mxcUrl: 'mxc://x/cat' },
    ]);
  });

  it('caps the list at MAX_RECENT_EMOTES, dropping the oldest', async () => {
    const full = Array.from({ length: MAX_RECENT_EMOTES }, (_, i) => ({ shortcode: `e${i}`, mxcUrl: `mxc://x/${i}` }));
    const { mx, getContent } = fakeClient(full);
    await noteRecentEmote(mx, { shortcode: 'new', mxcUrl: 'mxc://x/new' });
    const items = getContent()?.items as { shortcode: string }[];
    expect(items).toHaveLength(MAX_RECENT_EMOTES);
    expect(items[0].shortcode).toBe('new');
    expect(items.some((i) => i.shortcode === `e${MAX_RECENT_EMOTES - 1}`)).toBe(false);
  });
});
