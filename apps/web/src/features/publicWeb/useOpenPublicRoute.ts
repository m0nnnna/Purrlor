import { useEffect } from 'react';
import { useStore } from 'jotai';
import { globalFeedOpenAtom, openPostAtom, profileUserIdAtom } from '../../app/state/selection';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { parsePublicRoute } from '../../matrix/publicWeb';
import { pageTargetAtom } from '../profilePage/PageTargetContext';
import { loadLinkedPost } from '../feed/useOpenPost';

/**
 * Signed in, the public addresses open the same things inside the app: `/@name` is that person's
 * profile; a post's `/@name/post/<id>` (with `?room=` for a Space post) is that post's page over
 * it; a link to something on a page (`/@name/music/…`, `/art/…`, `/commissions/…`) is the profile
 * with that thing open; `/feed` is the global feed. A name without a server is on this homeserver.
 * The address goes back to `/` afterwards, so a reload doesn't reopen it over wherever you've
 * since gone.
 */
export function useOpenPublicRoute(): void {
  const mx = useMatrixClient();
  const store = useStore();

  useEffect(() => {
    const route = parsePublicRoute(window.location.pathname, window.location.search);
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
    // A post's link: its own page, over the author's profile (where it stays if the post can't be read).
    if (route.kind === 'post') {
      void loadLinkedPost(mx, userId, route.eventId, route.roomId)
        .catch(() => undefined)
        .then((post) => {
          if (post && store.get(profileUserIdAtom) === userId) store.set(openPostAtom, post);
        });
    }
  }, [mx, store]);
}
