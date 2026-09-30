import { useMediaUrl } from '../../matrix/hooks/useMediaUrl';
import './EmoteImage.css';

/**
 * Renders one custom emote inline. Deliberately a plain <img> at native size (no thumbnail
 * resizing to a fixed small size the way avatars are) — that's what makes animated GIF/WebP
 * emotes "just work" with zero special handling, the browser animates an <img> natively.
 */
export function EmoteImage({
  shortcode,
  mxcUrl,
  size,
}: {
  shortcode: string;
  mxcUrl: string;
  /** In a message: bigger than in a picker or a reaction, and bigger again when the message is
   *  nothing but emotes (renderMessageText). Unset: the compact size lists and pickers use. */
  size?: 'message' | 'jumbo';
}) {
  const src = useMediaUrl(mxcUrl);

  if (!src) return <>{`:${shortcode}:`}</>;

  return (
    <img
      className={size ? `nu-emote nu-emote--${size}` : 'nu-emote'}
      data-nu-role="emote"
      src={src}
      alt={`:${shortcode}:`}
      title={`:${shortcode}:`}
    />
  );
}
