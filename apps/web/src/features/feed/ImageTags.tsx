import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type RefObject } from 'react';
import { useSetAtom } from 'jotai';
import { openPostAtom, profileUserIdAtom } from '../../app/state/selection';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { useUserProfile } from '../../matrix/hooks/useUserProfile';
import { MAX_TAGS_PER_IMAGE, placeTag, tagAt, tagPosition, type ImageTag } from '../../matrix/imageTags';
import type { MentionPerson } from '../messaging/useMentionAutocomplete';
import './ImageTags.css';

/**
 * Tagging people in a picture (matrix/imageTags.ts): placing tags while writing a post or comment
 * (ImageTagEditor), and showing them on the posted picture (TaggedImageOverlay).
 */

/**
 * Where the picture itself is inside its box, which isn't the box when it's letterboxed (`contain`)
 * or cropped (`cover`): tags are placed on the picture, so they're drawn on this.
 */
function useContentBox(imgRef: RefObject<HTMLImageElement | null>, fit: 'contain' | 'cover'): CSSProperties | null {
  const [box, setBox] = useState<CSSProperties | null>(null);
  useEffect(() => {
    const img = imgRef.current;
    if (!img) return undefined;
    const measure = () => {
      const { naturalWidth: nw, naturalHeight: nh, clientWidth: w, clientHeight: h } = img;
      if (!nw || !nh || !w || !h) return;
      const scale = fit === 'contain' ? Math.min(w / nw, h / nh) : Math.max(w / nw, h / nh);
      setBox({ left: (w - nw * scale) / 2, top: (h - nh * scale) / 2, width: nw * scale, height: nh * scale });
    };
    measure();
    img.addEventListener('load', measure);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : undefined;
    observer?.observe(img);
    return () => {
      img.removeEventListener('load', measure);
      observer?.disconnect();
    };
  }, [imgRef, fit]);
  return box;
}

function TagName({ userId, fallback }: { userId: string; fallback?: string }) {
  const profile = useUserProfile(userId);
  return <>{fallback || profile.name}</>;
}

/**
 * The tags on a posted picture: a small "people" button over it, and pressing it shows each tagged
 * person's name at their spot (tapping a name opens their profile). Hidden until asked for, so
 * the picture isn't covered in labels.
 */
export function TaggedImageOverlay({
  tags,
  imgRef,
  fit,
}: {
  tags: ImageTag[];
  imgRef: RefObject<HTMLImageElement | null>;
  fit: 'contain' | 'cover';
}) {
  const [shown, setShown] = useState(false);
  const box = useContentBox(imgRef, fit);
  const setProfileUserId = useSetAtom(profileUserIdAtom);
  const setOpenPost = useSetAtom(openPostAtom);
  return (
    <>
      <button
        type="button"
        className={shown ? 'nu-image-tags__toggle nu-image-tags__toggle--on' : 'nu-image-tags__toggle'}
        data-nu-role="post-media-tags-toggle"
        aria-pressed={shown}
        aria-label={`${tags.length === 1 ? '1 person' : `${tags.length} people`} tagged. ${shown ? 'Hide' : 'Show'} who`}
        title={shown ? 'Hide tags' : 'Show who’s tagged'}
        onClick={(evt) => {
          evt.stopPropagation();
          setShown((on) => !on);
        }}
      >
        <Icon name="users" size={14} />
        <span>{tags.length}</span>
      </button>
      {shown && box && (
        <div className="nu-image-tags__layer" style={box}>
          {tags.map((tag) => (
            <button
              key={tag.user_id}
              type="button"
              className="nu-image-tags__label"
              data-nu-role="post-media-tag"
              style={tagPosition(tag)}
              onClick={(evt) => {
                evt.stopPropagation();
                setOpenPost(null);
                setProfileUserId(tag.user_id);
              }}
            >
              <TagName userId={tag.user_id} />
            </button>
          ))}
        </div>
      )}
    </>
  );
}

const MAX_SUGGESTIONS = 8;

/**
 * Placing tags on a picture before it's posted: tap where someone is, pick who it is from the same
 * people an @mention offers, and their name sits there. Their tag can be taken off again; tagging
 * the same person somewhere else moves them. "Tag someone" without tapping puts the tag in the
 * middle, for using a keyboard.
 */
export function ImageTagEditor({
  src,
  alt,
  tags,
  people,
  onChange,
  onClose,
}: {
  src: string;
  alt: string;
  tags: ImageTag[];
  people: MentionPerson[];
  onChange: (tags: ImageTag[]) => void;
  onClose: () => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [spot, setSpot] = useState<{ x: number; y: number } | null>(null);
  const [query, setQuery] = useState('');
  const nameOf = (userId: string) => people.find((person) => person.userId === userId)?.name;
  const full = tags.length >= MAX_TAGS_PER_IMAGE;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return people
      .filter((person) => !q || person.name.toLowerCase().includes(q) || person.userId.toLowerCase().includes(q))
      .slice(0, MAX_SUGGESTIONS);
  }, [people, query]);

  const pickSpot = (evt: MouseEvent<HTMLImageElement>) => {
    const rect = evt.currentTarget.getBoundingClientRect();
    setSpot({ x: (evt.clientX - rect.left) / rect.width, y: (evt.clientY - rect.top) / rect.height });
    setQuery('');
  };

  const choose = (person: MentionPerson) => {
    if (!spot) return;
    onChange(placeTag(tags, tagAt(person.userId, spot.x, spot.y)));
    setSpot(null);
  };

  return (
    <Modal title="Tag people" onClose={spot ? () => setSpot(null) : onClose} wide>
      <div className="nu-image-tagger" data-nu-role="image-tagger">
        <p className="nu-field__hint">
          {full ? `That’s as many as one picture takes (${MAX_TAGS_PER_IMAGE}).` : 'Tap where someone is in the picture, then pick who it is. They’ll be told they were tagged.'}
        </p>
        <div className="nu-image-tagger__stage">
          <img
            ref={imgRef}
            className="nu-image-tagger__img"
            data-nu-role="image-tagger-image"
            src={src}
            alt={alt}
            onClick={full ? undefined : pickSpot}
          />
          {tags.map((tag) => (
            <span key={tag.user_id} className="nu-image-tags__label nu-image-tags__label--editing" style={tagPosition(tag)}>
              <TagName userId={tag.user_id} fallback={nameOf(tag.user_id)} />
              <button
                type="button"
                className="nu-image-tags__remove"
                aria-label="Remove this tag"
                onClick={() => onChange(tags.filter((t) => t.user_id !== tag.user_id))}
              >
                <Icon name="x" size={10} />
              </button>
            </span>
          ))}
          {spot && (
            <div
              className="nu-image-tagger__picker"
              data-nu-role="image-tagger-picker"
              style={{ left: `${spot.x * 100}%`, top: `${spot.y * 100}%` }}
            >
              <span className="nu-image-tagger__dot" aria-hidden="true" />
              <input
                className="nu-field__input"
                data-nu-role="image-tagger-search"
                placeholder="Who’s this?"
                value={query}
                autoFocus
                onChange={(evt) => setQuery(evt.target.value)}
                onKeyDown={(evt) => {
                  if (evt.key === 'Enter' && matches[0]) {
                    evt.preventDefault();
                    choose(matches[0]);
                  }
                }}
              />
              <ul className="nu-image-tagger__people">
                {matches.length === 0 && <li className="nu-image-tagger__none">Nobody by that name here</li>}
                {matches.map((person) => (
                  <li key={person.userId}>
                    <button type="button" className="nu-image-tagger__person" data-nu-role="image-tagger-person" onClick={() => choose(person)}>
                      <Avatar name={person.name} mxcUrl={person.avatarUrl ?? null} size={22} />
                      <span>{person.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="nu-image-tagger__actions">
          {!full && !spot && (
            <button type="button" className="nu-button nu-button--secondary" onClick={() => setSpot({ x: 0.5, y: 0.5 })}>
              Tag someone…
            </button>
          )}
          <button type="button" className="nu-button nu-button--primary" data-nu-role="image-tagger-done" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}
