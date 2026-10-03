import { useEffect, useState } from 'react';
import { Avatar } from '../../components/Avatar';
import { useMediaUrl } from '../../matrix/hooks/useMediaUrl';
import { parseProfilePage } from '../../matrix/profilePage';
import { fetchPublicPage, type PageTarget, type PublicPageAnswer } from '../../matrix/publicWeb';
import { handleFor } from '../../matrix/roles';
import { ProfilePageLayout } from '../profilePage/ProfilePageLayout';
import { PageOwnerContext } from '../profilePage/PageOwnerContext';
import { PageTargetContext } from '../profilePage/PageTargetContext';
import { ProfilePageFrame } from '../profilePage/ProfilePageFrame';
import { PublicPostCard } from './PublicPostCard';
import { usePublicPosts } from './usePublicPosts';
import '../feed/FeedView.css';
import '../feed/ProfileView.css';

type State = { answer?: PublicPageAnswer; status: 'loading' | 'ok' | 'not_found' | 'error' };

/**
 * "Sign in to see this page": the one answer for every reason a page isn't shown (no such person,
 * not opted in, hidden, another server), so it never confirms that an account exists.
 */
function SignInToSee({ onSignIn }: { onSignIn: () => void }) {
  return (
    <section className="nu-public__banner" data-nu-role="public-page-closed">
      <h1>Sign in to see this page</h1>
      <p>This page isn’t shown to people who aren’t signed in.</p>
      <button type="button" className="nu-button nu-button--primary" onClick={onSignIn}>
        Sign in
      </button>
    </section>
  );
}

function PublicPosts({ userId, onSignIn }: { userId: string; onSignIn: () => void }) {
  const feed = usePublicPosts(userId);
  return (
    <>
      {feed.posts.map((post) => (
        <PublicPostCard key={post.eventId} post={post} authors={feed.authors} onSignIn={onSignIn} />
      ))}
      {feed.loading && <p className="nu-feed__status">Loading posts…</p>}
      {!feed.loading && feed.posts.length === 0 && <p className="nu-feed__status">No public posts yet.</p>}
      {feed.hasMore && !feed.loading && (
        <button type="button" className="nu-button nu-button--secondary nu-public__more" onClick={feed.loadMore}>
          Older posts
        </button>
      )}
    </>
  );
}

function PublicProfile({
  answer,
  target,
  onSignIn,
  onRegister,
}: {
  answer: PublicPageAnswer;
  target?: PageTarget;
  onSignIn: () => void;
  onRegister: () => void;
}) {
  // The service only checks it's a page at all: it goes through the same parser as the signed-in app.
  const page = parseProfilePage(answer.page);
  const name = answer.displayName || handleFor(answer.userId);
  const bannerSrc = useMediaUrl(answer.bannerUrl, { width: 1200, height: 360, method: 'crop' });

  useEffect(() => {
    const previous = document.title;
    document.title = `${name} on Purrlor`;
    return () => {
      document.title = previous;
    };
  }, [name]);

  return (
    <main className="nu-public__page" data-nu-role="public-page">
      <ProfilePageFrame page={page}>
        <PageOwnerContext.Provider value={{ userId: answer.userId, isMe: false }}>
          <PageTargetContext.Provider value={target}>
            <ProfilePageLayout
              page={page}
              header={
                <section className="nu-profile-view__card">
                  <div
                    className="nu-profile-view__banner"
                    style={bannerSrc ? { backgroundImage: `url(${bannerSrc})` } : undefined}
                    data-nu-role="profile-view-banner"
                  />
                  <div className="nu-profile-view__identity">
                    <div className="nu-profile-view__avatar">
                      <Avatar name={name} mxcUrl={answer.avatarUrl ?? null} size={88} animated={answer.avatarAnimated} />
                    </div>
                    <div className="nu-profile-view__actions">
                      <button type="button" className="nu-follow-button nu-follow-button--on" onClick={onRegister} data-nu-role="public-make-page">
                        Make your own page
                      </button>
                    </div>
                  </div>
                  <h1 className="nu-profile-view__name">{name}</h1>
                  <p className="nu-profile-view__handle">{handleFor(answer.userId)}</p>
                  {answer.bio && <p className="nu-profile-view__bio">{answer.bio}</p>}
                </section>
              }
              posts={
                <div className={page ? 'nu-profile-page__posts' : 'nu-profile-view__posts'}>
                  <PublicPosts userId={answer.userId} onSignIn={onSignIn} />
                </div>
              }
            />
          </PageTargetContext.Provider>
        </PageOwnerContext.Provider>
      </ProfilePageFrame>
    </main>
  );
}

/** A person's page at /@name, for someone who isn't signed in. */
export function PublicPage({
  user,
  target,
  onSignIn,
  onRegister,
}: {
  user: string;
  /** What the link pointed at on the page, if anything (`/@name/music/<album>`, …). */
  target?: PageTarget;
  onSignIn: () => void;
  onRegister: () => void;
}) {
  const [state, setState] = useState<State>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void fetchPublicPage(user).then((result) => {
      if (!cancelled) setState(result.status === 'ok' ? { answer: result.value, status: 'ok' } : { status: result.status });
    });
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (state.status === 'loading') return <p className="nu-feed__status">Loading…</p>;
  if (state.status === 'error') return <p className="nu-feed__status">Couldn’t load this page right now.</p>;
  if (state.status === 'not_found' || !state.answer) return <SignInToSee onSignIn={onSignIn} />;
  return <PublicProfile answer={state.answer} target={target} onSignIn={onSignIn} onRegister={onRegister} />;
}
