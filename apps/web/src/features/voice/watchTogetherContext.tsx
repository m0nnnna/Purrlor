import { createContext, useContext } from 'react';
import type { WatchTogetherControls } from './useWatchTogether';

// Deliberately livekit-free: NowPlayingCard reads useSharedWatchTogether() from the sidebar
// (ChannelList), which is mounted whether or not a call is active — pulling @livekit/components-
// react into that module graph would undo VoiceCallBody/ActiveVoiceCall's code-splitting. The
// provider that actually needs LiveKit's room context lives in WatchTogetherProvider.tsx instead.

export const WatchTogetherContext = createContext<WatchTogetherControls | null>(null);

/** The call's shared session and its controls; null outside a connected call. */
export function useSharedWatchTogether(): WatchTogetherControls | null {
  return useContext(WatchTogetherContext);
}
