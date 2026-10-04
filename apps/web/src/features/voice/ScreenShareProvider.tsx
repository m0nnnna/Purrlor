import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Track, type RemoteTrackPublication } from 'livekit-client';
import { useRoomContext, useTracks, type TrackReference } from '@livekit/components-react';
import { useScreenSharePopout } from './useScreenSharePopout';

export type CallScreenShare = {
  /** Every screen share in the call, yours included. */
  shares: TrackReference[];
  /** The one on screen (and in the pop-out). */
  active: TrackReference | undefined;
  /** Watch this person's share instead. */
  select: (identity: string) => void;
  popout: ReturnType<typeof useScreenSharePopout>;
};

/**
 * The share to show: the one picked, while it lasts; otherwise someone else's before your own
 * (your own screen shown back to you is rarely what you want to watch).
 */
export function pickActiveShare(shares: TrackReference[], selected: string | null): TrackReference | undefined {
  return (
    shares.find((share) => share.participant.identity === selected) ??
    shares.find((share) => !share.participant.isLocal) ??
    shares[0]
  );
}

const ScreenShareContext = createContext<CallScreenShare | null>(null);

/**
 * The call's screen shares: which one you're watching, and its pop-out window. Held for the whole
 * call, inside the LiveKit room in ActiveVoiceCall like WatchTogetherProvider, so both outlive the
 * call's pane: the pop-out stays open while you're in another channel (closing only when the share
 * ends or you leave), and your choice of share is still there when you come back.
 *
 * Only the share you're watching is received. Every other one's video (up to 8 Mbps each) and
 * sound are unsubscribed, so you don't download streams nobody is looking at or hear a share you
 * aren't watching. Switching subscribes the new one.
 */
export function ScreenShareProvider({ children }: { children: ReactNode }) {
  const room = useRoomContext();
  // Unsubscribed ones too: they're the ones you can switch to.
  const shares = useTracks([Track.Source.ScreenShare], { onlySubscribed: false });
  const shareAudio = useTracks([Track.Source.ScreenShareAudio], { onlySubscribed: false });
  const [selected, setSelected] = useState<string | null>(null);
  const active = pickActiveShare(shares, selected);
  const activeIdentity = active?.participant.identity;
  const popout = useScreenSharePopout(active?.publication.track?.mediaStreamTrack);

  useEffect(() => {
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        if (publication.source !== Track.Source.ScreenShare && publication.source !== Track.Source.ScreenShareAudio) continue;
        const remote = publication as RemoteTrackPublication;
        const want = participant.identity === activeIdentity;
        if (remote.isDesired !== want) remote.setSubscribed(want);
      }
    }
  }, [room, shares, shareAudio, activeIdentity]);

  const value: CallScreenShare = { shares, active, select: setSelected, popout };
  return <ScreenShareContext.Provider value={value}>{children}</ScreenShareContext.Provider>;
}

const NONE: CallScreenShare = { shares: [], active: undefined, select: () => {}, popout: { isOpen: false, toggle: () => {} } };

/** The call's screen shares; none outside a call. */
export function useCallScreenShare(): CallScreenShare {
  return useContext(ScreenShareContext) ?? NONE;
}
