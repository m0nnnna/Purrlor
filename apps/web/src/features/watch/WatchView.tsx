import { useEffect, useState } from 'react';
import { useSetAtom } from 'jotai';
import { Icon } from '../../components/Icon';
import { mapWithConcurrency } from '../../matrix/globalFeed';
import { useFollows } from '../../matrix/hooks/useFollows';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import type { PublicStream } from '../../matrix/liveStream';
import { firstUnseenIndex, hasUnseen, loadStoryReel, readStoriesSeen, type StoryReel } from '../../matrix/stories';
import type { LiveEntry, StoryEntry } from '../../matrix/videos';
import { StreamCard } from '../home/HomeView';
import { Bubble } from '../stories/StoriesBar';
import { StoryViewer } from '../stories/StoryViewer';
import { useStreamBase } from '../streaming/useStream';
import { VideoCard } from './VideoCard';
import { openVideoAtom } from './watchState';
import { useCatalogue } from './useCatalogue';
import { useEndOfList } from './useInfiniteScroll';
import '../home/HomeView.css';
import '../stories/Stories.css';
import './Watch.css';

/** Most people's stories loaded for the row; each is a read of their profile room. */
const MAX_STORY_REELS = 40;
const STORY_CONCURRENCY = 6;

type Tab = 'latest' | 'following';

/** A live entry as the stream card takes it (docs/watch.md: live entries carry just enough for a card). */
function streamOf(entry: LiveEntry): PublicStream {
  return {
    id: entry.streamId,
    owner: entry.owner,
    title: entry.title,
    state: 'live',
    liveAt: entry.startedAt,
    endedAt: null,
    chatRoom: null,
    thumbnail: `/api/public/streams/${entry.streamId}/thumbnail`,
    replay: null,
    expiresAt: null,
    source: 'browser',
  };
}

/** A stream on this server or a peer: its thumbnail comes from the stream's own server. */
function LiveCard({ entry }: { entry: LiveEntry }) {
  const mx = useMatrixClient();
  const base = useStreamBase(entry.owner, mx.getDomain() ?? undefined);
  if (base === undefined) return null;
  return <StreamCard stream={streamOf(entry)} base={base} />;
}

/** The people with a story, read one by one (their rooms aren't synced): seen ones last. */
function useStoryReels(entries: StoryEntry[]): { reels: StoryReel[]; seen: ReturnType<typeof readStoriesSeen>; refreshSeen: () => void } {
  const mx = useMatrixClient();
  const [reels, setReels] = useState<StoryReel[]>([]);
  const [seen, setSeen] = useState(() => readStoriesSeen(mx));
  const key = entries.map((entry) => `${entry.owner}:${entry.latestTs}`).join('\n');
  useEffect(() => {
    let cancelled = false;
    const owners = [...new Set(entries.map((entry) => entry.owner))].slice(0, MAX_STORY_REELS);
    void mapWithConcurrency(owners, STORY_CONCURRENCY, (owner) => loadStoryReel(mx, owner)).then((loaded) => {
      if (!cancelled) setReels(loaded.filter((reel): reel is StoryReel => !!reel));
    });
    return () => {
      cancelled = true;
    };
    // The entries' contents, not the array's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mx, key]);
  const latest = (reel: StoryReel) => reel.stories[reel.stories.length - 1].ts;
  const ordered = [...reels].sort((a, b) => Number(hasUnseen(b, seen)) - Number(hasUnseen(a, seen)) || latest(b) - latest(a));
  return { reels: ordered, seen, refreshSeen: () => setSeen(readStoriesSeen(mx)) };
}

function StoriesRow({ entries }: { entries: StoryEntry[] }) {
  const { reels, seen, refreshSeen } = useStoryReels(entries);
  const [viewing, setViewing] = useState<{ reel: number; story: number }>();
  if (reels.length === 0) return null;
  return (
    <section className="nu-home__section nu-stories" data-nu-role="watch-stories" aria-label="Stories">
      <h2 className="nu-home__heading">Stories</h2>
      <div className="nu-stories__row">
        {reels.map((reel, index) => (
          <Bubble
            key={reel.userId}
            reel={reel}
            unseen={hasUnseen(reel, seen)}
            label={`${reel.name}'s story${hasUnseen(reel, seen) ? ', new' : ''}`}
            onOpen={() => setViewing({ reel: index, story: firstUnseenIndex(reel, seen) })}
          />
        ))}
      </div>
      {viewing && (
        <StoryViewer
          reels={reels}
          startReel={viewing.reel}
          startStory={viewing.story}
          onClose={() => {
            setViewing(undefined);
            refreshSeen();
          }}
          onDeleted={() => setViewing(undefined)}
        />
      )}
    </section>
  );
}

/**
 * The Watch section's page (docs/watch.md): who's live, everyone's stories, and the videos grid,
 * Latest or from the people you follow, with search; more load as you scroll.
 */
export function WatchView({ hidden = false }: { hidden?: boolean }) {
  const setOpenVideo = useSetAtom(openVideoAtom);
  const follows = useFollows().users;
  const [tab, setTab] = useState<Tab>('latest');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  // Typing waits a moment before asking the server.
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [query]);
  const following = tab === 'following';
  const catalogue = useCatalogue({ q: search, owners: following ? follows : undefined, enabled: !following || follows.length > 0 });
  const end = useEndOfList(catalogue.hasMore && !catalogue.loadingMore, catalogue.loadMore, catalogue.videos.length);

  return (
    <main className="nu-main-pane" data-nu-role="watch-view" style={hidden ? { display: 'none' } : undefined}>
      <div className="nu-main-pane__header" data-nu-role="main-pane-header">
        <h1 className="nu-main-pane__header-name">Watch</h1>
      </div>
      <div className="nu-watch-scroll">
        <div className="nu-watch-view">
          {catalogue.live.length > 0 && (
            <section className="nu-home__section" data-nu-role="watch-live" aria-labelledby="nu-watch-live">
              <h2 className="nu-home__heading" id="nu-watch-live">
                Live now
              </h2>
              <div className="nu-home__live-list">
                {catalogue.live.map((entry) => (
                  <LiveCard key={entry.streamId} entry={entry} />
                ))}
              </div>
            </section>
          )}
          <StoriesRow entries={catalogue.stories} />
          <section className="nu-home__section" data-nu-role="watch-videos" aria-label="Videos">
            <div className="nu-watch-view__controls">
              <div className="nu-profile-view__tabs" role="tablist">
                {(['latest', 'following'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={tab === value}
                    className={tab === value ? 'nu-profile-view__tab nu-profile-view__tab--active' : 'nu-profile-view__tab'}
                    data-nu-role={`watch-tab-${value}`}
                    onClick={() => setTab(value)}
                  >
                    {value === 'latest' ? 'Latest' : 'Following'}
                  </button>
                ))}
              </div>
              <label className="nu-watch-view__search">
                <Icon name="search" size={15} />
                <input
                  className="nu-field__input"
                  type="search"
                  data-nu-role="watch-search"
                  placeholder="Search videos"
                  aria-label="Search videos"
                  value={query}
                  onChange={(evt) => setQuery(evt.target.value)}
                />
              </label>
            </div>
            {following && follows.length === 0 ? (
              <p className="nu-feed__status" data-nu-role="watch-following-empty">
                Follow people to see their videos here.
              </p>
            ) : (
              <>
                <div className="nu-watch-grid" data-nu-role="watch-grid">
                  {catalogue.videos.map((video) => (
                    <VideoCard key={`${video.owner}|${video.id}`} video={video} onOpen={() => setOpenVideo({ owner: video.owner, id: video.id, video })} />
                  ))}
                </div>
                {catalogue.loading && <p className="nu-feed__status">Loading videos…</p>}
                {catalogue.error && !catalogue.loading && (
                  <p className="nu-feed__status" data-nu-role="watch-error">
                    Couldn’t load videos right now.{' '}
                    <button type="button" className="nu-home__link" onClick={catalogue.reload}>
                      Try again
                    </button>
                  </p>
                )}
                {!catalogue.loading && !catalogue.error && catalogue.videos.length === 0 && (
                  <p className="nu-feed__status" data-nu-role="watch-empty">
                    {search ? 'No videos match that.' : following ? 'The people you follow haven’t uploaded videos yet.' : 'No videos yet.'}
                  </p>
                )}
                <div ref={end} aria-hidden="true" />
              </>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
