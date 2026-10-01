import { useEffect, useState } from 'react';
import { RoomStateEvent, type Room } from 'matrix-js-sdk';
import { CALENDAR_EVENT, readCalendarEvents, type CalendarEvent } from '../calendar';

/** One calendar event of a Space, live (edits and cancelling show at once). Undefined if it's gone. */
export function useCalendarEvent(space: Room | undefined, eventId: string): CalendarEvent | undefined {
  const [event, setEvent] = useState(() => (space ? readCalendarEvents(space).find((e) => e.id === eventId) : undefined));
  useEffect(() => {
    if (!space) {
      setEvent(undefined);
      return undefined;
    }
    const update = () => setEvent(readCalendarEvents(space).find((e) => e.id === eventId));
    update();
    const onState = (stateEvent: { getType: () => string }) => {
      if (stateEvent.getType() === CALENDAR_EVENT) update();
    };
    space.on(RoomStateEvent.Events, onState);
    return () => {
      space.removeListener(RoomStateEvent.Events, onState);
    };
  }, [space, eventId]);
  return event;
}
