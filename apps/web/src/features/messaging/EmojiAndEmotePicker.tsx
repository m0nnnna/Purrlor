import { useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import type { Room } from 'matrix-js-sdk';
import { EmojiPicker } from '../../components/EmojiPicker';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import type { EmoteSource, Sticker, SourcedEmote } from '../../matrix/emotes';
import { canContributeToLibrary, canModerateLibrary } from '../../matrix/emoteLibrary';
import { useEmoteLibraryRoom } from '../../matrix/hooks/useEmoteLibrary';
import { useGroupedRoomEmotes } from '../../matrix/hooks/useGroupedRoomEmotes';
import { usePersonalEmotePacks } from '../../matrix/hooks/usePersonalEmotePacks';
import { useRecentEmotes } from '../../matrix/hooks/useRecentEmotes';
import { useRoomStickers } from '../../matrix/hooks/useRoomStickers';
import { canSendStateEvent } from '../../matrix/permissions';
import { noteRecentEmote } from '../../matrix/recentEmotes';
import { findParentSpaceId } from '../../matrix/spaceChildren';
import { EmoteImage } from './EmoteImage';
import { EmoteManagerModal } from './EmoteManagerModal';
import './EmojiAndEmotePicker.css';

type Tab = 'emoji' | 'emotes' | 'stickers';

const SOURCE_LABELS: Record<EmoteSource, string> = { global: 'Global', space: 'This server', channel: 'Channel' };
/** Display order for the grouped sections — deliberately widest-to-narrowest, independent of
 *  groupEmotesBySource's dedup precedence (which goes the other way: the *narrowest* scope wins a
 *  shared shortcode). */
const SOURCE_ORDER: EmoteSource[] = ['global', 'space', 'channel'];

function matchesQuery(shortcode: string, query: string): boolean {
  return shortcode.toLowerCase().includes(query.trim().toLowerCase());
}

/** One labeled grid of emote buttons — Recents, and each of the Global/This server/Channel
 *  sections, are all the same shape. */
function EmoteSection({
  label,
  emotes,
  onPick,
}: {
  label: string;
  emotes: { shortcode: string; mxcUrl: string }[];
  onPick: (emote: { shortcode: string; mxcUrl: string }) => void;
}) {
  if (emotes.length === 0) return null;
  return (
    <section className="nu-emoji-emote-picker__section">
      <h3 className="nu-emoji-emote-picker__section-label">{label}</h3>
      <div className="nu-emoji-emote-picker__grid">
        {emotes.map((emote) => (
          <button
            key={emote.shortcode}
            type="button"
            className="nu-emoji-emote-picker__item"
            data-nu-role="emoji-emote-picker-item"
            title={`:${emote.shortcode}:`}
            onClick={() => onPick(emote)}
          >
            <EmoteImage shortcode={emote.shortcode} mxcUrl={emote.mxcUrl} />
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * The composer's single 😀 button. Unicode emoji and this room's custom emotes used to be two
 * separate buttons with two separate popovers; combined into one, tabbed, since both are just
 * "insert this into the message" — the same way Discord's own picker folds custom server emoji
 * in alongside the Unicode set rather than giving them their own button. ReactionPicker (reacting
 * to an existing message, rather than composing one) is its own smaller component: reactions can
 * use custom emotes too, but a reaction's `key` sends as the emote's `mxc://` URL rather than
 * `:shortcode:` text, so it isn't just this component reused — see ReactionPicker.tsx.
 *
 * The Emotes tab has a search box, a Recents section (recentEmotes.ts — only emotes still usable
 * here, so picking one never sends a shortcode this room can't actually resolve), your own
 * MSC2545 personal packs if you have any (personalEmotePacks.ts — Element/Cinny's "these emotes
 * follow me" packs, one section per pack, your own labeled "Personal"), and the rest grouped by
 * where each one comes from (groupEmotesBySource: Global library / this Space / this channel
 * specifically), widest scope first.
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
  const groupedEmotes = useGroupedRoomEmotes(room);
  const personalPacks = usePersonalEmotePacks();
  const recentEmotes = useRecentEmotes();
  const stickers = useRoomStickers(room);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('emoji');
  const [query, setQuery] = useState('');
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

  const filteredEmotes = useMemo(
    () => (query.trim() ? groupedEmotes.filter((e) => matchesQuery(e.shortcode, query)) : groupedEmotes),
    [groupedEmotes, query]
  );
  const bySource = (source: EmoteSource): SourcedEmote[] => filteredEmotes.filter((e) => e.source === source);
  // Recents only while not searching (search results already cover them, same as Discord's own
  // picker), and only ones still actually available here — a shortcode this room can't resolve
  // would just send as literal `:text:` (see messageFormatting.ts).
  const availableRecents = query.trim()
    ? []
    : recentEmotes.filter((recent) => groupedEmotes.some((e) => e.shortcode === recent.shortcode && e.mxcUrl === recent.mxcUrl));
  const filteredPersonalPacks = useMemo(
    () =>
      personalPacks
        .map((pack) => ({ ...pack, emotes: query.trim() ? pack.emotes.filter((e) => matchesQuery(e.shortcode, query)) : pack.emotes }))
        .filter((pack) => pack.emotes.length > 0),
    [personalPacks, query]
  );
  const hasAnyEmotes = groupedEmotes.length > 0 || personalPacks.some((pack) => pack.emotes.length > 0);
  const hasAnyMatch = filteredEmotes.length > 0 || filteredPersonalPacks.length > 0;

  const pickEmote = (emote: { shortcode: string; mxcUrl: string }) => {
    setOpen(false);
    onPickEmote(emote.shortcode);
    void noteRecentEmote(mx, emote).catch(() => undefined);
  };

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
              <input
                type="text"
                className="nu-emoji-emote-picker__search"
                data-nu-role="emoji-emote-picker-search"
                placeholder="Search emotes…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
              />
              {!hasAnyEmotes ? (
                <p className="nu-emoji-emote-picker__empty">No custom emotes available here yet.</p>
              ) : !hasAnyMatch ? (
                <p className="nu-emoji-emote-picker__empty">No emotes match "{query.trim()}".</p>
              ) : (
                <>
                  <EmoteSection label="Recents" emotes={availableRecents} onPick={pickEmote} />
                  {filteredPersonalPacks.map((pack, i) => (
                    <EmoteSection key={`${pack.name}-${i}`} label={pack.name} emotes={pack.emotes} onPick={pickEmote} />
                  ))}
                  {SOURCE_ORDER.map((source) => (
                    <EmoteSection key={source} label={SOURCE_LABELS[source]} emotes={bySource(source)} onPick={pickEmote} />
                  ))}
                </>
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
