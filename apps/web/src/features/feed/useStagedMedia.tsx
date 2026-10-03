import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent } from 'react';
import { Icon } from '../../components/Icon';
import type { ImageTag } from '../../matrix/imageTags';
import type { MentionPerson } from '../messaging/useMentionAutocomplete';
import { ImageTagEditor } from './ImageTags';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import {
  formatBytes,
  getUploadLimit,
  MAX_ATTACHMENTS,
  prepareMedia,
  uploadPostMedia,
  type PostAttachment,
  type PreparedMedia,
} from '../../matrix/postMedia';

/** A picked file, ready to send, and anyone tagged in it (imageTags.ts). */
export type Staged = PreparedMedia & { previewUrl: string; tags: ImageTag[] };

/**
 * Images and videos picked for a post or a comment, held until it's sent: validated, JPG/PNG
 * re-encoded to WebP (postMedia.ts), checked against the server's upload limit, and previewed.
 * Shared by the post composer and the comment box so both take media the same way.
 */
export function useStagedMedia(onError: (message: string) => void) {
  const mx = useMatrixClient();
  const [staged, setStaged] = useState<Staged[]>([]);
  const [preparing, setPreparing] = useState(false);

  // Object URLs hold the file in memory until revoked. Removing one revokes it right there;
  // whatever is still staged when the composer goes away is revoked here.
  const stagedRef = useRef(staged);
  stagedRef.current = staged;
  useEffect(() => () => stagedRef.current.forEach((item) => URL.revokeObjectURL(item.previewUrl)), []);

  const addFiles = (evt: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(evt.target.files ?? []);
    evt.target.value = '';
    return addPicked(files);
  };

  /** A paste into the text box: a copied picture or video, or a screenshot, is staged the way a
   *  picked one is, and the paste stops there. A paste with no image or video on the clipboard
   *  goes into the text as usual. */
  const addPasted = (evt: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(evt.clipboardData.items)
      .filter((item) => item.kind === 'file' && /^(image|video)\//.test(item.type))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (!files.length) return;
    evt.preventDefault();
    if (preparing) return;
    if (staged.length >= MAX_ATTACHMENTS) {
      onError(`Up to ${MAX_ATTACHMENTS} images or videos at a time.`);
      return;
    }
    void addPicked(files);
  };

  /** Stages files that didn't come from the picker, such as ones shared in from another app. */
  const addPicked = async (files: File[]) => {
    if (!files.length) return;
    const room = MAX_ATTACHMENTS - staged.length;
    if (files.length > room) onError(`Up to ${MAX_ATTACHMENTS} images or videos at a time.`);
    setPreparing(true);
    try {
      const limit = await getUploadLimit(mx);
      const prepared: Staged[] = [];
      for (const file of files.slice(0, room)) {
        try {
          const media = await prepareMedia(file);
          if (limit && media.file.size > limit) {
            onError(`${file.name} is ${formatBytes(media.file.size)}; this server takes up to ${formatBytes(limit)}.`);
            continue;
          }
          prepared.push({ ...media, previewUrl: URL.createObjectURL(media.file), tags: [] });
        } catch (err) {
          onError(err instanceof Error ? err.message : `${file.name} couldn’t be added.`);
        }
      }
      setStaged((prev) => [...prev, ...prepared]);
    } finally {
      setPreparing(false);
    }
  };

  const remove = (index: number) => {
    setStaged((prev) => {
      URL.revokeObjectURL(prev[index].previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  };

  const setTags = (index: number, tags: ImageTag[]) => {
    setStaged((prev) => prev.map((item, i) => (i === index ? { ...item, tags } : item)));
  };

  const clear = () => {
    staged.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    setStaged([]);
  };

  /** Uploads everything staged — encrypted unless it's headed somewhere public (postMedia.ts). */
  const upload = async (encrypt: boolean): Promise<PostAttachment[]> => {
    const attachments: PostAttachment[] = [];
    for (const media of staged) attachments.push(await uploadPostMedia(mx, media, { encrypt, tags: media.tags }));
    return attachments;
  };

  const savedBytes = staged.reduce((sum, item) => sum + (item.originalSize ? item.originalSize - item.file.size : 0), 0);

  return { staged, preparing, addFiles, addPasted, addPicked, remove, setTags, clear, upload, savedBytes, full: staged.length >= MAX_ATTACHMENTS };
}

/**
 * The staged pictures and videos, each removable. With `people` and `onSetTags`, a picture also has
 * a "Tag" button: who's in it, from the same people an @mention offers (ImageTagEditor).
 */
export function StagedMediaPreviews({
  staged,
  onRemove,
  role,
  people,
  onSetTags,
}: {
  staged: Staged[];
  onRemove: (index: number) => void;
  role: string;
  people?: MentionPerson[];
  onSetTags?: (index: number, tags: ImageTag[]) => void;
}) {
  const [tagging, setTagging] = useState<number | null>(null);
  if (staged.length === 0) return null;
  const taggingItem = tagging !== null ? staged[tagging] : undefined;
  return (
    <div className="nu-post-composer__previews" data-nu-role={role}>
      {staged.map((item, index) => (
        <div className="nu-post-composer__preview" key={item.previewUrl}>
          {item.kind === 'video' ? <video src={item.previewUrl} muted playsInline /> : <img src={item.previewUrl} alt={item.name} />}
          <span className="nu-post-composer__preview-type">{item.mimetype.split('/')[1].toUpperCase()}</span>
          {item.kind === 'image' && people && onSetTags && (
            <button
              type="button"
              className="nu-post-composer__preview-tag"
              data-nu-role="composer-preview-tag"
              aria-label={item.tags.length ? `Tagged: ${item.tags.length}. Change who's tagged` : 'Tag people in this picture'}
              title="Tag people"
              onClick={() => setTagging(index)}
            >
              <Icon name="users" size={11} />
              {item.tags.length > 0 && item.tags.length}
            </button>
          )}
          <button
            type="button"
            className="nu-post-composer__preview-remove"
            aria-label={`Remove ${item.name}`}
            onClick={() => onRemove(index)}
          >
            <Icon name="x" size={12} />
          </button>
        </div>
      ))}
      {taggingItem && people && onSetTags && (
        <ImageTagEditor
          src={taggingItem.previewUrl}
          alt={taggingItem.name}
          tags={taggingItem.tags}
          people={people}
          onChange={(tags) => onSetTags(tagging!, tags)}
          onClose={() => setTagging(null)}
        />
      )}
    </div>
  );
}
