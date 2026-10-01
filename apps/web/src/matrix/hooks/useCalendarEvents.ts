import { useEffect, useState } from 'react';
import { RoomStateEvent, type Room } from 'matrix-js-sdk';
import { CALENDAR_EVENT, readCalendarEvents, type CalendarEvent } from '../calendar';

/** A Space's calendar events, live. Empty without a Space. */
export function useCalendarEvents(space: Room | undefined): CalendarEvent[] {
  const [events, setEvents] = useState<CalendarEvent[]>(() => (space ? readCalendarEvents(space) : []));
  useEffect(() => {
    if (!space) {
      setEvents([]);
      return undefined;
    }
    const update = () => setEvents(readCalendarEvents(space));
    update();
    const onState = (stateEvent: { getType: () => string }) => {
      if (stateEvent.getType() === CALENDAR_EVENT) update();
    };
    space.on(RoomStateEvent.Events, onState);
    return () => {
      space.removeListener(RoomStateEvent.Events, onState);
    };
  }, [space]);
  return events;
}
