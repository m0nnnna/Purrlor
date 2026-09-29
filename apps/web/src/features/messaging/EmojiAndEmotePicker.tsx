import { useState } from 'react';
import { Icon } from '../../components/Icon';
import type { Room } from 'matrix-js-sdk';
import { EmojiPicker } from '../../components/EmojiPicker';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import type { Sticker } from '../../matrix/emotes';
import { canContributeToLibrary, canModerateLibrary } from '../../matrix/emoteLibrary';
import { useEmoteLibraryRoom } from '../../matrix/hooks/useEmoteLibrary';
import { useRoomEmotes } from '../../matrix/hooks/useRoomEmotes';
import { useRoomStickers } from '../../matrix/hooks/useRoomStickers';
import { canSendStateEvent } from '../../matrix/permissions';
import { findParentSpaceId } from '../../matrix/spaceChildren';
import { EmoteImage } from './EmoteImage';
import { EmoteManagerModal } from './EmoteManagerModal';
import './EmojiAndEmotePicker.css';

type Tab = 'emoji' | 'emotes' | 'stickers';

/**
 * The composer's single 😀 button. Unicode emoji and this room's custom emotes used to be two
 * separate buttons with two separate popovers; combined into one, tabbed, since both are just
 * "insert this into the message" — the same way Discord's own picker folds custom server emoji
 * in alongside the Unicode set rather than giving them their own button. ReactionPicker (reacting
 * to an existing message, rather than composing one) is its own smaller component: reactions can
 * use custom emotes too, but a reaction's `key` sends as the emote's `mxc://` URL rather than
 * `:shortcode:` text, so it isn't just this component reused — see ReactionPicker.tsx.
 */
export function EmojiAndEmotePicker({
  room,
  onPickEmoji,
  onPickEmote,
  onPickSticker,
}: {
  room: Room | undefined;
  onPickEmoji: (emoji: string) => void;
  onPickEmote: (shortcode: string) => void;
  onPickSticker: (sticker: Sticker) => void;
}) {
  const mx = useMatrixClient();
  const emotes = useRoomEmotes(room);
  const stickers = useRoomStickers(room);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('emoji');
  const [showManager, setShowManager] = useState(false);
  const library = useEmoteLibraryRoom();
  const myUserId = mx.getUserId() ?? '';
  const parentSpaceId = room ? findParentSpaceId(mx, room.roomId) : null;
  const space = parentSpaceId ? mx.getRoom(parentSpaceId) : null;
  // Anyone can add to the global library, so with one set up the manager is open to everyone.
  const canManage = room
    ? canSendStateEvent(room, myUserId, 'im.ponies.room_emotes') ||
      (!!space && canSendStateEvent(space, myUserId, 'im.ponies.room_emotes')) ||
      (!!library && (canContributeToLibrary(library, myUserId) || canModerateLibrary(library, myUserId)))
    : false;

  return (
    <div className="nu-emoji-emote-picker">
      <button
        type="button"
        className="nu-emoji-emote-picker__toggle"
        data-nu-role="emoji-emote-picker-toggle"
        title="Emoji and emotes"
        aria-label="Emoji and emotes"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="smile" size={20} />
      </button>
      {open && (
        <div className="nu-emoji-emote-picker__panel" data-nu-role="emoji-emote-picker-panel">
          <div className="nu-emoji-emote-picker__tabs" data-nu-role="emoji-emote-picker-tabs">
            <button
              type="button"
              className={
                tab === 'emoji'
                  ? 'nu-emoji-emote-picker__tab nu-emoji-emote-picker__tab--active'
                  : 'nu-emoji-emote-picker__tab'
              }
              data-nu-role="emoji-emote-picker-tab-emoji"
              onClick={() => setTab('emoji')}
            >
              Emoji
            </button>
            <button
              type="button"
              className={
                tab === 'emotes'
                  ? 'nu-emoji-emote-picker__tab nu-emoji-emote-picker__tab--active'
                  : 'nu-emoji-emote-picker__tab'
              }
              data-nu-role="emoji-emote-picker-tab-emotes"
              onClick={() => setTab('emotes')}
            >
              Emotes
            </button>
            <button
              type="button"
              className={
                tab === 'stickers'
                  ? 'nu-emoji-emote-picker__tab nu-emoji-emote-picker__tab--active'
                  : 'nu-emoji-emote-picker__tab'
              }
              data-nu-role="emoji-emote-picker-tab-stickers"
              onClick={() => setTab('stickers')}
            >
              Stickers
            </button>
          </div>
          {tab === 'emoji' && (
            <EmojiPicker
              onPick={(emoji) => {
                setOpen(false);
                onPickEmoji(emoji);
              }}
            />
          )}
          {tab === 'emotes' && (
            <div className="nu-emoji-emote-picker__emotes" data-nu-role="emoji-emote-picker-emotes">
              {emotes.length === 0 ? (
                <p className="nu-emoji-emote-picker__empty">No custom emotes available here yet.</p>
              ) : (
                <div className="nu-emoji-emote-picker__grid">
                  {emotes.map((emote) => (
                    <button
                      key={emote.shortcode}
                      type="button"
                      className="nu-emoji-emote-picker__item"
                      title={`:${emote.shortcode}:`}
                      onClick={() => {
                        setOpen(false);
                        onPickEmote(emote.shortcode);
                      }}
                    >
                      <EmoteImage shortcode={emote.shortcode} mxcUrl={emote.mxcUrl} />
                    </button>
                  ))}
                </div>
              )}
              {canManage && (
                <button
                  type="button"
                  className="nu-emoji-emote-picker__manage"
                  data-nu-role="emoji-emote-picker-manage"
                  onClick={() => {
                    setOpen(false);
                    setShowManager(true);
                  }}
                >
                  Manage Emotes & Stickers
                </button>
              )}
            </div>
          )}
          {tab === 'stickers' && (
            <div className="nu-emoji-emote-picker__emotes" data-nu-role="emoji-emote-picker-stickers">
              {stickers.length === 0 ? (
                <p className="nu-emoji-emote-picker__empty">No stickers available here yet.</p>
              ) : (
                <div className="nu-emoji-emote-picker__grid">
                  {stickers.map((sticker) => (
                    <button
                      key={sticker.shortcode}
                      type="button"
                      className="nu-emoji-emote-picker__item"
                      data-nu-role="sticker-picker-item"
                      title={sticker.body}
                      onClick={() => {
                        setOpen(false);
                        onPickSticker(sticker);
                      }}
                    >
                      <EmoteImage shortcode={sticker.shortcode} mxcUrl={sticker.mxcUrl} />
                    </button>
                  ))}
                </div>
              )}
              {canManage && (
                <button
                  type="button"
                  className="nu-emoji-emote-picker__manage"
                  data-nu-role="emoji-emote-picker-manage"
                  onClick={() => {
                    setOpen(false);
                    setShowManager(true);
                  }}
                >
                  Manage Emotes & Stickers
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {showManager && room && <EmoteManagerModal room={room} onClose={() => setShowManager(false)} />}
    </div>
  );
}
