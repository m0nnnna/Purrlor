import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import './ShareLinkButton.css';

/**
 * Hands a link out: the phone's own share sheet where there is one (a touch screen), otherwise
 * the clipboard. `cancelled` when the person closed the share sheet; `failed` when neither works.
 */
export async function shareLink(url: string, title?: string): Promise<'shared' | 'copied' | 'cancelled' | 'failed'> {
  const touch = window.matchMedia?.('(pointer: coarse)').matches;
  if (touch && navigator.share) {
    try {
      await navigator.share({ url, ...(title && { title }) });
      return 'shared';
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return 'copied';
  } catch {
    return 'failed';
  }
}

/**
 * A button that hands out a link: the phone's own share sheet where there is one (a touch screen), otherwise
 * copied to the clipboard, saying so for a moment. If neither works the link is shown to copy by
 * hand.
 */
export function ShareLinkButton({
  url,
  label = 'Copy link',
  title,
  className = 'nu-button nu-button--secondary',
  role,
  iconOnly = false,
}: {
  url: string;
  label?: string;
  /** What's being shared, for the share sheet. */
  title?: string;
  className?: string;
  role?: string;
  iconOnly?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (state !== 'copied') return;
    const timer = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [state]);

  const share = async () => {
    const result = await shareLink(url, title);
    if (result === 'copied' || result === 'failed') setState(result);
  };

  const text = state === 'copied' ? 'Link copied' : label;
  return (
    <span className="nu-share-link">
      <button
        type="button"
        className={className}
        data-nu-role={role}
        data-nu-link={url}
        aria-label={iconOnly ? `${label}${title ? `: ${title}` : ''}` : undefined}
        title={iconOnly ? text : undefined}
        onClick={(evt) => {
          evt.stopPropagation();
          void share();
        }}
      >
        <Icon name={state === 'copied' ? 'check' : 'link'} size={14} />
        {!iconOnly && <span>{text}</span>}
      </button>
      {state === 'failed' && (
        <input className="nu-field__input nu-share-link__fallback" readOnly value={url} aria-label="Link to copy" onFocus={(evt) => evt.target.select()} autoFocus />
      )}
    </span>
  );
}
