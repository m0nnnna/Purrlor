import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Lightbox } from '../../components/Lightbox';
import { Modal } from '../../components/Modal';
import { useSignedIn } from '../../matrix/hooks/useSignedIn';
import { useMediaUrl } from '../../matrix/hooks/useMediaUrl';
import { ShareLinkButton } from '../../components/ShareLinkButton';
import type { ArtAlbum, ArtPiece, PageBlock } from '../../matrix/profilePage';
import { pageLink } from '../../matrix/publicWeb';
import { PageOwnerContext } from './PageOwnerContext';
import { PageTargetContext } from './PageTargetContext';

type GalleryBlockType = Extract<PageBlock, { type: 'gallery' }>;

/** The pieces this viewer may see: Mature ones only when signed in (every account is 18+, so no further check). */
export function visiblePieces(album: ArtAlbum, signedIn: boolean): ArtPiece[] {
  return album.pieces.filter((piece) => piece.rating !== 'mature' || signedIn);
}

function Piece({
  piece,
  link,
  linked,
  onOpen,
}: {
  piece: ArtPiece;
  /** A link straight to this piece, when the page's owner is known. */
  link?: string;
  /** A link pointed at this piece: shown large once it's loaded (unless it's Mature and covered). */
  linked: boolean;
  onOpen: (src: string, alt: string) => void;
}) {
  const thumb = useMediaUrl(piece.url, { width: 480, height: 480, method: 'scale' });
  const full = useMediaUrl(piece.url);
  const mature = piece.rating === 'mature';
  const [revealed, setRevealed] = useState(false);
  const covered = mature && !revealed;
  const alt = piece.title ?? piece.description ?? '';
  const shownLinked = useRef(false);
  useEffect(() => {
    if (!linked || shownLinked.current || !full || mature) return;
    shownLinked.current = true;
    onOpen(full, alt);
  }, [linked, full, mature, alt, onOpen]);

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
      {(piece.title || piece.description || piece.tags.length > 0 || link) && (
        <figcaption className="nu-profile-page__piece-caption">
          {piece.title && <strong>{piece.title}</strong>}
          {piece.description && <span>{piece.description}</span>}
          {piece.tags.length > 0 && <span className="nu-profile-page__tags">{piece.tags.map((tag) => `#${tag}`).join(' ')}</span>}
          {link && <ShareLinkButton url={link} title={piece.title} iconOnly className="nu-profile-page__piece-link" role="art-piece-link" />}
        </figcaption>
      )}
    </figure>
  );
}

const STRIP = 4;

/** One small square of an album's preview strip; a Mature piece stays blurred here. */
function StripThumb({ piece }: { piece: ArtPiece }) {
  const src = useMediaUrl(piece.url, { width: 160, height: 160, method: 'crop' });
  return (
    <span className={piece.rating === 'mature' ? 'nu-profile-page__strip-thumb nu-profile-page__strip-thumb--blurred' : 'nu-profile-page__strip-thumb'}>
      {src && <img src={src} alt="" loading="lazy" />}
    </span>
  );
}

/**
 * An album on the page: its title, how many pieces, and a strip of the first few as small squares.
 * The whole album opens over the page (AlbumDialog), so a big gallery takes a few lines of a side
 * column rather than the screen.
 */
function AlbumPreview({ album, signedIn, showTitle, onOpen }: { album: ArtAlbum; signedIn: boolean; showTitle: boolean; onOpen: () => void }) {
  const pieces = visiblePieces(album, signedIn);
  // Pieces anyone may see go first, so a Mature one doesn't front the strip when there's a choice.
  const strip = [...pieces.filter((p) => p.rating === 'general'), ...pieces.filter((p) => p.rating !== 'general')].slice(0, STRIP);
  return (
    <section className="nu-profile-page__album" data-nu-role="art-album">
      {showTitle && <h4 className="nu-profile-page__album-title">{album.title}</h4>}
      <button type="button" className="nu-profile-page__strip" aria-label={`Open ${album.title}`} onClick={onOpen}>
        {strip.map((piece, index) => (
          <StripThumb key={`${piece.url}-${index}`} piece={piece} />
        ))}
      </button>
      <button type="button" className="nu-profile-page__view-all" data-nu-role="art-album-open" onClick={onOpen}>
        View all ({pieces.length})
      </button>
    </section>
  );
}

/** An album over the page: every piece, its tags to filter by, and a link to it. */
function AlbumDialog({
  album,
  signedIn,
  ownerId,
  linkedPiece,
  onClose,
}: {
  album: ArtAlbum;
  signedIn: boolean;
  ownerId?: string;
  /** A piece a link pointed at, by its place in the album (from 0): shown large once loaded. */
  linkedPiece?: number;
  onClose: () => void;
}) {
  const pieces = visiblePieces(album, signedIn);
  const [tag, setTag] = useState<string>();
  const [lightbox, setLightbox] = useState<{ src: string; alt: string }>();
  const tags = [...new Set(pieces.flatMap((piece) => piece.tags))];
  const shown = tag ? pieces.filter((piece) => piece.tags.includes(tag)) : pieces;
  const hidden = album.pieces.length - pieces.length;
  const openLightbox = useCallback((src: string, alt: string) => setLightbox({ src, alt }), []);

  return (
    <Modal title={album.title} onClose={onClose} wide>
      <div className="nu-profile-page__album-dialog" data-nu-role="art-album-dialog">
        {(album.description || ownerId) && (
          <p className="nu-profile-page__album-description">
            {album.description}
            {ownerId && (
              <ShareLinkButton
                url={pageLink(ownerId, { kind: 'art', album: album.id })}
                title={album.title}
                iconOnly
                className="nu-profile-page__piece-link"
                role="art-album-link"
              />
            )}
          </p>
        )}
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
          {shown.map((piece, index) => {
            const place = album.pieces.indexOf(piece);
            return (
              <Piece
                key={`${piece.url}-${index}`}
                piece={piece}
                link={ownerId ? pageLink(ownerId, { kind: 'art', album: album.id, piece: place + 1 }) : undefined}
                linked={place === linkedPiece}
                onOpen={openLightbox}
              />
            );
          })}
        </div>
        {hidden > 0 && (
          <p className="nu-field__hint" data-nu-role="art-mature-hidden">
            {hidden} Mature {hidden === 1 ? 'piece is' : 'pieces are'} hidden unless you’re signed in.
          </p>
        )}
        {lightbox && <Lightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(undefined)} />}
      </div>
    </Modal>
  );
}

/**
 * A page's gallery: each album as a short strip of thumbnails with "View all", opening the album
 * over the page. Only the strips' small thumbnails load until then. With ratings on, Mature pieces
 * are hidden when signed out and blurred until clicked when signed in. A link to an album (or a
 * piece in it) opens that album.
 */
export function GalleryBlock({ block }: { block: GalleryBlockType }) {
  const signedIn = useSignedIn();
  const owner = useContext(PageOwnerContext);
  const target = useContext(PageTargetContext);
  const linked = target?.kind === 'art' ? block.albums.find((album) => album.id === target.album) : undefined;
  const [open, setOpen] = useState<string | undefined>(linked?.id);
  const linkedPiece = linked && target?.kind === 'art' && target.piece ? target.piece - 1 : undefined;
  const albums = block.albums.filter((album) => visiblePieces(album, signedIn).length > 0);
  if (albums.length === 0) return null;
  const shown = albums.find((album) => album.id === open);
  // One album named like the module needn't say its name twice.
  const showTitles = albums.length > 1 || albums[0].title !== (block.title ?? 'Gallery');
  return (
    <div className="nu-profile-page__albums">
      {albums.map((album) => (
        <AlbumPreview key={album.id} album={album} signedIn={signedIn} showTitle={showTitles} onOpen={() => setOpen(album.id)} />
      ))}
      {shown && (
        <AlbumDialog
          album={shown}
          signedIn={signedIn}
          ownerId={owner?.userId}
          linkedPiece={shown.id === linked?.id ? linkedPiece : undefined}
          onClose={() => setOpen(undefined)}
        />
      )}
    </div>
  );
}
