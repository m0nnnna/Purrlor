import { PublicPostCard } from './PublicPostCard';
import { usePublicPosts } from './usePublicPosts';

/** The read-only Global feed at /feed. */
export function PublicFeed({ onSignIn, onRegister }: { onSignIn: () => void; onRegister: () => void }) {
  const feed = usePublicPosts();
  return (
    <main className="nu-public__main" data-nu-role="public-feed">
      <section className="nu-public__banner">
        <h1>Global feed</h1>
        <p>Posts anyone on Purrlor chose to share with the whole web. Everything else stays behind sign-in.</p>
        <button type="button" className="nu-button nu-button--primary" onClick={onRegister}>
          Join Purrlor
        </button>
      </section>
      <div className="nu-public__posts">
        {feed.posts.map((post) => (
          <PublicPostCard key={post.eventId} post={post} authors={feed.authors} onSignIn={onSignIn} />
        ))}
      </div>
      {feed.loading && <p className="nu-feed__status">Loading posts…</p>}
      {feed.error && <p className="nu-feed__status">Couldn’t load posts right now.</p>}
      {!feed.loading && !feed.error && feed.posts.length === 0 && <p className="nu-feed__status">No public posts yet.</p>}
      {feed.hasMore && !feed.loading && (
        <button type="button" className="nu-button nu-button--secondary nu-public__more" onClick={feed.loadMore}>
          Older posts
        </button>
      )}
    </main>
  );
}
