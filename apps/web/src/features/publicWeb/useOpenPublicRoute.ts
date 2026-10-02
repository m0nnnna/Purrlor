import { useEffect } from 'react';
import { useStore } from 'jotai';
import { globalFeedOpenAtom, openPostAtom, profileUserIdAtom } from '../../app/state/selection';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { parsePublicRoute } from '../../matrix/publicWeb';
import { pageTargetAtom } from '../profilePage/PageTargetContext';

/**
 * Signed in, the public addresses open the same things inside the app: `/@name` (and a post's
 * `/@name/post/<id>`) is that person's profile, a link to something on a page (`/@name/music/…`,
 * `/art/…`, `/commissions/…`) is the profile with that thing open, `/feed` is the global feed. A name without a
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
    if (!userId) return;
    store.set(pageTargetAtom, route.kind === 'page' && route.target ? { userId, target: route.target } : null);
    store.set(profileUserIdAtom, userId);
  }, [mx, store]);
}
