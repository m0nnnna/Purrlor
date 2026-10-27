import { Room, RoomEvent, Track, type LocalVideoTrack } from 'livekit-client';
import type { MatrixClient } from 'matrix-js-sdk';
import type { createStore } from 'jotai';
import {
  fetchStream,
  markStreamLive,
  sendThumbnail,
  startStream,
  stopStream,
  watchPath,
  writeLivePointer,
  type PublicStream,
} from '../../matrix/liveStream';
import { ensureProfileRoom } from '../../matrix/profileFeed';
import { publishToTarget } from '../../matrix/postPublishing';
import { prepareEmbeds } from '../../matrix/embedResolve';
import { publicPagePath } from '../../matrix/publicWeb';
import { APP_AUDIO_HINTS, withDisplayMediaHints } from '../voice/voiceChannelRoomOptions';
import { STREAM_PUBLISH_OPTIONS, STREAMER_ROOM_OPTIONS, streamCaptureOptions } from './streamRoomOptions';
import { streamerAtom, type StreamerStatus } from './streamerState';

/**
 * Going live and stopping (docs/streaming.md): one stream at a time, kept for the whole app so it
 * goes on while you look at other things. Loaded only when someone goes live.
 */

type Store = ReturnType<typeof createStore>;

const THUMBNAIL_EVERY_MS = 60_000;
const VIEWERS_EVERY_MS = 15_000;

let current:
  | { mx: MatrixClient; store: Store; room: Room; stream: PublicStream; profileRoomId?: string; timers: number[]; stopping: boolean }
  | undefined;

function set(store: Store, status: StreamerStatus): void {
  store.set(streamerAtom, status);
}

function displayNameOf(mx: MatrixClient): string {
  const me = mx.getUserId() ?? '';
  return mx.getUser(me)?.displayName || me.replace(/^@/, '').replace(/:.*$/, '');
}

export type GoLiveChoices = { title: string; includeSystemAudio: boolean; mic: boolean };

/**
 * Asks the server for a stream, connects, shares the screen (the browser asks which), turns the
 * microphone on if chosen, and only then says it's live, in the server and in your profile room.
 * Cancelling the browser's picker, or anything failing on the way, takes it all back.
 */
export async function goLive(mx: MatrixClient, store: Store, choices: GoLiveChoices): Promise<void> {
  if (current) return;
  set(store, { phase: 'starting' });
  let started: { stream: PublicStream; token: string; url: string } | undefined;
  const room = new Room(STREAMER_ROOM_OPTIONS);
  try {
    started = await startStream(mx, choices.title);
    await room.connect(started.url, started.token);
    const share = () => room.localParticipant.setScreenShareEnabled(true, streamCaptureOptions(choices.includeSystemAudio), STREAM_PUBLISH_OPTIONS);
    const published = choices.includeSystemAudio ? await share() : await withDisplayMediaHints(APP_AUDIO_HINTS, share);
    if (!published) throw new Error('cancelled');
    if (choices.mic) await room.localParticipant.setMicrophoneEnabled(true, undefined, STREAM_PUBLISH_OPTIONS);
    const live = await markStreamLive(mx, started.stream.id);
    current = { mx, store, room, stream: live, timers: [], stopping: false };
    set(store, { phase: 'live', stream: live, viewers: 0, micOn: choices.mic, posted: false });
    watch(current);
    // The pointer is a hint for other people's apps; the stream is live without it.
    try {
      const profileRoomId = await ensureProfileRoom(mx, displayNameOf(mx));
      current.profileRoomId = profileRoomId;
      await writeLivePointer(mx, profileRoomId, { streamId: live.id, title: live.title, startedAt: live.liveAt ?? Date.now() });
    } catch (err) {
      console.warn('Live stream: profile pointer not written', err);
    }
  } catch (err) {
    await room.disconnect().catch(() => undefined);
    if (started) await stopStream(mx, started.stream.id).catch(() => undefined);
    current = undefined;
    const cancelled = err instanceof Error && (err.message === 'cancelled' || err.name === 'NotAllowedError' || err.name === 'AbortError');
    set(store, cancelled ? { phase: 'idle' } : { phase: 'error', message: errorText(err) });
    if (!cancelled) throw err;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Couldn’t go live.';
}

/** While live: thumbnails, the viewer count, and stopping when the share or the connection ends. */
function watch(session: NonNullable<typeof current>): void {
  const { room, stream, mx, store } = session;
  const screen = () => room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.videoTrack as LocalVideoTrack | undefined;
  const snap = () => void thumbnail(screen()).then((picture) => picture && sendThumbnail(mx, stream.id, picture)).catch(() => undefined);
  session.timers.push(window.setTimeout(snap, 3000), window.setInterval(snap, THUMBNAIL_EVERY_MS));
  session.timers.push(
    window.setInterval(() => {
      void fetchStream('', stream.id)
        .then((fresh) => {
          const status = store.get(streamerAtom);
          if (fresh && status.phase === 'live' && current === session) set(store, { ...status, viewers: fresh.viewers ?? 0 });
        })
        .catch(() => undefined);
    }, VIEWERS_EVERY_MS)
  );
  // The browser's own "Stop sharing", or the connection lost for good: the stream is over.
  room.localParticipant.on('localTrackUnpublished', (publication) => {
    if (publication.source === Track.Source.ScreenShare) void stopLive();
  });
  room.on(RoomEvent.Disconnected, () => void stopLive());
}

/** A 640×360 JPEG of the shared screen, for cards and link previews. */
async function thumbnail(track: LocalVideoTrack | undefined): Promise<Blob | undefined> {
  const media = track?.mediaStreamTrack;
  if (!media || media.readyState !== 'live') return undefined;
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([media]);
  try {
    await video.play();
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | undefined>((resolve) => canvas.toBlob((blob) => resolve(blob ?? undefined), 'image/jpeg', 0.72));
  } finally {
    video.pause();
    video.srcObject = null;
  }
}

/** Ends it for everyone: the server first, then the pointer and the connection. */
export async function stopLive(): Promise<void> {
  const session = current;
  if (!session || session.stopping) return;
  session.stopping = true;
  const { mx, store, room, stream, profileRoomId, timers } = session;
  set(store, { phase: 'stopping', stream });
  timers.forEach((timer) => window.clearTimeout(timer));
  await stopStream(mx, stream.id).catch((err) => console.warn('Live stream: stop not confirmed (the server ends it within 2 minutes)', err));
  if (profileRoomId) await writeLivePointer(mx, profileRoomId, undefined).catch(() => undefined);
  await room.disconnect().catch(() => undefined);
  current = undefined;
  set(store, { phase: 'idle' });
}

export async function setMicrophone(on: boolean): Promise<void> {
  const session = current;
  if (!session) return;
  await session.room.localParticipant.setMicrophoneEnabled(on, undefined, STREAM_PUBLISH_OPTIONS);
  const status = session.store.get(streamerAtom);
  if (status.phase === 'live') set(session.store, { ...status, micOn: on });
}

/** A Global post with the watch page's link, which shows as a link card with the thumbnail. */
export async function postAboutStream(): Promise<void> {
  const session = current;
  if (!session) return;
  const { mx, stream, store } = session;
  const link = `${window.location.origin}${watchPath(publicPagePath(stream.owner), stream.id)}`;
  const embeds = await prepareEmbeds(mx, [link], false).catch(() => []);
  await publishToTarget(mx, { kind: 'global' }, { body: `Live now: ${stream.title}\n${link}`, embeds }, displayNameOf(mx), true);
  const status = store.get(streamerAtom);
  if (status.phase === 'live') set(store, { ...status, posted: true });
}
