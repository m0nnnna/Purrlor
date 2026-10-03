import { useMediaUrl } from '../../matrix/hooks/useMediaUrl';
import { useSignedIn } from '../../matrix/hooks/useSignedIn';
import type { ArtPiece, MusicAlbum, PageBlock } from '../../matrix/profilePage';
import { visiblePieces } from './GalleryBlock';

/**
 * The newest release: the latest year when albums have one, otherwise the last added (the builder
 * adds albums at the end).
 */
export function latestAlbum(albums: MusicAlbum[]): MusicAlbum | undefined {
  return albums.reduce<MusicAlbum | undefined>((best, album) => (!best || (album.year ?? 0) >= (best.year ?? 0) ? album : best), undefined);
}

/** The newest piece this viewer may see: the last one added to the last album that has one. */
export function latestPiece(block: Extract<PageBlock, { type: 'gallery' }>, signedIn: boolean): ArtPiece | undefined {
  for (let i = block.albums.length - 1; i >= 0; i--) {
    const pieces = visiblePieces(block.albums[i], signedIn);
    if (pieces.length > 0) return pieces[pieces.length - 1];
  }
  return undefined;
}

function AlbumPreview({ album }: { album: MusicAlbum }) {
  const cover = useMediaUrl(album.cover, { width: 240, height: 240, method: 'crop' });
  const facts = [album.year, `${album.tracks.length} ${album.tracks.length === 1 ? 'track' : 'tracks'}`].filter(Boolean).join(' · ');
  return (
    <span className="nu-profile-page__preview nu-profile-page__preview--album">
      <span className="nu-profile-page__preview-cover">{cover ? <img src={cover} alt="" loading="lazy" /> : <span aria-hidden="true">♪</span>}</span>
      <span className="nu-profile-page__preview-text">
        <span className="nu-profile-page__preview-label">Latest release</span>
        <strong>{album.title ?? 'Untitled album'}</strong>
        <span className="nu-profile-page__preview-facts">{facts}</span>
      </span>
    </span>
  );
}

function PiecePreview({ piece }: { piece: ArtPiece }) {
  const src = useMediaUrl(piece.url, { width: 480, height: 480, method: 'scale' });
  return (
    <span className="nu-profile-page__preview nu-profile-page__preview--piece">
      <span
        className={
          piece.rating === 'mature' ? 'nu-profile-page__preview-image nu-profile-page__preview-image--blurred' : 'nu-profile-page__preview-image'
        }
      >
        {src && <img src={src} alt={piece.rating === 'mature' ? '' : (piece.title ?? '')} loading="lazy" />}
      </span>
      <span className="nu-profile-page__preview-label">Latest{piece.title ? `: ${piece.title}` : ''}</span>
    </span>
  );
}

/**
 * What a closed module shows under its title, so a visitor sees what's in it before opening it:
 * a gallery's newest piece, a music block's newest release with its cover. One thumbnail, nothing
 * more. Other kinds show nothing. A Mature piece stays blurred, and signed out it's never chosen.
 */
export function ModulePreview({ block, onOpen }: { block: PageBlock; onOpen: () => void }) {
  const signedIn = useSignedIn();
  const album = block.type === 'music' ? latestAlbum(block.albums) : undefined;
  const piece = block.type === 'gallery' ? latestPiece(block, signedIn) : undefined;
  if (!album && !piece) return null;
  return (
    <button type="button" className="nu-profile-page__preview-button" onClick={onOpen} data-nu-role="profile-page-module-preview">
      {album ? <AlbumPreview album={album} /> : piece && <PiecePreview piece={piece} />}
    </button>
  );
}
