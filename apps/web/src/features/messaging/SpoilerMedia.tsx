import { useState, type ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import './SpoilerMedia.css';

/** A chat image or video its sender marked as a spoiler: blurred and inert until clicked. Local
 *  to this client, like SpoilerText — revealing it tells no one. */
export function SpoilerMedia({ spoiler, children }: { spoiler: boolean; children: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  if (!spoiler) return <>{children}</>;
  return (
    <div className={revealed ? 'nu-spoiler-media' : 'nu-spoiler-media nu-spoiler-media--covered'} data-nu-role="spoiler-media">
      <div className="nu-spoiler-media__content">{children}</div>
      {!revealed && (
        <button type="button" className="nu-spoiler-media__reveal" data-nu-role="spoiler-media-reveal" onClick={() => setRevealed(true)}>
          <Icon name="eyeOff" size={18} />
          Spoiler
          <span className="nu-spoiler-media__hint">Show</span>
        </button>
      )}
    </div>
  );
}
