import { useEffect, useRef, type DOMAttributes, type MouseEvent, type TouchEvent } from 'react';

/** How long a finger rests on a message before its actions open. */
export const LONG_PRESS_MS = 450;
/** Moving further than this is a scroll or a swipe, not a press. */
const SLOP_PX = 10;

/**
 * Press and hold a message to open its actions, as in most phone chat apps (MessageActionSheet).
 * Touch only: a mouse has the ⋯ in the message's own column. Moving the finger cancels it, so a
 * scroll or a swipe to reply (useSwipeToReply.ts) never opens the sheet. Once it has fired, the
 * tap the finger's lifting would make (on a picture, a link) is swallowed, and so is the browser's
 * own long-press menu.
 */
export function useLongPress(onLongPress: (() => void) | undefined): TouchHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };

  useEffect(() => cancel, []);

  if (!onLongPress) return {};

  return {
    onTouchStart: (evt: TouchEvent<HTMLElement>) => {
      const touch = evt.touches[0];
      fired.current = false;
      cancel();
      if (evt.touches.length !== 1 || !touch) return;
      start.current = { x: touch.clientX, y: touch.clientY };
      timer.current = setTimeout(() => {
        timer.current = null;
        fired.current = true;
        navigator.vibrate?.(10);
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onTouchMove: (evt: TouchEvent<HTMLElement>) => {
      const from = start.current;
      const touch = evt.touches[0];
      if (!from || !touch) return;
      if (Math.abs(touch.clientX - from.x) > SLOP_PX || Math.abs(touch.clientY - from.y) > SLOP_PX) cancel();
    },
    onTouchEnd: (evt: TouchEvent<HTMLElement>) => {
      cancel();
      // No click after a press that opened the sheet: it would open a picture or follow a link.
      if (fired.current && evt.cancelable) evt.preventDefault();
    },
    onTouchCancel: cancel,
    onContextMenu: (evt: MouseEvent<HTMLElement>) => evt.preventDefault(),
  };
}

export type TouchHandlers = Partial<Pick<DOMAttributes<HTMLElement>, 'onTouchStart' | 'onTouchMove' | 'onTouchEnd' | 'onTouchCancel' | 'onContextMenu'>>;

const HANDLER_KEYS = ['onTouchStart', 'onTouchMove', 'onTouchEnd', 'onTouchCancel', 'onContextMenu'] as const;

/** Several gestures' handlers on one element (a message: swipe to reply, and press and hold). */
export function combineHandlers(...sets: TouchHandlers[]): TouchHandlers {
  const combined: TouchHandlers = {};
  for (const key of HANDLER_KEYS) {
    const handlers = sets.map((set) => set[key] as ((evt: unknown) => void) | undefined).filter((fn) => !!fn);
    if (handlers.length) combined[key] = ((evt: unknown) => handlers.forEach((fn) => fn!(evt))) as never;
  }
  return combined;
}
