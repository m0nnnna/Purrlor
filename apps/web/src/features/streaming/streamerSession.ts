import {
  createLocalScreenTracks,
  Room,
  RoomEvent,
  Track,
  type LocalAudioTrack,
  type LocalVideoTrack,
  type RemoteTrack,
} from 'livekit-client';
import type { MatrixClient } from 'matrix-js-sdk';
import type { createStore } from 'jotai';
import {
  fetchMyStream,
  fetchPreviewToken,
  fetchStream,
  markStreamLive,
  renameStream,
  sendThumbnail,
  startStream,
  StreamError,
  stopStream,
  watchPath,
  writeLivePointer,
  type PublicStream,
  type StreamSource,
} from '../../matrix/liveStream';
import { ensureProfileRoom } from '../../matrix/profileFeed';
import { publishToTarget } from '../../matrix/postPublishing';
import { prepareEmbeds } from '../../matrix/embedResolve';
import { publicPagePath } from '../../matrix/publicWeb';
import { APP_AUDIO_HINTS, withDisplayMediaHints } from '../voice/voiceChannelRoomOptions';
import { bitrateKbps, readVideoStats, type Health, type StatEntry, type VideoStats } from './streamDashboard';
import { STREAM_PUBLISH_OPTIONS, STREAMER_ROOM_OPTIONS, streamCaptureOptions, VIEWER_ROOM_OPTIONS } from './streamRoomOptions';
import { streamerAtom, type StreamerStatus } from './streamerState';

/**
 * Going live and stopping (docs/streaming.md): one stream at a time, kept for the whole app so it
 * goes on while you look at other things. Loaded only when someone goes live.
 *
 * A browser stream publishes the screen from here. An OBS stream is published by Ingress; this
 * connects only to watch it (the preview) and asks the server every 3 s whether the picture has
 * arrived.
 */

type Store = ReturnType<typeof createStore>;

const THUMBNAIL_EVERY_MS = 60_000;
const VIEWERS_EVERY_MS = 10_000;
const OBS_POLL_MS = 3_000;

type Session = {
  mx: MatrixClient;
  store: Store;
  room: Room;
  stream: PublicStream;
  source: StreamSource;
  profileRoomId?: string;
  timers: number[];
  stopping: boolean;
  /** Replacing the shared screen: the old track ending isn't the end of the stream. */
  swapping: boolean;
  /** A thumbnail the streamer picked, which the screen's automatic ones would replace. */
  customThumbnail?: Blob;
  lastStats?: VideoStats;
  includeSystemAudio: boolean;
};

let current: Session | undefined;

function set(store: Store, status: StreamerStatus): void {
  store.set(streamerAtom, status);
}

function displayNameOf(mx: MatrixClient): string {
  const me = mx.getUserId() ?? '';
  return mx.getUser(me)?.displayName || me.replace(/^@/, '').replace(/:.*$/, '');
}

export type GoLiveChoices = {
  title: string;
  source?: StreamSource;
  includeSystemAudio: boolean;
  mic: boolean;
  /** An already-converted 640×360 JPEG, sent once live. */
  thumbnail?: Blob;
};

/**
 * Asks the server for a stream. A browser stream connects, shares the screen (the browser asks
 * which), turns the microphone on if chosen, and only then says it's live, in the server and in
 * your profile room; cancelling the picker, or anything failing on the way, takes it all back.
 * An OBS stream returns once it's made: it goes live when OBS's picture arrives.
 */
export async function goLive(mx: MatrixClient, store: Store, choices: GoLiveChoices): Promise<void> {
  if (current) return;
  const source = choices.source ?? 'browser';
  set(store, { phase: 'starting', source });
  let started: { stream: PublicStream; token: string; url: string } | undefined;
  const room = new Room(source === 'obs' ? VIEWER_ROOM_OPTIONS : STREAMER_ROOM_OPTIONS);
  try {
    started = await startStream(mx, choices.title, source);
    const session: Session = {
      mx,
      store,
      room,
      stream: started.stream,
      source,
      timers: [],
      stopping: false,
      swapping: false,
      customThumbnail: choices.thumbnail,
      includeSystemAudio: choices.includeSystemAudio,
    };
    if (source === 'obs') {
      current = session;
      set(store, { phase: 'starting', stream: started.stream, source, waiting: true });
      // The preview is a nicety: without it the stream still goes live when OBS sends.
      void room.connect(started.url, started.token).catch((err) => console.warn('Live stream: preview not connected', err));
      void waitForObs(session);
      return;
    }
    await room.connect(started.url, started.token);
    const share = () => room.localParticipant.setScreenShareEnabled(true, streamCaptureOptions(choices.includeSystemAudio), STREAM_PUBLISH_OPTIONS);
    const published = choices.includeSystemAudio ? await share() : await withDisplayMediaHints(APP_AUDIO_HINTS, share);
    if (!published) throw new Error('cancelled');
    if (choices.mic) await room.localParticipant.setMicrophoneEnabled(true, undefined, STREAM_PUBLISH_OPTIONS);
    const live = await markStreamLive(mx, started.stream.id);
    current = session;
    await becomeLive(session, live, choices.mic);
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

/** The stream is live: say so in the status, start the timers, write the pointer, send the picked thumbnail. */
async function becomeLive(session: Session, live: PublicStream, micOn: boolean): Promise<void> {
  const { mx, store, room } = session;
  session.stream = live;
  const sound = room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
  set(store, { phase: 'live', stream: live, source: session.source, viewers: 0, micOn, soundOn: !!sound && !sound.isMuted, posted: false });
  watch(session);
  if (session.customThumbnail) {
    const picture = session.customThumbnail;
    await sendThumbnail(mx, live.id, picture).catch((err) => console.warn('Live stream: thumbnail not sent', err));
  }
  // The pointer is a hint for other people's apps; the stream is live without it.
  try {
    const profileRoomId = await ensureProfileRoom(mx, displayNameOf(mx));
    session.profileRoomId = profileRoomId;
    await writeLivePointer(mx, profileRoomId, { streamId: live.id, title: live.title, startedAt: live.liveAt ?? Date.now() });
  } catch (err) {
    console.warn('Live stream: profile pointer not written', err);
  }
}

/** An OBS stream: asks every 3 s whether OBS's picture is in (or the server has already noticed), until it is or you end it. */
async function waitForObs(session: Session): Promise<void> {
  const { mx } = session;
  const sleep = () => new Promise<void>((resolve) => session.timers.push(window.setTimeout(resolve, OBS_POLL_MS)));
  while (current === session && !session.stopping) {
    try {
      const live = await markStreamLive(mx, session.stream.id);
      if (current === session && !session.stopping) await becomeLive(session, live, false);
      return;
    } catch (err) {
      // 409 not_receiving: OBS hasn't started. The server may also make it live by itself.
      if (err instanceof StreamError && err.status === 409 && err.code !== 'not_receiving') {
        await endSession(session, errorText(err));
        return;
      }
      const fresh = await fetchStream('', session.stream.id).catch(() => undefined);
      if (fresh?.state === 'live' && current === session && !session.stopping) {
        await becomeLive(session, fresh, false);
        return;
      }
    }
    await sleep();
  }
}

/** The stream is over without the streamer pressing End (the server ended it): take everything down. */
async function endSession(session: Session, message?: string): Promise<void> {
  const { mx, store, room, profileRoomId, timers } = session;
  session.stopping = true;
  timers.forEach((timer) => window.clearTimeout(timer));
  if (profileRoomId) await writeLivePointer(mx, profileRoomId, undefined).catch(() => undefined);
  await room.disconnect().catch(() => undefined);
  if (current === session) current = undefined;
  set(store, message ? { phase: 'error', message } : { phase: 'idle' });
}

/** While live: thumbnails, the viewer count, and stopping when the share or the connection ends. */
function watch(session: Session): void {
  const { room, stream, mx, store, source } = session;
  const screen = () => room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.videoTrack as LocalVideoTrack | undefined;
  if (source === 'browser' && !session.customThumbnail) {
    const snap = () => void thumbnail(screen()).then((picture) => picture && sendThumbnail(mx, stream.id, picture)).catch(() => undefined);
    session.timers.push(window.setTimeout(snap, 3000), window.setInterval(snap, THUMBNAIL_EVERY_MS));
  }
  session.timers.push(
    window.setInterval(() => {
      void fetchStream('', stream.id)
        .then((fresh) => {
          if (current !== session || session.stopping) return;
          const status = store.get(streamerAtom);
          if (fresh && status.phase === 'live') set(store, { ...status, viewers: fresh.viewers ?? 0 });
          // OBS stopped sending and the server ended it, or an admin did.
          if (fresh?.state === 'ended') void endSession(session);
        })
        .catch(() => undefined);
    }, VIEWERS_EVERY_MS)
  );
  if (source === 'obs') return;
  // The browser's own "Stop sharing", or the connection lost for good: the stream is over.
  room.localParticipant.on('localTrackUnpublished', (publication) => {
    if (publication.source === Track.Source.ScreenShare && !session.swapping) void stopLive();
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

/** Ends it for everyone: the server first, then the pointer and the connection. For OBS this cuts OBS off too. */
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

/** Ends a stream this page can't control any more (a browser stream found after a reload). */
export async function endOrphan(mx: MatrixClient, store: Store, stream: PublicStream): Promise<void> {
  set(store, { phase: 'stopping', stream });
  await stopStream(mx, stream.id).catch((err) => console.warn('Live stream: stop not confirmed (the server ends it within 2 minutes)', err));
  try {
    await writeLivePointer(mx, await ensureProfileRoom(mx, displayNameOf(mx)), undefined);
  } catch {
    // Nothing was written, or it can't be now; the pointer is only a hint.
  }
  set(store, { phase: 'idle' });
}

/**
 * After a reload: the stream the server still has for you. An OBS stream gets its dashboard back
 * (a new preview token); a browser stream's tracks are gone, so it can only be ended.
 */
export async function resumeStream(mx: MatrixClient, store: Store, found?: PublicStream): Promise<void> {
  if (current || store.get(streamerAtom).phase !== 'idle') return;
  const stream = found ?? (await fetchMyStream(mx));
  if (!stream || current || store.get(streamerAtom).phase !== 'idle') return;
  if (stream.source !== 'obs') {
    set(store, { phase: 'orphan', stream });
    return;
  }
  const room = new Room(VIEWER_ROOM_OPTIONS);
  const session: Session = { mx, store, room, stream, source: 'obs', timers: [], stopping: false, swapping: false, includeSystemAudio: false };
  current = session;
  set(store, { phase: 'starting', stream, source: 'obs', waiting: stream.state !== 'live' });
  try {
    const { token, url } = await fetchPreviewToken(mx, stream.id);
    await room.connect(url, token);
  } catch (err) {
    console.warn('Live stream: preview not connected', err);
  }
  if (stream.state === 'live') await becomeLive(session, stream, false);
  else void waitForObs(session);
}

export async function setMicrophone(on: boolean): Promise<void> {
  const session = current;
  if (!session || session.source !== 'browser') return;
  await session.room.localParticipant.setMicrophoneEnabled(on, undefined, STREAM_PUBLISH_OPTIONS);
  const status = session.store.get(streamerAtom);
  if (status.phase === 'live') set(session.store, { ...status, micOn: on });
}

/** Mutes or unmutes the shared sound (it can only be shared if it was asked for when going live). */
export async function setSharedSound(on: boolean): Promise<void> {
  const session = current;
  const publication = session?.room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
  if (!session || !publication) return;
  await (on ? publication.unmute() : publication.mute());
  const status = session.store.get(streamerAtom);
  if (status.phase === 'live') set(session.store, { ...status, soundOn: on });
}

/** Whether the browser stream carries the computer's sound at all (so the switch can be offered). */
export function hasSharedSound(): boolean {
  return !!current?.room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
}

/**
 * Shares another screen or window: the browser asks which, and the published tracks take the new
 * picture (and its sound) in place, so viewers see no break. Cancelling the picker changes nothing.
 */
export async function changeScreen(): Promise<void> {
  const session = current;
  if (!session || session.source !== 'browser' || session.swapping) return;
  const participant = session.room.localParticipant;
  const videoTrack = participant.getTrackPublication(Track.Source.ScreenShare)?.videoTrack as LocalVideoTrack | undefined;
  const audioTrack = participant.getTrackPublication(Track.Source.ScreenShareAudio)?.audioTrack as LocalAudioTrack | undefined;
  if (!videoTrack) return;
  session.swapping = true;
  try {
    const capture = () => createLocalScreenTracks(streamCaptureOptions(!!audioTrack));
    const fresh = await (audioTrack ? capture() : withDisplayMediaHints(APP_AUDIO_HINTS, capture));
    const nextVideo = fresh.find((track) => track.kind === Track.Kind.Video);
    const nextAudio = fresh.find((track) => track.kind === Track.Kind.Audio);
    if (nextVideo) await videoTrack.replaceTrack(nextVideo.mediaStreamTrack);
    if (nextAudio && audioTrack) await audioTrack.replaceTrack(nextAudio.mediaStreamTrack);
    else nextAudio?.stop();
    session.lastStats = undefined;
  } catch (err) {
    // The picker cancelled: the old share goes on.
    if (!(err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError'))) throw err;
  } finally {
    session.swapping = false;
  }
}

/** Shows the stream's own picture in `video` (muted): the shared screen, or for OBS the preview room. Returns the undo. */
export function attachPreview(video: HTMLVideoElement, sound?: HTMLElement): () => void {
  const session = current;
  if (!session) return () => undefined;
  const { room } = session;
  const attached: Array<{ detach: (el: HTMLVideoElement) => unknown }> = [];
  const heard: Array<{ detach: () => HTMLMediaElement[] }> = [];
  const take = (track: { attach: (el: HTMLVideoElement) => unknown; detach: (el: HTMLVideoElement) => unknown }) => {
    track.attach(video);
    attached.push(track);
  };
  // OBS's sound, for the dashboard's Listen switch. A browser stream's own sound isn't played back: it would echo.
  const hear = (track: Track) => {
    if (!sound) return;
    const element = track.attach();
    element.muted = true;
    sound.append(element);
    heard.push(track);
  };
  if (session.source === 'browser') {
    const local = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.videoTrack;
    if (local) take(local);
    return () => attached.forEach((track) => track.detach(video));
  }
  const onSubscribed = (track: RemoteTrack) => {
    if (track.kind === Track.Kind.Video) take(track);
    else if (track.kind === Track.Kind.Audio) hear(track);
  };
  room.remoteParticipants.forEach((p) => {
    p.videoTrackPublications.forEach((pub) => pub.videoTrack && take(pub.videoTrack));
    p.audioTrackPublications.forEach((pub) => pub.audioTrack && hear(pub.audioTrack));
  });
  room.on(RoomEvent.TrackSubscribed, onSubscribed);
  return () => {
    room.off(RoomEvent.TrackSubscribed, onSubscribed);
    attached.forEach((track) => track.detach(video));
    heard.forEach((track) => track.detach().forEach((element) => element.remove()));
  };
}

/** Resolution, frame rate and bitrate of the picture, from WebRTC's stats (asked about every 2 s). */
export async function readHealth(): Promise<Health | undefined> {
  const session = current;
  if (!session) return undefined;
  let report: RTCStatsReport | undefined;
  if (session.source === 'browser') {
    const track = session.room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.videoTrack as LocalVideoTrack | undefined;
    report = await track?.sender?.getStats().catch(() => undefined);
  } else {
    for (const p of session.room.remoteParticipants.values()) {
      for (const pub of p.videoTrackPublications.values()) {
        const receiver = (pub.videoTrack as { receiver?: RTCRtpReceiver } | undefined)?.receiver;
        report ??= await receiver?.getStats().catch(() => undefined);
      }
    }
  }
  const entries: StatEntry[] = [];
  report?.forEach((entry: StatEntry) => entries.push(entry));
  const stats = readVideoStats(entries);
  if (!stats) return undefined;
  const kbps = bitrateKbps(session.lastStats, stats);
  session.lastStats = stats;
  return { width: stats.width, height: stats.height, fps: stats.fps, ...(kbps !== undefined && { kbps }) };
}

/** Renames the stream while it's live, in the server and in the profile pointer. */
export async function renameLive(title: string): Promise<void> {
  const session = current;
  if (!session) return;
  const { mx, store } = session;
  const stream = await renameStream(mx, session.stream.id, title);
  session.stream = stream;
  const status = store.get(streamerAtom);
  if (status.phase === 'live') set(store, { ...status, stream });
  if (session.profileRoomId) {
    await writeLivePointer(mx, session.profileRoomId, { streamId: stream.id, title: stream.title, startedAt: stream.liveAt ?? Date.now() }).catch(() => undefined);
  }
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
