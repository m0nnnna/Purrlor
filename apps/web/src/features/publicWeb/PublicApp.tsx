import { useEffect, useState } from 'react';
import { getHomeServer, setHomeServer } from '../../matrix/homeServer';
import { fetchInstance, type PublicRoute } from '../../matrix/publicWeb';
import { PublicChrome } from './PublicChrome';
import { PublicFeed } from './PublicFeed';
import { PublicPage } from './PublicPage';
import { PublicPostView } from './PublicPostView';

/**
 * What a visitor who isn't signed in sees at `/@name`, `/@name/post/<id>` and `/feed`
 * (docs/public-web.md). Everything here is read through the public API, never Matrix.
 *
 * It first learns this deployment's own server name, so a federated instance's people keep theirs
 * in handles and links (`@mochi:cats.example`, docs/federation.md). Without an answer it draws
 * anyway, as before federation.
 */
export function PublicApp({ route, onSignIn, onRegister }: { route: PublicRoute; onSignIn: () => void; onRegister: () => void }) {
  const [known, setKnown] = useState(() => !!getHomeServer());
  useEffect(() => {
    if (known) return undefined;
    let cancelled = false;
    void fetchInstance().then((instance) => {
      if (instance) setHomeServer(instance.serverName);
      if (!cancelled) setKnown(true);
    });
    return () => {
      cancelled = true;
    };
  }, [known]);

  return (
    <PublicChrome onSignIn={onSignIn} onRegister={onRegister}>
      {known && route.kind === 'feed' && <PublicFeed onSignIn={onSignIn} onRegister={onRegister} />}
      {known && route.kind === 'page' && <PublicPage user={route.user} target={route.target} onSignIn={onSignIn} onRegister={onRegister} />}
      {known && route.kind === 'post' && <PublicPostView eventId={route.eventId} author={route.user} onSignIn={onSignIn} onRegister={onRegister} />}
    </PublicChrome>
  );
}
