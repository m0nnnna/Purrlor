import { useEffect, useRef } from 'react';

/** A ref for an element at the foot of a list: `onVisible` runs when it scrolls into view (or is already), while `active`. */
export function useEndOfList(active: boolean, onVisible: () => void, version: number) {
  const ref = useRef<HTMLDivElement>(null);
  const callback = useRef(onVisible);
  callback.current = onVisible;
  useEffect(() => {
    const node = ref.current;
    if (!active || !node || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) callback.current();
    }, { rootMargin: '400px' });
    observer.observe(node);
    return () => observer.disconnect();
    // `version` (the list's length) makes a fresh observer, which reports a foot that is still in view after a page arrived.
  }, [active, version]);
  return ref;
}
