import { useEffect, useState } from 'react';
import type { Room } from 'matrix-js-sdk';
import { Icon } from '../../components/Icon';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { useCalendarEvent } from '../../matrix/hooks/useCalendarEvent';
import { useSpaceVoiceServer } from '../../matrix/hooks/useSpaceVoiceServer';
import { useVoiceChannelParticipants } from '../../matrix/hooks/useVoiceChannelParticipants';
import { getParentSpace } from '../../matrix/voice';
import { attendanceLabel, countdownLabel, partyPhase } from '../../matrix/watchParty';
import { useJoinVoiceChannel } from './useJoinVoiceChannel';
import './WatchPartyCard.css';

/**
 * Under a watch party's notice in its channel (matrix/calendarNotice.ts): a live countdown, then
 * "Live now: 4 watching" from the voice channel's participant list, with a Join button. Nothing
 * for an ordinary event's notice, or once a party is over.
 */
export function WatchPartyCard({ room, eventId }: { room: Room; eventId: string }) {
  const mx = useMatrixClient();
  const space = getParentSpace(mx, room);
  const event = useCalendarEvent(space ?? undefined, eventId);
  const voiceServer = useSpaceVoiceServer(space ?? undefined);
  const join = useJoinVoiceChannel();
  const [now, setNow] = useState(() => Date.now());
  const phase = event ? partyPhase(event, now) : 'over';

  // Once a second while counting down; the rest of the time a slow tick is enough to notice it ending.
  useEffect(() => {
    if (!event || phase === 'over') return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), phase === 'upcoming' && event.start - now < 3600_000 ? 1000 : 15_000);
    return () => window.clearInterval(timer);
  }, [event, phase, now]);

  const participants = useVoiceChannelParticipants(event?.channelId ?? '', phase === 'live' && event?.watch ? voiceServer : undefined);

  if (!event?.watch || !event.channelId || phase === 'over') return null;
  const { channelId, watch } = event;
  return (
    <div className={phase === 'live' ? 'nu-watch-party nu-watch-party--live' : 'nu-watch-party'} data-nu-role="watch-party-card">
      <Icon name="play" size={14} />
      <span className="nu-watch-party__status" data-nu-role="watch-party-status">
        {phase === 'live' ? `Live now: ${attendanceLabel(participants.length, watch.mode)}` : `Starts in ${countdownLabel(event.start - now)}`}
      </span>
      <button type="button" className="nu-button nu-button--primary" data-nu-role="watch-party-join" onClick={() => join(channelId)}>
        {phase === 'live' ? 'Join' : 'Join early'}
      </button>
    </div>
  );
}
