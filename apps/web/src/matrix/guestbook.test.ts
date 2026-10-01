import { describe, expect, it, vi } from 'vitest';
import {
  enforceGuestbookAutomod,
  GUESTBOOK_EVENT,
  guestbookSigningProblem,
  guestbookWaitMs,
  readGuestbookEntries,
  signGuestbook,
  visibleGuestbookEntries,
  type GuestbookEntry,
  type GuestbookRules,
} from './guestbook';

const entry = (eventId: string, sender: string, body: string, ts = 1000): GuestbookEntry => ({ eventId, sender, body, ts });
const open: GuestbookRules = { who: 'everyone', slowmode: 0, blockedWords: [] };

describe('readGuestbookEntries', () => {
  it('keeps real entries and drops redacted, empty, over-long and other events', () => {
    const entries = readGuestbookEntries([
      { event_id: '$1', type: GUESTBOOK_EVENT, sender: '@a:s', origin_server_ts: 5, content: { body: ' hi ' } },
      { event_id: '$2', type: GUESTBOOK_EVENT, sender: '@a:s', content: { body: 'x' }, unsigned: { redacted_because: {} } },
      { event_id: '$3', type: GUESTBOOK_EVENT, sender: '@a:s', content: { body: '   ' } },
      { event_id: '$4', type: GUESTBOOK_EVENT, sender: '@a:s', content: { body: 'x'.repeat(501) } },
      { event_id: '$5', type: 'xyz.nekous.comment', sender: '@a:s', content: { body: 'comment' } },
      { event_id: '$6', type: GUESTBOOK_EVENT, sender: '@a:s', content: { body: { evil: true } } },
    ]);
    expect(entries).toEqual([{ eventId: '$1', sender: '@a:s', ts: 5, body: 'hi' }]);
  });
});

describe('visibleGuestbookEntries', () => {
  const entries = [
    entry('$1', '@friend:s', 'hello'),
    entry('$2', '@stranger:s', 'hello'),
    entry('$3', '@friend:s', 'you are RUDE!'),
    entry('$4', '@owner:s', 'rude of me'),
  ];

  it('leaves out entries with a blocked word, but never the owner’s own', () => {
    const visible = visibleGuestbookEntries(entries, '@owner:s', { ...open, blockedWords: ['rude'] }, []);
    expect(visible.map((e) => e.eventId)).toEqual(['$1', '$2', '$4']);
  });

  it('with "people I follow", shows only those, and the owner', () => {
    const visible = visibleGuestbookEntries(entries, '@owner:s', { ...open, who: 'following' }, ['@friend:s']);
    expect(visible.map((e) => e.eventId)).toEqual(['$1', '$3', '$4']);
  });

  it('leaves out entries sent faster than the slowmode allows, from another client say', () => {
    // Newest first, as the page loads them. @x signs at 0s, 5s, 20s and 61s under a 60s slowmode.
    const flood = [
      entry('$x4', '@x:s', 'four', 61_000),
      entry('$o2', '@owner:s', 'mine', 30_000),
      entry('$x3', '@x:s', 'three', 20_000),
      entry('$o1', '@owner:s', 'mine too', 25_000),
      entry('$y1', '@y:s', 'hi', 10_000),
      entry('$x2', '@x:s', 'two', 5_000),
      entry('$x1', '@x:s', 'one', 0),
    ];
    const visible = visibleGuestbookEntries(flood, '@owner:s', { ...open, slowmode: 60 }, []);
    expect(visible.map((e) => e.eventId)).toEqual(['$x4', '$o2', '$o1', '$y1', '$x1']);
  });
});

describe('signing rules', () => {
  it('holds back someone the owner does not follow', () => {
    expect(guestbookSigningProblem('@x:s', '@owner:s', { ...open, who: 'following' }, ['@y:s'], [])).toEqual({ kind: 'following' });
    expect(guestbookSigningProblem('@y:s', '@owner:s', { ...open, who: 'following' }, ['@y:s'], [])).toBeUndefined();
  });

  it('applies slowmode from the person’s latest entry, and never to the owner', () => {
    const entries = [entry('$1', '@x:s', 'hi', 10_000), entry('$2', '@y:s', 'hi', 14_000)];
    expect(guestbookWaitMs(entries, '@x:s', 30, 20_000)).toBe(20_000);
    expect(guestbookWaitMs(entries, '@x:s', 30, 50_000)).toBe(0);
    expect(guestbookWaitMs(entries, '@z:s', 30, 20_000)).toBe(0);
    expect(guestbookWaitMs(entries, '@x:s', 0, 20_000)).toBe(0);
    expect(guestbookSigningProblem('@x:s', '@owner:s', { ...open, slowmode: 30 }, [], entries, 20_000)).toEqual({ kind: 'wait', ms: 20_000 });
    expect(
      guestbookSigningProblem('@owner:s', '@owner:s', { ...open, slowmode: 30 }, [], [entry('$3', '@owner:s', 'hi', 19_000)], 20_000)
    ).toBeUndefined();
  });
});

describe('signGuestbook', () => {
  const client = () => ({
    getUserId: () => '@x:s',
    getRoom: () => ({ getMyMembership: () => 'join' }),
    joinRoom: vi.fn(),
    sendEvent: vi.fn(async () => ({ event_id: '$new' })),
  });

  it('sends the entry as its own event type, trimmed', async () => {
    const mx = client();
    await signGuestbook(mx as never, '!r:s', '@owner:s', '  hello  ', open);
    expect(mx.sendEvent).toHaveBeenCalledWith('!r:s', GUESTBOOK_EVENT, { body: 'hello' });
  });

  it('refuses empty, over-long and blocked-word entries without sending', async () => {
    const mx = client();
    await expect(signGuestbook(mx as never, '!r:s', '@owner:s', '   ', open)).rejects.toThrow();
    await expect(signGuestbook(mx as never, '!r:s', '@owner:s', 'x'.repeat(501), open)).rejects.toThrow();
    await expect(signGuestbook(mx as never, '!r:s', '@owner:s', 'So RUDE.', { ...open, blockedWords: ['rude'] })).rejects.toThrow(/word/);
    expect(mx.sendEvent).not.toHaveBeenCalled();
  });
});

describe('enforceGuestbookAutomod', () => {
  it('deletes other people’s entries with a blocked word, and reports which', async () => {
    const redactEvent = vi.fn(async () => ({}));
    const mx = { getUserId: () => '@owner:s', redactEvent };
    const removed = await enforceGuestbookAutomod(
      mx as never,
      '!r:s',
      [entry('$1', '@x:s', 'rude'), entry('$2', '@x:s', 'nice'), entry('$3', '@owner:s', 'rude')],
      ['rude']
    );
    expect(removed).toEqual(['$1']);
    expect(redactEvent).toHaveBeenCalledTimes(1);
  });
});
