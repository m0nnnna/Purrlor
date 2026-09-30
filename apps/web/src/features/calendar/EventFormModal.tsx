import { useState, type FormEvent } from 'react';
import type { Room } from 'matrix-js-sdk';
import { Modal } from '../../components/Modal';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { createCalendarEvent, updateCalendarEvent, type CalendarEvent } from '../../matrix/calendar';
import { spaceChannels } from '../../matrix/channelPermissions';
import { announceEvent } from '../../matrix/calendarNotice';

/** `datetime-local` wants local time as YYYY-MM-DDTHH:mm. */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function nextFullHour(): number {
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return d.getTime();
}

/** Creating an event in a Space's calendar, or editing one. */
export function EventFormModal({ space, event, onClose }: { space: Room; event?: CalendarEvent; onClose: () => void }) {
  const mx = useMatrixClient();
  const channels = spaceChannels(mx, space);
  const [title, setTitle] = useState(event?.title ?? '');
  const [description, setDescription] = useState(event?.description ?? '');
  const [start, setStart] = useState(toLocalInput(event?.start ?? nextFullHour()));
  const [end, setEnd] = useState(event?.end ? toLocalInput(event.end) : '');
  const [channelId, setChannelId] = useState(event?.channelId ?? '');
  const [location, setLocation] = useState(event?.location ?? '');
  // Where to tell people about a new event: the channel it's in, unless changed. Not offered when editing.
  const [announceIn, setAnnounceIn] = useState<string | undefined>(undefined);
  const announceChannelId = announceIn ?? channelId;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const handleSubmit = async (evt: FormEvent) => {
    evt.preventDefault();
    const startMs = new Date(start).getTime();
    const endMs = end ? new Date(end).getTime() : undefined;
    if (!title.trim() || !Number.isFinite(startMs)) return;
    if (endMs !== undefined && endMs <= startMs) {
      setError('The end has to be after the start.');
      return;
    }
    setSaving(true);
    setError(undefined);
    const input = { title, description, start: startMs, end: endMs, channelId: channelId || undefined, location: channelId ? undefined : location };
    try {
      if (event) await updateCalendarEvent(mx, space, event.id, input);
      else {
        await createCalendarEvent(mx, space, input);
        // A failed notice shouldn't undo the event: it's made, and people can still find it in Events.
        if (announceChannelId) await announceEvent(mx, announceChannelId, input).catch((err: unknown) => console.warn('Couldn’t announce the event', err));
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save the event');
      setSaving(false);
    }
  };

  return (
    <Modal title={event ? 'Edit event' : `New event in ${space.name}`} onClose={onClose}>
      <form className="nu-modal-form" onSubmit={handleSubmit} data-nu-role="calendar-event-form">
        <label className="nu-field">
          Title
          <input className="nu-field__input" data-nu-role="calendar-event-title" value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus />
        </label>
        <label className="nu-field">
          Starts
          <input
            className="nu-field__input"
            type="datetime-local"
            data-nu-role="calendar-event-start"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            required
          />
        </label>
        <label className="nu-field">
          Ends (optional)
          <input className="nu-field__input" type="datetime-local" data-nu-role="calendar-event-end" value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <label className="nu-field">
          Where
          <select className="nu-field__input" data-nu-role="calendar-event-channel" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
            <option value="">Somewhere else</option>
            {channels.map((channel) => (
              <option key={channel.roomId} value={channel.roomId}>
                #{channel.name}
              </option>
            ))}
          </select>
        </label>
        {!channelId && (
          <label className="nu-field">
            Location (optional)
            <input className="nu-field__input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="A link, an address…" />
          </label>
        )}
        {!event && (
          <label className="nu-field">
            Announce in a channel (optional)
            <select
              className="nu-field__input"
              data-nu-role="calendar-event-announce"
              value={announceChannelId}
              onChange={(e) => setAnnounceIn(e.target.value)}
            >
              <option value="">Don’t announce</option>
              {channels.map((channel) => (
                <option key={channel.roomId} value={channel.roomId}>
                  #{channel.name}
                </option>
              ))}
            </select>
            <span className="nu-field__hint">Posts a quiet notice there that doesn’t notify anyone.</span>
          </label>
        )}
        <label className="nu-field">
          Description (optional)
          <textarea className="nu-field__textarea" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        </label>
        {error && <p className="nu-field__error">{error}</p>}
        <div className="nu-form-actions">
          <button type="button" className="nu-button nu-button--secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="nu-button nu-button--primary" data-nu-role="calendar-event-save" disabled={saving || !title.trim()}>
            {saving ? 'Saving…' : event ? 'Save' : 'Create event'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
