import { useEffect, useRef, useState } from 'react';
import { useMediaUrl } from '../../matrix/hooks/useMediaUrl';
import { formatTime } from '../../matrix/musicTracks';
import type { MusicAlbum, PageBlock } from '../../matrix/profilePage';
import { readListenVolume, saveListenVolume } from '../voice/listenVolume';

type MusicBlockType = Extract<PageBlock, { type: 'music' }>;

/** What's playing: an album of the block, and a track of it. */
type Playing = { album: number; track: number };

function albumLength(album: MusicAlbum): number | undefined {
  if (album.tracks.some((track) => !track.duration)) return undefined;
  return album.tracks.reduce((total, track) => total + (track.duration ?? 0), 0);
}

/** "2024 · 9 tracks · 41:05", whatever of it the album has. */
function albumFacts(album: MusicAlbum): string {
  const length = albumLength(album);
  return [album.year, `${album.tracks.length} ${album.tracks.length === 1 ? 'track' : 'tracks'}`, length ? formatTime(length) : undefined]
    .filter(Boolean)
    .join(' · ');
}

function Cover({ mxc, size }: { mxc?: string; size: number }) {
  const src = useMediaUrl(mxc, { width: size, height: size, method: 'crop' });
  return <span className="nu-profile-page__music-cover">{src ? <img src={src} alt="" loading="lazy" /> : <span aria-hidden="true">♪</span>}</span>;
}

/** One album on the shelf: its cover and what it is. Opens its track list. */
function AlbumCard({ album, playing, onOpen }: { album: MusicAlbum; playing: boolean; onOpen: () => void }) {
  return (
    <button type="button" className="nu-profile-page__music-card" data-nu-role="music-album-card" onClick={onOpen}>
      <Cover mxc={album.cover} size={320} />
      <strong>{album.title ?? 'Untitled album'}</strong>
      <span className="nu-profile-page__album-count">
        {playing && <span className="nu-profile-page__music-now">Playing · </span>}
        {albumFacts(album)}
      </span>
    </button>
  );
}

/**
 * A page's music: albums, each a track list, and a basic player (play, pause, seek, volume). With
 * several albums the block is a shelf of covers and one album opens at a time; a lone album shows
 * open. Nothing loads until a visitor presses play: there's no audio element at all before that,
 * so no request is made for any track (covers are small thumbnails). Signed out, a track plays
 * straight from the public media route (which seeks with range requests); signed in, from the
 * homeserver like any other page file. Playing a track goes on to the next in its album, and stops
 * after the last; the player keeps going while another album is open. Volume is the same one
 * Listen Together remembers.
 */
export function MusicBlock({ block }: { block: MusicBlockType }) {
  const single = block.albums.length === 1;
  const [openAlbum, setOpenAlbum] = useState<number | undefined>(single ? 0 : undefined);
  const [current, setCurrent] = useState<Playing>();
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(readListenVolume);
  const [failed, setFailed] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  const track = current && block.albums[current.album]?.tracks[current.track];
  // Null until a track is picked, so a page full of music costs nothing to open.
  const src = useMediaUrl(track?.url);
  const shown = openAlbum === undefined ? undefined : block.albums[openAlbum];

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume, src]);

  const choose = (album: number, index: number) => {
    const audio = audioRef.current;
    if (current?.album === album && current.track === index && audio) {
      if (audio.paused) void audio.play().catch(() => setPlaying(false));
      else audio.pause();
      return;
    }
    setCurrent({ album, track: index });
    setTime(0);
    setDuration(block.albums[album].tracks[index].duration ?? 0);
    setFailed(false);
    setPlaying(true);
  };

  const changeVolume = (next: number) => {
    setVolume(next);
    saveListenVolume(next);
  };

  const ended = () => {
    if (current && current.track + 1 < block.albums[current.album].tracks.length) choose(current.album, current.track + 1);
    else setPlaying(false);
  };

  return (
    <>
      {block.title && <h3 className="nu-profile-page__block-title">{block.title}</h3>}
      {!shown && (
        <div className="nu-profile-page__music-shelf" data-nu-role="music-albums">
          {block.albums.map((album, index) => (
            <AlbumCard key={album.id} album={album} playing={playing && current?.album === index} onOpen={() => setOpenAlbum(index)} />
          ))}
        </div>
      )}
      {shown && openAlbum !== undefined && (
        <section className="nu-profile-page__music-album" data-nu-role="music-album">
          {!single && (
            <button type="button" className="nu-profile-page__music-back" data-nu-role="music-albums-back" onClick={() => setOpenAlbum(undefined)}>
              ‹ All albums
            </button>
          )}
          {(shown.title || shown.cover || shown.description || shown.year || !single) && (
            <header className="nu-profile-page__music-head">
              {shown.cover && <Cover mxc={shown.cover} size={320} />}
              <span className="nu-profile-page__album-text">
                {shown.title && shown.title !== block.title && <h4 className="nu-profile-page__album-title">{shown.title}</h4>}
                <span className="nu-profile-page__album-count">{albumFacts(shown)}</span>
                {shown.description && <p className="nu-profile-page__album-description">{shown.description}</p>}
              </span>
            </header>
          )}
          {shown.tracks.length > 1 && (
            <button
              type="button"
              className="nu-button nu-profile-page__music-play-all"
              data-nu-role="music-play-album"
              onClick={() => choose(openAlbum, 0)}
            >
              ▶ Play album
            </button>
          )}
          <ol className="nu-profile-page__tracks" data-nu-role="music-tracks">
            {shown.tracks.map((item, index) => {
              const active = current?.album === openAlbum && current.track === index;
              const on = active && playing;
              return (
                <li key={`${item.url}-${index}`}>
                  <button
                    type="button"
                    className={active ? 'nu-profile-page__track nu-profile-page__track--active' : 'nu-profile-page__track'}
                    data-nu-role="music-track"
                    aria-label={`${on ? 'Pause' : 'Play'} ${item.title}${item.artist ? ` by ${item.artist}` : ''}`}
                    onClick={() => choose(openAlbum, index)}
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
        </section>
      )}
      {track && current && (
        <div className="nu-profile-page__player" data-nu-role="music-player">
          <audio
            key={`${current.album}-${current.track}`}
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
          {/* Another album is open: say what's playing, with a way to pause it from here. */}
          {current.album !== openAlbum && (
            <div className="nu-profile-page__music-now-playing" data-nu-role="music-now-playing">
              <button
                type="button"
                className="nu-profile-page__track-icon"
                aria-label={`${playing ? 'Pause' : 'Play'} ${track.title}`}
                onClick={() => choose(current.album, current.track)}
              >
                {playing ? '❚❚' : '▶'}
              </button>
              <span className="nu-profile-page__track-text">
                <strong>{track.title}</strong>
                <span>{block.albums[current.album].title ?? 'Untitled album'}</span>
              </span>
            </div>
          )}
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
