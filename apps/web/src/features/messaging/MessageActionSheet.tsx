import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Room } from 'matrix-js-sdk';
import { QUICK_REACTIONS, ReactionPicker } from './ReactionPicker';
import './MessageActionSheet.css';

/** Reactions one tap away at the top of the sheet; the 😀 after them opens the rest. */
const SHEET_REACTIONS = QUICK_REACTIONS.slice(0, 6);

/**
 * A message's actions on a phone: a sheet up from the bottom of the screen, opened by pressing
 * and holding the message (useLongPress.ts). Quick reactions across the top, then each action
 * with its name (MessageTimeline.tsx passes the same buttons a computer gets in its row under the
 * message). In the page's body, so the timeline's scrolling and clipping can't reach it. Tapping
 * outside it, Escape or any action closes it.
 */
export function MessageActionSheet({
  room,
  onReact,
  onClose,
  children,
}: {
  room: Room;
  onReact: (key: string, shortcode?: string) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return createPortal(
    <div className="nu-message-sheet" data-nu-role="message-action-sheet">
      <div className="nu-message-sheet__backdrop" data-nu-role="message-action-sheet-backdrop" onClick={onClose} />
      <div className="nu-message-sheet__panel" role="dialog" aria-modal="true" aria-label="Message actions">
        <div className="nu-message-sheet__reactions">
          {SHEET_REACTIONS.map((key) => (
            <button
              key={key}
              type="button"
              className="nu-message-sheet__reaction"
              data-nu-role="message-sheet-reaction"
              aria-label={`React with ${key}`}
              onClick={() => onReact(key)}
            >
              {key}
            </button>
          ))}
          <ReactionPicker room={room} onPick={onReact} />
        </div>
        <div className="nu-message-sheet__items">{children}</div>
      </div>
    </div>,
    document.body
  );
}
