import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchPublicFeed, type PublicAuthor, type PublicPost } from '../../matrix/publicWeb';

type State = { posts: PublicPost[]; authors: Record<string, PublicAuthor>; next?: number; loading: boolean; error: boolean };

/** The public feed, a page at a time (newest first); `author` narrows it to one person. */
export function usePublicPosts(author?: string) {
  const [state, setState] = useState<State>({ posts: [], authors: {}, loading: true, error: false });
  const loadingRef = useRef(false);

  const load = useCallback(
    async (before?: number) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      setState((s) => ({ ...s, loading: true, error: false }));
      const result = await fetchPublicFeed({ before, author });
      loadingRef.current = false;
      setState((s) => {
        if (result.status !== 'ok') return { ...s, next: undefined, loading: false, error: result.status === 'error' };
        const seen = new Set(s.posts.map((post) => post.eventId));
        return {
          posts: [...s.posts, ...result.value.posts.filter((post) => !seen.has(post.eventId))],
          authors: { ...s.authors, ...result.value.authors },
          next: result.value.next,
          loading: false,
          error: false,
        };
      });
    },
    [author]
  );

  useEffect(() => {
    loadingRef.current = false;
    setState({ posts: [], authors: {}, loading: true, error: false });
    void load();
  }, [load]);

  const next = state.next;
  const loadMore = useCallback(() => {
    if (next !== undefined) void load(next);
  }, [load, next]);

  return { ...state, hasMore: next !== undefined, loadMore };
}
