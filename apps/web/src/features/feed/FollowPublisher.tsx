import { useEffect } from 'react';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { readFollows } from '../../matrix/follows';
import { republishFollows } from '../../matrix/profileFeed';

/** Waits a little after start, out of the way of the first screen loading. */
const DELAY_MS = 8_000;

/**
 * Puts the people you follow on your profile if it doesn't show them yet (profileFeed.ts,
 * republishFollows): follows made before they could be published were kept only privately, so
 * follower counts, Top 8 friends and "people I follow" guestbooks didn't see them. Once per
 * session, quietly; a failure is tried again next time. Renders nothing.
 */
export function FollowPublisher() {
  const mx = useMatrixClient();
  useEffect(() => {
    const timer = setTimeout(() => {
      void republishFollows(mx, readFollows(mx).users).catch(() => undefined);
    }, DELAY_MS);
    return () => clearTimeout(timer);
  }, [mx]);
  return null;
}
