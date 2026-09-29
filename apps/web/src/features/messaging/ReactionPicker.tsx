import { useState } from 'react';
import type { Room } from 'matrix-js-sdk';
import { Icon } from '../../components/Icon';
import { EmojiPicker } from '../../components/EmojiPicker';
import { useRoomEmotes } from '../../matrix/hooks/useRoomEmotes';
import { EmoteImage } from './EmoteImage';
import './ReactionPicker.css';

/**
 * A deliberately small, curated set of common reactions for the one-click row — covers the
 * usual Discord/Slack "quick reaction" range. "More…" opens the full Unicode picker
 * (components/EmojiPicker.tsx) for anything else.
 */
const QUICK_REACTIONS = ['👍', '👎', '❤️', '😂', '😮', '😢', '🎉', '🔥', '👀', '✅', '❌', '🤔'];

type Panel = 'quick' | 'emoji' | 'emotes';

/**
 * Hover-revealed "React" trigger + popover — the entry point for adding a *new* reaction type
 * to a message (toggling an existing one is done directly on its pill, see ReactionBar). Besides
 * plain Unicode emoji, this room's own custom emotes (`room`, same merged list Composer/
 * EmojiAndEmotePicker use) can be picked too: an `m.reaction` whose annotation `key` is the
 * emote's `mxc://` URL rather than a character — there's no way to put an *image* on a reaction
 * pill otherwise, `key` has to stay a plain string either way. The shortcode travels alongside on
 * `com.beeper.reaction.shortcode` (matrix/reactions.ts), the same field Element/Cinny already use,
 * for any client (including this one — see ReactionBar.tsx) that wants to show it as text/a
 * tooltip instead of resolving the mxc URL.
 */
export function ReactionPicker({ room, onPick }: { room?: Room; onPick: (key: string, shortcode?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>('quick');
  const emotes = useRoomEmotes(room);

  const pick = (key: string, shortcode?: string) => {
    setOpen(false);
    setPanel('quick');
    onPick(key, shortcode);
  };

  return (
    <div className="nu-reaction-picker">
      <button
        type="button"
        className="nu-timeline__message-pin-action nu-reaction-picker__toggle"
        data-nu-role="reaction-picker-toggle"
        title="Add reaction"
        aria-label="Add reaction"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="smile" size={16} />
      </button>
      {open &&
        (panel === 'emoji' ? (
          <div className="nu-reaction-picker__panel nu-reaction-picker__panel--full" data-nu-role="reaction-picker-full-panel">
            <EmojiPicker onPick={(key) => pick(key)} />
          </div>
        ) : panel === 'emotes' ? (
          <div className="nu-reaction-picker__panel nu-reaction-picker__panel--full" data-nu-role="reaction-picker-emotes-panel">
            {emotes.length === 0 ? (
              <p className="nu-reaction-picker__empty">No custom emotes available here yet.</p>
            ) : (
              <div className="nu-reaction-picker__grid" data-nu-role="reaction-picker-emote-grid">
                {emotes.map((emote) => (
                  <button
                    key={emote.shortcode}
                    type="button"
                    className="nu-reaction-picker__item"
                    title={`:${emote.shortcode}:`}
                    onClick={() => pick(emote.mxcUrl, emote.shortcode)}
                  >
                    <EmoteImage shortcode={emote.shortcode} mxcUrl={emote.mxcUrl} />
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="nu-reaction-picker__panel" data-nu-role="reaction-picker-panel">
            <div className="nu-reaction-picker__grid">
              {QUICK_REACTIONS.map((key) => (
                <button key={key} type="button" className="nu-reaction-picker__item" onClick={() => pick(key)}>
                  {key}
                </button>
              ))}
              <button
                type="button"
                className="nu-reaction-picker__more"
                data-nu-role="reaction-picker-more"
                title="More emoji"
                onClick={() => setPanel('emoji')}
              >
                …
              </button>
            </div>
            {emotes.length > 0 && (
              <button
                type="button"
                className="nu-reaction-picker__emotes-toggle"
                data-nu-role="reaction-picker-emotes-toggle"
                onClick={() => setPanel('emotes')}
              >
                Custom emotes
              </button>
            )}
          </div>
        ))}
    </div>
  );
}
