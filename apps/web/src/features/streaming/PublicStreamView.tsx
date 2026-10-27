import { useEffect } from 'react';
import { getHomeServer } from '../../matrix/homeServer';
import { watchPath } from '../../matrix/liveStream';
import { publicPagePath } from '../../matrix/publicWeb';
import { handleFor } from '../../matrix/roles';
import { ProfileStreamCard, StreamWatch } from './StreamViews';
import { useProfileStream, useStream, useStreamBase } from './useStream';
import './Streaming.css';

/** `name` or `name:server` from an address → a user ID; a bare name is on this server. */
export function userIdFromPath(user: string): string | undefined {
  const name = user.replace(/^@/, '');
  if (name.includes(':')) return `@${name}`;
  const server = getHomeServer();
  return server ? `@${name}:${server}` : undefined;
}

/**
 * The watch page (`/@name/live/<id>`) for someone who isn't signed in: the player, and the chat to
 * read with a way to sign in to talk. Anyone may watch, whether or not the person's page is public.
 */
export function PublicStreamView({ user, streamId, onSignIn }: { user: string; streamId: string; onSignIn: () => void }) {
  const owner = userIdFromPath(user);
  const base = useStreamBase(owner, getHomeServer());
  const { stream, loaded } = useStream(base, streamId);

  useEffect(() => {
    if (!stream) return undefined;
    const previous = document.title;
    document.title = `${stream.title} · Purrlor`;
    return () => {
      document.title = previous;
    };
  }, [stream]);

  if (!stream || base === undefined || stream.owner !== owner) {
    return (
      <main className="nu-public__page nu-stream-page" data-nu-role="public-stream">
        <p className="nu-feed__status" data-nu-role="stream-missing">
          {!loaded && base !== undefined ? 'Loading the stream…' : 'This stream has ended, and its replay is gone.'}
        </p>
      </main>
    );
  }
  return (
    <main className="nu-public__page nu-stream-page" data-nu-role="public-stream">
      <StreamWatch base={base} stream={stream} onSignIn={onSignIn} ownerName={handleFor(stream.owner)} onOwner={() => window.location.assign(publicPagePath(stream.owner))} />
    </main>
  );
}

/** On a signed-out profile, above the posts: the owner's live stream or newest replay. */
export function PublicProfileStream({ userId }: { userId: string }) {
  const base = useStreamBase(userId, getHomeServer());
  const stream = useProfileStream(userId, base);
  if (!stream || base === undefined) return null;
  return <ProfileStreamCard base={base} stream={stream} onOpen={() => window.location.assign(watchPath(publicPagePath(userId), stream.id))} />;
}
