import { lazy, Suspense } from 'react';
import { useSetAtom } from 'jotai';
import type { Room as MatrixRoom } from 'matrix-js-sdk';
import { activeVoiceChannelIdAtom } from '../../app/state/selection';
import { useSpaceVoiceServer } from '../../matrix/hooks/useSpaceVoiceServer';
import { getParentSpace } from '../../matrix/voice';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { useVoiceCall } from './voiceCallContext';
import './VoiceChannelPanel.css';

// The live call UI (participant grid, controls, screen share) pulls in livekit-client and
// @livekit/components-react — loaded as its own chunk, only once a call actually reaches the
// "ready" state, rather than in the main bundle for every visitor. See VoiceCallBody.tsx.
const VoiceCallBody = lazy(() => import('./VoiceCallBody'));

/**
 * Voice channel main pane. The call itself is owned by VoiceCallSession (mounted once at the
 * AppShell level, so it survives navigating away to a text channel) — this component only
 * decides what to show for *this particular room*: the live call UI if it's the one you're
 * actually connected to, a join prompt if it's a different (or no) voice channel, or a
 * connecting/error status in between.
 */
export function VoiceChannelPanel({ room }: { room: MatrixRoom }) {
  const mx = useMatrixClient();
  const space = getParentSpace(mx, room);
  const voiceServer = useSpaceVoiceServer(space);
  const setActiveVoiceChannelId = useSetAtom(activeVoiceChannelIdAtom);
  const call = useVoiceCall();
  const activeCall = call && call.roomId === room.roomId ? call : null;

  // A call that failed is still the *active* one, so the way back in is a real retry of the
  // token fetch — not re-selecting a channel that's already selected, which set the atom to the
  // value it already held and so did nothing at all.
  if (activeCall?.state.status === 'error') {
    return (
      <div className="nu-voice-panel nu-voice-panel--join" data-nu-role="voice-panel">
        <p className="nu-voice-panel__error" data-nu-role="voice-error">
          {activeCall.state.message}
        </p>
        <div className="nu-voice-panel__actions">
          <button type="button" className="nu-button nu-button--primary" onClick={activeCall.retry}>
            Try again
          </button>
          <button type="button" className="nu-button nu-button--secondary" onClick={activeCall.leave}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (!activeCall || activeCall.state.status === 'idle') {
    return (
      <div className="nu-voice-panel nu-voice-panel--join" data-nu-role="voice-panel">
        <button
          type="button"
          className="nu-button nu-button--primary"
          onClick={() => setActiveVoiceChannelId(room.roomId)}
          disabled={!voiceServer}
        >
          Join voice
        </button>
        {!voiceServer && (
          <p className="nu-voice-panel__hint">
            No voice server is configured for this server yet — a server admin can set one under
            server settings.
          </p>
        )}
      </div>
    );
  }

  if (activeCall.state.status === 'connecting' || activeCall.state.status === 'preparing') {
    return (
      <div className="nu-voice-panel nu-voice-panel--join" data-nu-role="voice-panel">
        <p className="nu-voice-panel__hint" data-nu-role="voice-status">
          {activeCall.state.status === 'preparing' ? activeCall.state.message : 'Connecting…'}
        </p>
        <button type="button" className="nu-button nu-button--secondary" onClick={activeCall.leave}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="nu-voice-panel" data-nu-role="voice-panel">
      <Suspense
        fallback={
          <p className="nu-voice-panel__hint" data-nu-role="voice-status">
            Connecting…
          </p>
        }
      >
        <VoiceCallBody room={room} onLeave={activeCall.leave} />
      </Suspense>
    </div>
  );
}
