import { useEffect } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import { useMediaUrl } from '../../matrix/hooks/useMediaUrl';
import { readListenVolume } from '../voice/listenVolume';
import { useMusicMediaSession } from './useMusicMediaSession';
import { musicFailedAtom, musicPlayingAtom, musicQueueAtom, musicTimeAtom, registerMusicAudio } from './musicPlayer';

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
  useMusicMediaSession();

  // A new track: start from nothing, with the length the uploader measured until the file says.
  useEffect(() => {
    setTime({ time: 0, duration: item?.track.duration ?? 0 });
    setFailed(false);
    if (!item) setPlaying(false);
  }, [item, setTime, setFailed, setPlaying]);

  if (!queue || !item) return null;

  return (
    <audio
      key={`${queue.source}/${queue.index}`}
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
        if (queue.index + 1 < queue.items.length) setQueue({ ...queue, index: queue.index + 1 });
        else setPlaying(false);
      }}
      onError={() => {
        setFailed(true);
        setPlaying(false);
      }}
    />
  );
}
