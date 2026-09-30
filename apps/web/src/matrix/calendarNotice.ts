import type { MatrixClient } from 'matrix-js-sdk';
import type { CalendarEventInput } from './calendar';

/** "Movie night · Fri, Oct 2, 7:00 PM": what a notice says about when. */
export function eventNoticeBody(input: Pick<CalendarEventInput, 'title' | 'start' | 'location'>, locale?: string): string {
  const when = new Date(input.start).toLocaleString(locale, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `📅 New event: ${input.title.trim()} · ${when}${input.location?.trim() ? ` · ${input.location.trim()}` : ''}`;
}

/**
 * Tells a channel about an event just added to the Space's calendar, as a notice (the kind bots
 * post, which doesn't notify anyone), so people who don't open Events still hear of it.
 */
export async function announceEvent(mx: MatrixClient, channelId: string, input: Pick<CalendarEventInput, 'title' | 'start' | 'location'>): Promise<void> {
  await mx.sendMessage(channelId, { msgtype: 'm.notice', body: eventNoticeBody(input) } as any);
}
