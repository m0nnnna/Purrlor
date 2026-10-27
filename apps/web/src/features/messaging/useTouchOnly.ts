import { useEffect, useState } from 'react';

/** A touch screen with no pointer that hovers: a phone or tablet (MessageTimeline.css says the same). */
export const TOUCH_ONLY_QUERY = '(hover: none)';

function matches(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.(TOUCH_ONLY_QUERY).matches;
}

/** Whether this is a touch-only screen, kept up to date (a tablet docked to a keyboard and mouse). */
export function useTouchOnly(): boolean {
  const [touchOnly, setTouchOnly] = useState(matches);
  useEffect(() => {
    const query = window.matchMedia?.(TOUCH_ONLY_QUERY);
    if (!query) return undefined;
    const onChange = () => setTouchOnly(query.matches);
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);
  return touchOnly;
}
