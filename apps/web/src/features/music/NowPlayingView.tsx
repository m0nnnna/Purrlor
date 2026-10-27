import { useState } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { ShareLinkButton } from '../../components/ShareLinkButton';
import { useMediaUrl } from '../../matrix/hooks/useMediaUrl';
import { formatTime } from '../../matrix/musicTracks';
import { pageLink } from '../../matrix/publicWeb';
import { readListenVolume, saveListenVolume } from '../voice/listenVolume';
import {
  musicAudio,
  musicFailedAtom,
  musicNowPlayingOpenAtom,
  musicPlayingAtom,
  musicQueueAtom,
  musicTimeAtom,
  toggleMusic,
} from './musicPlayer';
import { jumpTo, moveUpNext, removeUpNext, upNext } from './musicQueue';
import { useMusicTransport } from './useMusicTransport';
import './NowPlayingView.css';

/**
 * The full "now playing" view, opened by pressing the cover or title in any MusicPlayerBar: a
 * panel on a desktop, the whole screen on a phone. A big cover, what's on, a seek bar, the
 * transport (back, play or pause, next, shuffle, repeat), volume, a link to the song, and the
 * queue's up next list to play from, reorder or take songs out of. Mounted once, by MusicPlayerHost.
 */
export function NowPlayingView() {
  const [open, setOpen] = useAtom(musicNowPlayingOpenAtom);
  const [queue, setQueue] = useAtom(musicQueueAtom);
  const playing = useAtomValue(musicPlayingAtom);
  const { time, duration } = useAtomValue(musicTimeAtom);
  const failed = useAtomValue(musicFailedAtom);
  const transport = useMusicTransport();
  const [volume, setVolume] = useState(readListenVolume);
  const item = queue?.items[queue.index];
  const cover = useMediaUrl(item?.cover, { width: 640, height: 640, method: 'crop' });
  if (!open || !queue || !item) return null;

  const changeVolume = (next: number) => {
    setVolume(next);
    saveListenVolume(next);
    const audio = musicAudio();
    if (audio) audio.volume = next;
  };
  const link = item.ownerId ? pageLink(item.ownerId, { kind: 'music', album: item.albumId, track: item.trackNumber }) : undefined;
  const queued = upNext(queue);
  const { shuffle, repeat } = transport;
  const repeatLabel = repeat === 'off' ? 'Repeat: off' : repeat === 'all' ? 'Repeat: all' : 'Repeat: one';

  return (
    <Modal title="Now playing" onClose={() => setOpen(false)}>
      <div className="nu-now-playing" data-nu-role="music-now-playing">
        <div className="nu-now-playing__cover" aria-hidden="true">
          {cover ? <img src={cover} alt="" /> : <Icon name="music" size={64} />}
        </div>
        <div className="nu-now-playing__text">
          <strong data-nu-role="music-now-title">{item.track.title}</strong>
          {item.track.artist && <span data-nu-role="music-now-artist">{item.track.artist}</span>}
          {item.albumTitle && <span data-nu-role="music-now-album">{item.albumTitle}</span>}
        </div>
        {failed ? (
          <p className="nu-field__error" role="status">
            This track couldn’t be played.
          </p>
        ) : (
          <label className="nu-now-playing__seek">
            <span className="nu-music-player__time">{formatTime(time)}</span>
            <input
              type="range"
              min={0}
              max={duration > 0 ? duration : 1}
              step={1}
              value={Math.min(time, duration > 0 ? duration : 0)}
              disabled={duration <= 0}
              data-nu-role="music-now-seek"
              aria-label={`Seek in ${item.track.title}`}
              onChange={(evt) => {
                const audio = musicAudio();
                if (audio) audio.currentTime = Number(evt.target.value);
              }}
            />
            <span className="nu-music-player__time">{formatTime(duration)}</span>
          </label>
        )}
        <div className="nu-now-playing__transport">
          <button
            type="button"
            className={`nu-now-playing__button${shuffle ? ' nu-now-playing__button--on' : ''}`}
            aria-label={shuffle ? 'Shuffle: on' : 'Shuffle: off'}
            aria-pressed={shuffle}
            data-nu-role="music-shuffle"
            onClick={transport.toggleShuffle}
          >
            <Icon name="shuffle" size={18} />
          </button>
          <button type="button" className="nu-now-playing__button" aria-label="Previous track" data-nu-role="music-now-previous" onClick={transport.previous}>
            <Icon name="chevronLeft" size={22} />
          </button>
          <button
            type="button"
            className="nu-now-playing__button nu-now-playing__button--main"
            aria-label={playing ? 'Pause' : 'Play'}
            data-nu-role="music-now-toggle"
            onClick={toggleMusic}
          >
            <Icon name={playing ? 'pause' : 'play'} size={24} />
          </button>
          <button
            type="button"
            className="nu-now-playing__button"
            aria-label="Next track"
            data-nu-role="music-now-next"
            disabled={!transport.canNext}
            onClick={transport.next}
          >
            <Icon name="chevronRight" size={22} />
          </button>
          <button
            type="button"
            className={`nu-now-playing__button${repeat !== 'off' ? ' nu-now-playing__button--on' : ''}`}
            aria-label={repeatLabel}
            data-nu-role="music-repeat"
            data-nu-repeat={repeat}
            onClick={transport.cycleRepeat}
          >
            <Icon name={repeat === 'one' ? 'repeatOne' : 'repeat'} size={18} />
          </button>
        </div>
        <div className="nu-now-playing__extras">
          <label className="nu-music-player__volume" title="Volume">
            <Icon name="volume" size={14} />
            <input
              type="range"
              min={0.05}
              max={1}
              step={0.05}
              value={volume}
              data-nu-role="music-now-volume"
              aria-label="Your volume for music"
              onChange={(evt) => changeVolume(Number(evt.target.value))}
            />
          </label>
          {link && <ShareLinkButton url={link} title={item.track.title} role="music-now-link" />}
        </div>
        <section className="nu-now-playing__queue" aria-label="Up next">
          <h3>Up next</h3>
          {queued.length === 0 ? (
            <p className="nu-now-playing__empty" data-nu-role="music-up-next-empty">
              Nothing after this song.
            </p>
          ) : (
            <ol data-nu-role="music-up-next">
              {queued.map(({ position, item: entry }, i) => (
                <li key={`${entry.albumId}/${entry.trackNumber}/${position}`} className="nu-now-playing__row" data-nu-role="music-up-next-item">
                  <button
                    type="button"
                    className="nu-now-playing__play"
                    aria-label={`Play ${entry.track.title}`}
                    data-nu-role="music-up-next-play"
                    onClick={() => setQueue(jumpTo(queue, position))}
                  >
                    <strong>{entry.track.title}</strong>
                    <span>{[entry.track.artist, entry.track.duration ? formatTime(entry.track.duration) : undefined].filter(Boolean).join(' · ')}</span>
                  </button>
                  <button
                    type="button"
                    className="nu-music-player__button"
                    aria-label={`Move ${entry.track.title} up`}
                    data-nu-role="music-up-next-up"
                    disabled={i === 0}
                    onClick={() => setQueue(moveUpNext(queue, position, -1))}
                  >
                    <Icon name="chevronUp" size={14} />
                  </button>
                  <button
                    type="button"
                    className="nu-music-player__button"
                    aria-label={`Move ${entry.track.title} down`}
                    data-nu-role="music-up-next-down"
                    disabled={i === queued.length - 1}
                    onClick={() => setQueue(moveUpNext(queue, position, 1))}
                  >
                    <Icon name="chevronDown" size={14} />
                  </button>
                  <button
                    type="button"
                    className="nu-music-player__button"
                    aria-label={`Remove ${entry.track.title} from the queue`}
                    data-nu-role="music-up-next-remove"
                    onClick={() => setQueue(removeUpNext(queue, position))}
                  >
                    <Icon name="x" size={14} />
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </Modal>
  );
}
