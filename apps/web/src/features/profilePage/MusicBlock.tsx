import { useEffect, useRef, useState } from 'react';
import { useMediaUrl } from '../../matrix/hooks/useMediaUrl';
import { formatTime } from '../../matrix/musicTracks';
import type { PageBlock } from '../../matrix/profilePage';
import { readListenVolume, saveListenVolume } from '../voice/listenVolume';

type MusicBlockType = Extract<PageBlock, { type: 'music' }>;

/**
 * A page's music: the track list and a basic player (play, pause, seek, volume). Nothing loads
 * until a visitor presses play: there's no audio element at all before that, so no request is
 * made for any track. Signed out, a track plays straight from the public media route (which seeks
 * with range requests); signed in, from the homeserver like any other page file. Playing one
 * track goes on to the next, and stops after the last. Volume is the same one Listen Together
 * remembers.
 */
export function MusicBlock({ block }: { block: MusicBlockType }) {
  const [current, setCurrent] = useState<number>();
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(readListenVolume);
  const [failed, setFailed] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  const track = current === undefined ? undefined : block.tracks[current];
  // Null until a track is picked, so a page full of music costs nothing to open.
  const src = useMediaUrl(track?.url);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume, src]);

  const choose = (index: number) => {
    const audio = audioRef.current;
    if (index === current && audio) {
      if (audio.paused) void audio.play().catch(() => setPlaying(false));
      else audio.pause();
      return;
    }
    setCurrent(index);
    setTime(0);
    setDuration(block.tracks[index].duration ?? 0);
    setFailed(false);
    setPlaying(true);
  };

  const changeVolume = (next: number) => {
    setVolume(next);
    saveListenVolume(next);
  };

  const ended = () => {
    if (current !== undefined && current + 1 < block.tracks.length) choose(current + 1);
    else setPlaying(false);
  };

  return (
    <>
      {block.title && <h3 className="nu-profile-page__block-title">{block.title}</h3>}
      <ol className="nu-profile-page__tracks" data-nu-role="music-tracks">
        {block.tracks.map((item, index) => {
          const active = index === current;
          const on = active && playing;
          return (
            <li key={`${item.url}-${index}`}>
              <button
                type="button"
                className={active ? 'nu-profile-page__track nu-profile-page__track--active' : 'nu-profile-page__track'}
                data-nu-role="music-track"
                aria-label={`${on ? 'Pause' : 'Play'} ${item.title}${item.artist ? ` by ${item.artist}` : ''}`}
                onClick={() => choose(index)}
              >
                <span aria-hidden="true" className="nu-profile-page__track-icon">
                  {on ? '❚❚' : '▶'}
                </span>
                <span className="nu-profile-page__track-text">
                  <strong>{item.title}</strong>
                  {item.artist && <span>{item.artist}</span>}
                </span>
                {item.duration ? <span className="nu-profile-page__track-time">{formatTime(item.duration)}</span> : null}
              </button>
            </li>
          );
        })}
      </ol>
      {track && (
        <div className="nu-profile-page__player" data-nu-role="music-player">
          <audio
            key={current}
            ref={audioRef}
            src={src ?? undefined}
            autoPlay
            preload="auto"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTimeUpdate={(evt) => setTime(evt.currentTarget.currentTime)}
            onLoadedMetadata={(evt) => Number.isFinite(evt.currentTarget.duration) && setDuration(evt.currentTarget.duration)}
            onEnded={ended}
            onError={() => {
              setFailed(true);
              setPlaying(false);
            }}
          />
          {failed ? (
            <p className="nu-field__error" role="status">
              This track couldn’t be played.
            </p>
          ) : (
            <label className="nu-profile-page__seek">
              <span className="nu-profile-page__time">{formatTime(time)}</span>
              <input
                type="range"
                min={0}
                max={duration > 0 ? duration : 1}
                step={1}
                value={Math.min(time, duration > 0 ? duration : 0)}
                disabled={duration <= 0}
                data-nu-role="music-seek"
                aria-label={`Seek in ${track.title}`}
                onChange={(evt) => {
                  const next = Number(evt.target.value);
                  if (audioRef.current) audioRef.current.currentTime = next;
                  setTime(next);
                }}
              />
              <span className="nu-profile-page__time">{formatTime(duration)}</span>
            </label>
          )}
          <label className="nu-profile-page__volume">
            <span>Volume</span>
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
    </>
  );
}
