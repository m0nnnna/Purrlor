import { useCallback, useEffect, useRef, useState } from 'react';
import { ConnectionState, RoomEvent, type Room as LivekitRoom } from 'livekit-client';
import {
  currentPositionSeconds,
  isAudioFileUrl,
  parseWatchUrl,
  shouldAcceptState,
  type WatchTogetherMode,
  type WatchTogetherState,
} from './watchTogether';

/** Scopes these data messages from any other future use of the call's data channel — LiveKit
 *  delivers every `publishData` call to every listener regardless of topic, so without this a
 *  totally unrelated feature added later that also uses data messages would have to know to
 *  ignore ours (or vice versa). */
const TOPIC = 'xyz.nekous.watch_together';

type WireMessage =
  | { type: 'state'; state: WatchTogetherState }
  | { type: 'stop' }
  /** Sent once on joining a call — whichever existing participant already knows the current
   *  state answers with one. If nobody does (nothing's playing), nothing answers, which is
   *  itself the correct outcome — no "elect a host" step needed. */
  | { type: 'request-sync' };

function encode(msg: WireMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(msg));
}

function decode(payload: Uint8Array): WireMessage | null {
  try {
    return JSON.parse(new TextDecoder().decode(payload)) as WireMessage;
  } catch {
    return null;
  }
}

export type WatchTogetherControls = {
  state: WatchTogetherState | null;
  /** Starts (or replaces) the shared session — watched in the call's video slot, or listened to
   *  from the Now playing card. An audio file is always listened to. Returns false without doing
   *  anything if `url` isn't even a well-formed http(s) URL. */
  start: (url: string, mode?: WatchTogetherMode) => boolean;
  play: () => void;
  pause: () => void;
  seek: (seconds: number) => void;
  stop: () => void;
};

/**
 * Synchronizes a shared "watch together" session across everyone in a LiveKit call via its data
 * channel (see watchTogether.ts's own doc comment for why nothing here routes actual media
 * through LiveKit). Mounted once per call (WatchTogetherProvider, inside VoiceCallSession), so the
 * session outlives whichever channel you're looking at — Listen together keeps playing while you
 * chat elsewhere, and coming back to the call's pane doesn't need a fresh sync.
 */
export function useWatchTogether(livekitRoom: LivekitRoom, myIdentity: string): WatchTogetherControls {
  const [state, setState] = useState<WatchTogetherState | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const broadcast = useCallback(
    (msg: WireMessage) => {
      // A send can fail mid-reconnect; the next state change carries the whole state anyway.
      livekitRoom.localParticipant.publishData(encode(msg), { reliable: true, topic: TOPIC }).catch(() => undefined);
    },
    [livekitRoom]
  );

  useEffect(() => {
    const onData = (payload: Uint8Array, _participant?: unknown, _kind?: unknown, topic?: string) => {
      if (topic !== TOPIC) return;
      const msg = decode(payload);
      if (!msg) return;
      if (msg.type === 'state') {
        // Two people starting at once converge on one session (shouldAcceptState).
        setState((prev) => (shouldAcceptState(prev, msg.state) ? msg.state : prev));
      } else if (msg.type === 'stop') {
        setState(null);
      } else if (msg.type === 'request-sync') {
        if (stateRef.current) broadcast({ type: 'state', state: stateRef.current });
      }
    };
    // Ask whoever's already in the call what's playing — once connected. Mounted at call level
    // (WatchTogetherProvider), this can run before the connection is up, and a request sent then
    // goes nowhere; a reconnect asks again, in case something started while we were gone.
    const requestSync = () => broadcast({ type: 'request-sync' });
    livekitRoom.on(RoomEvent.DataReceived, onData);
    livekitRoom.on(RoomEvent.Connected, requestSync);
    livekitRoom.on(RoomEvent.Reconnected, requestSync);
    if (livekitRoom.state === ConnectionState.Connected) requestSync();
    return () => {
      livekitRoom.off(RoomEvent.DataReceived, onData);
      livekitRoom.off(RoomEvent.Connected, requestSync);
      livekitRoom.off(RoomEvent.Reconnected, requestSync);
    };
  }, [livekitRoom, broadcast]);

  const start = useCallback(
    (url: string, mode: WatchTogetherMode = 'watch') => {
      const parsed = parseWatchUrl(url);
      if (!parsed) return false;
      const next: WatchTogetherState = {
        kind: parsed.kind,
        mode: isAudioFileUrl(url) ? 'listen' : mode,
        url,
        videoId: parsed.kind === 'youtube' ? parsed.videoId : undefined,
        playing: true,
        positionSeconds: 0,
        updatedAt: Date.now(),
        startedBy: myIdentity,
        startedAt: Date.now(),
      };
      setState(next);
      broadcast({ type: 'state', state: next });
      return true;
    },
    [broadcast, myIdentity]
  );

  const play = useCallback(() => {
    setState((prev) => {
      if (!prev || prev.playing) return prev;
      const next = { ...prev, playing: true, positionSeconds: currentPositionSeconds(prev), updatedAt: Date.now() };
      broadcast({ type: 'state', state: next });
      return next;
    });
  }, [broadcast]);

  const pause = useCallback(() => {
    setState((prev) => {
      if (!prev || !prev.playing) return prev;
      const next = { ...prev, playing: false, positionSeconds: currentPositionSeconds(prev), updatedAt: Date.now() };
      broadcast({ type: 'state', state: next });
      return next;
    });
  }, [broadcast]);

  const seek = useCallback(
    (seconds: number) => {
      setState((prev) => {
        if (!prev) return prev;
        const next = { ...prev, positionSeconds: seconds, updatedAt: Date.now() };
        broadcast({ type: 'state', state: next });
        return next;
      });
    },
    [broadcast]
  );

  const stop = useCallback(() => {
    setState(null);
    broadcast({ type: 'stop' });
  }, [broadcast]);

  return { state, start, play, pause, seek, stop };
}
