import { createContext, useContext, type ReactNode } from 'react';
import { Track } from 'livekit-client';
import { useTracks } from '@livekit/components-react';
import { useScreenSharePopout } from './useScreenSharePopout';

type ScreenSharePopout = ReturnType<typeof useScreenSharePopout>;

const ScreenSharePopoutContext = createContext<ScreenSharePopout | null>(null);

/**
 * Holds the screen share's pop-out window for as long as the call lasts, mounted inside the
 * LiveKit room in ActiveVoiceCall like WatchTogetherProvider. It used to belong to the call's
 * pane (VoiceCallBody), which unmounts whenever another channel is opened, so changing channel
 * closed the window, while the whole point of popping it out is to keep watching elsewhere. It
 * still closes when the share ends or you leave the call.
 */
export function ScreenSharePopoutProvider({ children }: { children: ReactNode }) {
  const activeScreenShare = useTracks([Track.Source.ScreenShare])[0];
  const popout = useScreenSharePopout(activeScreenShare?.publication.track?.mediaStreamTrack);
  return <ScreenSharePopoutContext.Provider value={popout}>{children}</ScreenSharePopoutContext.Provider>;
}

/** The call's screen share pop-out; a closed one that can't open outside a call. */
export function useCallScreenSharePopout(): ScreenSharePopout {
  return useContext(ScreenSharePopoutContext) ?? { isOpen: false, toggle: () => {} };
}
