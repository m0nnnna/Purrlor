import { describe, expect, it, vi } from 'vitest';
import type { MatrixClient } from 'matrix-js-sdk';
import { addMentionToInbox, readMentionInbox } from './mentionInbox';

const MENTION_INBOX_EVENT = 'xyz.nekous.mention_inbox';

function fakeClient(items: { roomId: string; eventId: string; mentionedAt: number }[] = []) {
  const setAccountData = vi.fn().mockResolvedValue({});
  const mx = {
    getAccountData: (type: string) => (type === MENTION_INBOX_EVENT ? { getContent: () => ({ items }) } : undefined),
    setAccountData,
  } as unknown as MatrixClient;
  return { mx, setAccountData };
}

describe('readMentionInbox', () => {
  it('returns an empty list when nothing has been logged', () => {
    const { mx } = fakeClient();
    expect(readMentionInbox(mx)).toEqual([]);
  });

  it('returns whatever is stored', () => {
    const { mx } = fakeClient([{ roomId: '!a:example.org', eventId: '$1', mentionedAt: 123 }]);
    expect(readMentionInbox(mx)).toEqual([{ roomId: '!a:example.org', eventId: '$1', mentionedAt: 123 }]);
  });
});

describe('addMentionToInbox', () => {
  it('appends a new mention', async () => {
    const { mx, setAccountData } = fakeClient();
    await addMentionToInbox(mx, '!a:example.org', '$1');
    expect(setAccountData).toHaveBeenCalledWith(
      MENTION_INBOX_EVENT,
      expect.objectContaining({ items: [expect.objectContaining({ roomId: '!a:example.org', eventId: '$1' })] })
    );
  });

  it('does not duplicate an already-logged mention', async () => {
    const { mx, setAccountData } = fakeClient([{ roomId: '!a:example.org', eventId: '$1', mentionedAt: 1 }]);
    await addMentionToInbox(mx, '!a:example.org', '$1');
    expect(setAccountData).not.toHaveBeenCalled();
  });

  it('caps the list at 50 entries, dropping the oldest', async () => {
    const existing = Array.from({ length: 50 }, (_, i) => ({
      roomId: '!a:example.org',
      eventId: `$${i}`,
      mentionedAt: i,
    }));
    const { mx, setAccountData } = fakeClient(existing);
    await addMentionToInbox(mx, '!a:example.org', '$new');
    const written = setAccountData.mock.calls[0][1] as { items: { eventId: string }[] };
    expect(written.items).toHaveLength(50);
    expect(written.items[0].eventId).toBe('$1'); // oldest ($0) dropped
    expect(written.items[written.items.length - 1].eventId).toBe('$new');
  });
});
