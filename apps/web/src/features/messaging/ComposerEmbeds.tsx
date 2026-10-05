import type { CSSProperties } from 'react';
import { Icon } from '../../components/Icon';
import type { ComposerEmbed } from '../../matrix/hooks/useComposerEmbeds';

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Above the composer: what each link in the draft will embed as, with a × to send it without
 * (useComposerEmbeds). The picture is the token server's short-lived copy, not the site's.
 */
export function ComposerEmbeds({ previews, onRemove }: { previews: ComposerEmbed[]; onRemove: (url: string) => void }) {
  if (previews.length === 0) return null;
  return (
    <div className="nu-composer-embeds" data-nu-role="composer-embeds">
      {previews.map(({ url, status, link }) => {
        const embed = link?.embed;
        const image = link?.files.image;
        const style = embed?.site?.color ? ({ '--nu-embed-accent': embed.site.color } as CSSProperties) : undefined;
        return (
          <div key={url} className="nu-composer-embed" data-nu-role="composer-embed" data-nu-status={status} style={style}>
            {image && <img className="nu-composer-embed__thumb" src={`/api/public/embeds/files/${encodeURIComponent(image.id)}`} alt="" />}
            <span className="nu-composer-embed__text">
              <span className="nu-composer-embed__title">
                {status === 'loading' ? 'Getting a preview…' : (embed?.title ?? embed?.author?.name ?? embed?.description ?? hostOf(url))}
              </span>
              <span className="nu-composer-embed__site">{embed?.site?.name ?? hostOf(url)}</span>
            </span>
            <button
              type="button"
              className="nu-composer-embed__remove"
              data-nu-role="composer-embed-remove"
              title="Send without this embed"
              aria-label="Send without this embed"
              onClick={() => onRemove(url)}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
