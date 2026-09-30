import { useEffect, useState } from 'react';
import { useSetAtom } from 'jotai';
import { RoomStateEvent, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { selectedRoomIdAtom, selectedSpaceViewAtom } from '../../app/state/selection';
import { Icon } from '../../components/Icon';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import {
  canManageCalendar,
  cancelCalendarEvent,
  pastEvents,
  readCalendarEvents,
  readOwnRsvp,
  readRsvps,
  setRsvp,
  upcomingEvents,
  type CalendarEvent,
  type Rsvp,
} from '../../matrix/calendar';
import { EventFormModal } from './EventFormModal';
import './CalendarView.css';

/** Re-renders when the Space's state changes: its events, or anyone's RSVP (a member event). */
function useSpaceStateVersion(space: Room): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const onState = (event: MatrixEvent) => {
      if (event.getRoomId() === space.roomId) setVersion((v) => v + 1);
    };
    space.on(RoomStateEvent.Events, onState);
    return () => {
      space.removeListener(RoomStateEvent.Events, onState);
    };
  }, [space]);
  return version;
}

const dayFormat: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric' };
const timeFormat: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function EventCard({ space, event, going, interested }: { space: Room; event: CalendarEvent; going: string[]; interested: string[] }) {
  const mx = useMatrixClient();
  const myUserId = mx.getUserId() ?? '';
  const setSelectedRoomId = useSetAtom(selectedRoomIdAtom);
  const setSpaceView = useSetAtom(selectedSpaceViewAtom);
  const own = readOwnRsvp(space, myUserId, event.id);
  const canManage = canManageCalendar(space, myUserId);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string>();
  const channel = event.channelId ? mx.getRoom(event.channelId) : null;

  const rsvp = (value: Rsvp | undefined) => {
    setError(undefined);
    setRsvp(mx, space, event.id, value).catch((err: unknown) => setError(err instanceof Error ? err.message : 'Couldn’t save your RSVP'));
  };

  const cancel = () => {
    setError(undefined);
    cancelCalendarEvent(mx, space, event.id).catch((err: unknown) => setError(err instanceof Error ? err.message : 'Couldn’t cancel the event'));
  };

  const time = `${new Date(event.start).toLocaleTimeString([], timeFormat)}${
    event.end ? `–${new Date(event.end).toLocaleTimeString([], timeFormat)}` : ''
  }`;
  const names = (ids: string[]) => ids.map((id) => space.getMember(id)?.name ?? id).join(', ');

  return (
    <article className="nu-calendar__event" data-nu-role="calendar-event">
      <div className="nu-calendar__event-time">{time}</div>
      <div className="nu-calendar__event-body">
        <h3 className="nu-calendar__event-title">{event.title}</h3>
        {(channel || event.location) && (
          <p className="nu-calendar__event-where">
            {channel ? (
              <button
                type="button"
                className="nu-calendar__event-channel"
                onClick={() => {
                  setSpaceView(null);
                  setSelectedRoomId(channel.roomId);
                }}
              >
                #{channel.name}
              </button>
            ) : (
              event.location
            )}
          </p>
        )}
        {event.description && <p className="nu-calendar__event-description">{event.description}</p>}
        <p className="nu-calendar__event-rsvps" data-nu-role="calendar-event-rsvps" title={names([...going, ...interested])}>
          {going.length} going{interested.length > 0 && ` · ${interested.length} interested`}
        </p>
        <div className="nu-calendar__event-actions">
          <button
            type="button"
            className={own === 'going' ? 'nu-button nu-button--primary' : 'nu-button nu-button--secondary'}
            data-nu-role="calendar-rsvp-going"
            aria-pressed={own === 'going'}
            onClick={() => rsvp(own === 'going' ? undefined : 'going')}
          >
            Going
          </button>
          <button
            type="button"
            className={own === 'interested' ? 'nu-button nu-button--primary' : 'nu-button nu-button--secondary'}
            data-nu-role="calendar-rsvp-interested"
            aria-pressed={own === 'interested'}
            onClick={() => rsvp(own === 'interested' ? undefined : 'interested')}
          >
            Interested
          </button>
          {canManage && (
            <>
              <button type="button" className="nu-button nu-button--secondary" data-nu-role="calendar-event-edit" onClick={() => setEditing(true)}>
                Edit
              </button>
              <button type="button" className="nu-button nu-button--danger" data-nu-role="calendar-event-cancel" onClick={cancel}>
                Cancel event
              </button>
            </>
          )}
        </div>
        {error && <p className="nu-field__error">{error}</p>}
      </div>
      {editing && <EventFormModal space={space} event={event} onClose={() => setEditing(false)} />}
    </article>
  );
}

function EventList({ space, events }: { space: Room; events: CalendarEvent[] }) {
  const rsvps = readRsvps(space);
  const days: { key: string; start: number; events: CalendarEvent[] }[] = [];
  for (const event of events) {
    const key = dayKey(event.start);
    const day = days.find((d) => d.key === key);
    if (day) day.events.push(event);
    else days.push({ key, start: event.start, events: [event] });
  }
  return (
    <>
      {days.map((day) => (
        <section key={day.key} className="nu-calendar__day">
          <h2 className="nu-calendar__day-heading">{new Date(day.start).toLocaleDateString([], dayFormat)}</h2>
          {day.events.map((event) => (
            <EventCard
              key={event.id}
              space={space}
              event={event}
              going={rsvps[event.id]?.going ?? []}
              interested={rsvps[event.id]?.interested ?? []}
            />
          ))}
        </section>
      ))}
    </>
  );
}

/**
 * A Space's calendar (matrix/calendar.ts): what's coming up, grouped by day, with RSVPs. Whoever
 * can manage it (moderators, by default) adds, edits and cancels events. Going to an event means a
 * reminder 15 minutes before it starts (ReminderWatcher).
 */
export function CalendarView({ space }: { space: Room }) {
  const mx = useMatrixClient();
  const setSpaceView = useSetAtom(selectedSpaceViewAtom);
  useSpaceStateVersion(space);
  const [creating, setCreating] = useState(false);
  const events = readCalendarEvents(space);
  const upcoming = upcomingEvents(events);
  const past = pastEvents(events).slice(0, 20);
  const canManage = canManageCalendar(space, mx.getUserId() ?? '');

  return (
    <main className="nu-main-pane" data-nu-role="main-pane">
      <div className="nu-main-pane__header" data-nu-role="main-pane-header">
        <button
          type="button"
          className="nu-main-pane__header-back"
          data-nu-role="main-pane-back"
          title="Back to channels"
          aria-label="Back to channels"
          onClick={() => setSpaceView(null)}
        >
          <Icon name="arrowLeft" size={18} />
        </button>
        <Icon name="calendar" size={20} className="nu-main-pane__header-icon" />
        <h1 className="nu-main-pane__header-name">Events</h1>
        <div className="nu-main-pane__header-actions">
          {canManage && (
            <button type="button" className="nu-button nu-button--primary" data-nu-role="calendar-new-event" onClick={() => setCreating(true)}>
              New event
            </button>
          )}
        </div>
      </div>
      <div className="nu-calendar" data-nu-role="calendar">
        {upcoming.length === 0 ? (
          <p className="nu-calendar__empty" data-nu-role="calendar-empty">
            Nothing coming up in {space.name}.{canManage ? ' Add an event and everyone here can RSVP.' : ''}
          </p>
        ) : (
          <EventList space={space} events={upcoming} />
        )}
        {past.length > 0 && (
          <details className="nu-calendar__past">
            <summary>Past events</summary>
            <EventList space={space} events={past} />
          </details>
        )}
      </div>
      {creating && <EventFormModal space={space} onClose={() => setCreating(false)} />}
    </main>
  );
}
