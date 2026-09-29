import { useEffect, useState, type FormEvent } from 'react';
import type { Room } from 'matrix-js-sdk';
import { Modal } from '../../components/Modal';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { addRoomImage, getRoomEmotes, getRoomStickers, removeRoomImage } from '../../matrix/emotes';
import {
  addLibraryImage,
  canContributeToLibrary,
  canModerateLibrary,
  joinEmoteLibrary,
  LIBRARY_MAX_FILE_BYTES,
  LIBRARY_MAX_IMAGES_PER_PERSON,
  readLibraryPacks,
  removeLibraryImage,
} from '../../matrix/emoteLibrary';
import { useEmoteLibraryRoom } from '../../matrix/hooks/useEmoteLibrary';
import { canSendStateEvent } from '../../matrix/permissions';
import { formatBytes } from '../../matrix/postMedia';
import { findParentSpaceId } from '../../matrix/spaceChildren';
import { EmoteImage } from './EmoteImage';
import { EmoteLibraryModeration } from './EmoteLibraryModeration';
import './EmoteManagerModal.css';

function sanitizeShortcode(raw: string): string {
  return raw
    .trim()
    .replace(/^:|:$/g, '')
    .replace(/[^a-zA-Z0-9_+-]/g, '');
}

/** One list entry tagged with which room it actually lives on — needed once entries can come
 *  from either the channel or its parent Space, so Remove targets the right one. */
type ScopedItem<T> = { item: T; scopeRoom: Room; isServerWide: boolean };

function scopedList<T extends { shortcode: string }>(
  getter: (room: Room) => T[],
  room: Room,
  space: Room | undefined
): ScopedItem<T>[] {
  const channelItems = getter(room);
  const channelCodes = new Set(channelItems.map((i) => i.shortcode));
  const spaceItems = space ? getter(space).filter((i) => !channelCodes.has(i.shortcode)) : [];
  return [
    ...spaceItems.map((item) => ({ item, scopeRoom: space as Room, isServerWide: true })),
    ...channelItems.map((item) => ({ item, scopeRoom: room, isServerWide: false })),
  ];
}

type Scope = 'library' | 'space' | 'channel';

/**
 * Manages this channel's own image pack, its parent Space's, and your own images in the server's
 * global library (matrix/emoteLibrary.ts) — Discord's mental model is one emoji set for the whole
 * server, not per-channel, so "Whole server" is the default target for anything newly added here
 * when you're allowed to change it (see useRoomEmotes.ts/useRoomStickers.ts for how the packs get
 * merged for display/autocomplete elsewhere). Per-channel still works and is offered as the
 * narrower alternative; the global library is open to everyone, so it's the one choice left for
 * someone without a Space or channel role. The library's moderators also get its moderation here.
 */
export function EmoteManagerModal({ room, onClose }: { room: Room; onClose: () => void }) {
  const mx = useMatrixClient();
  const myUserId = mx.getUserId() ?? '';
  const library = useEmoteLibraryRoom();
  const parentSpaceId = findParentSpaceId(mx, room.roomId);
  const space = parentSpaceId ? mx.getRoom(parentSpaceId) ?? undefined : undefined;
  const canManageSpace = space ? canSendStateEvent(space, myUserId, 'im.ponies.room_emotes') : false;
  const canManageChannel = canSendStateEvent(room, myUserId, 'im.ponies.room_emotes');
  const canUseLibrary = !!library && canContributeToLibrary(library, myUserId);
  const canModerate = !!library && canModerateLibrary(library, myUserId);

  const scopes: Scope[] = [
    ...(canManageSpace ? (['space'] as const) : []),
    ...(canManageChannel ? (['channel'] as const) : []),
    ...(canUseLibrary ? (['library'] as const) : []),
  ];
  const [chosenScope, setScope] = useState<Scope>();
  // The library can arrive (or a role change) while this is open, so a choice that's no longer
  // on offer falls back to the first one that is.
  const scope = chosenScope && scopes.includes(chosenScope) ? chosenScope : scopes[0];
  const [moderating, setModerating] = useState(false);
  const [shortcode, setShortcode] = useState('');
  const [file, setFile] = useState<File>();
  const [asEmote, setAsEmote] = useState(true);
  const [asSticker, setAsSticker] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>();

  // The library may have been set up since this session joined it (EmoteLibraryWatcher only
  // tries at start), so opening the manager tries again.
  useEffect(() => {
    if (!library) void joinEmoteLibrary(mx);
  }, [mx, library]);

  const emotes = scopedList(getRoomEmotes, room, space);
  const stickers = scopedList(getRoomStickers, room, space);
  const allShortcodes = new Set([...emotes.map((e) => e.item.shortcode), ...stickers.map((s) => s.item.shortcode)]);
  const myLibraryImages = library ? readLibraryPacks(library).find((pack) => pack.owner === myUserId)?.images ?? [] : [];

  const handleSubmit = async (evt: FormEvent) => {
    evt.preventDefault();
    const code = sanitizeShortcode(shortcode);
    if (!code || !file || uploading || !scope) return;
    if (!asEmote && !asSticker) {
      setError('Pick at least one of Emote / Sticker.');
      return;
    }
    if (scope === 'library') {
      if (file.size > LIBRARY_MAX_FILE_BYTES) {
        setError(`Images in the global library can be up to ${formatBytes(LIBRARY_MAX_FILE_BYTES)}.`);
        return;
      }
    } else if (allShortcodes.has(code)) {
      setError(`:${code}: already exists — remove it first to replace it.`);
      return;
    }
    setUploading(true);
    setError(undefined);
    try {
      const { content_uri: mxcUrl } = await mx.uploadContent(file);
      const usage = [...(asEmote ? (['emoticon'] as const) : []), ...(asSticker ? (['sticker'] as const) : [])];
      if (scope === 'library' && library) await addLibraryImage(mx, library, code, mxcUrl, usage);
      else await addRoomImage(mx, scope === 'space' && space ? space : room, code, mxcUrl, usage);
      setShortcode('');
      setFile(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add image');
    } finally {
      setUploading(false);
    }
  };

  if (moderating && library && canModerate) {
    return (
      <Modal title="Moderate the global library" onClose={onClose}>
        <button type="button" className="nu-button nu-button--secondary" onClick={() => setModerating(false)}>
          ← Back to your emotes
        </button>
        <EmoteLibraryModeration room={library} />
      </Modal>
    );
  }

  return (
    <Modal title="Manage Emotes & Stickers" onClose={onClose}>
      <div className="nu-emote-manager">
        {canModerate && (
          <button
            type="button"
            className="nu-button nu-button--secondary"
            data-nu-role="emote-library-moderate"
            onClick={() => setModerating(true)}
          >
            Moderate the global library
          </button>
        )}
        {scopes.length === 0 ? (
          <p className="nu-field__hint">
            You can't add emotes here, and this server has no global emote library for everyone to add to.
          </p>
        ) : (
          <form className="nu-modal-form" onSubmit={handleSubmit}>
            {scopes.length > 1 ? (
              <label className="nu-field">
                Add to
                <select
                  className="nu-field__input"
                  data-nu-role="emote-manager-scope"
                  value={scope}
                  onChange={(e) => setScope(e.target.value as Scope)}
                >
                  {canManageSpace && space && <option value="space">Whole server ({space.name})</option>}
                  {canManageChannel && <option value="channel">This channel only ({room.name})</option>}
                  {canUseLibrary && <option value="library">Global library (everyone, everywhere)</option>}
                </select>
              </label>
            ) : (
              scope === 'library' && (
                <p className="nu-field__hint">
                  Goes in the global library: everyone on this server can use it, in any channel, DM or post.
                </p>
              )
            )}
            <label className="nu-field">
              Shortcode
              <input
                className="nu-field__input"
                value={shortcode}
                onChange={(e) => setShortcode(e.target.value)}
                placeholder="pogchamp"
                required
              />
            </label>
            <label className="nu-button nu-button--secondary nu-file-picker">
              {file ? file.name : 'Choose image (GIF/WebP animate)'}
              <input
                type="file"
                accept="image/*"
                onChange={(e) => setFile(e.target.files?.[0])}
              />
            </label>
            <div className="nu-field__checkbox-row">
              <label>
                <input type="checkbox" checked={asEmote} onChange={(e) => setAsEmote(e.target.checked)} /> Emote (inline
                :shortcode:)
              </label>
              <label>
                <input type="checkbox" checked={asSticker} onChange={(e) => setAsSticker(e.target.checked)} /> Sticker
                (sent on its own)
              </label>
            </div>
            {error && <p className="nu-field__error">{error}</p>}
            <div className="nu-form-actions">
              <button type="submit" className="nu-button nu-button--primary" disabled={!shortcode.trim() || !file || uploading}>
                {uploading ? 'Adding…' : 'Add'}
              </button>
            </div>
          </form>
        )}
        {emotes.length > 0 && (
          <>
            <p className="nu-field__hint">Emotes</p>
            <div className="nu-emote-manager__list" data-nu-role="emote-manager-list">
              {emotes.map(({ item: emote, scopeRoom, isServerWide }) => (
                <div className="nu-emote-manager__item" key={`emote-${emote.shortcode}`}>
                  <EmoteImage shortcode={emote.shortcode} mxcUrl={emote.mxcUrl} />
                  <span className="nu-emote-manager__item-code">
                    :{emote.shortcode}: {isServerWide && <span className="nu-emote-manager__item-scope">server</span>}
                  </span>
                  {(isServerWide ? canManageSpace : canManageChannel) && (
                    <button
                      type="button"
                      className="nu-emote-manager__remove"
                      onClick={() => removeRoomImage(mx, scopeRoom, emote.shortcode)}
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
        {stickers.length > 0 && (
          <>
            <p className="nu-field__hint">Stickers</p>
            <div className="nu-emote-manager__list" data-nu-role="sticker-manager-list">
              {stickers.map(({ item: sticker, scopeRoom, isServerWide }) => (
                <div className="nu-emote-manager__item" key={`sticker-${sticker.shortcode}`}>
                  <EmoteImage shortcode={sticker.shortcode} mxcUrl={sticker.mxcUrl} />
                  <span className="nu-emote-manager__item-code">
                    :{sticker.shortcode}: {isServerWide && <span className="nu-emote-manager__item-scope">server</span>}
                  </span>
                  {(isServerWide ? canManageSpace : canManageChannel) && (
                    <button
                      type="button"
                      className="nu-emote-manager__remove"
                      onClick={() => removeRoomImage(mx, scopeRoom, sticker.shortcode)}
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
        {myLibraryImages.length > 0 && (
          <>
            <p className="nu-field__hint">
              Yours in the global library ({myLibraryImages.length}/{LIBRARY_MAX_IMAGES_PER_PERSON})
            </p>
            <div className="nu-emote-manager__list" data-nu-role="emote-library-own-list">
              {myLibraryImages.map((image) => (
                <div
                  className={image.hidden ? 'nu-emote-manager__item nu-emote-manager__item--hidden' : 'nu-emote-manager__item'}
                  key={`library-${image.shortcode}`}
                >
                  <EmoteImage shortcode={image.shortcode} mxcUrl={image.mxcUrl} />
                  <span className="nu-emote-manager__item-code">
                    :{image.shortcode}:{' '}
                    {image.hidden && (
                      <span className="nu-emote-manager__item-scope" title="A moderator hid this one">
                        hidden
                      </span>
                    )}
                  </span>
                  {library && (
                    <button
                      type="button"
                      className="nu-emote-manager__remove"
                      onClick={() => void removeLibraryImage(mx, library, image.shortcode).catch(() => undefined)}
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
