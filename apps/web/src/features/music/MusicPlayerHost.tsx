import { useEffect } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useMediaUrl } from '../../matrix/hooks/useMediaUrl';
import { readListenVolume } from '../voice/listenVolume';
import { useMusicMediaSession } from './useMusicMediaSession';
import { NowPlayingView } from './NowPlayingView';
import { musicFailedAtom, musicPlayingAtom, musicQueueAtom, musicShuffleAtom, musicTimeAtom, registerMusicAudio } from './musicPlayer';
import { withShuffle } from './musicQueue';
import { useMusicTransport } from './useMusicTransport';

/**
 * The app's one audio element for page music, mounted once beside everything else (the app shell
 * signed in, the public frame signed out), so music keeps playing wherever you go: another
 * profile, a channel, the feed. Nothing to see here; MusicPlayerBar is the controls. There's no
 * element at all until something is played, so nothing loads before that. A track that ends goes
 * on to the next in its album, and the album stops after its last.
 */
export function MusicPlayerHost() {
  const [queue, setQueue] = useAtom(musicQueueAtom);
  const setPlaying = useSetAtom(musicPlayingAtom);
  const setTime = useSetAtom(musicTimeAtom);
  const setFailed = useSetAtom(musicFailedAtom);
  const item = queue?.items[queue.index];
  const src = useMediaUrl(item?.track.url);
  const shuffle = useAtomValue(musicShuffleAtom);
  const transport = useMusicTransport();
  useMusicMediaSession();

  // Keep the queue's play order in step with shuffle: made when it's on, dropped when it's off.
  useEffect(() => {
    if (!queue) return;
    const synced = withShuffle(queue, shuffle);
    if (synced !== queue) setQueue(synced);
  }, [queue, shuffle, setQueue]);

  // A new track: start from nothing, with the length the uploader measured until the file says.
  useEffect(() => {
    setTime({ time: 0, duration: item?.track.duration ?? 0 });
    setFailed(false);
    if (!item) setPlaying(false);
  }, [item, setTime, setFailed, setPlaying]);

  if (!queue || !item) return null;

  return (
    <>
    <audio
      key={`${queue.source}/${item.albumId}/${item.trackNumber}/${item.track.url}`}
      ref={(element) => {
        registerMusicAudio(element);
        if (element) element.volume = readListenVolume();
      }}
      src={src ?? undefined}
      autoPlay
      preload="auto"
      data-nu-role="music-audio"
      onPlay={() => setPlaying(true)}
      onPause={() => setPlaying(false)}
      onTimeUpdate={(evt) => {
        const { currentTime } = evt.currentTarget;
        setTime((t) => ({ ...t, time: currentTime }));
      }}
      onLoadedMetadata={(evt) => {
        const { duration } = evt.currentTarget;
        if (Number.isFinite(duration)) setTime((t) => ({ ...t, duration }));
      }}
      onEnded={() => {
        if (!transport.ended()) setPlaying(false);
      }}
      onError={() => {
        setFailed(true);
        setPlaying(false);
      }}
    />
    <NowPlayingView />
    </>
  );
}
