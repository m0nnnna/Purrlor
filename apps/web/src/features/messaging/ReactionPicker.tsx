import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
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

/** Phones (ReactionPicker.css): the panel is centred on the screen rather than placed by its 😀. */
const PHONE_QUERY = '(max-width: 900px)';

/** Room left between the panel and the window's edges. */
const EDGE = 8;

/**
 * Where the panel goes beside its 😀, in the window: under it, lined up with its left edge,
 * moved up over it where there's no room below and kept inside the window either way. Pure.
 */
export function panelPosition(
  toggle: { left: number; top: number; bottom: number },
  panel: { width: number; height: number },
  view: { width: number; height: number }
): { left: number; top: number } {
  const left = Math.max(EDGE, Math.min(toggle.left, view.width - panel.width - EDGE));
  const below = toggle.bottom + 4;
  const above = toggle.top - 4 - panel.height;
  const top = below + panel.height <= view.height - EDGE || above < EDGE ? below : above;
  return { left, top: Math.max(EDGE, Math.min(top, view.height - panel.height - EDGE)) };
}

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
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Hidden until placed, so it never shows a frame in the wrong spot.
  const [placement, setPlacement] = useState<CSSProperties>({ visibility: 'hidden' });

  const close = () => {
    setOpen(false);
    setPanel('quick');
  };

  const pick = (key: string, shortcode?: string) => {
    close();
    onPick(key, shortcode);
  };

  // Closes on a click anywhere else or Escape, like Menu.tsx. Without this an open picker outlived
  // the hover that shows the message toolbar: still open, but invisible.
  useEffect(() => {
    if (!open) return undefined;
    const dismiss = () => {
      setOpen(false);
      setPanel('quick');
    };
    const onPointer = (evt: PointerEvent) => {
      const target = evt.target as Node;
      if (!rootRef.current?.contains(target) && !panelRef.current?.contains(target)) dismiss();
    };
    const onKey = (evt: KeyboardEvent) => {
      if (evt.key === 'Escape') dismiss();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // The panel is in the page's body (below), out of the timeline that scrolls and clips it and of
  // any blurred frame, which would make a `fixed` panel line up with that frame, not the screen:
  // the picker opened off-centre and cut off on phones. Placed by its 😀 here; phones centre it
  // in CSS. Placed again as it changes size (the full emoji picker) or the page scrolls.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const toggle = rootRef.current?.getBoundingClientRect();
      const panelEl = panelRef.current;
      if (!toggle || !panelEl) return;
      if (window.matchMedia?.(PHONE_QUERY).matches) {
        setPlacement({});
        return;
      }
      const { left, top } = panelPosition(
        toggle,
        { width: panelEl.offsetWidth, height: panelEl.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight }
      );
      setPlacement({ left, top });
    };
    place();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    if (panelRef.current) observer?.observe(panelRef.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, panel]);

  const panelProps = { ref: panelRef, style: placement };

  return (
    // --open keeps the message toolbar showing (MessageTimeline.css): switching to the emoji or
    // emote panel unmounts the button that had focus, and the new panel may not be under the
    // pointer, so neither :hover nor :focus-within would.
    <div className={`nu-reaction-picker${open ? ' nu-reaction-picker--open' : ''}`} ref={rootRef}>
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
        createPortal(
          panel === 'emoji' ? (
            <div
              className="nu-reaction-picker__panel nu-reaction-picker__panel--full"
              data-nu-role="reaction-picker-full-panel"
              {...panelProps}
            >
              <EmojiPicker onPick={(key) => pick(key)} />
            </div>
          ) : panel === 'emotes' ? (
            <div
              className="nu-reaction-picker__panel nu-reaction-picker__panel--full"
              data-nu-role="reaction-picker-emotes-panel"
              {...panelProps}
            >
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
            <div className="nu-reaction-picker__panel" data-nu-role="reaction-picker-panel" {...panelProps}>
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
          ),
          document.body
        )}
    </div>
  );
}
