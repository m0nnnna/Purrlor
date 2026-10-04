import { Lightbox } from '../../components/Lightbox';
import { useAttachmentUrl, type AttachmentSource } from '../../matrix/hooks/useAttachmentUrl';

/** The lightbox for an image shown inline as a thumbnail: the thumbnail at once, then the whole
 *  file in its place once it has loaded. */
export function AttachmentLightbox({
  source,
  preview,
  alt,
  onClose,
}: {
  source: AttachmentSource;
  preview: string;
  alt: string;
  onClose: () => void;
}) {
  const full = useAttachmentUrl(source, { direct: true });
  return <Lightbox src={full ?? preview} alt={alt} onClose={onClose} />;
}
