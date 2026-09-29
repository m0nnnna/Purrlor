import { lazy, Suspense, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import { activeVoiceChannelIdAtom } from '../../app/state/selection';
import { useRoom } from '../../matrix/hooks/useRoom';

// livekit-client/@livekit/components-react load as their own chunk — only once a voice channel
// is actually selected — rather than in the main bundle for every visitor. See ActiveVoiceCall.tsx.
const ActiveVoiceCall = lazy(() => import('./ActiveVoiceCall'));

/**
 * Owns the active voice call for the whole app, mounted once above ChannelList/MainPane in
 * AppShell — so it keeps running (and keeps its LiveKit connection alive) no matter what the
 * user navigates to elsewhere, the way Discord lets you keep chatting in a text channel while
 * still in a voice call. Descendants (MainPane's call UI, a connected-call indicator in
 * ChannelList) read the call via `useVoiceCall()` rather than owning any connection state
 * themselves.
 */
export function VoiceCallSession({ children }: { children: ReactNode }) {
  const activeVoiceChannelId = useAtomValue(activeVoiceChannelIdAtom);
  const room = useRoom(activeVoiceChannelId);

  if (!room) {
    return <>{children}</>;
  }
  // Fallback renders the app's ordinary content (as if no call were active yet) while the voice
  // chunk loads, rather than blocking the whole app shell on it — the call UI simply catches up
  // a moment later once it's ready.
  return (
    <Suspense fallback={<>{children}</>}>
      <ActiveVoiceCall room={room}>{children}</ActiveVoiceCall>
    </Suspense>
  );
}
