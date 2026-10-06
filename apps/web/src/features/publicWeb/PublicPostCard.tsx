import { EmbedList } from '../messaging/EmbedCard';
import type { StoredEmbed } from '../../matrix/embeds';
import { useState, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { Lightbox } from '../../components/Lightbox';
import { usePauseWhenOffscreen } from '../../components/usePauseWhenOffscreen';
import { useMediaUrl } from '../../matrix/hooks/useMediaUrl';
import type { Emote } from '../../matrix/emotes';
import {
  publicPagePath,
  type PublicAttachment,
  type PublicAuthor,
  type PublicEmbed,
  type PublicEmote,
  type PublicPost,
  type PublicRepost,
} from '../../matrix/publicWeb';
import { handleFor } from '../../matrix/roles';
import { formatPostTime } from '../feed/formatPostTime';
import { renderMessageText } from '../messaging/renderMessageText';
import { renderPostMarkdown } from '../feed/renderPostMarkdown';
import '../feed/FeedView.css';
import '../feed/PostMedia.css';
import './PublicWeb.css';

const toEmotes = (emotes?: PublicEmote[]): Emote[] => (emotes ?? []).map((emote) => ({ shortcode: emote.shortcode, mxcUrl: emote.url }));

function PublicMediaItem({ attachment, onOpen }: { attachment: PublicAttachment; onOpen: (src: string) => void }) {
  const src = useMediaUrl(attachment.url);
  const thumb = useMediaUrl(attachment.kind === 'image' ? attachment.url : null, { width: 800, height: 800, method: 'scale' });
  const videoRef = usePauseWhenOffscreen();
  const style = attachment.w && attachment.h ? { aspectRatio: `${attachment.w} / ${attachment.h}` } : undefined;
  if (!src) return null;
  if (attachment.kind === 'video') {
    // As in the app (feed/PostMedia.tsx): plays with its sound when pressed, pauses off screen.
    return (
      <div className="nu-post-media__item" style={style}>
        <video ref={videoRef} className="nu-post-media__video" src={src} controls loop playsInline preload="metadata" />
      </div>
    );
  }
  if (attachment.kind === 'audio') return <audio className="nu-public__audio" src={src} controls preload="none" />;
  if (attachment.kind !== 'image') return null;
  return (
    <div className="nu-post-media__item" style={style}>
      <button type="button" className="nu-public__media-button" onClick={() => onOpen(src)} aria-label="Open picture">
        <img className="nu-post-media__img" src={thumb ?? src} alt="" loading="lazy" />
      </button>
    </div>
  );
}

/** The public answer's embed in the shape EmbedCard draws (pictures are plain mxc: no encryption here). */
function storedFromPublic(embed: PublicEmbed): StoredEmbed {
  const { image, author, ...rest } = embed;
  return {
    ...rest,
    ...(image && { image: { url: image.url, info: { mimetype: image.mimetype, w: image.w, h: image.h } } }),
    ...(author && {
      author: { name: author.name, handle: author.handle, url: author.url, ...(author.avatar && { avatar: { url: author.avatar, info: { mimetype: 'image/*' } } }) },
    }),
  };
}

function PublicMedia({ attachments, sensitive }: { attachments: PublicAttachment[]; sensitive?: boolean }) {
  const [open, setOpen] = useState<string>();
  const [revealed, setRevealed] = useState(!sensitive);
  if (!revealed) {
    return (
      <button type="button" className="nu-public__sensitive" onClick={() => setRevealed(true)}>
        <Icon name="eyeOff" size={16} /> Sensitive media. Show it
      </button>
    );
  }
  return (
    // The same classes as the app's own (feed/PostMedia.tsx), so a picture is sized to its box.
    <div className={`nu-post-media nu-post-media--count-${attachments.length}`}>
      {attachments.map((attachment, index) => (
        <PublicMediaItem key={index} attachment={attachment} onOpen={setOpen} />
      ))}
      {open && <Lightbox src={open} alt="" onClose={() => setOpen(undefined)} />}
    </div>
  );
}

function WarningGate({ warning, children }: { warning?: string; children: ReactNode }) {
  const [shown, setShown] = useState(false);
  if (!warning) return <>{children}</>;
  return (
    <>
      <div className="nu-post__warning">
        <Icon name="eyeOff" size={14} />
        <span className="nu-post__warning-text">{warning}</span>
        <button type="button" className="nu-post__warning-toggle" aria-expanded={shown} onClick={() => setShown((s) => !s)}>
          {shown ? 'Show less' : 'Show more'}
        </button>
      </div>
      {shown && children}
    </>
  );
}

/** An author's name. It leads to their page if they opted in, and to "Sign in to see this page" if not. */
function AuthorLink({ userId }: { userId: string }) {
  return (
    <a className="nu-post__author nu-post__author--link" href={publicPagePath(userId)}>
      {handleFor(userId)}
    </a>
  );
}

function RepostQuote({ repost, authors }: { repost: PublicRepost; authors: Record<string, PublicAuthor> }) {
  if (repost.kind === 'hidden') {
    return (
      <blockquote className="nu-post__quote nu-post__quote--unavailable" data-nu-role="public-repost-hidden">
        Shared a post from a Space. Sign in to see it.
      </blockquote>
    );
  }
  return (
    <blockquote className="nu-post__quote" data-nu-role="public-repost">
      <header className="nu-post__meta">
        <Avatar name={handleFor(repost.author)} mxcUrl={authors[repost.author]?.avatarUrl ?? null} size={20} />
        <AuthorLink userId={repost.author} />
        <time className="nu-post__time">{formatPostTime(repost.ts)}</time>
      </header>
      {repost.body && <div className="nu-post__text">{renderPostMarkdown(repost.body, (text) => renderMessageText(text, toEmotes(repost.emotes)))}</div>}
      {repost.attachments && <PublicMedia attachments={repost.attachments} />}
    </blockquote>
  );
}

/**
 * One Global post for someone who isn't signed in: the author's avatar and username and nothing
 * else about them, the text and media, counts only, and a prompt to sign in for the rest.
 */
export function PublicPostCard({
  post,
  authors,
  onSignIn,
  single = false,
}: {
  post: PublicPost;
  authors: Record<string, PublicAuthor>;
  onSignIn: () => void;
  /** On the post's own page: its time isn't a link to itself. */
  single?: boolean;
}) {
  const time = new Date(post.ts);
  const postPath = `${publicPagePath(post.author)}/post/${encodeURIComponent(post.eventId)}`;
  return (
    <article className="nu-post" data-nu-role="public-post">
      <Avatar name={handleFor(post.author)} mxcUrl={authors[post.author]?.avatarUrl ?? null} size={40} />
      <div className="nu-post__body">
        <header className="nu-post__meta">
          <AuthorLink userId={post.author} />
          <span className="nu-post__origin nu-post__origin--global nu-post__origin--static">
            <Icon name="globe" size={11} />
            Global
          </span>
          {single ? (
            <time className="nu-post__time" dateTime={time.toISOString()} title={time.toLocaleString()}>
              {formatPostTime(post.ts)}
            </time>
          ) : (
            <a className="nu-post__time nu-post__time--link" href={postPath} title={time.toLocaleString()}>
              <time dateTime={time.toISOString()}>{formatPostTime(post.ts)}</time>
            </a>
          )}
          {post.edited && <span className="nu-post__time">(edited)</span>}
        </header>
        <WarningGate warning={post.warning}>
          {post.body && <div className="nu-post__text">{renderPostMarkdown(post.body, (text) => renderMessageText(text, toEmotes(post.emotes)))}</div>}
          {post.attachments && <PublicMedia attachments={post.attachments} sensitive={post.sensitive} />}
          {post.embeds && <EmbedList embeds={post.embeds.map(storedFromPublic)} eventKey={post.eventId} />}
        </WarningGate>
        {post.repost && <RepostQuote repost={post.repost} authors={authors} />}
        <div className="nu-post__actions nu-public__counts">
          <span className="nu-post__action nu-public__count" title="Likes">
            <Icon name="heart" size={15} /> {post.likes ?? 0}
          </span>
          <span className="nu-post__action nu-public__count" title="Comments">
            <Icon name="comment" size={15} /> {post.comments ?? 0}
          </span>
          <button type="button" className="nu-public__signin-link" onClick={onSignIn}>
            Sign in to like or comment
          </button>
        </div>
      </div>
    </article>
  );
}
