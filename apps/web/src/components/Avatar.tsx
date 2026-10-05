import { useState } from 'react';
import { useMediaUrl } from '../matrix/hooks/useMediaUrl';
import './Avatar.css';

type AvatarProps = {
  name: string;
  mxcUrl?: string | null;
  size?: number;
  /** Matrix presence string ('online' | 'offline' | 'unavailable' | ...). Omit entirely for
   *  contexts where presence doesn't apply (spaces, DM rows) — only pass it where a status dot
   *  makes sense (the member list). */
  presence?: string;
  /** Skips thumbnail cropping in favor of the raw original media — a `/thumbnail` request
   *  freezes a GIF/animated WEBP to one frame, so an avatar known to be animated (see
   *  matrix/extendedProfile.ts) needs the full, unprocessed file instead to actually animate.
   *  Costs more bandwidth than a small cropped thumbnail, so only pass this where that tradeoff
   *  is worth it (a profile being looked at closely, not a 16px row icon). */
  animated?: boolean;
};

function statusDotClass(presence: string): string {
  if (presence === 'online') return 'nu-avatar__status-dot nu-avatar__status-dot--online';
  if (presence === 'unavailable') return 'nu-avatar__status-dot nu-avatar__status-dot--unavailable';
  return 'nu-avatar__status-dot nu-avatar__status-dot--offline';
}

/** Deterministic hue from a name, so two users without a real avatar still land on visibly
 *  different (but stable across renders/sessions) gradient colors instead of one flat brand
 *  color repeated for everyone. Exported for MessageTimeline, which colors a sender's display
 *  name to match their avatar. */
export function nameHue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

/** Shared avatar rendering — resolves a Matrix avatar mxc:// URL, falling back to an initial. */
export function Avatar({ name, mxcUrl, size = 28, presence, animated }: AvatarProps) {
  const src = useMediaUrl(mxcUrl, animated ? {} : { width: size * 2, height: size * 2, method: 'crop' });
  const initial = (name || '?').trim().slice(0, 1).toUpperCase();
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  // The image is the media URL itself now (the service worker signs it), so one that won't load
  // shows the initial rather than a broken image.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  const image = src && src !== failedSrc ? (
    <img className="nu-avatar" data-nu-role="avatar" src={src} alt="" style={style} onError={() => setFailedSrc(src)} />
  ) : (
    <div
      className="nu-avatar nu-avatar--fallback"
      data-nu-role="avatar"
      style={{ ...style, ['--nu-avatar-hue' as string]: nameHue(name || '?') }}
    >
      {initial}
    </div>
  );

  if (presence === undefined) return image;

  return (
    <span className="nu-avatar-wrapper" style={{ width: size, height: size }}>
      {image}
      <span className={statusDotClass(presence)} data-nu-role="avatar-status-dot" />
    </span>
  );
}
