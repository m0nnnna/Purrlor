import type { ReactNode } from 'react';
import { useLocalParticipant, useRoomContext } from '@livekit/components-react';
import { useWatchTogether } from './useWatchTogether';
import { WatchTogetherContext } from './watchTogetherContext';

/**
 * Holds the call's shared Watch/Listen together session for as long as the call lasts. Mounted
 * inside the LiveKit room in ActiveVoiceCall, above everything — so the call's pane and the
 * Now playing card beside the call bar read the same session, and it keeps going whichever
 * channel is on screen.
 *
 * Split out from watchTogetherContext.tsx (rather than living there like before) because this
 * needs @livekit/components-react's room context and that file doesn't — see its comment.
 */
export function WatchTogetherProvider({ children }: { children: ReactNode }) {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const controls = useWatchTogether(room, localParticipant.identity);
  return <WatchTogetherContext.Provider value={controls}>{children}</WatchTogetherContext.Provider>;
}
