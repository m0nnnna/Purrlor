import { useEffect, useId, useState } from 'react';
import type { Room } from 'matrix-js-sdk';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { useSpaces } from '../../matrix/hooks/useSpaces';
import { useFollows } from '../../matrix/hooks/useFollows';
import { useProfileBrief } from '../../matrix/hooks/useProfileBrief';
import { followsBack } from '../../matrix/topFriends';
import type { Emote } from '../../matrix/emotes';
import {
  DIVIDER_STYLES,
  GUESTBOOK_WHO,
  LIMITS,
  readHttpsUrl,
  type DividerStyle,
  type GuestbookWho,
  type PageBlock,
  type PageLink,
  type PageSpace,
} from '../../matrix/profilePage';
import { parseWatchUrl } from '../voice/watchTogether';
import { BLOCK_LABELS, findEmote } from './editorModel';
import { ImagePicker, ImageThumb } from './ImagePicker';

type Block<T extends PageBlock['type']> = Extract<PageBlock, { type: T }>;
type EditorProps<T extends PageBlock['type']> = {
  block: Block<T>;
  onChange: (block: Block<T>) => void;
  emotes: Emote[];
  imagesLeft: number;
};

function TitleField({ value, onChange }: { value?: string; onChange: (title: string | undefined) => void }) {
  return (
    <label className="nu-field">
      Heading (optional)
      <input
        className="nu-field__input"
        value={value ?? ''}
        maxLength={LIMITS.title}
        onChange={(evt) => onChange(evt.target.value || undefined)}
      />
    </label>
  );
}

/** A link field that says when what's typed won't be kept (it must be https://). */
function UrlField({
  label,
  value,
  onChange,
  role,
  hint,
}: {
  label: string;
  value: string;
  onChange: (url: string) => void;
  role?: string;
  hint?: string;
}) {
  const invalid = value.trim() !== '' && !readHttpsUrl(value);
  return (
    <label className="nu-field">
      {label}
      <input
        className="nu-field__input"
        type="url"
        inputMode="url"
        placeholder="https://"
        value={value}
        maxLength={LIMITS.url}
        onChange={(evt) => onChange(evt.target.value)}
        data-nu-role={role}
      />
      {invalid ? (
        <span className="nu-field__error">Use a full link starting with https://</span>
      ) : (
        hint && <span className="nu-field__hint">{hint}</span>
      )}
    </label>
  );
}

/** Emote by shortcode, from the emotes you can use in messages. */
function EmoteField({
  label,
  value,
  emotes,
  onChange,
}: {
  label: string;
  value?: string;
  emotes: Emote[];
  onChange: (mxc: string | undefined) => void;
}) {
  const listId = useId();
  const current = emotes.find((emote) => emote.mxcUrl === value);
  return (
    <label className="nu-field">
      {label}
      <span className="nu-page-editor__row">
        {value && <ImageThumb mxc={value} />}
        <input
          className="nu-field__input"
          list={listId}
          placeholder=":shortcode:"
          defaultValue={current ? `:${current.shortcode}:` : ''}
          onChange={(evt) => onChange(findEmote(emotes, evt.target.value)?.mxcUrl)}
        />
      </span>
      <datalist id={listId}>
        {emotes.slice(0, 300).map((emote) => (
          <option key={emote.shortcode} value={`:${emote.shortcode}:`} />
        ))}
      </datalist>
    </label>
  );
}

function TextEditor({ block, onChange }: EditorProps<'text'>) {
  return (
    <>
      <TitleField value={block.title} onChange={(title) => onChange({ ...block, title })} />
      <label className="nu-field">
        Text
        <textarea
          className="nu-field__input nu-field__textarea"
          rows={5}
          maxLength={LIMITS.body}
          value={block.body}
          onChange={(evt) => onChange({ ...block, body: evt.target.value })}
          data-nu-role="page-editor-text-body"
        />
        <span className="nu-field__hint">**bold**, *italic*, ||spoilers|| and :emotes: work the same as in messages.</span>
      </label>
    </>
  );
}

function LinksEditor({ block, onChange, emotes }: EditorProps<'links'>) {
  const setItem = (index: number, patch: Partial<PageLink>) =>
    onChange({ ...block, items: block.items.map((item, i) => (i === index ? { ...item, ...patch } : item)) });
  return (
    <>
      <TitleField value={block.title} onChange={(title) => onChange({ ...block, title })} />
      {block.items.map((item, index) => (
        <fieldset key={index} className="nu-page-editor__subitem">
          <label className="nu-field">
            Label
            <input
              className="nu-field__input"
              value={item.label}
              maxLength={LIMITS.label}
              onChange={(evt) => setItem(index, { label: evt.target.value })}
              data-nu-role="page-editor-link-label"
            />
          </label>
          <UrlField label="Goes to" value={item.url} onChange={(url) => setItem(index, { url })} role="page-editor-link-url" />
          <div className="nu-page-editor__row">
            <EmoteField label="Emote (optional)" value={item.emote} emotes={emotes} onChange={(emote) => setItem(index, { emote })} />
            <label className="nu-page-editor__color">
              <input
                type="checkbox"
                checked={!!item.color}
                onChange={(evt) => setItem(index, { color: evt.target.checked ? '#ff7ab6' : undefined })}
              />
              Own colour
            </label>
            {item.color && (
              <input
                type="color"
                value={item.color}
                onChange={(evt) => setItem(index, { color: evt.target.value.toLowerCase() })}
                aria-label="Button colour"
              />
            )}
          </div>
          <button
            type="button"
            className="nu-page-editor__inline-button"
            onClick={() => onChange({ ...block, items: block.items.filter((_, i) => i !== index) })}
          >
            Remove this link
          </button>
        </fieldset>
      ))}
      {block.items.length < LIMITS.links && (
        <button
          type="button"
          className="nu-button nu-button--secondary"
          onClick={() => onChange({ ...block, items: [...block.items, { label: '', url: '' }] })}
          data-nu-role="page-editor-add-link"
        >
          Add a link
        </button>
      )}
    </>
  );
}

function ImageEditor({ block, onChange, imagesLeft }: EditorProps<'image'>) {
  return (
    <>
      <div className="nu-page-editor__row">
        {block.url && <ImageThumb mxc={block.url} />}
        <ImagePicker
          label={block.url ? 'Change image…' : 'Upload an image or GIF…'}
          disabled={!block.url && imagesLeft < 1}
          onUploaded={([url]) => onChange({ ...block, url })}
        />
      </div>
      <label className="nu-field">
        Caption (optional)
        <input
          className="nu-field__input"
          value={block.caption ?? ''}
          maxLength={LIMITS.caption}
          onChange={(evt) => onChange({ ...block, caption: evt.target.value || undefined })}
        />
      </label>
      <UrlField label="Link (optional)" value={block.link ?? ''} onChange={(link) => onChange({ ...block, link: link || undefined })} />
    </>
  );
}

function GalleryEditor({ block, onChange, imagesLeft }: EditorProps<'gallery'>) {
  const room = Math.min(imagesLeft, LIMITS.galleryImages - block.images.length);
  return (
    <>
      <TitleField value={block.title} onChange={(title) => onChange({ ...block, title })} />
      <div className="nu-page-editor__thumbs">
        {block.images.map((image, index) => (
          <ImageThumb
            key={`${image.url}-${index}`}
            mxc={image.url}
            onRemove={() => onChange({ ...block, images: block.images.filter((_, i) => i !== index) })}
          />
        ))}
      </div>
      <ImagePicker
        label="Add images…"
        multiple
        max={room}
        disabled={room < 1}
        onUploaded={(urls) => onChange({ ...block, images: [...block.images, ...urls.map((url) => ({ url }))] })}
      />
      <span className="nu-field__hint">
        {block.images.length} of {LIMITS.galleryImages}
      </span>
    </>
  );
}

function SongEditor({ block, onChange }: EditorProps<'song'>) {
  const unplayable = !!readHttpsUrl(block.url) && !parseWatchUrl(block.url);
  return (
    <>
      <TitleField value={block.title} onChange={(title) => onChange({ ...block, title })} />
      <UrlField
        label="Song link"
        value={block.url}
        onChange={(url) => onChange({ ...block, url })}
        role="page-editor-song-url"
        hint="A YouTube or YouTube Music link, or a link to an audio file. Visitors press play; it never starts by itself."
      />
      {unplayable && <span className="nu-field__error">That link can’t be played.</span>}
    </>
  );
}

function serverOf(userId: string): string {
  return userId.slice(userId.indexOf(':') + 1);
}

function toPageSpace(space: Room, via: string): PageSpace {
  const avatarUrl = space.getMxcAvatarUrl() ?? undefined;
  return { roomId: space.roomId, name: space.name || 'A Space', ...(avatarUrl && { avatarUrl }), via: [via] };
}

/** Your public Spaces, ticked to show them. A private Space can't go on a public page. */
function SpacesEditor({ block, onChange }: EditorProps<'spaces'>) {
  const mx = useMatrixClient();
  const publicSpaces = useSpaces().filter((space) => space.getJoinRule() === 'public');
  const via = serverOf(mx.getUserId() ?? '');
  const shown = new Set(block.spaces.map((space) => space.roomId));
  return (
    <>
      <TitleField value={block.title} onChange={(title) => onChange({ ...block, title })} />
      {publicSpaces.length === 0 && <p className="nu-field__hint">You aren’t in any public Spaces yet.</p>}
      {publicSpaces.map((space) => (
        <label key={space.roomId} className="nu-field__checkbox-row">
          <input
            type="checkbox"
            checked={shown.has(space.roomId)}
            disabled={!shown.has(space.roomId) && block.spaces.length >= LIMITS.spaces}
            onChange={(evt) =>
              onChange({
                ...block,
                spaces: evt.target.checked
                  ? [...block.spaces, toPageSpace(space, via)]
                  : block.spaces.filter((s) => s.roomId !== space.roomId),
              })
            }
          />
          {space.name}
        </label>
      ))}
    </>
  );
}

const DIVIDER_LABELS: Record<DividerStyle, string> = { line: 'Line', dots: 'Dots', emote: 'A row of an emote' };

function DividerEditor({ block, onChange, emotes }: EditorProps<'divider'>) {
  return (
    <>
      <label className="nu-field">
        Style
        <select
          className="nu-field__input"
          value={block.style}
          onChange={(evt) => onChange({ ...block, style: evt.target.value as DividerStyle })}
        >
          {DIVIDER_STYLES.map((style) => (
            <option key={style} value={style}>
              {DIVIDER_LABELS[style]}
            </option>
          ))}
        </select>
      </label>
      {block.style === 'emote' && (
        <EmoteField label="Emote" value={block.emote} emotes={emotes} onChange={(emote) => onChange({ ...block, emote })} />
      )}
    </>
  );
}

function FriendRow({ userId, checked, disabled, onToggle }: { userId: string; checked: boolean; disabled: boolean; onToggle: (on: boolean) => void }) {
  const mx = useMatrixClient();
  const brief = useProfileBrief(userId);
  const [back, setBack] = useState<boolean>();
  useEffect(() => {
    let cancelled = false;
    void followsBack(mx, userId, mx.getUserId() ?? '').then((result) => {
      if (!cancelled) setBack(result);
    });
    return () => {
      cancelled = true;
    };
  }, [mx, userId]);
  return (
    <label className="nu-field__checkbox-row">
      <input type="checkbox" checked={checked} disabled={(disabled && !checked) || (back === false && !checked)} onChange={(evt) => onToggle(evt.target.checked)} />
      {brief.name}
      {back === false && <span className="nu-field__hint"> doesn’t follow you back</span>}
    </label>
  );
}

/** Your Top 8, picked from people you follow who follow you back. Anyone else wouldn't be shown anyway. */
function FriendsEditor({ block, onChange }: EditorProps<'friends'>) {
  const follows = useFollows().users;
  const chosen = new Set(block.users);
  // Someone you've since unfollowed stays listed so you can take them off.
  const people = [...new Set([...block.users, ...follows])];
  return (
    <>
      <TitleField value={block.title} onChange={(title) => onChange({ ...block, title })} />
      <p className="nu-field__hint">
        Only people who follow you back are shown ({block.users.length} of {LIMITS.friends}).
      </p>
      {people.length === 0 && <p className="nu-field__hint">Follow some people first.</p>}
      {people.map((userId) => (
        <FriendRow
          key={userId}
          userId={userId}
          checked={chosen.has(userId)}
          disabled={block.users.length >= LIMITS.friends}
          onToggle={(on) => onChange({ ...block, users: on ? [...block.users, userId] : block.users.filter((u) => u !== userId) })}
        />
      ))}
    </>
  );
}

const GUESTBOOK_WHO_LABELS: Record<GuestbookWho, string> = { everyone: 'Anyone signed in', following: 'Only people I follow' };

function GuestbookEditor({ block, onChange }: EditorProps<'guestbook'>) {
  return (
    <>
      <TitleField value={block.title} onChange={(title) => onChange({ ...block, title })} />
      <label className="nu-field">
        Who can sign
        <select
          className="nu-field__input"
          value={block.who}
          onChange={(evt) => onChange({ ...block, who: evt.target.value as GuestbookWho })}
          data-nu-role="page-editor-guestbook-who"
        >
          {GUESTBOOK_WHO.map((who) => (
            <option key={who} value={who}>
              {GUESTBOOK_WHO_LABELS[who]}
            </option>
          ))}
        </select>
      </label>
      <label className="nu-field">
        Slowmode (seconds between one person’s entries, 0 for none)
        <input
          className="nu-field__input"
          type="number"
          min={0}
          max={LIMITS.guestbookSlowmode}
          value={block.slowmode}
          onChange={(evt) => onChange({ ...block, slowmode: Math.max(0, Math.min(LIMITS.guestbookSlowmode, Math.round(Number(evt.target.value) || 0))) })}
        />
      </label>
      <label className="nu-field">
        Blocked words (one per line)
        <textarea
          className="nu-field__input nu-field__textarea"
          rows={3}
          value={block.blockedWords.join('\n')}
          onChange={(evt) =>
            onChange({ ...block, blockedWords: evt.target.value.split('\n').map((word) => word.slice(0, LIMITS.guestbookWord)).slice(0, LIMITS.guestbookWords) })
          }
        />
        <span className="nu-field__hint">
          Entries with these words are left out and deleted from your guestbook. Like everything on your page, the list is public. To switch the
          guestbook off, remove the block.
        </span>
      </label>
    </>
  );
}

function Fields({
  block,
  onChange,
  emotes,
  imagesLeft,
}: {
  block: PageBlock;
  onChange: (block: PageBlock) => void;
  emotes: Emote[];
  imagesLeft: number;
}) {
  const shared = { emotes, imagesLeft };
  switch (block.type) {
    case 'text':
      return <TextEditor block={block} onChange={onChange} {...shared} />;
    case 'links':
      return <LinksEditor block={block} onChange={onChange} {...shared} />;
    case 'image':
      return <ImageEditor block={block} onChange={onChange} {...shared} />;
    case 'gallery':
      return <GalleryEditor block={block} onChange={onChange} {...shared} />;
    case 'song':
      return <SongEditor block={block} onChange={onChange} {...shared} />;
    case 'spaces':
      return <SpacesEditor block={block} onChange={onChange} {...shared} />;
    case 'divider':
      return <DividerEditor block={block} onChange={onChange} {...shared} />;
    case 'friends':
      return <FriendsEditor block={block} onChange={onChange} {...shared} />;
    case 'guestbook':
      return <GuestbookEditor block={block} onChange={onChange} {...shared} />;
    default:
      return null;
  }
}

/** One block in the builder's list: its kind, move and remove buttons, and its fields when open. */
export function BlockEditor({
  block,
  open,
  first,
  last,
  emotes,
  imagesLeft,
  onToggle,
  onChange,
  onMove,
  onRemove,
}: {
  block: PageBlock;
  open: boolean;
  first: boolean;
  last: boolean;
  emotes: Emote[];
  imagesLeft: number;
  onToggle: () => void;
  onChange: (block: PageBlock) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const summary = 'title' in block && block.title ? `${BLOCK_LABELS[block.type]}: ${block.title}` : BLOCK_LABELS[block.type];
  return (
    <div
      className={open ? 'nu-page-editor__block nu-page-editor__block--open' : 'nu-page-editor__block'}
      data-nu-role={`page-editor-block-${block.type}`}
    >
      <div className="nu-page-editor__block-head">
        <button type="button" className="nu-page-editor__block-name" aria-expanded={open} onClick={onToggle}>
          {open ? '▾' : '▸'} {summary}
        </button>
        <button type="button" className="nu-page-editor__icon-button" aria-label="Move up" disabled={first} onClick={() => onMove(-1)}>
          ↑
        </button>
        <button type="button" className="nu-page-editor__icon-button" aria-label="Move down" disabled={last} onClick={() => onMove(1)}>
          ↓
        </button>
        <button
          type="button"
          className="nu-page-editor__icon-button"
          aria-label="Remove block"
          onClick={onRemove}
          data-nu-role="page-editor-remove-block"
        >
          ✕
        </button>
      </div>
      {open && (
        <div className="nu-page-editor__block-fields">
          <Fields block={block} onChange={onChange} emotes={emotes} imagesLeft={imagesLeft} />
        </div>
      )}
    </div>
  );
}
