import { useState } from 'react';
import { useSetAtom } from 'jotai';
import { profileUserIdAtom, selectedRoomIdAtom, selectedSpaceIdAtom } from '../../app/state/selection';
import { Avatar } from '../../components/Avatar';
import { Lightbox } from '../../components/Lightbox';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { useMediaUrl } from '../../matrix/hooks/useMediaUrl';
import type { PageBlock, PageImage, PageLink, PageSpace } from '../../matrix/profilePage';
import { renderMessageText } from '../messaging/renderMessageText';
import { parseWatchUrl } from '../voice/watchTogether';
import { linkDomain } from './pageStyle';

type Block<T extends PageBlock['type']> = Extract<PageBlock, { type: T }>;

/** Links off the page: a new tab, no access back to Purrlor, and no endorsement for search engines. */
const EXTERNAL = { target: '_blank', rel: 'noopener noreferrer nofollow ugc' } as const;

function BlockTitle({ title }: { title?: string }) {
  return title ? <h3 className="nu-profile-page__block-title">{title}</h3> : null;
}

function TextBlock({ block }: { block: Block<'text'> }) {
  const mx = useMatrixClient();
  return (
    <>
      <BlockTitle title={block.title} />
      <div className="nu-profile-page__text">
        {renderMessageText(block.body, [], [], mx.getUserId() ?? undefined, { formattedBody: block.formatted })}
      </div>
    </>
  );
}

function EmoteImage({ mxc, className }: { mxc: string; className: string }) {
  const src = useMediaUrl(mxc);
  return src ? <img className={className} src={src} alt="" /> : <span className={className} />;
}

function LinkButton({ link }: { link: PageLink }) {
  return (
    <a
      className="nu-profile-page__link"
      href={link.url}
      {...EXTERNAL}
      style={link.color ? { backgroundColor: link.color } : undefined}
      data-nu-role="profile-page-link"
    >
      {link.emote && <EmoteImage mxc={link.emote} className="nu-profile-page__link-emote" />}
      <span className="nu-profile-page__link-text">
        <span className="nu-profile-page__link-label">{link.label}</span>
        <span className="nu-profile-page__link-domain">{linkDomain(link.url)}</span>
      </span>
    </a>
  );
}

function LinksBlock({ block }: { block: Block<'links'> }) {
  return (
    <>
      <BlockTitle title={block.title} />
      <div className="nu-profile-page__links">
        {block.items.map((link, index) => (
          <LinkButton key={index} link={link} />
        ))}
      </div>
    </>
  );
}

function ImageBlock({ block }: { block: Block<'image'> }) {
  const src = useMediaUrl(block.url);
  const image = src ? <img className="nu-profile-page__image" src={src} alt={block.caption ?? ''} loading="lazy" /> : null;
  return (
    <figure className="nu-profile-page__figure">
      {block.link ? (
        <a href={block.link} {...EXTERNAL} className="nu-profile-page__image-link">
          {image}
          <span className="nu-profile-page__link-domain">{linkDomain(block.link)}</span>
        </a>
      ) : (
        image
      )}
      {block.caption && <figcaption className="nu-profile-page__caption">{block.caption}</figcaption>}
    </figure>
  );
}

function GalleryImage({ image, onOpen }: { image: PageImage; onOpen: (src: string, alt: string) => void }) {
  const src = useMediaUrl(image.url);
  if (!src) return <span className="nu-profile-page__gallery-item" />;
  return (
    <button type="button" className="nu-profile-page__gallery-item" onClick={() => onOpen(src, image.caption ?? '')}>
      <img src={src} alt={image.caption ?? ''} loading="lazy" />
    </button>
  );
}

function GalleryBlock({ block }: { block: Block<'gallery'> }) {
  const [open, setOpen] = useState<{ src: string; alt: string }>();
  return (
    <>
      <BlockTitle title={block.title} />
      <div className="nu-profile-page__gallery">
        {block.images.map((image, index) => (
          <GalleryImage key={index} image={image} onOpen={(src, alt) => setOpen({ src, alt })} />
        ))}
      </div>
      {open && <Lightbox src={open.src} alt={open.alt} onClose={() => setOpen(undefined)} />}
    </>
  );
}

/**
 * The profile song. Nothing loads until the visitor presses play: no autoplay, and no request to
 * YouTube or the file's host before then. YouTube's player stays at least 200px tall, as its
 * terms ask (see watchTogether.ts).
 */
function SongBlock({ block }: { block: Block<'song'> }) {
  const [playing, setPlaying] = useState(false);
  const source = parseWatchUrl(block.url);
  if (!source) return null;
  const videoId = source.kind === 'youtube' && /^[\w-]{6,20}$/.test(source.videoId) ? source.videoId : undefined;
  if (source.kind === 'youtube' && !videoId) return null;

  return (
    <>
      <BlockTitle title={block.title ?? 'Profile song'} />
      {!playing ? (
        <button type="button" className="nu-profile-page__play" data-nu-role="profile-page-play" onClick={() => setPlaying(true)}>
          ▶ Play
          <span className="nu-profile-page__link-domain">{linkDomain(block.url)}</span>
        </button>
      ) : videoId ? (
        <iframe
          className="nu-profile-page__youtube"
          src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1`}
          title={block.title ?? 'Profile song'}
          allow="autoplay; encrypted-media"
          sandbox="allow-scripts allow-same-origin allow-presentation"
          referrerPolicy="strict-origin-when-cross-origin"
        />
      ) : (
        <audio className="nu-profile-page__audio" src={block.url} controls autoPlay />
      )}
    </>
  );
}

function SpaceRow({ space }: { space: PageSpace }) {
  const mx = useMatrixClient();
  const setSelectedSpaceId = useSetAtom(selectedSpaceIdAtom);
  const setSelectedRoomId = useSetAtom(selectedRoomIdAtom);
  const setProfileUserId = useSetAtom(profileUserIdAtom);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string>();
  const joined = mx.getRoom(space.roomId)?.getMyMembership() === 'join';

  const open = (roomId: string) => {
    setProfileUserId(null);
    setSelectedRoomId(null);
    setSelectedSpaceId(roomId);
  };

  const join = async () => {
    setJoining(true);
    setError(undefined);
    try {
      const room = await mx.joinRoom(space.roomId, { viaServers: space.via });
      open(room.roomId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t join that Space');
      setJoining(false);
    }
  };

  return (
    <div className="nu-profile-page__space" data-nu-role="profile-page-space">
      <Avatar name={space.name} mxcUrl={space.avatarUrl ?? null} size={36} />
      <span className="nu-profile-page__space-name">{space.name}</span>
      <button
        type="button"
        className="nu-profile-page__space-join"
        disabled={joining}
        onClick={() => (joined ? open(space.roomId) : void join())}
      >
        {joined ? 'Open' : joining ? 'Joining…' : 'Join'}
      </button>
      {error && <span className="nu-field__error">{error}</span>}
    </div>
  );
}

function SpacesBlock({ block }: { block: Block<'spaces'> }) {
  return (
    <>
      <BlockTitle title={block.title ?? 'Spaces'} />
      <div className="nu-profile-page__spaces">
        {block.spaces.map((space) => (
          <SpaceRow key={space.roomId} space={space} />
        ))}
      </div>
    </>
  );
}

function DividerBlock({ block }: { block: Block<'divider'> }) {
  if (block.style === 'emote' && block.emote) {
    return (
      <div className="nu-profile-page__divider nu-profile-page__divider--emote" role="separator">
        {Array.from({ length: 5 }, (_, i) => (
          <EmoteImage key={i} mxc={block.emote as string} className="nu-profile-page__divider-emote" />
        ))}
      </div>
    );
  }
  return <hr className={`nu-profile-page__divider nu-profile-page__divider--${block.style}`} />;
}

function BlockBody({ block }: { block: PageBlock }) {
  switch (block.type) {
    case 'text':
      return <TextBlock block={block} />;
    case 'links':
      return <LinksBlock block={block} />;
    case 'image':
      return <ImageBlock block={block} />;
    case 'gallery':
      return <GalleryBlock block={block} />;
    case 'song':
      return <SongBlock block={block} />;
    case 'spaces':
      return <SpacesBlock block={block} />;
    case 'divider':
      return <DividerBlock block={block} />;
  }
}

/** A page's blocks, in its own order. Dividers sit on the page; everything else gets a card. */
export function PageBlocks({ blocks }: { blocks: PageBlock[] }) {
  return (
    <div className="nu-profile-page__blocks" data-nu-role="profile-page-blocks">
      {blocks.map((block) => (
        <section
          key={block.id}
          className={block.type === 'divider' ? 'nu-profile-page__plain' : `nu-profile-page__block nu-profile-page__block--${block.type}`}
          data-nu-role={`profile-page-block-${block.type}`}
        >
          <BlockBody block={block} />
        </section>
      ))}
    </div>
  );
}
