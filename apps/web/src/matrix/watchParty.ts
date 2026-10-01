import { parseWatchUrl, type WatchTogetherMode } from '../features/voice/watchTogether';
import type { CalendarEvent } from './calendar';

/**
 * **Watch parties.** A calendar event (calendar.ts) that also carries what to play:
 * `"watch": { "url": "https://youtu.be/…", "mode": "watch" | "listen" }` on
 * `xyz.nekous.calendar_event`, held in one of the Space's voice channels. Older clients ignore the
 * field and see a normal event. Nothing here is new infrastructure: the start ping is the event
 * reminder (reminders.ts) at zero minutes, the countdown is on the event's channel notice
 * (calendarNotice.ts), and playback is Watch Together (useWatchTogether.ts) started by whoever
 * joins first once the event is live.
 */

export type WatchParty = { url: string; mode: WatchTogetherMode };

/** Which notice in a channel is about which calendar event, so it can show a live countdown. */
export const NOTICE_EVENT_KEY = 'xyz.nekous.calendar_event_id';

/** A party's field, if it names something Watch Together can play. */
export function parseWatchParty(raw: unknown): WatchParty | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { url, mode } = raw as { url?: unknown; mode?: unknown };
  if (typeof url !== 'string' || url.length > 2000 || !parseWatchUrl(url)) return undefined;
  return { url: url.trim(), mode: mode === 'listen' ? 'listen' : 'watch' };
}

const HOUR_MS = 60 * 60 * 1000;

/** An event's end, counting one with none as an hour (calendar.ts does the same for "upcoming"). */
export const eventEndsAt = (event: Pick<CalendarEvent, 'start' | 'end'>) => event.end ?? event.start + HOUR_MS;

export type PartyPhase = 'upcoming' | 'live' | 'over';

export function partyPhase(event: Pick<CalendarEvent, 'start' | 'end'>, now = Date.now()): PartyPhase {
  if (now < event.start) return 'upcoming';
  return now < eventEndsAt(event) ? 'live' : 'over';
}

/** The watch party happening in `channelId` right now, if there is one (the soonest started wins). */
export function liveWatchPartyIn(events: CalendarEvent[], channelId: string, now = Date.now()): (CalendarEvent & { watch: WatchParty }) | undefined {
  return events
    .filter((event): event is CalendarEvent & { watch: WatchParty } => event.channelId === channelId && !!event.watch && partyPhase(event, now) === 'live')
    .sort((a, b) => a.start - b.start)[0];
}

/** "Starts in 2d 3h", "Starts in 12m 5s": the countdown a notice shows. */
export function countdownLabel(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** "4 watching" / "3 listening" / "Nobody yet". */
export function attendanceLabel(count: number, mode: WatchTogetherMode): string {
  if (count <= 0) return 'Nobody here yet';
  return `${count} ${mode === 'listen' ? 'listening' : 'watching'}`;
}

/** A YouTube video's thumbnail, for the event card. Anything else has none. */
export function watchThumbnailUrl(url: string): string | undefined {
  const parsed = parseWatchUrl(url);
  if (parsed?.kind !== 'youtube' || !/^[\w-]{6,20}$/.test(parsed.videoId)) return undefined;
  return `https://i.ytimg.com/vi/${parsed.videoId}/mqdefault.jpg`;
}
