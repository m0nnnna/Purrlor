import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import './Lightbox.css';

/** Full-screen in-app image viewer — click the backdrop, the close button, or press Escape.
 *  Portalled out like Modal.tsx: an ancestor with a transform, filter or backdrop-filter would
 *  otherwise become what its `position: fixed` is relative to, and it would fill only that box. */
export function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (evt: KeyboardEvent) => {
      if (evt.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const lightbox = (
    <div className="nu-lightbox" data-nu-role="lightbox" onClick={onClose}>
      <button
        type="button"
        className="nu-lightbox__close"
        data-nu-role="lightbox-close"
        onClick={onClose}
        aria-label="Close"
      >
        ×
      </button>
      <img className="nu-lightbox__image" src={src} alt={alt} onClick={(evt) => evt.stopPropagation()} />
    </div>
  );
  return createPortal(lightbox, document.getElementById('portalContainer') ?? document.body);
}
