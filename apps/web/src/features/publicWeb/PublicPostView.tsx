import { useEffect, useState } from 'react';
import { fetchPublicPost, publicPagePath, type PublicPostsAnswer } from '../../matrix/publicWeb';
import { handleFor } from '../../matrix/roles';
import { PublicPostCard } from './PublicPostCard';

type State = { answer?: PublicPostsAnswer; status: 'loading' | 'ok' | 'not_found' | 'error' };

/** One Global post at /@name/post/<id>. */
export function PublicPostView({ eventId, onSignIn, onRegister }: { eventId: string; onSignIn: () => void; onRegister: () => void }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void fetchPublicPost(eventId).then((result) => {
      if (!cancelled) setState(result.status === 'ok' ? { answer: result.value, status: 'ok' } : { status: result.status });
    });
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  const post = state.answer?.posts[0];
  return (
    <main className="nu-public__main" data-nu-role="public-post-view">
      {state.status === 'loading' && <p className="nu-feed__status">Loading…</p>}
      {state.status === 'error' && <p className="nu-feed__status">Couldn’t load this post right now.</p>}
      {(state.status === 'not_found' || (state.status === 'ok' && !post)) && (
        <section className="nu-public__banner" data-nu-role="public-post-missing">
          <h1>Post not found</h1>
          <p>It may have been deleted, or it isn’t shared with the whole web.</p>
          <button type="button" className="nu-button nu-button--primary" onClick={onSignIn}>
            Sign in
          </button>
        </section>
      )}
      {post && state.answer && (
        <>
          <PublicPostCard post={post} authors={state.answer.authors} onSignIn={onSignIn} single />
          <section className="nu-public__banner">
            <p>Join Purrlor to like, comment and follow {handleFor(post.author)}.</p>
            <button type="button" className="nu-button nu-button--primary" onClick={onRegister}>
              Join Purrlor
            </button>
            <a className="nu-public__nav-link" href={publicPagePath(post.author)}>
              See their page
            </a>
          </section>
        </>
      )}
    </main>
  );
}
