import { useContext, useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { MatrixClientContext } from '../../matrix/MatrixClientContext';
import { inlineThumbnailSize, useAttachmentUrl } from '../../matrix/hooks/useAttachmentUrl';
import { useMediaUrl } from '../../matrix/hooks/useMediaUrl';
import { useEmbedSettings } from '../../matrix/embedSettings';
import { playerFrameUrl, playerSpec, type EmbedFile, type StoredEmbed } from '../../matrix/embeds';
import { AttachmentLightbox } from './AttachmentLightbox';
import { useSharedWatchTogether } from '../voice/watchTogetherContext';
import './EmbedCard.css';

/**
 * Draws a message's or post's link embeds (docs/embeds.md): cards, posts from other sites,
 * click-to-load players, and images, video and audio. Everything shown comes from the event as
 * plain text, pictures from the homeserver, players only from the table in matrix/embeds.ts.
 */

// --- One player at a time ------------------------------------------------------------------------

let activePlayer: string | null = null;
const playerListeners = new Set<() => void>();
function setActivePlayer(key: string | null) {
  activePlayer = key;
  playerListeners.forEach((listener) => listener());
}
function useActivePlayer(): string | null {
  return useSyncExternalStore(
    (listener) => {
      playerListeners.add(listener);
      return () => playerListeners.delete(listener);
    },
    () => activePlayer
  );
}

// --- Pictures ------------------------------------------------------------------------------------

/** A stored picture's src: an encrypted one decrypted (signed in only), a plain one from its mxc. */
function EncryptedImage({ file, alt, className, style }: { file: EmbedFile; alt: string; className: string; style?: CSSProperties }) {
  const src = useAttachmentUrl({ file: file.file, mimetype: file.info.mimetype });
  return src ? <img className={className} src={src} alt={alt} style={style} loading="lazy" /> : <span className={`${className} nu-embed__img--loading`} style={style} />;
}

function PlainImage({ file, alt, className, style, box }: { file: EmbedFile; alt: string; className: string; style?: CSSProperties; box?: number }) {
  const thumbnail = box ? inlineThumbnailSize(file.info.mimetype, file.info.w, file.info.h, box, box) : undefined;
  const src = useMediaUrl(file.url, thumbnail ? { width: thumbnail.width, height: thumbnail.height, method: 'scale' } : {});
  return src ? <img className={className} src={src} alt={alt} style={style} loading="lazy" /> : <span className={`${className} nu-embed__img--loading`} style={style} />;
}

function EmbedImage(props: { file: EmbedFile; alt: string; className: string; style?: CSSProperties; box?: number }) {
  return props.file.file ? <EncryptedImage {...props} /> : <PlainImage {...props} />;
}

function ratio(file: EmbedFile | undefined): CSSProperties | undefined {
  const { w, h } = file?.info ?? {};
  return w && h ? { aspectRatio: `${w} / ${h}` } : undefined;
}

// --- Pieces --------------------------------------------------------------------------------------

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function Shell({ embed, children, onRemove, link = true }: { embed: StoredEmbed; children: ReactNode; onRemove?: () => void; link?: boolean }) {
  const [revealed, setRevealed] = useState(false);
  const covered = embed.sensitive && !revealed;
  const style = embed.site?.color ? ({ '--nu-embed-accent': embed.site.color } as CSSProperties) : undefined;
  return (
    <div className={`nu-embed nu-embed--${embed.kind}${covered ? ' nu-embed--covered' : ''}`} data-nu-role="embed" data-nu-embed-kind={embed.kind} style={style}>
      {link ? (
        <a className="nu-embed__body" href={embed.url} target="_blank" rel="noopener noreferrer nofollow">
          {children}
        </a>
      ) : (
        <div className="nu-embed__body">{children}</div>
      )}
      {covered && (
        <button type="button" className="nu-embed__reveal" data-nu-role="embed-reveal" onClick={() => setRevealed(true)}>
          <Icon name="eyeOff" size={16} />
          Sensitive
          <span className="nu-embed__reveal-hint">Show</span>
        </button>
      )}
      {onRemove && (
        <button type="button" className="nu-embed__remove" data-nu-role="embed-remove" title="Remove this embed" aria-label="Remove this embed" onClick={onRemove}>
          <Icon name="x" size={14} />
        </button>
      )}
    </div>
  );
}

function SiteLine({ embed }: { embed: StoredEmbed }) {
  return <div className="nu-embed__site">{embed.site?.name ?? hostOf(embed.url)}</div>;
}

function CardView({ embed, onRemove }: { embed: StoredEmbed; onRemove?: () => void }) {
  const { w, h } = embed.image?.info ?? {};
  // A wide picture goes under the text, a squarish one beside it (Discord's way).
  const wide = !!embed.image && (!w || !h || w >= h * 1.3);
  return (
    <Shell embed={embed} onRemove={onRemove}>
      <div className={wide ? 'nu-embed__card' : 'nu-embed__card nu-embed__card--side'}>
        <div className="nu-embed__text">
          <SiteLine embed={embed} />
          {embed.author?.name && <div className="nu-embed__author-line">{embed.author.name}</div>}
          {embed.title && <div className="nu-embed__title">{embed.title}</div>}
          {embed.description && <div className="nu-embed__description">{embed.description}</div>}
        </div>
        {embed.image && (
          <EmbedImage file={embed.image} alt="" className={wide ? 'nu-embed__picture' : 'nu-embed__thumb'} style={wide ? ratio(embed.image) : undefined} box={wide ? 400 : 80} />
        )}
      </div>
    </Shell>
  );
}

function PostView({ embed, onRemove }: { embed: StoredEmbed; onRemove?: () => void }) {
  const { author } = embed;
  return (
    <Shell embed={embed} onRemove={onRemove}>
      <div className="nu-embed__post">
        {(author?.name || author?.handle) && (
          <div className="nu-embed__post-author">
            {author.avatar && <EmbedImage file={author.avatar} alt="" className="nu-embed__avatar" box={40} />}
            <span className="nu-embed__post-name">{author.name ?? author.handle}</span>
            {author.handle && author.name && <span className="nu-embed__post-handle">{author.handle}</span>}
          </div>
        )}
        {embed.title && <div className="nu-embed__title">{embed.title}</div>}
        {embed.description && <div className="nu-embed__post-text">{embed.description}</div>}
        {embed.image && <EmbedImage file={embed.image} alt="" className="nu-embed__picture" style={ratio(embed.image)} box={400} />}
        <div className="nu-embed__post-footer">
          <SiteLine embed={embed} />
          {embed.published && <time dateTime={new Date(embed.published).toISOString()}>{new Date(embed.published).toLocaleDateString()}</time>}
        </div>
      </div>
    </Shell>
  );
}

function PlayerView({ embed, onRemove, playerKey }: { embed: StoredEmbed; onRemove?: () => void; playerKey: string }) {
  const active = useActivePlayer();
  // In a call: hand a YouTube video to the call's Watch Together (features/voice/useWatchTogether.ts).
  const watchTogether = useSharedWatchTogether();
  const frame = playerFrameUrl(embed.player, window.location.hostname);
  if (!frame || !embed.player) return <CardView embed={embed} onRemove={onRemove} />;
  const spec = playerSpec(embed.player.provider);
  const playing = active === playerKey;
  return (
    <Shell embed={embed} onRemove={onRemove} link={false}>
      <div className="nu-embed__player-head">
        <SiteLine embed={embed} />
        {embed.title && (
          <a className="nu-embed__title" href={embed.url} target="_blank" rel="noopener noreferrer nofollow">
            {embed.title}
          </a>
        )}
        {embed.author?.name && <div className="nu-embed__author-line">{embed.author.name}</div>}
        {watchTogether && embed.player.provider === 'youtube' && (
          <button
            type="button"
            className="nu-embed__watch-together"
            data-nu-role="embed-watch-together"
            onClick={() => {
              if (watchTogether.start(embed.url, 'watch')) setActivePlayer(null);
            }}
          >
            <Icon name="tv" size={14} />
            Watch together
          </button>
        )}
      </div>
      {playing ? (
        <iframe
          className={spec.audio ? 'nu-embed__frame nu-embed__frame--audio' : 'nu-embed__frame'}
          style={spec.height ? { height: spec.height } : undefined}
          src={frame}
          title={embed.title ?? 'Player'}
          allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          data-nu-role="embed-player-frame"
        />
      ) : (
        // Nothing loads from the site until this is pressed.
        <button type="button" className="nu-embed__play" data-nu-role="embed-play" aria-label={`Play ${embed.title ?? ''}`.trim()} onClick={() => setActivePlayer(playerKey)}>
          {embed.image ? <EmbedImage file={embed.image} alt="" className="nu-embed__picture" style={ratio(embed.image)} box={400} /> : <span className="nu-embed__picture nu-embed__picture--blank" />}
          <span className="nu-embed__play-icon" aria-hidden="true">
            <Icon name="play" size={28} />
          </span>
        </button>
      )}
    </Shell>
  );
}

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function ImageView({ embed, onRemove, signedIn }: { embed: StoredEmbed; onRemove?: () => void; signedIn: boolean }) {
  const [open, setOpen] = useState(false);
  const isGif = embed.image?.info.mimetype === 'image/gif';
  // A GIF waits for a click when the reader asked for less motion.
  const [play, setPlay] = useState(() => !(isGif && reducedMotion()));
  if (!embed.image) return null;
  const image = embed.image;
  // Signed out there's no lightbox (it needs the client): the picture links to its page.
  if (!signedIn) {
    return (
      <Shell embed={embed}>
        <EmbedImage file={image} alt={embed.title ?? ''} className="nu-embed__picture" style={ratio(image)} box={400} />
      </Shell>
    );
  }
  return (
    <Shell embed={embed} onRemove={onRemove} link={false}>
      {play ? (
        <button type="button" className="nu-embed__image-button" onClick={() => setOpen(true)} aria-label="Open image">
          <EmbedImage file={image} alt={embed.title ?? ''} className="nu-embed__picture" style={ratio(image)} box={isGif ? undefined : 400} />
        </button>
      ) : (
        <button type="button" className="nu-embed__play nu-embed__picture nu-embed__picture--blank" style={ratio(image)} onClick={() => setPlay(true)}>
          GIF
        </button>
      )}
      {open && <ImageLightbox file={image} alt={embed.title ?? ''} onClose={() => setOpen(false)} />}
    </Shell>
  );
}

function ImageLightbox({ file, alt, onClose }: { file: EmbedFile; alt: string; onClose: () => void }) {
  const preview = useMediaUrl(file.url) ?? '';
  return <AttachmentLightbox source={{ url: file.url, file: file.file, mimetype: file.info.mimetype }} preview={preview} alt={alt} onClose={onClose} />;
}

function MediaView({ embed, onRemove }: { embed: StoredEmbed; onRemove?: () => void }) {
  const media = embed.media!;
  const src = useAttachmentUrl({ url: media.url, file: media.file, mimetype: media.info.mimetype }, { direct: true });
  const poster = useMediaUrl(embed.image?.url);
  return (
    <Shell embed={embed} onRemove={onRemove} link={false}>
      {embed.title && (
        <a className="nu-embed__title" href={embed.url} target="_blank" rel="noopener noreferrer nofollow">
          {embed.title}
        </a>
      )}
      {!src ? (
        <span className="nu-embed__picture nu-embed__img--loading" style={ratio(media)} />
      ) : embed.kind === 'video' ? (
        <video className="nu-embed__video" src={src} poster={poster ?? undefined} controls playsInline preload="metadata" style={ratio(media)} />
      ) : (
        <audio className="nu-embed__audio" src={src} controls preload="metadata" />
      )}
    </Shell>
  );
}

// --- The list ------------------------------------------------------------------------------------

export function EmbedView({ embed, onRemove, playerKey, noPlayers = false }: { embed: StoredEmbed; onRemove?: () => void; playerKey: string; noPlayers?: boolean }) {
  const settings = useEmbedSettings();
  // A channel can turn players off for everyone (channelPermissions.ts); a person, for themselves.
  const show = noPlayers && settings.show === 'all' ? 'no-players' : settings.show;
  const signedIn = !!useContext(MatrixClientContext);
  // Stop this one's player if it goes away while playing.
  useEffect(() => () => {
    if (activePlayer === playerKey) setActivePlayer(null);
  }, [playerKey]);
  if (show === 'none') return null;
  switch (embed.kind) {
    case 'post':
      return <PostView embed={embed} onRemove={onRemove} />;
    case 'player':
      // Signed out (the public web) and "no players": a card that opens the site.
      return show === 'all' && signedIn ? <PlayerView embed={embed} onRemove={onRemove} playerKey={playerKey} /> : <CardView embed={embed} onRemove={onRemove} />;
    case 'image':
      return <ImageView embed={embed} onRemove={onRemove} signedIn={signedIn} />;
    case 'video':
    case 'audio':
      return signedIn ? <MediaView embed={embed} onRemove={onRemove} /> : <CardView embed={{ ...embed, title: embed.title ?? hostOf(embed.url) }} />;
    default:
      return <CardView embed={embed} onRemove={onRemove} />;
  }
}

/**
 * An event's embeds, under its text. `onRemove` (your own messages and posts) offers a × on each,
 * which edits it out. `eventKey` keeps each player's identity distinct across the timeline.
 */
export function EmbedList({
  embeds,
  eventKey,
  onRemove,
  noPlayers,
}: {
  embeds: StoredEmbed[];
  eventKey: string;
  onRemove?: (url: string) => void;
  /** The channel turned players off. */
  noPlayers?: boolean;
}) {
  if (embeds.length === 0) return null;
  return (
    <div className="nu-embeds" data-nu-role="embeds">
      {embeds.map((embed) => (
        <EmbedView
          key={embed.url}
          embed={embed}
          playerKey={`${eventKey}|${embed.url}`}
          onRemove={onRemove ? () => onRemove(embed.url) : undefined}
          noPlayers={noPlayers}
        />
      ))}
    </div>
  );
}
