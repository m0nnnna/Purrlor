import { useEffect } from 'react';
import { useStore } from 'jotai';
import { globalFeedOpenAtom, openPostAtom, profileUserIdAtom } from '../../app/state/selection';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { parsePublicRoute } from '../../matrix/publicWeb';

/**
 * Signed in, the public addresses open the same things inside the app: `/@name` (and a post's
 * `/@name/post/<id>`) is that person's profile, `/feed` is the global feed. A name without a
 * server is on this homeserver. The address goes back to `/` afterwards, so a reload doesn't
 * reopen it over wherever you've since gone.
 */
export function useOpenPublicRoute(): void {
  const mx = useMatrixClient();
  const store = useStore();

  useEffect(() => {
    const route = parsePublicRoute(window.location.pathname);
    if (!route) return;
    window.history.replaceState({}, '', `/${window.location.search}`);
    store.set(openPostAtom, null);
    if (route.kind === 'feed') {
      store.set(profileUserIdAtom, null);
      store.set(globalFeedOpenAtom, true);
      return;
    }
    const domain = mx.getDomain();
    const name = route.user.replace(/^@/, '');
    const userId = name.includes(':') ? `@${name}` : domain ? `@${name}:${domain}` : undefined;
    if (userId) store.set(profileUserIdAtom, userId);
  }, [mx, store]);
}
