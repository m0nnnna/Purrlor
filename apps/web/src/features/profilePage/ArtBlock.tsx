import { useState } from 'react';
import { Lightbox } from '../../components/Lightbox';
import { useSignedIn } from '../../matrix/hooks/useSignedIn';
import { useMediaUrl } from '../../matrix/hooks/useMediaUrl';
import type { ArtAlbum, ArtPiece, PageBlock } from '../../matrix/profilePage';

type ArtBlockType = Extract<PageBlock, { type: 'art' }>;

/** The pieces this viewer may see: Mature ones only when signed in (every account is 18+, so no further check). */
export function visiblePieces(album: ArtAlbum, signedIn: boolean): ArtPiece[] {
  return album.pieces.filter((piece) => piece.rating !== 'mature' || signedIn);
}

function Piece({ piece, onOpen }: { piece: ArtPiece; onOpen: (src: string, alt: string) => void }) {
  const thumb = useMediaUrl(piece.url, { width: 480, height: 480, method: 'scale' });
  const full = useMediaUrl(piece.url);
  const mature = piece.rating === 'mature';
  const [revealed, setRevealed] = useState(false);
  const covered = mature && !revealed;
  const alt = piece.title ?? piece.description ?? '';

  return (
    <figure className="nu-profile-page__piece" data-nu-role="art-piece" data-nu-rating={piece.rating}>
      <button
        type="button"
        className={covered ? 'nu-profile-page__piece-image nu-profile-page__piece-image--blurred' : 'nu-profile-page__piece-image'}
        aria-label={covered ? 'Mature artwork. Show it' : `Open ${alt || 'artwork'}`}
        onClick={() => (covered ? setRevealed(true) : full && onOpen(full, alt))}
      >
        {thumb && <img src={thumb} alt={covered ? '' : alt} loading="lazy" />}
        {covered && <span className="nu-profile-page__piece-warning">Mature. Click to show</span>}
      </button>
      {(piece.title || piece.description || piece.tags.length > 0) && (
        <figcaption className="nu-profile-page__piece-caption">
          {piece.title && <strong>{piece.title}</strong>}
          {piece.description && <span>{piece.description}</span>}
          {piece.tags.length > 0 && <span className="nu-profile-page__tags">{piece.tags.map((tag) => `#${tag}`).join(' ')}</span>}
        </figcaption>
      )}
    </figure>
  );
}

function Album({ album, signedIn, open, onToggle }: { album: ArtAlbum; signedIn: boolean; open: boolean; onToggle: () => void }) {
  const pieces = visiblePieces(album, signedIn);
  const [tag, setTag] = useState<string>();
  const [lightbox, setLightbox] = useState<{ src: string; alt: string }>();
  // The cover is a piece anyone may see, so a Mature one never fronts an album for a viewer who can't open it.
  const cover = pieces.find((piece) => piece.rating === 'general') ?? pieces[0];
  const coverSrc = useMediaUrl(open ? null : cover?.url, { width: 320, height: 320, method: 'crop' });
  const tags = [...new Set(pieces.flatMap((piece) => piece.tags))];
  const shown = tag ? pieces.filter((piece) => piece.tags.includes(tag)) : pieces;
  const hidden = album.pieces.length - pieces.length;

  return (
    <section className="nu-profile-page__album" data-nu-role="art-album">
      <button type="button" className="nu-profile-page__album-head" aria-expanded={open} onClick={onToggle}>
        {!open && cover && (
          <span className={cover.rating === 'mature' ? 'nu-profile-page__album-cover nu-profile-page__album-cover--blurred' : 'nu-profile-page__album-cover'}>
            {coverSrc && <img src={coverSrc} alt="" loading="lazy" />}
          </span>
        )}
        <span className="nu-profile-page__album-text">
          <strong>{album.title}</strong>
          <span className="nu-profile-page__album-count">
            {pieces.length} {pieces.length === 1 ? 'piece' : 'pieces'}
          </span>
        </span>
      </button>
      {album.description && <p className="nu-profile-page__album-description">{album.description}</p>}
      {/* Pieces load only once the album is open: a page of art stays light until someone looks. */}
      {open && (
        <>
          {tags.length > 1 && (
            <div className="nu-profile-page__tag-filter" role="group" aria-label="Filter by tag">
              {tags.map((t) => (
                <button key={t} type="button" aria-pressed={tag === t} onClick={() => setTag(tag === t ? undefined : t)}>
                  #{t}
                </button>
              ))}
            </div>
          )}
          <div className="nu-profile-page__pieces">
            {shown.map((piece, index) => (
              <Piece key={`${piece.url}-${index}`} piece={piece} onOpen={(src, alt) => setLightbox({ src, alt })} />
            ))}
          </div>
          {hidden > 0 && (
            <p className="nu-field__hint" data-nu-role="art-mature-hidden">
              {hidden} Mature {hidden === 1 ? 'piece is' : 'pieces are'} hidden unless you’re signed in.
            </p>
          )}
          {lightbox && <Lightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(undefined)} />}
        </>
      )}
    </section>
  );
}

/** An artist's albums. Only the open album's pieces load; Mature pieces are hidden when signed out, and blurred until clicked when signed in. */
export function ArtBlock({ block }: { block: ArtBlockType }) {
  const signedIn = useSignedIn();
  const [open, setOpen] = useState<string | undefined>(block.albums.length === 1 ? block.albums[0].id : undefined);
  const albums = block.albums.filter((album) => visiblePieces(album, signedIn).length > 0);
  if (albums.length === 0) return null;
  return (
    <>
      {block.title && <h3 className="nu-profile-page__block-title">{block.title}</h3>}
      <div className="nu-profile-page__albums">
        {albums.map((album) => (
          <Album key={album.id} album={album} signedIn={signedIn} open={open === album.id} onToggle={() => setOpen(open === album.id ? undefined : album.id)} />
        ))}
      </div>
    </>
  );
}
