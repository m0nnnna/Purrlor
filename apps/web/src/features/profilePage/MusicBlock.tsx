import { useContext, useEffect, useRef, useState } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { ShareLinkButton } from '../../components/ShareLinkButton';
import { useMediaUrl } from '../../matrix/hooks/useMediaUrl';
import { formatTime } from '../../matrix/musicTracks';
import type { MusicAlbum, PageBlock } from '../../matrix/profilePage';
import { pageLink } from '../../matrix/publicWeb';
import { albumSource, musicPlayingAtom, musicQueueAtom, toggleMusic, type MusicQueue } from '../music/musicPlayer';
import { PageOwnerContext } from './PageOwnerContext';
import { PageTargetContext } from './PageTargetContext';

type MusicBlockType = Extract<PageBlock, { type: 'music' }>;

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

/** One album on the shelf: its cover and title, and whether it's the one playing. Opens its songs. */
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
 * An album's songs, over the page: its cover and details, "Play album", a link to it, and the track
 * list, each with its own link. Playing goes to the app's player, which carries on after this
 * closes. `highlight` is a track a link pointed at (from 0): shown, not played, since a browser
 * won't play sound before the visitor presses something.
 */
function AlbumDialog({
  album,
  source,
  ownerId,
  blockId,
  highlight,
  onClose,
}: {
  album: MusicAlbum;
  source: string;
  ownerId?: string;
  blockId: string;
  highlight?: number;
  onClose: () => void;
}) {
  const [queue, setQueue] = useAtom(musicQueueAtom);
  const playing = useAtomValue(musicPlayingAtom);
  const listRef = useRef<HTMLOListElement>(null);
  const current = queue?.source === source ? queue.index : undefined;
  const link = (track?: number) => (ownerId ? pageLink(ownerId, { kind: 'music', album: album.id, ...(track && { track }) }) : undefined);
  const albumLink = link();

  useEffect(() => {
    if (highlight === undefined) return;
    listRef.current?.children[highlight]?.scrollIntoView?.({ block: 'center' });
  }, [highlight]);

  const play = (index: number) => {
    if (current === index) return toggleMusic();
    const next: MusicQueue = {
      source,
      index,
      items: album.tracks.map((track) => ({ track, albumTitle: album.title, cover: album.cover, ownerId })),
    };
    setQueue(next);
  };

  return (
    <Modal title={album.title ?? 'Untitled album'} onClose={onClose}>
      <div className="nu-profile-page__music-album" data-nu-role="music-album" data-nu-block={blockId}>
        <header className="nu-profile-page__music-head">
          <Cover mxc={album.cover} size={320} />
          <span className="nu-profile-page__album-text">
            <span className="nu-profile-page__album-count">{albumFacts(album)}</span>
            {album.description && <p className="nu-profile-page__album-description">{album.description}</p>}
            <span className="nu-profile-page__music-actions">
              <button type="button" className="nu-button nu-button--primary" data-nu-role="music-play-album" onClick={() => play(0)}>
                <Icon name="play" size={14} /> Play album
              </button>
              {albumLink && <ShareLinkButton url={albumLink} title={album.title} role="music-album-link" />}
            </span>
          </span>
        </header>
        <ol className="nu-profile-page__tracks" data-nu-role="music-tracks" ref={listRef}>
          {album.tracks.map((item, index) => {
            const active = index === current;
            const on = active && playing;
            const trackLink = link(index + 1);
            return (
              <li key={`${item.url}-${index}`} className="nu-profile-page__track-row">
                <button
                  type="button"
                  className={[
                    'nu-profile-page__track',
                    active && 'nu-profile-page__track--active',
                    index === highlight && current === undefined && 'nu-profile-page__track--linked',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  data-nu-role="music-track"
                  aria-label={`${on ? 'Pause' : 'Play'} ${item.title}${item.artist ? ` by ${item.artist}` : ''}`}
                  onClick={() => play(index)}
                >
                  <span aria-hidden="true" className="nu-profile-page__track-icon">
                    {on ? '❚❚' : active ? '▶' : index + 1}
                  </span>
                  <span className="nu-profile-page__track-text">
                    <strong>{item.title}</strong>
                    {item.artist && <span>{item.artist}</span>}
                  </span>
                  {item.duration ? <span className="nu-profile-page__track-time">{formatTime(item.duration)}</span> : null}
                </button>
                {trackLink && (
                  <ShareLinkButton url={trackLink} title={item.title} iconOnly className="nu-profile-page__track-link" role="music-track-link" />
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </Modal>
  );
}

/**
 * A page's music: a shelf of albums, cover and title each, so a big discography takes a row or
 * two of the page rather than all of it. An album's songs open over the page, and play in the
 * app's own player (MusicPlayerHost), which keeps going wherever you go next. Nothing plays or
 * loads until a visitor presses play; the covers are small thumbnails. A link to an album (or a
 * track on it) opens that album.
 */
export function MusicBlock({ block }: { block: MusicBlockType }) {
  const owner = useContext(PageOwnerContext);
  const target = useContext(PageTargetContext);
  const linked = target?.kind === 'music' ? block.albums.findIndex((album) => album.id === target.album) : -1;
  const [open, setOpen] = useState<number | undefined>(linked >= 0 ? linked : undefined);
  const [highlight, setHighlight] = useState(linked >= 0 && target?.kind === 'music' && target.track ? target.track - 1 : undefined);
  const queue = useAtomValue(musicQueueAtom);
  const playing = useAtomValue(musicPlayingAtom);
  const shown = open === undefined ? undefined : block.albums[open];

  return (
    <>
      <div className="nu-profile-page__music-shelf" data-nu-role="music-albums">
        {block.albums.map((album, index) => (
          <AlbumCard
            key={album.id}
            album={album}
            playing={playing && queue?.source === albumSource(owner?.userId, block.id, album.id)}
            onOpen={() => {
              setHighlight(undefined);
              setOpen(index);
            }}
          />
        ))}
      </div>
      {shown && (
        <AlbumDialog
          album={shown}
          source={albumSource(owner?.userId, block.id, shown.id)}
          ownerId={owner?.userId}
          blockId={block.id}
          highlight={highlight}
          onClose={() => setOpen(undefined)}
        />
      )}
    </>
  );
}
