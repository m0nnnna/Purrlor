import { useAtomValue, useSetAtom } from 'jotai';
import { feedPostsAtom, feedSearchAtom } from '../../app/state/feed';
import { openPostAtom, profileUserIdAtom, socialViewAtom } from '../../app/state/selection';
import { Avatar } from '../../components/Avatar';
import { readPost } from '../../matrix/feed';
import type { GlobalPost } from '../../matrix/globalFeed';
import { extractHashtags } from '../../matrix/hashtags';
import { useExtendedProfile } from '../../matrix/hooks/useExtendedProfile';
import { useFollows } from '../../matrix/hooks/useFollows';
import { useMediaUrl } from '../../matrix/hooks/useMediaUrl';
import { useOwnProfile } from '../../matrix/hooks/useOwnProfile';
import { handleFor } from '../../matrix/roles';
import './FeedSidebar.css';

const DAY = 24 * 60 * 60 * 1000;
const TOP_TAGS = 6;

/** The tags used most in the posts given, newest day first: each counted once per post. */
export function trendingTags(posts: GlobalPost[], now = Date.now(), limit = TOP_TAGS): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const post of posts) {
    if (now - post.ts > DAY) continue;
    const body = readPost(post.event)?.body;
    if (!body) continue;
    for (const tag of new Set(extractHashtags(body))) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, limit);
}

function ProfileCard() {
  const me = useOwnProfile();
  const { profile } = useExtendedProfile(me.userId);
  const banner = useMediaUrl(profile.bannerUrl ?? null);
  const follows = useFollows();
  const posts = useAtomValue(feedPostsAtom);
  const mine = posts.filter((post) => post.source.owner === me.userId).length;
  const setProfileUserId = useSetAtom(profileUserIdAtom);
  const setOpenPost = useSetAtom(openPostAtom);
  return (
    <section className="nu-feed-side__window nu-feed-side__profile" data-nu-role="feed-side-profile" aria-label="Your profile">
      <div className="nu-feed-side__banner" style={banner ? { backgroundImage: `url("${banner.replace(/"/g, '%22')}")` } : undefined} />
      <div className="nu-feed-side__profile-body">
        <span className="nu-feed-side__avatar">
          <Avatar name={me.displayName} mxcUrl={me.avatarUrl} size={56} />
        </span>
        <div>
          <div className="nu-feed-side__name">{me.displayName}</div>
          <div className="nu-feed-side__handle">{handleFor(me.userId)}</div>
        </div>
        {profile.bio && <p className="nu-feed-side__bio">{profile.bio}</p>}
        <dl className="nu-feed-side__stats">
          <div>
            <dt>Posts</dt>
            {/* What's loaded here: the feed reads back a page at a time. */}
            <dd title="In the posts loaded so far">{mine}</dd>
          </div>
          <div>
            <dt>Following</dt>
            <dd>{follows.users.length + follows.spaces.length}</dd>
          </div>
        </dl>
        <button
          type="button"
          className="nu-button nu-button--secondary"
          data-nu-role="feed-side-open-profile"
          onClick={() => {
            setOpenPost(null);
            setProfileUserId(me.userId);
          }}
        >
          Your profile
        </button>
      </div>
    </section>
  );
}

function TrendingTags() {
  const posts = useAtomValue(feedPostsAtom);
  const setSearch = useSetAtom(feedSearchAtom);
  const setView = useSetAtom(socialViewAtom);
  const tags = trendingTags(posts);
  return (
    <section className="nu-feed-side__window" data-nu-role="feed-side-trending" aria-labelledby="nu-feed-side-trending">
      <div className="nu-feed-side__pad">
        <h2 className="nu-feed-side__label" id="nu-feed-side-trending">
          Trending · last 24 h
        </h2>
        {tags.length === 0 ? (
          <p className="nu-feed-side__empty">No #tags in the last day’s posts yet.</p>
        ) : (
          <ul className="nu-feed-side__tags">
            {tags.map(({ tag, count }) => (
              <li key={tag}>
                <button
                  type="button"
                  className="nu-feed-side__tag"
                  data-nu-role="feed-side-tag"
                  onClick={() => {
                    setView('everyone');
                    setSearch(`#${tag}`);
                  }}
                >
                  #{tag}
                </button>
                <span className="nu-feed-side__count">{count}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/**
 * The column beside the global feed, where a channel has its member list: your profile and the
 * tags trending in what's loaded, as two of the frame's glass windows under the clock (the Ultimit
 * mockup's feed screen). Only on a wide screen (styles/base/frame.css).
 */
export function FeedSidebar() {
  return (
    <aside className="nu-feed-side" data-nu-role="feed-side">
      <ProfileCard />
      <TrendingTags />
    </aside>
  );
}
