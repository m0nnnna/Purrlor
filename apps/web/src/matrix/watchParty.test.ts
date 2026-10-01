import { describe, expect, it, vi } from 'vitest';
import { parseCalendarEvent, type CalendarEvent } from './calendar';
import { announceEvent, eventNoticeBody } from './calendarNotice';
import { remindersForGateway } from './reminderPush';
import {
  attendanceLabel,
  countdownLabel,
  liveWatchPartyIn,
  NOTICE_EVENT_KEY,
  parseWatchParty,
  partyPhase,
} from './watchParty';

const HOUR = 60 * 60 * 1000;
const YT = 'https://youtu.be/dQw4w9WgXcQ';

describe('parseWatchParty', () => {
  it('keeps a link Watch Together can play, with its mode', () => {
    expect(parseWatchParty({ url: YT, mode: 'listen' })).toEqual({ url: YT, mode: 'listen' });
    expect(parseWatchParty({ url: ` ${YT} `, mode: 'anything else' })).toEqual({ url: YT, mode: 'watch' });
    expect(parseWatchParty({ url: 'https://example.org/film.mp4' })).toEqual({ url: 'https://example.org/film.mp4', mode: 'watch' });
  });

  it('drops anything else', () => {
    expect(parseWatchParty(undefined)).toBeUndefined();
    expect(parseWatchParty('https://youtu.be/x')).toBeUndefined();
    expect(parseWatchParty({ url: 'javascript:alert(1)' })).toBeUndefined();
    expect(parseWatchParty({ url: 'not a link' })).toBeUndefined();
    expect(parseWatchParty({ url: 42 })).toBeUndefined();
    expect(parseWatchParty({ url: `https://example.org/${'a'.repeat(2000)}` })).toBeUndefined();
  });
});

describe('a calendar event with a watch field', () => {
  const content = { title: 'Movie night', start: 1000, channel_id: '!voice:s', watch: { url: YT, mode: 'watch' } };

  it('carries it with its channel', () => {
    expect(parseCalendarEvent('e1', '@a:s', content)?.watch).toEqual({ url: YT, mode: 'watch' });
  });

  it('is an ordinary event without a channel to watch in, or with a bad link', () => {
    expect(parseCalendarEvent('e1', '@a:s', { ...content, channel_id: undefined })?.watch).toBeUndefined();
    expect(parseCalendarEvent('e1', '@a:s', { ...content, watch: { url: 'nope' } })?.watch).toBeUndefined();
    expect(parseCalendarEvent('e1', '@a:s', { title: 'x', start: 1 })?.watch).toBeUndefined();
  });
});

const party = (start: number, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: `e${start}`,
  title: 'Party',
  description: '',
  start,
  channelId: '!voice:s',
  watch: { url: YT, mode: 'watch' },
  createdBy: '@a:s',
  ...extra,
});

describe('partyPhase', () => {
  it('is upcoming, live, then over, counting an event with no end as an hour', () => {
    const event = party(10 * HOUR);
    expect(partyPhase(event, 9 * HOUR)).toBe('upcoming');
    expect(partyPhase(event, 10 * HOUR)).toBe('live');
    expect(partyPhase(event, 10.9 * HOUR)).toBe('live');
    expect(partyPhase(event, 11 * HOUR)).toBe('over');
    expect(partyPhase(party(10 * HOUR, { end: 13 * HOUR }), 12 * HOUR)).toBe('live');
  });
});

describe('liveWatchPartyIn', () => {
  it('finds the party on now in that channel, not one elsewhere, over, or without a watch field', () => {
    const now = 10.5 * HOUR;
    const here = party(10 * HOUR);
    const events = [
      party(10 * HOUR, { id: 'elsewhere', channelId: '!other:s' }),
      party(2 * HOUR, { id: 'over' }),
      party(10 * HOUR, { id: 'plain', watch: undefined }),
      party(11 * HOUR, { id: 'later' }),
      here,
    ];
    expect(liveWatchPartyIn(events, '!voice:s', now)?.id).toBe(here.id);
    expect(liveWatchPartyIn(events, '!none:s', now)).toBeUndefined();
  });
});

describe('labels', () => {
  it('counts down in the two most useful units', () => {
    expect(countdownLabel(2 * 86400_000 + 3 * HOUR + 5000)).toBe('2d 3h');
    expect(countdownLabel(5 * HOUR + 7 * 60_000)).toBe('5h 7m');
    expect(countdownLabel(12 * 60_000 + 5_000)).toBe('12m 5s');
    expect(countdownLabel(4_200)).toBe('5s');
    expect(countdownLabel(-5)).toBe('0s');
  });

  it('says who is there', () => {
    expect(attendanceLabel(4, 'watch')).toBe('4 watching');
    expect(attendanceLabel(3, 'listen')).toBe('3 listening');
    expect(attendanceLabel(0, 'watch')).toBe('Nobody here yet');
  });
});

describe('the notice and the start ping', () => {
  it('announces a watch party as one, tagged with its event so it can count down', async () => {
    const sendMessage = vi.fn(async () => ({}));
    const input = { title: 'Movie night', start: Date.UTC(2026, 9, 2, 19), watch: { url: YT, mode: 'watch' as const } };
    expect(eventNoticeBody(input, 'en-US')).toMatch(/^🎬 Watch party: Movie night/);
    await announceEvent({ sendMessage } as never, '!chan', input, 'e1');
    expect(sendMessage).toHaveBeenCalledWith('!chan', expect.objectContaining({ msgtype: 'm.notice', [NOTICE_EVENT_KEY]: 'e1' }));
  });

  it('sends the gateway a second reminder at the start, opening the voice channel', () => {
    const now = 1000;
    const list = remindersForGateway([], [party(now + 30 * 60_000), party(now + 40 * 60_000, { id: 'plain', watch: undefined })], {
      now,
      encryptedRoomIds: new Set(),
    });
    expect(new Set(list.map((r) => r.id))).toEqual(new Set([`event:e${now + 30 * 60_000}`, 'event:plain', `event-start:e${now + 30 * 60_000}`]));
    const start = list.find((r) => r.id.startsWith('event-start:'));
    expect(start).toMatchObject({ at: now + 30 * 60_000, roomId: '!voice:s' });
    expect(list.filter((r) => r.id.startsWith('event-start:'))).toHaveLength(1);
  });
});
