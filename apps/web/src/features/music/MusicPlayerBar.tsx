import { useState } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { Icon } from '../../components/Icon';
import { useMediaUrl } from '../../matrix/hooks/useMediaUrl';
import { formatTime } from '../../matrix/musicTracks';
import { readListenVolume, saveListenVolume } from '../voice/listenVolume';
import { musicAudio, musicFailedAtom, musicPlayingAtom, musicQueueAtom, musicTimeAtom, toggleMusic } from './musicPlayer';
import './MusicPlayerBar.css';

/**
 * The controls for page music (MusicPlayerHost plays it): what's on and from which album, back,
 * play or pause, next, a seek bar, volume, and close. `card` sits in the sidebar above your name,
 * like Listen Together's card; `bar` runs along the bottom of the signed-out pages; `mini` is a
 * strip across the top of a phone's screen while the sidebar (and so the card) is out of sight:
 * what's on, play or pause, close. Hidden until something is played.
 */
export function MusicPlayerBar({ variant }: { variant: 'card' | 'bar' | 'mini' }) {
  const [queue, setQueue] = useAtom(musicQueueAtom);
  const playing = useAtomValue(musicPlayingAtom);
  const { time, duration } = useAtomValue(musicTimeAtom);
  const failed = useAtomValue(musicFailedAtom);
  const [volume, setVolume] = useState(readListenVolume);
  const item = queue?.items[queue.index];
  const cover = useMediaUrl(item?.cover, { width: 96, height: 96, method: 'crop' });
  if (!queue || !item) return null;

  const go = (delta: -1 | 1) => {
    const audio = musicAudio();
    // Back from a few seconds in starts the track again, as music players do.
    if (delta === -1 && audio && audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    const index = queue.index + delta;
    if (index >= 0 && index < queue.items.length) setQueue({ ...queue, index });
  };

  const changeVolume = (next: number) => {
    setVolume(next);
    saveListenVolume(next);
    const audio = musicAudio();
    if (audio) audio.volume = next;
  };

  return (
    <section className={`nu-music-player nu-music-player--${variant}`} data-nu-role="music-player" aria-label="Music player">
      <div className="nu-music-player__now">
        <span className="nu-music-player__cover" aria-hidden="true">
          {cover ? <img src={cover} alt="" /> : <Icon name="music" size={18} />}
        </span>
        <span className="nu-music-player__text">
          <strong data-nu-role="music-player-title">{item.track.title}</strong>
          <span>{[item.track.artist, item.albumTitle].filter(Boolean).join(' · ')}</span>
        </span>
        {variant === 'mini' && (
          <button
            type="button"
            className="nu-music-player__button nu-music-player__button--main"
            aria-label={playing ? 'Pause' : 'Play'}
            data-nu-role="music-player-toggle"
            onClick={toggleMusic}
          >
            <Icon name={playing ? 'pause' : 'play'} size={16} />
          </button>
        )}
        <button
          type="button"
          className="nu-music-player__button"
          aria-label="Close the player"
          data-nu-role="music-player-close"
          onClick={() => {
            musicAudio()?.pause();
            setQueue(null);
          }}
        >
          <Icon name="x" size={14} />
        </button>
      </div>
      {variant !== 'mini' && (
      <div className="nu-music-player__controls">
        <button type="button" className="nu-music-player__button" aria-label="Previous track" data-nu-role="music-player-previous" onClick={() => go(-1)}>
          <Icon name="chevronLeft" size={18} />
        </button>
        <button
          type="button"
          className="nu-music-player__button nu-music-player__button--main"
          aria-label={playing ? 'Pause' : 'Play'}
          data-nu-role="music-player-toggle"
          onClick={toggleMusic}
        >
          <Icon name={playing ? 'pause' : 'play'} size={18} />
        </button>
        <button
          type="button"
          className="nu-music-player__button"
          aria-label="Next track"
          data-nu-role="music-player-next"
          disabled={queue.index + 1 >= queue.items.length}
          onClick={() => go(1)}
        >
          <Icon name="chevronRight" size={18} />
        </button>
        {failed ? (
          <span className="nu-field__error nu-music-player__seek" role="status">
            This track couldn’t be played.
          </span>
        ) : (
          <label className="nu-music-player__seek">
            <span className="nu-music-player__time">{formatTime(time)}</span>
            <input
              type="range"
              min={0}
              max={duration > 0 ? duration : 1}
              step={1}
              value={Math.min(time, duration > 0 ? duration : 0)}
              disabled={duration <= 0}
              data-nu-role="music-seek"
              aria-label={`Seek in ${item.track.title}`}
              onChange={(evt) => {
                const audio = musicAudio();
                if (audio) audio.currentTime = Number(evt.target.value);
              }}
            />
            <span className="nu-music-player__time">{formatTime(duration)}</span>
          </label>
        )}
        <label className="nu-music-player__volume" title="Volume">
          <Icon name="volume" size={14} />
          <input
            type="range"
            min={0.05}
            max={1}
            step={0.05}
            value={volume}
            data-nu-role="music-volume"
            aria-label="Your volume for music"
            onChange={(evt) => changeVolume(Number(evt.target.value))}
          />
        </label>
      </div>
      )}
    </section>
  );
}
