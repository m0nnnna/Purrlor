import { useEffect, useState } from 'react';
import type { Room } from 'matrix-js-sdk';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { useCalendarEvents } from '../../matrix/hooks/useCalendarEvents';
import { getParentSpace } from '../../matrix/voice';
import { liveWatchPartyIn } from '../../matrix/watchParty';
import { useSharedWatchTogether } from './watchTogetherContext';
import { mediaTitle } from './watchTogether';

/** How long a newcomer waits for the call to answer "what's playing?" before offering to start something. */
const SYNC_GRACE_MS = 2500;

/**
 * In a voice channel that has a watch party on right now (matrix/watchParty.ts), when nothing is
 * playing: "Start <title>", one click. There's no server in a call, so whoever is there when it's
 * live gets the button; it starts Watch Together with the event's link and everyone already in the
 * call is synced, and the button goes for all of them. If two people press at once the tie-break
 * in watchTogether.ts (shouldAcceptState) leaves one session.
 */
export function WatchPartyStartBanner({ room }: { room: Room }) {
  const mx = useMatrixClient();
  const session = useSharedWatchTogether();
  const events = useCalendarEvents(getParentSpace(mx, room) ?? undefined);
  const [now, setNow] = useState(() => Date.now());
  const [settled, setSettled] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    const grace = window.setTimeout(() => setSettled(true), SYNC_GRACE_MS);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(grace);
    };
  }, []);

  const party = liveWatchPartyIn(events, room.roomId, now);
  if (!party || !session || session.state || !settled || dismissed.has(party.id)) return null;

  const label = party.watch.mode === 'listen' ? 'Start listening' : 'Start watching';
  return (
    <div className="nu-voice-panel__party" data-nu-role="watch-party-start">
      <span>
        <strong>{party.title}</strong> is on now. {mediaTitle(party.watch.url)}
      </span>
      <button
        type="button"
        className="nu-button nu-button--primary"
        data-nu-role="watch-party-start-button"
        onClick={() => session.start(party.watch.url, party.watch.mode)}
      >
        {label}
      </button>
      <button type="button" className="nu-button nu-button--secondary" onClick={() => setDismissed((current) => new Set(current).add(party.id))}>
        Not now
      </button>
    </div>
  );
}
