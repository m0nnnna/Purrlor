import type { PublicRoute } from '../../matrix/publicWeb';
import { PublicChrome } from './PublicChrome';
import { PublicFeed } from './PublicFeed';
import { PublicPage } from './PublicPage';
import { PublicPostView } from './PublicPostView';

/**
 * What a visitor who isn't signed in sees at `/@name`, `/@name/post/<id>` and `/feed`
 * (docs/public-web.md). Everything here is read through the public API, never Matrix.
 */
export function PublicApp({ route, onSignIn, onRegister }: { route: PublicRoute; onSignIn: () => void; onRegister: () => void }) {
  return (
    <PublicChrome onSignIn={onSignIn} onRegister={onRegister}>
      {route.kind === 'feed' && <PublicFeed onSignIn={onSignIn} onRegister={onRegister} />}
      {route.kind === 'page' && <PublicPage user={route.user} target={route.target} onSignIn={onSignIn} onRegister={onRegister} />}
      {route.kind === 'post' && <PublicPostView eventId={route.eventId} onSignIn={onSignIn} onRegister={onRegister} />}
    </PublicChrome>
  );
}
