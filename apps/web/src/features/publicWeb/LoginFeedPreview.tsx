import { useEffect, useState } from 'react';
import { getHomeServer, setHomeServer } from '../../matrix/homeServer';
import { fetchInstance } from '../../matrix/publicWeb';
import { PublicPostCard } from './PublicPostCard';
import { usePublicPosts } from './usePublicPosts';

/** How many of the newest posts the sign-in page shows; the rest are a link to /feed away. */
const PREVIEW_POSTS = 8;

function PreviewPosts({ onSignIn }: { onSignIn: () => void }) {
  const feed = usePublicPosts();
  // Nothing to show (no public posts yet, or the public API isn't there): no empty box either.
  if (!feed.loading && feed.posts.length === 0) return null;
  return (
    <section className="nu-login__feed" data-nu-role="login-feed" aria-labelledby="nu-login-feed-title">
      <header className="nu-login__feed-header">
        <h2 id="nu-login-feed-title" className="nu-login__feed-title">
          What people are posting
        </h2>
        <a className="nu-login__feed-all" href="/feed" data-nu-role="login-feed-all">
          See the whole feed
        </a>
      </header>
      {feed.loading && feed.posts.length === 0 ? (
        <p className="nu-feed__status">Loading posts…</p>
      ) : (
        <div className="nu-public__posts">
          {feed.posts.slice(0, PREVIEW_POSTS).map((post) => (
            <PublicPostCard key={post.eventId} post={post} authors={feed.authors} onSignIn={onSignIn} />
          ))}
        </div>
      )}
      {feed.posts.length > 0 && (
        <a className="nu-button nu-button--secondary nu-login__feed-more" href="/feed">
          More on the Global feed
        </a>
      )}
    </section>
  );
}

/**
 * The Global feed's newest posts beside the sign-in form, so a visitor gets a feel for the place
 * before making an account: the same public, read-only posts as /feed (PublicFeed.tsx), read
 * through the public API. Like PublicApp, it learns the server's name first, so handles come out
 * right. `onSignIn` is what a post's like or reply button does: back to the form.
 */
export function LoginFeedPreview({ onSignIn }: { onSignIn: () => void }) {
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
  return known ? <PreviewPosts onSignIn={onSignIn} /> : null;
}
