import { useRef, useState, type TouchEvent } from 'react';

/** How far a message is dragged right before letting go replies to it. */
export const SWIPE_REPLY_PX = 56;
/** It follows the finger this far at most. */
const MAX_PULL_PX = 80;
/** Swipes that start this close to the left edge are the browser's "back" gesture, not ours. */
const EDGE_PX = 24;

/**
 * Swipe a message right to reply, as in most phone chat apps: one gesture instead of opening the
 * ⋯ and then tapping Reply. Only touch starts it, and only a mostly sideways drag: up and down
 * still scroll, and a long press still selects text. The row follows the finger (its transform is
 * set directly, not through state, so a drag doesn't re-render the message on every move).
 */
export function useSwipeToReply(onReply: (() => void) | undefined) {
  const start = useRef<{ x: number; y: number; decided: boolean } | null>(null);
  const pull = useRef(0);
  const [swiping, setSwiping] = useState(false);
  const [armed, setArmed] = useState(false);

  const reset = (el: HTMLElement) => {
    start.current = null;
    pull.current = 0;
    el.style.transition = 'transform 0.18s ease';
    el.style.transform = '';
    setSwiping(false);
    setArmed(false);
  };

  if (!onReply) return { swiping: false, armed: false, handlers: {} };

  return {
    swiping,
    armed,
    handlers: {
      onTouchStart: (evt: TouchEvent<HTMLElement>) => {
        const touch = evt.touches[0];
        if (evt.touches.length !== 1 || !touch || touch.clientX < EDGE_PX) return;
        start.current = { x: touch.clientX, y: touch.clientY, decided: false };
      },
      onTouchMove: (evt: TouchEvent<HTMLElement>) => {
        const from = start.current;
        const touch = evt.touches[0];
        if (!from || !touch) return;
        const dx = touch.clientX - from.x;
        const dy = touch.clientY - from.y;
        if (!from.decided) {
          if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
          // Mostly up and down, or leftwards: a scroll, not a swipe. Let it be.
          if (dx <= 0 || Math.abs(dy) * 1.5 > dx || window.getSelection()?.toString()) {
            start.current = null;
            return;
          }
          from.decided = true;
          setSwiping(true);
        }
        const el = evt.currentTarget;
        pull.current = Math.max(0, Math.min(MAX_PULL_PX, dx));
        el.style.transition = 'none';
        el.style.transform = `translateX(${pull.current}px)`;
        const nowArmed = pull.current >= SWIPE_REPLY_PX;
        setArmed((was) => {
          if (nowArmed && !was) navigator.vibrate?.(8);
          return nowArmed;
        });
      },
      onTouchEnd: (evt: TouchEvent<HTMLElement>) => {
        if (!start.current?.decided) {
          start.current = null;
          return;
        }
        const reply = pull.current >= SWIPE_REPLY_PX;
        reset(evt.currentTarget);
        if (reply) onReply();
      },
      onTouchCancel: (evt: TouchEvent<HTMLElement>) => {
        if (start.current?.decided) reset(evt.currentTarget);
        else start.current = null;
      },
    },
  };
}
